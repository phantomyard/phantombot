/**
 * Phantombot provider package for OpenCode.
 *
 * OpenCode v2 loads a provider from a package specifier; this module is the one
 * `phantombot acp install opencode` points it at. It spawns `phantombot acp` as
 * a CHILD PROCESS and speaks the Agent Client Protocol over its stdin/stdout —
 * exactly what Zed already does — so the integration needs no daemon, no port,
 * no token and no network stack, and it keeps working while the Phantombot
 * service is down.
 *
 * ## Why the module looks like THIS (read before "simplifying" it)
 *
 * The obvious shape — export `model(modelID, settings)` returning OpenCode's own
 * `LanguageModel` — does not work, and fails in a way that looks like a bug in
 * this file. `Provider.importPackage` (packages/core/src/provider.ts, v2.2.0)
 * requires that export, but the value is then checked with
 * `LanguageModelSchema`, which is `Schema.declare(value => value instanceof
 * LanguageModel)` — an *identity* check against a class that lives inside
 * OpenCode's binary. An external `file://` module cannot import `@opencode/ai`
 * (verified: every such specifier fails to resolve), so it can never satisfy
 * that check. The first attempted install therefore always died with
 * "Schema validation failed".
 *
 * The seam that DOES work is OpenCode's AI-SDK route: a provider whose
 * `package` starts with `aisdk:` is loaded by the built-in
 * `opencode.provider.dynamic` plugin, which
 *
 *   1. imports the module,
 *   2. finds the FIRST export whose name starts with `create`,
 *   3. calls it with the provider's flattened `settings` and expects an object
 *      exposing `languageModel(modelID)`,
 *   4. uses the returned model through the AI SDK `LanguageModelV3` contract —
 *      a plain object, duck-typed, no class identity.
 *
 * That is why this file exports exactly ONE `create*` symbol and returns AI SDK
 * models rather than OpenCode ones.
 *
 * ## The ACP conversation model
 *
 * OpenCode replays the whole transcript on every request and knows nothing about
 * Phantombot's server-side memory, so this module:
 *
 *   - sends only the turns Phantombot has NOT seen (prefix-matched against what
 *     this instance already sent), never the full transcript;
 *   - keeps ONE ACP session per OpenCode conversation, and starts a new one when
 *     the incoming transcript does not extend a known conversation (a fork or a
 *     fresh chat that happens to share an opening line);
 *   - answers OpenCode's session-title requests locally. OpenCode asks the same
 *     model to name the conversation with the conversation's first user message
 *     as its prompt; sending that to Phantombot would burn a real turn, write a
 *     bogus memory row, and — because its prompt is a prefix of the real first
 *     turn — corrupt the conversation matching below.
 *
 * Zero dependencies beyond `node:` builtins: no npm install, no build step at
 * install time, nothing for a user to keep in sync.
 */

import { spawn } from "node:child_process";

/** Binary spawned when the install did not bake an absolute path in. */
const DEFAULT_COMMAND = "phantombot";

/** A Phantombot turn can legitimately run for many minutes; only bound the setup. */
const INIT_TIMEOUT_MS = 60_000;
const PROMPT_TIMEOUT_MS = 6 * 60 * 60 * 1000;

/** How long an aborted ACP session gets to acknowledge `session/cancel`. */
const CANCEL_GRACE_MS = 2_000;

/** Per-instance conversation registry cap — same spirit as the gateway's scan limit. */
const MAX_CONVERSATIONS = 200;

/** Runtime caches, keyed by spawn identity + persona (OpenCode calls `create*` per model). */
const runtimes = new Map();

/** Sentinel used by `finish` parts. */
const STOP = {
  end_turn: "stop",
  max_tokens: "length",
  refusal: "content-filter",
  cancelled: "other",
};

// ── ACP transport ────────────────────────────────────────────────────────

/**
 * One `phantombot acp` child process and the newline-delimited JSON-RPC
 * connection to it. Nothing is spawned until the first request, because
 * OpenCode calls `languageModel()` more than once per model and the child must
 * never be created as a side effect of that.
 */
