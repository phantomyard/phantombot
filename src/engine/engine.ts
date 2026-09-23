/**
 * The embeddable phantombot engine.
 *
 * `createEngine({ root })` gives an application the same brain the daemon
 * runs — persona, memory, retrieval, threat screening, the harness chain with
 * fallback and watchdogs, the decision model — as a TypeScript API.
 *
 * Design, in the order it matters:
 *
 *   1. ADDITIVE. The facade calls the functions the CLI and the daemon call
 *      (`runTurn`, `makeScreener`, `applyPersona`, `runMemorySearch`, …); it
 *      re-implements none of them. The daemon never enters an engine scope,
 *      so every seam this needed (`engineScope.ts`) is a no-op for it.
 *   2. ISOLATED. Everything lives under the application's `root`: config,
 *      personas, vault, memory database, turn registry. Paths are carried by
 *      an AsyncLocalStorage scope, never by rewriting `process.env`, and the
 *      root is exclusively locked so two engines cannot share memory.
 *      Credentials follow the same rule: a harness spawn gets a per-spawn
 *      env with the persona's vault applied (vault wins), and the
 *      application's `process.env` is never written (`harnessSpawnEnv`).
 *   3. EXPLICIT TRUST. `source` has no default. "untrusted" is screened by
 *      the threat judge before any capable harness runs; "principal" is not.
 *      Tools default to "none".
 *   4. STABLE SURFACE. Applications see `EngineEvent`, `TurnResult` and
 *      `EngineError` only — see `types.ts`.
 *
 * Runtime: Bun (the engine uses `bun:sqlite` and `Bun.spawn`, like the CLI).
 */

import { existsSync } from "node:fs";
import { mkdir, readFile } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import { parse as parseToml, stringify as stringifyToml } from "smol-toml";

import { runMemoryCapture, runMemorySearch } from "../cli/memory.ts";
import { applyPersona } from "../cli/create-persona.ts";
import { runNotify } from "../cli/notify.ts";
import { validPersonaName } from "../cli/persona-new.ts";
import { type Config, loadConfig, personaDir } from "../config.ts";
import { buildHarnessChain } from "../harnesses/buildChain.ts";
import type { Harness } from "../harnesses/types.ts";
import {
  DECISION_MODEL_DEFAULT_KEY_ENV,
  decisionModelDecide,
} from "../lib/decisionModel.ts";
import {
  bindToScope,
  type EngineScope,
  runInEngineScope,
} from "../lib/engineScope.ts";
import { resolveHarnessBinsForConfig } from "../lib/harnessAvailability.ts";
import { writeFileAtomic, type WriteSink } from "../lib/io.ts";
import { log } from "../lib/logger.ts";
import { personaConfigPath } from "../lib/personaConfig.ts";
import { listPersonaDirs } from "../lib/personaDefault.ts";
import { ENV_PI_API_KEY } from "../lib/piRouting.ts";
import { APP_CONVERSATION_PREFIX } from "../lib/memoryIndex.ts";
import { acquireRunLock, type LockHandle } from "../lib/runLock.ts";
import { openPersonaVault } from "../lib/vault.ts";
import { openMemoryStore, type MemoryStore } from "../memory/store.ts";
import {
  makeDurableFactPuller,
  makeFactExtractor,
} from "../orchestrator/durableFacts.ts";
import { makeRetriever } from "../orchestrator/retrieval.ts";
import { makeScreener, type ScreenVerdict } from "../orchestrator/screen.ts";
import { runTurn } from "../orchestrator/turn.ts";
import { makeTurnIndexer } from "../orchestrator/turnIndexer.ts";
import { EngineError } from "./errors.ts";
import { toEngineEvent } from "./events.ts";
import {
  parseJsonReply,
  structuredOutputInstruction,
  structuredRetryMessage,
  validateOutput,
} from "./structured.ts";
import type {
  CreatePersonaOptions,
  DecideOptions,
  DecisionAnswer,
  DecisionResult,
  EngineEvent,
  EngineLogRecord,
  EngineOptions,
  HarnessId,
  MemoryHit,
  MemorySearchOptions,
  PersonaConfig,
  StructuredResult,
  StructuredTurnOptions,
  TurnOptions,
  TurnResult,
  TurnStream,
} from "./types.ts";

const HARNESS_IDS: readonly HarnessId[] = ["native", "pi-host", "claude", "codex"];
/**
 * Harness ids whose `toolsMode: "none"` is READ-ONLY rather than tool-less
 * (see HarnessRequest.toolsMode). A tool-less engine turn never runs on one.
 */
const READ_ONLY_TOOLLESS: ReadonlySet<string> = new Set(["codex"]);
const CONVERSATION_PREFIX = APP_CONVERSATION_PREFIX;
const MAX_CONVERSATION_KEY = 200;
const DEFAULT_DECIDE_TIMEOUT_MS = 5000;

/**
 * Test seam: replaces harness discovery + chain building. Deliberately NOT
 * exported from `index.ts` — it is not part of the public surface.
 */
let harnessFactoryForTesting:
  | ((config: Config, persona: string) => Harness[])
  | undefined;

/** @internal Tests only. Pass undefined to restore real harnesses. */
export function _setHarnessFactoryForTesting(
  factory: ((config: Config, persona: string) => Harness[]) | undefined,
): void {
  harnessFactoryForTesting = factory;
}

// ─── createEngine ─────────────────────────────────────────────────────────