class AcpConnection {
  constructor({ command, args, cwd }) {
    this.command = command;
    this.args = args;
    this.stderr = "";
    this.nextId = 1;
    this.pending = new Map();
    this.buffer = "";
    this.closed = false;
    this.closing = null;
    this.failure = null;
    this.onNotification = () => {};

    this.child = spawn(command, args, {
      cwd,
      stdio: ["pipe", "pipe", "pipe"],
      env: process.env,
    });

    this.child.stdout.setEncoding("utf8");
    this.child.stdout.on("data", (chunk) => this.consume(chunk));
    this.child.stderr.setEncoding("utf8");
    this.child.stderr.on("data", (chunk) => {
      this.stderr = (this.stderr + chunk).slice(-4000);
    });
    // `spawn` and `error` are mutually exclusive and both asynchronous. Requests
    // wait on this promise so a missing binary reports ENOENT with the fix in it,
    // instead of racing ahead and failing with a generic "not running".
    this.spawned = new Promise((resolve, reject) => {
      this.child.once("spawn", () => resolve());
      this.child.once("error", (error) => {
        this.failure = friendlySpawnError(error, command);
        reject(this.failure);
      });
    });
    // Nobody may await it (a fire-and-forget close path); keep the rejection handled.
    this.spawned.catch(() => {});
    this.child.on("exit", (code, signal) => {
      const detail = this.stderr.trim();
      this.fail(
        new Error(
          `phantombot acp exited (${signal ? `signal ${signal}` : `code ${code}`})` +
            (detail ? `: ${detail}` : "") +
            hintForCode(code, signal),
        ),
      );
    });
  }

  consume(chunk) {
    this.buffer += chunk;
    let index;
    while ((index = this.buffer.indexOf("\n")) >= 0) {
      const line = this.buffer.slice(0, index).trim();
      this.buffer = this.buffer.slice(index + 1);
      if (!line) continue;
      let message;
      try {
        message = JSON.parse(line);
      } catch {
        continue; // stdout is the protocol channel; ignore anything non-JSON.
      }
      if (message && typeof message === "object" && "id" in message && message.id !== null) {
        const waiting = this.pending.get(message.id);
        if (!waiting) continue;
        this.pending.delete(message.id);
        if (waiting.timer) clearTimeout(waiting.timer);
        if (message.error) {
          waiting.reject(new Error(message.error.message ?? "ACP request failed"));
        } else {
          waiting.resolve(message.result);
        }
        continue;
      }
      this.onNotification(message);
    }
  }

  write(message) {
    if (this.closed || !this.child.stdin.writable) {
      throw this.failure ?? new Error("phantombot acp is not running");
    }
    this.child.stdin.write(`${JSON.stringify(message)}\n`);
  }

  async request(method, params, timeoutMs = INIT_TIMEOUT_MS) {
    await this.spawned;
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      if (this.closed) {
        reject(this.failure ?? new Error("phantombot acp is not running"));
        return;
      }
      const timer =
        timeoutMs > 0
          ? setTimeout(() => {
              this.pending.delete(id);
              reject(new Error(`phantombot acp did not answer ${method} within ${timeoutMs}ms`));
            }, timeoutMs)
          : undefined;
      this.pending.set(id, { resolve, reject, timer });
      try {
        this.write({ jsonrpc: "2.0", id, method, params });
      } catch (error) {
        this.pending.delete(id);
        if (timer) clearTimeout(timer);
        reject(error);
      }
    });
  }

  notify(method, params) {
    try {
      this.write({ jsonrpc: "2.0", method, params });
    } catch {
      // Nothing to tell a dead child.
    }
  }

  fail(error) {
    if (this.closed) return;
    this.closed = true;
    this.failure = this.failure ?? error;
    for (const [, waiting] of this.pending) {
      if (waiting.timer) clearTimeout(waiting.timer);
      waiting.reject(error);
    }
    this.pending.clear();
  }

  /** Tear the child down. Idempotent. */
  close() {
    if (this.closing) return this.closing;
    this.closed = true;
    for (const [, waiting] of this.pending) {
      if (waiting.timer) clearTimeout(waiting.timer);
      waiting.reject(new Error("phantombot acp was closed"));
    }
    this.pending.clear();
    this.closing = new Promise((resolve) => {
      if (this.child.exitCode !== null || this.child.signalCode !== null) {
        resolve();
        return;
      }
      this.child.once("exit", () => resolve());
      try {
        this.child.stdin.end();
      } catch {
        // already gone
      }
      this.child.kill();
      setTimeout(resolve, 1_000).unref?.();
    });
    return this.closing;
  }
}

function friendlySpawnError(error, command) {
  if (error && error.code === "ENOENT") {
    return new Error(
      `cannot find the phantombot binary at "${command}". Run \`phantombot acp install opencode\` again (it bakes the absolute path in), or set providers.phantombot.settings.command in your OpenCode config.`,
    );
  }
  if (error && error.code === "EACCES") {
    return new Error(`phantombot binary "${command}" is not executable.`);
  }
  return error instanceof Error ? error : new Error(String(error));
}

function hintForCode(code, signal) {
  if (signal) return " — killed before the turn finished.";
  if (code === 0) return " — it exited cleanly, so the turn could not complete.";
  return "";
}

// ── prompt handling ──────────────────────────────────────────────────────

const SYSTEM_REMINDER = /<system-reminder>[\s\S]*?<\/system-reminder>/g;

/** Flatten AI SDK prompt content into plain text. */
function textOf(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((part) => part && part.type === "text" && typeof part.text === "string")
    .map((part) => part.text)
    .join("\n");
}

/**
 * Split the incoming request into system text and the ordered user turns.
 * System-reminders are stripped: Phantombot's own harness already supplies its
 * context, and OpenCode's reminders change between retries of the same turn,
 * which would defeat the prefix matching below.
 */
function readPrompt(prompt) {
  const system = [];
  const turns = [];
  for (const message of Array.isArray(prompt) ? prompt : []) {
    if (!message || typeof message !== "object") continue;
    if (message.role === "system") {
      system.push(textOf(message.content));
      continue;
    }
    if (message.role !== "user") continue;
    const text = textOf(message.content).replace(SYSTEM_REMINDER, "").trim();
    if (text) turns.push(text);
  }
  return { system: system.join("\n\n"), turns };
}

/**
 * OpenCode names each new conversation by asking the SAME model with a fixed
 * instruction and the first user message. Recognising it lets us answer locally
 * instead of spending a Phantombot turn (and polluting its memory) on a title.
 * If upstream rewords the instruction this check simply stops matching and the
 * request falls through to Phantombot — the old, correct-but-costly behaviour.
 */
function isTitleRequest(system, turns) {
  return turns.length === 1 && /name conversations/i.test(system) && /list of past sessions/i.test(system);
}

function localTitle(turns) {
  const words = turns[0].replace(/\s+/g, " ").trim().split(" ").slice(0, 6).join(" ");
  const title = words.replace(/[.,;:!?]+$/, "").slice(0, 60);
  return title || "New session";
}

// ── conversation matching ────────────────────────────────────────────────

function isPrefix(prefix, full) {
  if (prefix.length > full.length) return false;
  return prefix.every((text, index) => text === full[index]);
}

/**
 * Find the conversation this transcript extends.
 *
 * Longest-prefix wins, so a transcript that diverges from a known conversation
 * (an edited or branched message) does NOT silently resume it — the caller
 * starts a new session instead. Identical openings stay ambiguous, which is
 * exactly why the whole transcript is compared and not just the first message.
 */
function matchConversation(registry, turns) {
  let best;
  for (const entry of registry.values()) {
    if (!isPrefix(entry.turns, turns)) continue;
    if (!best || entry.turns.length > best.turns.length) best = entry;
  }
  return best;
}

// ── runtime ──────────────────────────────────────────────────────────────

function createRuntime({ command, baseArgs, cwd, persona }) {
  const runtime = {
    command,
    baseArgs,
    cwd,
    persona,
    connection: null,
    initialized: null,
    conversations: new Map(),
    queue: Promise.resolve(),
    active: null,
  };
  return runtime;
}

async function ensureConnection(runtime) {
  if (runtime.connection && !runtime.connection.closed) {
    await runtime.initialized;
    return runtime.connection;
  }
  const args = runtime.baseArgs ?? ["acp", "--persona", runtime.persona];
  const connection = new AcpConnection({ command: runtime.command, args, cwd: runtime.cwd });
  connection.onNotification = (message) => {
    if (!message || message.method !== "session/update") return;
    const active = runtime.active;
    if (!active || !message.params) return;
    if (message.params.sessionId && message.params.sessionId !== active.sessionId) return;
    const update = message.params.update;
    if (!update) return;
    if (update.sessionUpdate === "agent_message_chunk" && update.content?.type === "text") {
      active.text(update.content.text);
    } else if (update.sessionUpdate === "agent_thought_chunk" && update.content?.type === "text") {
      active.reasoning(update.content.text);
    }
    // `tool_call` and `available_commands_update` are presentational. Emitting a
    // tool_call would make OpenCode try to execute a tool Phantombot already
    // ran itself, so they are deliberately dropped.
  };
  runtime.connection = connection;
  runtime.initialized = (async () => {
    await connection.request("initialize", {
      protocolVersion: 1,
      clientCapabilities: { fs: { readTextFile: false, writeTextFile: false } },
    });
    await connection.request("authenticate", { methodId: "none" }).catch(() => {
      // authMethods is empty on the Phantombot side; a rejection here is benign.
    });
  })().catch((error) => {
    runtime.connection = null;
    runtime.initialized = null;
    void connection.close();
    throw error;
  });
  await runtime.initialized;
  return connection;
}