/**
 * Open an engine on `options.root`. Rejects with `invalid_root` or
 * `root_locked`. Always `close()` it (or use `await using`).
 */
export async function createEngine(options: EngineOptions): Promise<Engine> {
  const root = options?.root;
  if (typeof root !== "string" || root.trim() === "" || !isAbsolute(root)) {
    throw new EngineError("invalid_root", "root must be an absolute path", {
      root,
    });
  }
  const base = resolve(root);
  const scope: EngineScope = {
    configHome: join(base, "config"),
    dataHome: join(base, "data"),
    stateHome: join(base, "state"),
    logSink: makeLogSink(options.log),
  };
  try {
    // Owner-only (umask-masked): the tree holds the encrypted vaults and the
    // memory database, and a group-writable directory lets a same-group local
    // user substitute files even when the files themselves are tight.
    await Promise.all([
      mkdir(scope.configHome, { recursive: true, mode: 0o700 }),
      mkdir(scope.dataHome, { recursive: true, mode: 0o700 }),
      mkdir(scope.stateHome, { recursive: true, mode: 0o700 }),
    ]);
  } catch (e) {
    throw new EngineError("invalid_root", `cannot create root: ${(e as Error).message}`, {
      root: base,
    });
  }

  const lock = acquireRunLock(join(scope.stateHome, "phantombot", "engine.lock"));
  if (!("release" in lock)) {
    throw new EngineError(
      "root_locked",
      `root is already owned by another engine (pid ${lock.pid})`,
      { root: base, pid: lock.pid },
    );
  }
  return new Engine(base, scope, lock);
}

function makeLogSink(
  option: EngineOptions["log"],
): ((line: string) => void) | undefined {
  if (option === undefined || option === "stderr") return undefined;
  if (option === "silent") return () => {};
  if (typeof option === "function") {
    return (line: string) => {
      try {
        option(JSON.parse(line) as EngineLogRecord);
      } catch {
        // A throwing application logger must never fail a turn.
      }
    };
  }
  throw new EngineError("invalid_argument", "log must be 'stderr', 'silent' or a function");
}

// ─── Engine ───────────────────────────────────────────────────────────────

export class Engine {
  readonly root: string;
  readonly personas: {
    list(): Promise<string[]>;
    exists(name: string): Promise<boolean>;
    create(name: string, options?: CreatePersonaOptions): Promise<Persona>;
  };

  #scope: EngineScope;
  /** `#scope` plus `persona`, one per persona handle (identity-stable). */
  #scopes = new Map<string, EngineScope>();
  #lock: LockHandle;
  #closed = false;
  #memory: Promise<MemoryStore> | undefined;
  #handles = new Map<string, Persona>();
  #active = new Set<{ controller: AbortController; done: Promise<void> }>();

  /** @internal Use `createEngine`. */
  constructor(root: string, scope: EngineScope, lock: LockHandle) {
    this.root = root;
    this.#scope = scope;
    this.#lock = lock;
    this.personas = {
      list: () => this.run(async () => listPersonaDirs(await loadConfig())),
      exists: (name) =>
        this.run(async () => {
          if (!validPersonaName(name)) return false;
          return existsSync(personaDir(await loadConfig(), name));
        }),
      create: (name, options) => this.#createPersona(name, options ?? {}),
    };
  }

  /** A handle on `name`. Cheap; existence is checked on use. */
  persona(name: string): Persona {
    this.#assertOpen();
    if (typeof name !== "string" || !validPersonaName(name)) {
      throw new EngineError(
        "persona_not_found",
        "persona names are lowercase letters, digits, '-' or '_'",
        { name },
      );
    }
    let handle = this.#handles.get(name);
    if (!handle) {
      handle = new Persona(this, name);
      this.#handles.set(name, handle);
    }
    return handle;
  }

  /**
   * Cancel in-flight turns, wait for them to unwind (their harness process
   * groups are killed and their state persisted), close the memory database
   * and release the root. Idempotent.
   */
  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    const active = [...this.#active];
    for (const turn of active) this.enter(() => turn.controller.abort());
    await Promise.allSettled(active.map((turn) => turn.done));
    if (this.#memory) {
      const memory = await this.#memory.catch(() => undefined);
      await memory?.close().catch(() => {});
    }
    this.#lock.release();
  }

  async [Symbol.asyncDispose](): Promise<void> {
    await this.close();
  }

  get closed(): boolean {
    return this.#closed;
  }

  // ── internals shared with Persona ──────────────────────────────────────

  /**
   * @internal Run `fn` inside this engine's scope. With `persona`, the scope
   * also records whose work this is, so a persona-less harness spawn made on
   * its behalf (the threat judge, fact extraction) draws that persona's vault
   * (`harnessSpawnEnv`).
   */
  run<T>(fn: () => Promise<T>, persona?: string): Promise<T> {
    this.#assertOpen();
    return runInEngineScope(this.#scopeFor(persona), fn);
  }

  /**
   * @internal Run `fn` in this engine's scope without the closed check —
   * for abort listeners, which fire in whatever context called `abort()`
   * (the application's, usually) and would otherwise log to the host sink.
   */
  enter<T>(fn: () => T, persona?: string): T {
    return runInEngineScope(this.#scopeFor(persona), fn);
  }

  /** @internal Bind an async iterable to this engine's scope. */
  bind<T>(iterable: AsyncIterable<T>, persona?: string): AsyncIterableIterator<T> {
    return bindToScope(this.#scopeFor(persona), iterable);
  }

  #scopeFor(persona: string | undefined): EngineScope {
    if (!persona) return this.#scope;
    let scope = this.#scopes.get(persona);
    if (!scope) {
      scope = { ...this.#scope, persona };
      this.#scopes.set(persona, scope);
    }
    return scope;
  }

  /** @internal The shared memory database (turns, facts, captures). */
  memoryStore(config: Config): Promise<MemoryStore> {
    if (!this.#memory) {
      this.#memory = openMemoryStore(config.memoryDbPath);
      this.#memory.catch(() => {
        this.#memory = undefined;
      });
    }
    return this.#memory;
  }

  /** @internal Track a turn so close() can cancel and await it. */
  track(controller: AbortController): () => void {
    let finish!: () => void;
    const entry = {
      controller,
      done: new Promise<void>((r) => {
        finish = r;
      }),
    };
    this.#active.add(entry);
    return () => {
      this.#active.delete(entry);
      finish();
    };
  }

  #assertOpen(): void {
    if (this.#closed) throw new EngineError("engine_closed", "engine is closed");
  }

  async #createPersona(name: string, options: CreatePersonaOptions): Promise<Persona> {
    if (typeof name !== "string" || !validPersonaName(name)) {
      throw new EngineError(
        "invalid_argument",
        "persona names are lowercase letters, digits, '-' or '_', starting with a letter or digit",
        { name },
      );
    }
    if (options.soul !== undefined && (typeof options.soul !== "string" || options.soul.trim() === "")) {
      // An empty SOUL.md would load silently as "no soul" — almost certainly
      // a bug in the caller, and one nothing downstream would report.
      throw new EngineError("invalid_argument", "soul must be non-empty markdown when given");
    }
    await this.run(async () => {
      const config = await loadConfig();
      if (existsSync(personaDir(config, name))) {
        throw new EngineError("persona_exists", `persona '${name}' already exists`, {
          name,
        });
      }
      await applyPersona(config, {
        name,
        identity: options.identity ?? `a phantom called ${name}`,
        tone: options.tone ?? "professional",
        expertise: options.expertise ?? [],
        owner: options.owner,
        hardRules: options.hardRules ?? "",
        greeting: "",
        setDefault: false,
        soul: options.soul,
      });
    });
    return this.persona(name);
  }
}

// ─── Persona ──────────────────────────────────────────────────────────────

interface PersonaRuntime {
  config: Config;
  harnesses: Harness[];
}

export class Persona {
  readonly name: string;
  readonly secrets: {
    /** Store a credential in this persona's encrypted vault (verified by read-back). */
    set(name: string, value: string): Promise<void>;
    has(name: string): Promise<boolean>;
    delete(name: string): Promise<void>;
  };
  readonly memory: {
    /** Search this persona's memory and knowledge base (BM25F, hybrid with embeddings). */
    search(query: string, options?: MemorySearchOptions): Promise<MemoryHit[]>;
    /** Record a note in today's journal; indexed immediately. */
    capture(text: string, options?: { tags?: string[]; conversation?: string }): Promise<void>;
  };

  #engine: Engine;
  #runtime: Promise<PersonaRuntime> | undefined;