/** Serialize turns on this runtime: one ACP prompt in flight per child. */
function serialized(runtime, work) {
  const run = runtime.queue.then(work, work);
  runtime.queue = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

/** Resolve (or create) the ACP session for this transcript, and the text to send. */
async function prepareTurn(runtime, connection, turns) {
  const known = matchConversation(runtime.conversations, turns);
  if (known && known.sessionId) {
    const pending = turns.slice(known.turns.length);
    known.turns = turns.slice();
    known.touched = Date.now();
    // A retry of the very same turn replays nothing new; answer it again rather
    // than returning an empty turn.
    return { sessionId: known.sessionId, send: pending.length > 0 ? pending : [turns[turns.length - 1]] };
  }

  const created = await connection.request("session/new", { cwd: runtime.cwd ?? process.cwd(), mcpServers: [] });
  const sessionId = created?.sessionId;
  if (typeof sessionId !== "string") throw new Error("phantombot acp did not return a session id");
  const entry = { sessionId, turns: turns.slice(), touched: Date.now() };
  runtime.conversations.set(sessionId, entry);
  evictConversations(runtime);
  // A brand-new ACP session has no history in Phantombot, so it gets the newest
  // turn only. Anything older is unrecoverable context (a fork, or a session
  // that predates this process) — sending the tail is the honest option.
  return { sessionId, send: [turns[turns.length - 1]] };
}

function evictConversations(runtime) {
  if (runtime.conversations.size <= MAX_CONVERSATIONS) return;
  const oldest = [...runtime.conversations.entries()].sort((a, b) => a[1].touched - b[1].touched).slice(0, 32);
  for (const [key] of oldest) runtime.conversations.delete(key);
}

/**
 * Run one turn and drive the AI SDK stream. Resolves once the stream is closed,
 * whether it ended, failed or was cancelled.
 */
async function runTurn(runtime, { turns, controller, abortSignal }) {
  let textId = 0;
  let lastTextId = null;
  let reasoningId = 0;
  let lastReasoningId = null;
  let closed = false;

  const emit = (part) => {
    if (closed) return;
    try {
      controller.enqueue(part);
    } catch {
      closed = true;
    }
  };
  const close = (part) => {
    if (closed) return;
    if (part) {
      try {
        controller.enqueue(part);
      } catch {
        // client went away
      }
    }
    closed = true;
    try {
      controller.close();
    } catch {
      // already closed
    }
  };
  const fail = (error) => {
    close({ type: "error", error: error instanceof Error ? error : new Error(String(error)) });
  };

  try {
    const connection = await ensureConnection(runtime);
    const { sessionId, send } = await prepareTurn(runtime, connection, turns);

    emit({ type: "stream-start", warnings: [] });

    let finish;
    runtime.active = {
      sessionId,
      text(delta) {
        if (!lastTextId) {
          lastTextId = `text-${textId++}`;
          emit({ type: "text-start", id: lastTextId });
        }
        emit({ type: "text-delta", id: lastTextId, delta });
      },
      reasoning(delta) {
        if (!lastReasoningId) {
          lastReasoningId = `reasoning-${reasoningId++}`;
          emit({ type: "reasoning-start", id: lastReasoningId });
        }
        emit({ type: "reasoning-delta", id: lastReasoningId, delta });
      },
    };

    const onAbort = () => {
      connection.notify("session/cancel", { sessionId });
      setTimeout(() => {
        // The agent ignored the cancel: kill the child so it stops burning
        // provider tokens with nobody reading its stream.
        if (finish === undefined) void connection.close();
      }, CANCEL_GRACE_MS);
    };
    if (abortSignal) {
      if (abortSignal.aborted) onAbort();
      else abortSignal.addEventListener("abort", onAbort, { once: true });
    }

    const result = await connection.request(
      "session/prompt",
      { sessionId, prompt: send.map((text) => ({ type: "text", text })) },
      PROMPT_TIMEOUT_MS,
    );
    finish = result?.stopReason ?? "end_turn";

    if (abortSignal) abortSignal.removeEventListener("abort", onAbort);
    runtime.active = null;

    if (lastReasoningId) {
      emit({ type: "reasoning-end", id: lastReasoningId });
      lastReasoningId = null;
    }
    if (lastTextId) {
      emit({ type: "text-end", id: lastTextId });
      lastTextId = null;
    }
    close({
      type: "finish",
      finishReason: { unified: STOP[finish] ?? "other", raw: finish },
      // ACP carries no token accounting; reporting zeros is honest, and the
      // dashboard shows usage only when a provider supplies it.
      usage: { inputTokens: { total: 0 }, outputTokens: { total: 0 } },
    });
  } catch (error) {
    if (lastTextId) emit({ type: "text-end", id: lastTextId });
    if (lastReasoningId) emit({ type: "reasoning-end", id: lastReasoningId });
    runtime.active = null;
    fail(error);
  }
}

function textOnlyStream(text) {
  return new ReadableStream({
    start(controller) {
      controller.enqueue({ type: "stream-start", warnings: [] });
      controller.enqueue({ type: "text-start", id: "text-0" });
      controller.enqueue({ type: "text-delta", id: "text-0", delta: text });
      controller.enqueue({ type: "text-end", id: "text-0" });
      controller.enqueue({
        type: "finish",
        finishReason: { unified: "stop", raw: "stop" },
        usage: { inputTokens: { total: 0 }, outputTokens: { total: 0 } },
      });
      controller.close();
    },
  });
}

// ── provider factory (the export OpenCode looks for) ─────────────────────

/**
 * Provider factory. OpenCode's `opencode.provider.dynamic` plugin imports this
 * module, picks the first export whose name starts with `create`, and calls it
 * with the flattened provider `settings`.
 *
 * Recognised settings (everything else is ignored):
 *   - `command` — absolute path to the phantombot binary (the installer bakes
 *     this in; PATH lookup is unreliable for GUI-launched editors).
 *   - `args`    — full argv override. Default: `["acp", "--persona", <modelID>]`.
 *   - `cwd`     — working directory for the child. Default: the editor's cwd.
 */
export function createPhantombot(settings = {}) {
  const command = typeof settings.command === "string" && settings.command.trim() ? settings.command.trim() : DEFAULT_COMMAND;
  const baseArgs = Array.isArray(settings.args) ? settings.args.map(String) : undefined;
  const cwd = typeof settings.cwd === "string" && settings.cwd.trim() ? settings.cwd.trim() : undefined;

  function languageModel(modelId) {
    const persona = modelId;
    const key = [command, JSON.stringify(baseArgs ?? null), cwd ?? "", persona].join("\u0000");
    let runtime = runtimes.get(key);
    if (!runtime) {
      runtime = createRuntime({ command, baseArgs, cwd, persona });
      runtimes.set(key, runtime);
    }
    const bound = runtime;

    return {
      specificationVersion: "v3",
      provider: "phantombot",
      modelId,
      supportedUrls: {},

      async doGenerate(options) {
        const { stream } = await this.doStream(options);
        const reader = stream.getReader();
        let text = "";
        let reasoning = "";
        let finishReason = { unified: "other", raw: undefined };
        try {
          for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            if (value.type === "text-delta") text += value.delta;
            else if (value.type === "reasoning-delta") reasoning += value.delta;
            else if (value.type === "finish") finishReason = value.finishReason;
            else if (value.type === "error") throw value.error;
          }
        } finally {
          reader.releaseLock();
        }
        const content = [];
        if (reasoning) content.push({ type: "reasoning", text: reasoning });
        if (text) content.push({ type: "text", text });
        return { content, finishReason, usage: { inputTokens: { total: 0 }, outputTokens: { total: 0 } }, warnings: [] };
      },

      async doStream(options) {
        const { system, turns } = readPrompt(options?.prompt);
        if (turns.length === 0) {
          return { stream: textOnlyStream("") };
        }
        if (isTitleRequest(system, turns)) {
          return { stream: textOnlyStream(localTitle(turns)) };
        }
        const abortSignal = options?.abortSignal;
        const stream = new ReadableStream({
          start(controller) {
            void serialized(bound, () => runTurn(bound, { turns, controller, abortSignal }));
          },
          cancel() {
            const sessionId = bound.active?.sessionId;
            if (sessionId) bound.connection?.notify("session/cancel", { sessionId });
          },
        });
        return { stream };
      },
    };
  }

  return { languageModel };
}