  /** @internal Use `engine.persona(name)`. */
  constructor(engine: Engine, name: string) {
    this.#engine = engine;
    this.name = name;
    this.secrets = {
      set: (key, value) => this.#run(() => this.#setSecret(key, value)),
      has: (key) =>
        this.#run(async () => {
          const vault = await openPersonaVault(await this.#dir());
          try {
            return vault.get(key) !== undefined;
          } finally {
            vault.close();
          }
        }),
      delete: (key) =>
        this.#run(async () => {
          const vault = await openPersonaVault(await this.#dir());
          try {
            vault.unset(key);
          } finally {
            vault.close();
          }
          this.#runtime = undefined;
        }),
    };
    this.memory = {
      search: (query, options) => this.#search(query, options ?? {}),
      capture: (text, options) => this.#capture(text, options ?? {}),
    };
  }

  // ── configuration ──────────────────────────────────────────────────────

  /**
   * Write this persona's brain and decision-model settings into ITS OWN
   * `config.toml` (never the root's global file, so one persona's settings
   * cannot leak into another's) and its keys into its encrypted vault.
   * Only the keys you pass are changed.
   */
  async configure(settings: PersonaConfig): Promise<void> {
    await this.#run(async () => {
      const config = await loadConfig(this.name);
      const dir = personaDir(config, this.name);
      if (!existsSync(dir)) throw notFound(this.name);
      const path = personaConfigPath(config.personasDir, this.name);
      const toml = await readTomlTable(path);

      const brain = settings.brain;
      if (brain) {
        const harnesses = table(toml, "harnesses");
        const chain = brain.chain ?? (brain.native ? ["native"] : undefined);
        if (chain) {
          if (
            chain.length === 0 ||
            chain.some((id) => !HARNESS_IDS.includes(id))
          ) {
            throw new EngineError(
              "invalid_argument",
              `chain must list one or more of: ${HARNESS_IDS.join(", ")}`,
              { chain },
            );
          }
          harnesses.chain = [...chain];
        }
        if (brain.native) {
          const n = brain.native;
          if (!n.provider?.trim() || !n.model?.trim()) {
            throw new EngineError(
              "invalid_argument",
              "native needs a provider and a model",
            );
          }
          const routing = table(table(harnesses, "pi"), "routing");
          // The native key is ONE vault slot (PHANTOMBOT_PI_API_KEY) shared
          // by whichever provider is routed. A provider SWITCH that keeps it
          // would send the previous provider's credential to the new one on
          // the next turn — the same no-carry-over rule the decision model
          // applies below (AGENTS invariant 63). So a switch needs the new
          // provider's key in the same call whenever a key is stored; with
          // no stored key there is nothing stale to carry.
          const previous = asStr(routing.provider)?.trim().toLowerCase();
          const next = n.provider.trim().toLowerCase();
          if (previous !== undefined && previous !== next && n.apiKey === undefined) {
            if (await this.#hasSecret(ENV_PI_API_KEY, dir)) {
              throw new EngineError(
                "invalid_argument",
                `native provider changes from '${previous}' to '${next}': pass apiKey ` +
                  `for the new provider (the stored key belongs to '${previous}')`,
                { from: previous, to: next },
              );
            }
          }
          // Stating routing supersedes a "use Pi's own config" tombstone.
          delete routing.use_local_config;
          routing.provider = n.provider.trim();
          routing.primary_model = n.model.trim();
          setOrDelete(routing, "coding_model", n.coderModel?.trim());
          setOrDelete(routing, "image_model", n.visionModel?.trim());
        }
      }

      const dm = settings.decisionModel;
      if (dm) {
        // Stored under `[jev]` — the on-disk name predates the general
        // "decision model" slot and is kept so existing hosts keep working.
        const block = table(toml, "jev");
        const stored = asStr(block.provider);
        const provider = dm.provider?.trim() || stored || "openrouter";
        if (!provider) throw new EngineError("invalid_argument", "decisionModel.provider must be non-empty");
        const switched =
          stored !== undefined && stored.trim().toLowerCase() !== provider.toLowerCase();
        if (switched) {
          // A provider switch carries nothing over: another vendor's model id
          // is meaningless here, and its key name / endpoint would send the
          // wrong credential to the wrong host (AGENTS invariant 63).
          delete block.model;
          delete block.base_url;
          delete block.key_env;
        }
        block.provider = provider;
        if (dm.model !== undefined) block.model = dm.model;
        if (dm.baseUrl !== undefined) block.base_url = dm.baseUrl;
        if (dm.keyName !== undefined) {
          if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(dm.keyName)) {
            throw new EngineError("invalid_argument", "decisionModel.keyName must be [A-Za-z_][A-Za-z0-9_]*");
          }
          block.key_env = dm.keyName;
        }
        if (block.key_env === undefined) block.key_env = DECISION_MODEL_DEFAULT_KEY_ENV;
        const builtIn = ["openrouter", "typesafe"].includes(provider.toLowerCase());
        if (!builtIn && asStr(block.base_url) === undefined) {
          // The config loader refuses this shape once a consumer is on; fail
          // here, at the write, rather than leave an unloadable persona.
          throw new EngineError(
            "invalid_argument",
            `decision model provider '${provider}' is not a built-in transport; pass its baseUrl`,
          );
        }

        if (dm.judge !== undefined) {
          const judge = table(block, "judge");
          judge.enabled = dm.judge !== false;
          if (typeof dm.judge === "object") {
            if (dm.judge.threshold !== undefined) {
              if (
                !Number.isInteger(dm.judge.threshold) ||
                dm.judge.threshold < 0 ||
                dm.judge.threshold > 100
              ) {
                throw new EngineError(
                  "invalid_argument",
                  "judge.threshold must be an integer 0..100",
                );
              }
              judge.threshold = dm.judge.threshold;
            }
            if (dm.judge.timeoutMs !== undefined) {
              judge.timeout_ms = positiveInt(dm.judge.timeoutMs, "judge.timeoutMs");
            }
          }
        }
        if (dm.router !== undefined) {
          const router = table(block, "router");
          router.enabled = dm.router !== false;
          if (typeof dm.router === "object" && dm.router.timeoutMs !== undefined) {
            router.timeout_ms = positiveInt(dm.router.timeoutMs, "router.timeoutMs");
          }
        }
      }

      // Secrets FIRST: a config naming a key that never landed in the vault
      // is a persona that looks configured and fails on its first turn.
      if (brain?.native?.apiKey !== undefined) {
        await this.#setSecret(ENV_PI_API_KEY, brain.native.apiKey);
      }
      if (dm?.apiKey !== undefined) {
        const keyEnv = asStr(table(toml, "jev").key_env) ?? DECISION_MODEL_DEFAULT_KEY_ENV;
        await this.#setSecret(keyEnv, dm.apiKey);
      }
      try {
        await writeFileAtomic(path, stringifyToml(toml) + "\n");
      } catch (e) {
        throw new EngineError("write_failed", `cannot write ${path}: ${(e as Error).message}`);
      }
      this.#runtime = undefined;
    });
  }

  // ── turns ──────────────────────────────────────────────────────────────

  /**
   * Run one turn and stream its events. Iterate it, or call `result()`, or
   * both. The stream can be consumed once.
   */
  turn(options: TurnOptions): TurnStream {
    validateTurnOptions(options);
    if (this.#engine.closed) throw new EngineError("engine_closed", "engine is closed");
    const controller = new AbortController();
    const abort = () => this.#enter(() => controller.abort());
    const external = options.signal;
    if (external?.aborted) abort();
    else external?.addEventListener("abort", abort, { once: true });

    const conversation = CONVERSATION_PREFIX + (options.conversation ?? "default");
    const events = this.#bind(this.#turnEvents(options, conversation, controller));
    return new TurnStreamImpl(events, conversation, controller, abort);
  }

  /** Run one turn and resolve with its result. */
  ask(options: TurnOptions): Promise<TurnResult> {
    return this.turn(options).result();
  }

  /**
   * Run a turn whose answer must be JSON that satisfies `schema`. Invalid
   * answers are retried (see `retries`) with the validation problem shown to
   * the model. Rejects with `schema_invalid` when attempts run out and with
   * `held` when the threat screen held the message.
   */
  async askJson<T>(options: StructuredTurnOptions<T>): Promise<StructuredResult<T>> {
    const tools = options.tools ?? "none";
    const retries = options.retries ?? (tools === "none" ? 1 : 0);
    if (!Number.isInteger(retries) || retries < 0) {
      throw new EngineError("invalid_argument", "retries must be a non-negative integer");
    }
    const instructions = [options.instructions, structuredOutputInstruction(options.jsonSchema)]
      .filter(Boolean)
      .join("\n\n");

    let message = options.message;
    let problem = "";
    for (let attempt = 1; attempt <= retries + 1; attempt++) {
      const result = await this.ask({ ...options, tools, message, instructions });
      if (result.held) {
        throw new EngineError("held", "the threat screen held this message", {
          conversation: result.conversation,
        });
      }
      const parsed = parseJsonReply(result.text);
      if (parsed.ok) {
        const valid = await validateOutput(options.schema, parsed.value);
        if (valid.ok) return { ...result, value: valid.value, attempts: attempt };
        problem = valid.problem;
      } else {
        problem = parsed.problem;
      }
      message = structuredRetryMessage(options.message, result.text, problem);
    }
    throw new EngineError("schema_invalid", `no valid answer after ${retries + 1} attempt(s)`, {
      problem,
    });
  }

  async *#turnEvents(
    options: TurnOptions,
    conversation: string,
    controller: AbortController,
  ): AsyncGenerator<EngineEvent> {
    // A stream is lazy: this body runs on the first `next()`, which can come
    // after `close()` released the root to another engine. Nothing below may
    // open runtime state once the engine is closed — the check happens here,
    // synchronously, before the turn is tracked and before any await.
    if (this.#engine.closed) {
      yield { type: "error", code: "engine_closed", message: "engine is closed" };
      return;
    }
    const untrack = this.#engine.track(controller);
    try {
      let runtime: PersonaRuntime;
      let memory: MemoryStore;
      try {
        runtime = await this.#loadRuntime();
        memory = await this.#engine.memoryStore(runtime.config);
      } catch (e) {
        const err = asEngineError(e, "not_configured");
        yield { type: "error", code: err.code, message: err.message };
        return;
      }
      const { config } = runtime;
      const agentDir = personaDir(config, this.name);
      const trusted = options.source === "principal";
      const history = options.history ?? options.conversation !== undefined;
      const tools = options.tools ?? "none";

      // `tools: "none"` promises the model cannot run commands. Codex maps a
      // tool-less request to `--sandbox read-only`, which still has a shell
      // for reads — enough to read `identity.json` and the vault from the
      // default cwd (the persona dir) and quote them back. That is not an
      // implementation of this contract, so codex is left out of a tool-less
      // turn's chain.
      //
      // The threat SCREEN is a tool-less request too, and a worse one to run
      // read-only: it is spawned in the persona dir and handed the untrusted
      // text itself, so an injection that steers the judge steers a shell
      // that can read the vault. The daemon accepts that floor because only
      // a score comes back; an application embedding the engine cannot audit
      // what the judge read, so the screen runs on the SAME tool-less set.
      const toolless = runtime.harnesses.filter((h) => !READ_ONLY_TOOLLESS.has(h.id));
      const readOnly = runtime.harnesses.filter((h) => READ_ONLY_TOOLLESS.has(h.id));
      const readOnlyIds = readOnly.map((h) => h.id).join(", ");
      let harnesses = runtime.harnesses;
      if (tools === "none") {
        if (readOnly.length > 0) {
          harnesses = toolless;
          log.warn("engine: harness skipped for a tool-less turn (read-only is not tool-less)", {
            persona: this.name,
            skipped: readOnly.map((h) => h.id),
          });
        }
        if (harnesses.length === 0) {
          yield {
            type: "error",
            code: "not_configured",
            message:
              `tools: "none" needs a harness that can run without tools ` +
              `(native, pi-host or claude); '${readOnlyIds}' only reaches ` +
              `read-only. Add one to the chain, or pass tools: "full" for input ` +
              `you trust.`,
          };
          return;
        }
      }
      // An untrusted turn needs a harness the screen can run on, whatever
      // `tools` the turn itself was granted. This holds with the decision
      // model judge enabled too: it decides first, the harness judge is its
      // FALLBACK, and a screener with an empty chain fails OPEN — so on a
      // codex-only chain a decision-model outage would hand the untrusted
      // text to codex with full tools, unscreened. Refused before anything
      // runs; the text never reaches a harness.
      if (!trusted && toolless.length === 0) {
        yield {
          type: "error",
          code: "not_configured",
          message:
            `untrusted input needs a harness the threat screen can run ` +
            `tool-less (native, pi-host or claude); '${readOnlyIds}' only ` +
            `reaches read-only. Add one to the chain.`,
        };
        return;
      }

      // Untrusted turns are screened; the wrapper records a hold so the
      // loop below can tell a hold notice from a reply.
      let held = false;
      const screen = trusted
        ? undefined
        : this.#screener(config, conversation, toolless, memory, () => {
            held = true;
          });

      const chunks = runTurn({
        persona: this.name,
        conversation,
        userMessage: options.message,
        agentDir,
        workingDir: options.workingDir ?? agentDir,
        harnesses,
        memory,
        idleTimeoutMs: config.harnessIdleTimeoutMs,
        hardTimeoutMs: config.harnessHardTimeoutMs,
        toolTimeoutMs: config.harnessToolTimeoutMs,
        thinkingTimeoutMs: config.harnessThinkingTimeoutMs,
        promptCache: config.promptCache,
        noHistory: !history,
        systemPromptSuffix: options.instructions,
        toolsMode: tools === "none" ? "none" : tools === "full" ? undefined : { allow: [...tools.allow] },
        mcpMode: tools === "none" ? "none" : undefined,
        trusted,
        origin: "channel",
        replyAudience: trusted ? "private" : "shared",
        retrieve: history
          ? makeRetriever(config, this.name, agentDir, conversation)
          : undefined,
        indexTurns: history
          ? makeTurnIndexer(config, this.name, conversation, memory)
          : undefined,
        pullFacts: history
          ? makeDurableFactPuller(config, this.name, conversation, memory)
          : undefined,
        extractFacts: history
          ? makeFactExtractor(config, this.name, conversation, memory, harnesses, agentDir)
          : undefined,
        screen,
        signal: controller.signal,
      });
      for await (const chunk of chunks) {
        // A held turn streams its notice as a `text` chunk before the
        // terminal `done`; to an application that is the hold notice, not
        // a reply, and the `held` event carries it. Drop the text.
        if (held && chunk.type === "text") continue;
        const event = toEngineEvent(chunk, controller.signal.aborted);
        if (event) yield event;
      }
    } finally {
      untrack();
    }
  }

  /**
   * The daemon's threat screen, with two engine-specific adjustments: a hold
   * still escalates to the owner on any channel this persona has (Telegram,
   * PhantomChat), but its diagnostics go to the engine's log rather than the
   * application's stdout/stderr; and `onHold` fires so the caller can tell a
   * hold notice from a reply.
   */
  #screener(
    config: Config,
    conversation: string,
    harnesses: Harness[],
    memory: MemoryStore,
    onHold: () => void,
  ): (content: string, signal?: AbortSignal) => Promise<ScreenVerdict> {
    const screen = makeScreener(config, this.name, conversation, harnesses, memory, {
      notify: async (message) => {
        const code = await runNotify({
          config,
          message,
          persona: this.name,
          out: logSinkWriter(),
          err: logSinkWriter(),
        });
        // Exit 2 with a non-empty message means "this persona has no owner
        // channel" — the normal shape of an embedded persona, whose
        // application learns of the hold from the `held` event instead. Not
        // a delivery failure to warn about.
        return code === 2 ? 0 : code;
      },
    });
    return async (content, signal) => {
      const verdict = await screen(content, signal);
      if (verdict.action === "hold") onHold();
      return verdict;
    };
  }

  // ── decisions ──────────────────────────────────────────────────────────

  /**
   * Ask the persona's decision model (TypeSafe Jev today, or any configured
   * decisions provider) typed questions. No harness, no
   * tools, sub-second. Rejects with `not_configured` or
   * `decision_unavailable` — never guesses an answer.
   */
  async decide(options: DecideOptions): Promise<DecisionResult> {
    if (!options || typeof options.instructions !== "string" || typeof options.state !== "string") {
      throw new EngineError("invalid_argument", "decide needs instructions and state strings");
    }
    if (!options.questions || Object.keys(options.questions).length === 0) {
      throw new EngineError("invalid_argument", "decide needs at least one question");
    }
    return this.#run(async () => {
      const config = await loadConfig(this.name);
      if (!existsSync(personaDir(config, this.name))) throw notFound(this.name);
      const dm = config.jev; // the persona's decision model ([jev] on disk)
      if (!dm?.baseUrl || !dm.apiKey) {
        throw new EngineError(
          "not_configured",
          dm
            ? "decision model has no endpoint or no API key"
            : "decision model is not configured for this persona",
        );
      }
      const decision = await decisionModelDecide({
        baseUrl: dm.baseUrl,
        apiKey: dm.apiKey,
        model: dm.model,
        instructions: options.instructions,
        state: options.state,
        questions: options.questions,
        timeoutMs: options.timeoutMs ?? DEFAULT_DECIDE_TIMEOUT_MS,
        signal: options.signal,
      });
      if (!decision.ok) {
        throw new EngineError("decision_unavailable", decision.error, {
          latencyMs: decision.latencyMs,
        });
      }
      const answers: Record<string, DecisionAnswer> = {};
      for (const [id, a] of Object.entries(decision.answers)) {
        answers[id] =
          a.type === "choice"
            ? { type: "choice", choice: a.choice, probabilities: a.probabilities, confidence: a.confidence }
            : { type: "score", score: a.score, probabilities: a.probabilities, confidence: a.confidence };
      }
      return { answers, latencyMs: decision.latencyMs };
    });
  }

  // ── internals ──────────────────────────────────────────────────────────

  /** Engine scope acting for THIS persona (see `Engine.run`). */
  #run<T>(fn: () => Promise<T>): Promise<T> {
    return this.#engine.run(fn, this.name);
  }

  #enter<T>(fn: () => T): T {
    return this.#engine.enter(fn, this.name);
  }

  #bind<T>(iterable: AsyncIterable<T>): AsyncIterableIterator<T> {
    return this.#engine.bind(iterable, this.name);
  }

  async #dir(): Promise<string> {
    const dir = personaDir(await loadConfig(this.name), this.name);
    if (!existsSync(dir)) throw notFound(this.name);
    return dir;
  }

  /** Config + harness chain, cached until `configure()` or a secret change. */
  #loadRuntime(): Promise<PersonaRuntime> {
    if (!this.#runtime) {
      this.#runtime = (async () => {
        let config = await loadConfig(this.name);
        if (!existsSync(personaDir(config, this.name))) throw notFound(this.name);
        if (harnessFactoryForTesting) {
          return { config, harnesses: harnessFactoryForTesting(config, this.name) };
        }
        const sink = logSinkWriter();
        ({ config } = await resolveHarnessBinsForConfig(config, { err: sink }));
        const harnesses = buildHarnessChain(config, sink, this.name);
        if (harnesses.length === 0) {
          throw new EngineError(
            "not_configured",
            `persona '${this.name}' has no usable harness; call configure({ brain })`,
          );
        }
        return { config, harnesses };
      })();
      this.#runtime.catch(() => {
        this.#runtime = undefined;
      });
    }
    return this.#runtime;
  }

  /** Read-only vault probe: is `key` stored? Never provisions (dir exists). */
  async #hasSecret(key: string, dir: string): Promise<boolean> {
    const vault = await openPersonaVault(dir);
    try {
      return vault.get(key) !== undefined;
    } finally {
      vault.close();
    }
  }

  /**
   * Vault write with read-back verification. Unlike the wizards'
   * `setPersonaSecret`, it does NOT mirror the value into `process.env`:
   * that would make it an ambient variable every other persona in this
   * process could read. Harnesses apply the vault to a per-spawn env copy
   * before each spawn (`harnessSpawnEnv`), so the value reaches the child
   * and nothing else.
   */
  async #setSecret(key: string, value: string): Promise<void> {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) {
      throw new EngineError("invalid_argument", "secret names are [A-Za-z_][A-Za-z0-9_]*");
    }
    if (typeof value !== "string" || value === "") {
      throw new EngineError("invalid_argument", `secret ${key} must be a non-empty string`);
    }
    const vault = await openPersonaVault(await this.#dir());
    try {
      vault.set(key, value);
      if (vault.get(key) !== value) {
        throw new EngineError("write_failed", `vault read-back mismatch for ${key}`);
      }
    } finally {
      vault.close();
    }
    this.#runtime = undefined;
  }

  async #search(query: string, options: MemorySearchOptions): Promise<MemoryHit[]> {
    if (typeof query !== "string" || query.trim() === "") {
      throw new EngineError("invalid_argument", "query must be a non-empty string");
    }
    return this.#run(async () => {
      const config = await loadConfig(this.name);
      const out = new StringSink();
      const err = new StringSink();
      const code = await runMemorySearch({
        config,
        persona: this.name,
        query,
        limit: options.limit,
        scope: options.scope,
        out,
        err,
      });
      if (code === 2) throw notFound(this.name);
      if (code !== 0) {
        throw new EngineError("invalid_argument", err.text.trim() || `memory search failed (${code})`);
      }
      const parsed = JSON.parse(out.text) as { results: Array<Record<string, unknown>> };
      return parsed.results.map((hit) => ({
        path: String(hit.path),
        scope: hit.scope as MemoryHit["scope"],
        ...(typeof hit.ftsScore === "number" ? { ftsScore: hit.ftsScore } : {}),
        ...(typeof hit.vecScore === "number" ? { vecScore: hit.vecScore } : {}),
        ...(typeof hit.rrfScore === "number" ? { rrfScore: hit.rrfScore } : {}),
        ...(hit.expanded === true ? { expanded: true } : {}),
        ...(typeof hit.snippet === "string" ? { snippet: hit.snippet } : {}),
      }));
    });
  }

  async #capture(
    text: string,
    options: { tags?: string[]; conversation?: string },
  ): Promise<void> {
    if (typeof text !== "string" || text.trim() === "") {
      throw new EngineError("invalid_argument", "text must be a non-empty string");
    }
    const tags = options.tags ?? [];
    if (tags.some((t) => !/^[a-z]+$/.test(t))) {
      throw new EngineError("invalid_argument", "tags are lowercase words, e.g. 'decision'");
    }
    return this.#run(async () => {
      const config = await loadConfig(this.name);
      const err = new StringSink();
      const code = await runMemoryCapture({
        config,
        persona: this.name,
        text,
        tags,
        conversation: CONVERSATION_PREFIX + (options.conversation ?? "default"),
        out: new StringSink(),
        err,
      });
      if (code === 2) throw notFound(this.name);
      if (code !== 0) {
        throw new EngineError("write_failed", err.text.trim() || `memory capture failed (${code})`);
      }
    });
  }
}

// ─── TurnStream ───────────────────────────────────────────────────────────

class TurnStreamImpl implements TurnStream {
  #events: AsyncIterableIterator<EngineEvent>;
  #conversation: string;
  #controller: AbortController;
  #abort: () => void;
  #consumed = false;
  #settle!: { resolve: (r: TurnResult) => void; reject: (e: EngineError) => void };
  #result: Promise<TurnResult>;

  constructor(
    events: AsyncIterableIterator<EngineEvent>,
    conversation: string,
    controller: AbortController,
    abort: () => void,
  ) {
    this.#events = events;
    this.#conversation = conversation;
    this.#controller = controller;
    this.#abort = abort;
    this.#result = new Promise<TurnResult>((resolve, reject) => {
      this.#settle = { resolve, reject };
    });
    // Observed here so a caller that only iterates never sees an unhandled
    // rejection; result() still hands out the real promise.
    this.#result.catch(() => {});
  }

  cancel(): void {
    this.#abort();
  }

  result(): Promise<TurnResult> {
    if (!this.#consumed) {
      void (async () => {
        for await (const _ of this) {
          // drain
        }
      })().catch(() => {});
    }
    return this.#result;
  }

  [Symbol.asyncIterator](): AsyncIterator<EngineEvent> {
    if (this.#consumed) {
      throw new EngineError("invalid_argument", "a turn stream can be consumed once");
    }
    this.#consumed = true;
    return this.#iterate();
  }

  async *#iterate(): AsyncGenerator<EngineEvent> {
    let outcome: { ok: true; result: TurnResult } | { ok: false; error: EngineError } | undefined;
    try {
      for await (const event of this.#events) {
        if (!outcome) {
          if (event.type === "done") {
            outcome = { ok: true, result: { text: event.text, held: false, conversation: this.#conversation } };
          } else if (event.type === "held") {
            outcome = { ok: true, result: { text: event.message, held: true, conversation: this.#conversation } };
          } else if (event.type === "error") {
            outcome = { ok: false, error: new EngineError(event.code, event.message) };
          }
        }
        yield event;
      }
    } catch (e) {
      const error = asEngineError(e, "harness_failed");
      outcome ??= { ok: false, error };
      throw error;
    } finally {
      // Early exit by the consumer (break/return) is a cancellation: stop the
      // harness rather than let it run on unobserved.
      if (!outcome) {
        this.#abort();
        await this.#events.return?.().catch(() => {});
      }
      if (!outcome) {
        outcome = {
          ok: false,
          error: this.#controller.signal.aborted
            ? new EngineError("cancelled", "turn cancelled")
            : new EngineError("harness_failed", "the harness chain produced no reply"),
        };
      }
      if (outcome.ok) this.#settle.resolve(outcome.result);
      else this.#settle.reject(outcome.error);
    }
  }
}

// ─── helpers ──────────────────────────────────────────────────────────────

class StringSink implements WriteSink {
  text = "";
  write(chunk: string | Uint8Array): boolean {
    this.text += typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk);
    return true;
  }
}

/**
 * Human-facing diagnostics that internals write to an `err` stream (harness
 * discovery, chain building), routed into the engine's structured log
 * instead of the application's stderr.
 */
function logSinkWriter(): WriteSink {
  return {
    write(chunk) {
      const text = (typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk)).trim();
      if (text) log.info("engine: diagnostic", { text });
      return true;
    },
  };
}

function validateTurnOptions(options: TurnOptions): void {
  if (!options || typeof options.message !== "string" || options.message.trim() === "") {
    throw new EngineError("invalid_argument", "message must be a non-empty string");
  }
  if (options.source !== "untrusted" && options.source !== "principal") {
    throw new EngineError(
      "invalid_argument",
      "source is required: 'untrusted' (screened) or 'principal' (the owner, from your own code)",
    );
  }
  if (options.conversation !== undefined) {
    const c = options.conversation;
    if (typeof c !== "string" || c === "" || c.length > MAX_CONVERSATION_KEY || /[\s\0]/.test(c)) {
      throw new EngineError(
        "invalid_argument",
        `conversation must be 1-${MAX_CONVERSATION_KEY} characters without whitespace`,
      );
    }
  }
  const tools = options.tools;
  if (
    tools !== undefined &&
    tools !== "none" &&
    tools !== "full" &&
    !(typeof tools === "object" && Array.isArray(tools.allow))
  ) {
    throw new EngineError("invalid_argument", "tools must be 'none', 'full' or { allow: string[] }");
  }
  if (options.workingDir !== undefined && !isAbsolute(options.workingDir)) {
    throw new EngineError("invalid_argument", "workingDir must be an absolute path");
  }
}

function notFound(name: string): EngineError {
  return new EngineError("persona_not_found", `persona '${name}' does not exist`, { name });
}

function asEngineError(e: unknown, fallback: EngineError["code"]): EngineError {
  if (e instanceof EngineError) return e;
  return new EngineError(fallback, e instanceof Error ? e.message : String(e));
}

async function readTomlTable(path: string): Promise<Record<string, unknown>> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch {
    return {};
  }
  try {
    return parseToml(text) as Record<string, unknown>;
  } catch (e) {
    throw new EngineError("write_failed", `cannot parse ${path}: ${(e as Error).message}`);
  }
}

function table(parent: Record<string, unknown>, key: string): Record<string, unknown> {
  const existing = parent[key];
  if (existing && typeof existing === "object" && !Array.isArray(existing)) {
    return existing as Record<string, unknown>;
  }
  const created: Record<string, unknown> = {};
  parent[key] = created;
  return created;
}

/** undefined keeps the stored value, "" clears it, anything else sets it. */
function setOrDelete(t: Record<string, unknown>, key: string, value: string | undefined): void {
  if (value === undefined) return;
  if (value === "") delete t[key];
  else t[key] = value;
}

function asStr(v: unknown): string | undefined {
  return typeof v === "string" && v.trim() !== "" ? v : undefined;
}

function positiveInt(v: number, name: string): number {
  if (!Number.isInteger(v) || v <= 0) {
    throw new EngineError("invalid_argument", `${name} must be a positive integer`);
  }
  return v;
}
