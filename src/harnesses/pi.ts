/**
 * Pi harness (https://pi.dev — Pi Coding Agent from Earendil Works).
 *
 * Spawns `pi --print --mode json` with the system prompt and the full rendered
 * payload (history + new message) ALWAYS spilled to temp files: the system
 * prompt via `--system-prompt <file>` and the payload via an `@<file>`
 * positional. Pi ignores stdin in --print mode, so the payload would otherwise
 * travel on argv — and as the LAST harness in the chain, pi is the transparent
 * fallback that must swallow WHATEVER context the primary was chewing when it
 * failed (a rate-limited claude turn is tens of KB). Routing that through temp
 * files removes every argv-length ceiling (Linux ARG_MAX, Windows' ~8,191-char
 * command line) so there is no payload size at which pi is skipped or errors.
 * There is deliberately NO maxPayloadBytes: the fallback never refuses a turn.
 *
 * Stream-json events translated to phantombot HarnessChunks:
 *   message_update with text_delta  → { type: "text", text }
 *   tool_execution_start            → { type: "progress", note: "tool: <name>" }
 *   turn_end                        → { type: "done" } COMPLETION marker: the
 *     model finished this turn. The shared engine requires it before it will
 *     synthesize the terminal `done` on exit 0, so an exit-0 that stopped
 *     mid-task (only tool narration, no turn_end) falls through to the next
 *     harness instead of being stored as a finished answer (issue #352).
 *   anything else (agent_start, agent_end, agent_settled,
 *     tool_execution_end, extension_*) → ignored
 *
 * Auth (per-turn, via env): when PHANTOMBOT_PI_API_KEY is set, phantombot
 * relays the key to the child through the provider's NATIVE env var (e.g.
 * OPENROUTER_API_KEY — resolved via PI_PROVIDER_CATALOG), never onto the
 * command line: /proc/<pid>/cmdline is world-readable while environ is 0400
 * (issue #602). It is still never persisted into Pi's own auth store. When
 * the key is UNSET, phantombot actively clears the native var and Pi falls
 * back to its own env / local store settings, so an "install later, no key"
 * or legacy install keeps working. A provider missing from the catalog has
 * no known native var — the key falls back to `--api-key` argv there (rare,
 * live-only providers), with a logged warning.
 * `phantombot doctor` surfaces failure if neither path yields credentials.
 *
 * Provider: the configured routing provider is threaded onto `--provider` every
 * turn. This is REQUIRED for a non-google key to work — Pi's `--provider`
 * defaults to google, so an OpenRouter key with no `--provider openrouter` is
 * sent to the wrong endpoint and fails. The wizard scopes all routed models to
 * one provider, so a single `--provider` is correct even after a coding swap.
 */

import { access, constants } from "node:fs/promises";
import type {
  Harness,
  HarnessChunk,
  HarnessModelInfo,
  HarnessRequest,
} from "./types.ts";
import {
  ENV_PHANTOMBOT_TMP_DIR,
  ENV_PI_API_KEY,
  ENV_PI_KEY_ENV,
  ENV_PI_PROVIDER,
  ENV_ROUTING_JSON,
  type PiRoutingConfig,
} from "../lib/piRouting.ts";
import { PI_PROVIDER_CATALOG } from "../lib/piModels.ts";
import type { ParseEventResult } from "./reasoningReplay.ts";
import { CODER_SWAP_MAX_ATTEMPTS, getCoderSwapOverride, resolveSwapModel, type SwapDecision } from "../lib/coderSwap.ts";
import { decisionModelRoute } from "../lib/decisionModelRouter.ts";
import { recordDecisionModelOutcome } from "../lib/decisionModelHealth.ts";
import { classifyFailure } from "../lib/harnessAlert.ts";
import { buildToolCall, type ToolCallDetail } from "./toolNote.ts";
import { withPersonaEnv } from "../lib/envBootstrap.ts";
import { reloadVaultForPersona } from "../lib/vault.ts";
import {
  type HarnessActivity,
  isHardCapError,
  runHarnessProcess,
} from "../lib/harnessRunner.ts";
import { log } from "../lib/logger.ts";
import { spawnInNewSession } from "../lib/processGroup.ts";
import { createHarnessTempDir } from "../lib/harnessArgvFiles.ts";
import { renderConversationPayload } from "./payload.ts";
import {
  DEFAULT_REASONING_REPLAY,
  type ReasoningReplayConfig,
} from "./reasoningReplay.ts";
import { xdgDataHome } from "../config.ts";
import {
  embeddedPiChildEnv,
  embeddedPiCommand,
  ENV_PHANTOMBOT_PI_COMMAND,
} from "../lib/embeddedPi.ts";
import { nativeAgentDir, nativeAgentEnv } from "../lib/nativeAgentDir.ts";
import { removePiApiKey } from "../lib/piAuthStore.ts";
import type { WriteSink } from "../lib/io.ts";

export const EXPECTED_PI_HEAP_MB = 2_048;

export interface PiHarnessConfig {
  /**
   * Path to the host `pi` CLI binary (`pi-host` mode). Ignored in native mode,
   * which always spawns the pi engine embedded in this binary.
   */
  bin: string;
  /**
   * Which pi engine this slot runs on:
   *   native — the engine EMBEDDED in the phantombot binary, with phantombot's
   *            routing (provider, models, api key) threaded onto every turn.
   *            The only mode that loads the Phantomyard's Phantombot
   *            attribution extension.
   *   host   — the host's own `pi` (`pi-host`), configured by its owner.
   *            Phantombot passes no --provider/--model/--api-key and no
   *            delegate routing, exactly as it passes none to claude or codex.
   * Default: host — the shape every pre-native caller constructed.
   */
  mode?: "native" | "host";
  /**
   * Native mode only: override the embedded-pi argv prefix. A TEST SEAM (point
   * it at a fake pi script); production always uses embeddedPiCommand().
   */
  command?: string[];
  /**
   * Resolved capability routing (env-over-TOML, from config.ts). When present
   * it does ONE runtime thing in this harness:
   *   1. `primaryModel` pins the orchestrator model via `--model` on the Pi
   *      CLI — without this the saved primary is never honored, Pi just uses
   *      its own default.
   * The DELEGATE models (image/coding) do NOT travel via the child env anymore.
   * They reach the bundled extension through the managed `routing.json` that
   * phantombot stamps into ~/.pi/agent/extensions/capability-routing/ on
   * startup (see lib/piExtensionProvision.ts). That makes a TOML-only install
   * fully self-provisioning — no env projection, no manual symlink.
   * Absent = no per-capability routing (Pi uses its configured default model).
   */
  routing?: PiRoutingConfig;
  /** Runtime identity and vault key for a named Pi instance. */
  id?: string;
  apiKeyEnv?: string;
  /**
   * The optional Jev brain-swap router (issue #597). Present only when the
   * operator configured [jev] and enabled the ROUTER consumer. The API key
   * is NOT carried here — it is read per-turn from `process.env[keyEnv]`
   * after the persona's vault is reconciled, the same contract as the Pi
   * API key. An enabled router DECIDES — the keyword scorer is the fallback
   * on any error, and there is no log-only mode (see DecisionModelConsumerSettings).
   */
  decisionModelRouter?: {
    baseUrl: string;
    model: string;
    keyEnv: string;
    timeoutMs: number;
    /** Personas root, for the fallback telemetry `doctor` reports. */
    personasDir?: string;
  };
  /** Explicit V8 old-space ceiling; never inferred from host memory. */
  maxOldSpaceMb?: number;
  /**
   * Narration-decay replay config (issue #551). Omitted = defaults
   * (DEFAULT_REASONING_REPLAY); tests pass short windows. Present = on.
   */
  reasoningReplay?: Partial<ReasoningReplayConfig>;
}

export class PiHarness implements Harness {
  readonly id: string;

  constructor(private readonly config: PiHarnessConfig) {
    this.id = config.id ?? (config.mode === "native" ? "native" : "pi-host");
  }

  /** Routing applies to native mode only; a host pi decides for itself. */
  private routing(): PiRoutingConfig | undefined {
    return this.config.mode === "native" ? this.config.routing : undefined;
  }

  /** The argv prefix to spawn: the embedded engine, or the host binary. */
  private command(): string[] {
    return this.config.mode === "native"
      ? (this.config.command ?? embeddedPiCommand())
      : [this.config.bin];
  }

  modelInfo(): HarnessModelInfo {
    if (this.config.mode !== "native") {
      return { model: "(host pi configuration)" };
    }
    const r = this.routing();
    return {
      model: r?.primaryModel ?? "(pi default)",
      provider: r?.provider,
      codingModel: r?.codingModel,
      imageModel: r?.imageModel,
    };
  }

  async available(): Promise<boolean> {
    // The embedded engine ships inside this binary — it cannot be missing.
    if (this.config.mode === "native") return true;
    try {
      if (this.config.bin.startsWith("/")) {
        await access(this.config.bin, constants.X_OK);
      }
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Startup diagnostic for host Pi. Native Pi runs inside phantombot's Bun
   * runtime, while pi-host is a Node CLI and inherits Node's V8 ceiling.
   * An explicit maxOldSpaceMb is operator intent and needs no probe.
   */
  async heapBudgetWarning(
    probe: () => Promise<number | undefined> = probeNodeHeapLimitMb,
  ): Promise<string | undefined> {
    if (this.config.mode !== "host" || this.config.maxOldSpaceMb !== undefined) {
      return undefined;
    }
    const actual = await probe();
    if (actual === undefined || actual >= EXPECTED_PI_HEAP_MB) return undefined;
    return (
      `${this.id}: Node's default V8 heap is ${Math.round(actual)} MiB, below ` +
      `the ${EXPECTED_PI_HEAP_MB} MiB Pi workload floor; set ` +
      "[harnesses.pi] max_old_space_mb (or PHANTOMBOT_PI_MAX_OLD_SPACE_MB) " +
      "to an explicit value that fits this host"
    );
  }

  async *invoke(req: HarnessRequest): AsyncGenerator<HarnessChunk> {
    const payload = renderPayload(req);
    const totalBytes =
      Buffer.byteLength(req.systemPrompt, "utf8") +
      Buffer.byteLength(payload, "utf8");

    // Payload is ALWAYS spilled to temp files, on every platform. Pi carries
    // BOTH the system prompt (a flag value) AND the full rendered payload (the
    // positional) — and as the LAST harness in the chain it must swallow the
    // SAME context the primary was chewing when it failed (a rate-limited
    // claude turn is tens of KB). Passing that on argv fails to spawn on
    // Windows (~8,191-char command line) and could theoretically hit Linux
    // ARG_MAX on a huge turn; routing through files removes the ceiling
    // entirely so the fallback never refuses a turn for size. Pi reads
    // `--system-prompt <file>` as the system prompt and includes an `@<file>`
    // positional's contents in the message (verified against pi 0.80.3). See
    // harnessArgvFiles.
    const temp = await createHarnessTempDir(req.tmpBaseDir);
    const systemPromptArg = await temp.file("system-prompt.md", req.systemPrompt);
    const payloadArg = `@${await temp.file("payload.md", payload)}`;
    try {

    const baseArgs = [
      "--print",
      "--mode", "json",
      "--system-prompt", systemPromptArg,
      // Pre-prompting trim:
      //   --offline   Disables Pi's STARTUP network operations (telemetry,
      //               update checks) only — NOT the model API call. The
      //               OpenRouter model request still goes out, so the
      //               (intentional) OpenRouter fallback is unaffected. Same as
      //               PI_OFFLINE=1.
      //   --no-session  Ephemeral: don't write a session file. Phantombot owns
      //               conversation state, so Pi's own session store is dead
      //               weight.
      // We leave tools / skills / extensions ENABLED so connectors survive.
      "--offline",
      "--no-session",
    ];
    // Capability routing: pin the orchestrator model. Without this `--model`
    // the saved primary is never honored — Pi falls back to its own default
    // and the routing config is silently inert. The delegate models reach the
    // extension via env (below), not argv.
    //
    // Coding-brain auto-swap: for a SUBSTANTIAL coding turn we don't delegate to
    // the `coder` tool (cold child, no memory/history/images) — we swap THIS
    // turn's primary to the configured coding model. Because pi runs
    // `--print --no-session` and phantombot rebuilds the full context every
    // turn, the coding model inherits memory + history + images natively. The
    // decision is a free, stateless CRS-style score over the user message (plus
    // a persistent /coder override), so it re-evaluates every turn and
    // flips back to the primary the moment the work stops being code. We never
    // swap the tool-less threat judge (toolsMode "none") — it must stay on the
    // configured primary and never gain capability.
    //
    // SKIP the whole swap subsystem — no override read, no scoring, no retry
    // ladder — when the coding model is unset OR THE SAME as the primary:
    // there is no distinct brain to swap to, so consulting the override store
    // and the scorer would be pure I/O and log noise (and a "swapped" turn on
    // an equal model would activate the retry ladder for nothing).
    const routing = this.routing();
    const primaryModel = routing?.primaryModel;
    const codingModel = routing?.codingModel;
    const coderSwapEligible =
      req.toolsMode !== "none" &&
      !!codingModel &&
      codingModel !== primaryModel;
    let swapped = false;
    let swapModel = primaryModel;
    if (coderSwapEligible) {
      const override =
        req.persona && req.conversation
          ? await getCoderSwapOverride({
              persona: req.persona,
              conversation: req.conversation,
            })
          : undefined;
      // The keyword scorer — the DEFAULT and the FALLBACK routing method
      // (issue #597). An enabled Jev router DECIDES and this runs on any
      // error or missing key, and a manual /coder override wins over both
      // without Jev even being consulted.
      const scoreRoute = () =>
        resolveSwapModel({
          text: req.userMessage,
          override,
          primaryModel,
          codingModel,
          // Pass conversation history so the current message is judged IN CONTEXT
          // (recency-decayed ratio over recent USER turns) rather than alone — a
          // natural-language follow-up mid-review no longer drops the coding brain.
          // History is already rebuilt for buildPayload() below, so this is free.
          history: req.history,
        });

      const decisionModelRouter = this.config.decisionModelRouter;
      let decision: SwapDecision | undefined;
      if (override === undefined && decisionModelRouter) {
        // Resolve the router key per-turn from the env (vault-injected), the
        // same contract as the Pi API key below. reloadVaultForPersona is
        // idempotent; calling it here too keeps the router working on turns
        // where Pi's own key comes from Pi's local store instead.
        await reloadVaultForPersona(req.persona);
        const decisionModelKey = process.env[decisionModelRouter.keyEnv]?.trim();
        if (!decisionModelKey) {
          log.warn(
            `pi.invoke jev-router enabled but ${decisionModelRouter.keyEnv} is not set; using the keyword scorer`,
          );
          // Same telemetry contract as a provider failure: an enabled router
          // with no key falls back on EVERY turn, and that must read as
          // DEGRADED in doctor, not as "no calls recorded".
          void recordDecisionModelOutcome({
            ...(decisionModelRouter.personasDir
              ? { personasDir: decisionModelRouter.personasDir }
              : {}),
            ...(req.persona ? { persona: req.persona } : {}),
            consumer: "router",
            ok: false,
            error: `jev-router enabled but ${decisionModelRouter.keyEnv} is not set`,
          });
          decision = scoreRoute();
        } else {
          const recentUserTexts = (req.history ?? [])
            .filter((t) => t.role === "user")
            .map((t) => t.text);
          const r = await decisionModelRoute({
            settings: {
              baseUrl: decisionModelRouter.baseUrl,
              apiKey: decisionModelKey,
              model: decisionModelRouter.model,
              timeoutMs: decisionModelRouter.timeoutMs,
            },
            text: req.userMessage,
            history: recentUserTexts,
          });
          // Outcome-only telemetry (never the routed text) so `doctor` can
          // report that the decision model is falling back to the scorer.
          void recordDecisionModelOutcome({
            ...(decisionModelRouter.personasDir
              ? { personasDir: decisionModelRouter.personasDir }
              : {}),
            ...(req.persona ? { persona: req.persona } : {}),
            consumer: "router",
            ok: r.ok,
            ...(r.ok ? {} : { error: r.error }),
          });
          if (r.ok) {
            decision = {
              model: r.route === "coder" ? codingModel : primaryModel,
              swapped: r.route === "coder",
              reason: `jev:${r.route}@${r.confidence.toFixed(2)}`,
              score: 0,
            };
          } else {
            log.warn(
              `pi.invoke jev-router unavailable, using the keyword scorer: ${r.error}`,
            );
            decision = scoreRoute();
          }
        }
      } else {
        decision = scoreRoute();
      }
      swapped = decision.swapped;
      swapModel = decision.model;
      if (decision.swapped) {
        log.info("pi.invoke coder-swap active", {
          persona: req.persona,
          conversation: req.conversation,
          model: decision.model,
          reason: decision.reason,
        });
      }
    }
    // Pin the provider for whichever model is active this turn. Pi's `--provider`
    // DEFAULTS TO GOOGLE, so a non-google api-key (e.g. OpenRouter) handed over
    // without this is fired at the wrong endpoint → auth failure. The wizard
    // scopes all routed models (primary + image + coding) to ONE provider, so a
    // single `--provider` is correct even after a coding-brain swap. Absent ⇒
    // omit the flag and let Pi use its own default. Read from the static routing
    // config (like the model), not per-turn env, since the provider is a config
    // choice that pairs with the saved models.
    const provider = routing?.provider;

    // The provider's NATIVE env var — the one Pi itself resolves the key from
    // when no runtime/stored credential exists (issue #602). Undefined for a
    // provider missing from the catalog (rare, live-only): those fall back to
    // the legacy `--api-key` argv flag below, with a logged warning.
    const nativeKeyEnv = provider
      ? PI_PROVIDER_CATALOG.find((p) => p.id === provider)?.envVar
      : undefined;

    // Reconcile this persona's encrypted vault into the env BEFORE the Pi API
    // key is read below — the key is a vault secret post-migration. See claude.ts.
    await reloadVaultForPersona(req.persona);

    // Per-turn Pi auth: relay the API key to the child via its PROVIDER-SCOPED
    // env var (e.g. OPENROUTER_API_KEY) — exactly the var Pi reads when it has
    // no runtime/stored credential. The key must NEVER travel on the command
    // line: /proc/<pid>/cmdline is world-readable (0444) for the process's
    // lifetime, so any local user could read the provider key; environ is 0400
    // owner-only (issue #602). We do NOT persist it into Pi's own auth store —
    // Phantomops owns key storage; this just relays whatever is in the env this
    // turn. Three-tier fallback (see ENV_PI_API_KEY): key present ⇒ project it
    // (wins over an ambient value, and natively scoped to the right provider);
    // ABSENT ⇒ actively CLEAR the native var so no stale ambient value reaches
    // Pi, which then falls back to its OWN env / local store settings (the
    // "install later, no key" path keeps legacy installs working); neither ⇒
    // Pi errors as usual.
    // Precedence note: Pi prefers a STORED credential over env vars, and the
    // native agent dir is HOST-level (lib/nativeAgentDir.ts) — a wizard-written
    // api_key entry there would outvote this relay and decide EVERY persona's
    // key (last onboarded wins, vault rotation a silent no-op; PR #606 review).
    // So a relayed turn STRIPS the provider's entry from the native store below
    // (see the removePiApiKey call before spawn): while a key is relayed, env
    // is the only resolution source. Tier-2 (no relayed key) keeps the entry —
    // the documented "install later, no key" fallback stays usable.
    // ...UNLESS this persona explicitly opted out of phantombot's routing
    // ("Use Pi's own config"). That opt-out has to cover the key as well as the
    // models: the key is read from the ambient env, which on a multi-persona
    // host is the HOST's key, so honouring it here would fire another persona's
    // credential at a provider this persona never chose. Withholding (and
    // clearing) the native var is what "Pi decides for itself" actually means.
    // A host pi (`pi-host`) never gets phantombot's key either: its owner
    // configured its auth, and the ambient key may belong to another persona.
    //
    // NATIVE (2026-09-13, Atlas postmortem): there IS no local-store fallback.
    // The embedded engine gets an ISOLATED agent dir (nativeAgentEnv below) —
    // it must never read the user's `~/.pi`, and its own auth store is empty
    // by design. So a native slot with a configured provider and no resolvable
    // key fails LOUDLY and ACTIONABLY here instead of with pi's cryptic
    // "No API key found" from an empty store. copyNativeKeys (startup/doctor)
    // is what keeps this path rare: it copies the legacy key into the vault
    // before anything depends on native.
    const piApiKey = this.config.mode !== "native" || routing?.useLocalConfig
      ? undefined
      : process.env[this.config.apiKeyEnv ?? ENV_PI_API_KEY]?.trim();
    if (
      this.config.mode === "native" &&
      !routing?.useLocalConfig &&
      provider &&
      !piApiKey
    ) {
      const secret = this.config.apiKeyEnv ?? ENV_PI_API_KEY;
      throw new Error(
        `${this.id}: no API key found for provider '${provider}'. ` +
          `Save your ${provider} API key once with 'phantombot doctor --fix' ` +
          `(or Configure → Brain) and it is stored for every native brain ` +
          `(secret ${secret}).`,
      );
    }

    /**
     * Assemble the full argv for ONE attempt. `model` is the brain this
     * attempt runs on — the swapped coding model or, after the swap's retries
     * are exhausted, the primary. Everything else (system prompt file, provider,
     * api-key, payload file) is model-independent and rebuilt identically per
     * attempt so the ladder only ever varies `--model`.
     */
    const buildArgs = (model: string | undefined): string[] => {
      const argv = [...baseArgs];
      if (provider) {
        argv.push("--provider", provider);
      }
      if (model) {
        argv.push("--model", model);
      }
      // Tool-less threat-judge mode. Per `pi --help`, `--no-tools` disables all
      // tools (built-in, extension, and custom) — true zero-tools, native flag,
      // no deny-list to maintain.
      if (req.toolsMode === "none") {
        argv.push("--no-tools");
      }
      // Legacy fallback ONLY: a provider missing from PI_PROVIDER_CATALOG has no
      // known native env var, so the key still has to travel on argv there.
      // World-readable /proc cmdline exposure (issue #602) — keep this path rare.
      if (piApiKey && !nativeKeyEnv) {
        log.warn(
          `${this.id}: provider '${provider ?? "(none)"}' is not in the provider catalog — ` +
            "relaying the API key via the legacy --api-key argv flag (visible in /proc/<pid>/cmdline). " +
            "Add the provider to PI_PROVIDER_CATALOG to close this.",
        );
        argv.push("--api-key", piApiKey);
      }
      // Payload is the LAST positional arg (pi reads it from argv, not stdin).
      // This is always `@<tempfile>` so pi loads the payload from disk instead
      // of the length-limited command line.
      argv.push(payloadArg);
      return argv;
    };
    log.debug("pi.invoke spawning", {
      command: this.command(),
      mode: this.config.mode ?? "host",
      payloadBytes: totalBytes,
      tempFiles: true,
    });

    // Relay THIS harness's provider + api-key into the child env so the bundled
    // capability-routing extension can relay them to its OWN delegate children
    // (look_at_image / coder) — provider via `--provider`, key via the native
    // env var named in ENV_PI_KEY_ENV, never onto delegate argv (#602). Delegate
    // MODELS still
    // travel via the managed routing.json, but the auth PAIR is per-turn and
    // scoped to the active harness — projecting it here (rather than leaning on a
    // shared ambient env var) is what keeps a primary-Pi→OpenRouter /
    // fallback-Pi→OpenAI box from colliding two providers in one namespace: each
    // pi subtree inherits exactly its own pair. We set the provider explicitly
    // (it was previously only an argv flag, invisible to the extension) and
    // re-assert the api-key so the child sees the value we just resolved. An
    // empty string CLEARS the key — so a harness with no provider/key actively
    // unsets any stale ambient value rather than leaking it into the subtree.
    // withPersonaEnv returns a fresh copy with turn context and non-interactive defaults;
    // the spread guarantees we can freely assign child-specific vars without mutating parent state.
    const childEnv = { ...withPersonaEnv(process.env, req.persona, req.conversation, req.turnId) };
    if (
      this.config.mode === "host" &&
      this.config.maxOldSpaceMb !== undefined
    ) {
      childEnv.NODE_OPTIONS = withMaxOldSpaceSize(
        childEnv.NODE_OPTIONS,
        this.config.maxOldSpaceMb,
      );
    }
    childEnv[ENV_PI_PROVIDER] = provider ?? "";
    childEnv[ENV_PI_API_KEY] = piApiKey ?? "";
    // The key itself travels via the provider's NATIVE env var (issue #602):
    // set when both provider and key resolve, actively CLEARED otherwise so a
    // stale ambient value (the host's own OPENROUTER_API_KEY etc.) can't leak
    // into a subtree that didn't configure that provider. ENV_PI_KEY_ENV names
    // the var for the capability-routing extension, which must relay the key to
    // its OWN delegate children via env too — never onto their argv.
    if (nativeKeyEnv) {
      childEnv[nativeKeyEnv] = piApiKey ?? "";
    }
    childEnv[ENV_PI_KEY_ENV] = nativeKeyEnv ?? "";
    // Point the extension at THIS persona's delegate models (phantombot#441).
    // Delegate models still travel as a routing.json, NOT as env vars — that
    // contract is unchanged. What changes is WHICH routing.json: the managed
    // one is stamped once per host from the default persona's config, so on a
    // multi-persona box every other persona's vision delegate was the default
    // persona's model. `[harnesses]` is persona-scoped now, so we write this
    // persona's models into its own per-turn temp dir (persona-owned, cleaned
    // up with the turn) and name the file in the child env. Written even when
    // this harness has no routing at all — an empty object is the inert state,
    // and stating it is what stops a routing-free persona inheriting the host's
    // stamped delegate.
    childEnv[ENV_ROUTING_JSON] = await temp.file(
      "routing.json",
      JSON.stringify(routingModelsForChild(routing)),
    );
    // Route the pi capability-routing extension's `phantombot-route-*` temp
    // files into the persona tmp dir too (issue #365). We pass our OWN var, not
    // a process-wide TMPDIR — that would leak across personas / unrelated child
    // processes (Kai's review point). spawnPi.ts falls back to os.tmpdir() when
    // it's unset (degraded/no-persona paths).
    if (req.tmpBaseDir) childEnv[ENV_PHANTOMBOT_TMP_DIR] = req.tmpBaseDir;
    // Native: hand the child the embedded engine's package dir (compiled
    // binaries only) and the self-exec argv, so the capability-routing
    // extension's delegates re-enter THIS engine rather than hunting for a
    // host pi. Host: blank the var so a host pi's delegates never inherit a
    // native invocation from an ambient environment.
    if (this.config.mode === "native") {
      Object.assign(childEnv, embeddedPiChildEnv(xdgDataHome()));
      // ISOLATION: the embedded engine gets a phantombot-owned agent dir
      // (auth.json, models-store.json, extensions). It never reads or writes
      // the user's ~/.pi — that dependency broke Atlas when her owner deleted
      // pi. Host mode: leave the var UNSET so the host pi keeps ~/.pi.
      Object.assign(childEnv, nativeAgentEnv(xdgDataHome()));
      if (this.config.command) {
        childEnv[ENV_PHANTOMBOT_PI_COMMAND] = JSON.stringify(this.config.command);
      }
    } else {
      childEnv[ENV_PHANTOMBOT_PI_COMMAND] = "";
    }

    // STRIP (PR #606 review): on a RELAYED turn, remove the provider's api_key
    // entry from the native auth store BEFORE spawn so Pi's store-first
    // precedence can't resurrect a stale (possibly another persona's) key —
    // env is the only source while we relay. Coupled to the relay, not to
    // native mode: no relayed key ⇒ no strip (tier-2 fallback stays usable).
    // agentDir-targeted only, so the host's ~/.pi is unreachable here.
    //
    // FAIL-CLOSED (PR #606 re-review, Kai): a relayed turn must never spawn
    // while ANY stored credential for this provider could still outrank the
    // relayed env key — Pi resolves any store entry, api_key AND oauth login,
    // ahead of env vars, so a survivor means the turn may silently
    // authenticate as the wrong (possibly another persona's) credential.
    //   - Strip failed (locked file, unparseable JSON, IO error) → ABORT this
    //     turn: throw, which the orchestrator converts into the standard
    //     fall-through + cooldown + alerter path. Same contract as the
    //     loud no-key throw above.
    //   - OAuth entry present → ABORT too. phantombot never deletes an
    //     interactive login; the error tells the operator how to clear it.
    // No relayed key ⇒ no strip (tier-2 fallback stays usable, oauth and all).
    if (piApiKey && nativeKeyEnv) {
      const strip = await removePiApiKey(provider as string, {
        agentDir: nativeAgentDir(xdgDataHome()),
      });
      if (!strip.ok) {
        throw new Error(
          `${this.id}: relayed turn aborted — could not remove the stored ` +
            `'${provider}' credential from the native auth store ` +
            `(${strip.reason}). Pi resolves a stored credential AHEAD of the ` +
            `relayed env key, so spawning now could authenticate as the wrong ` +
            `key. Fix the store (or clear the entry) and retry; nothing was spawned.`,
        );
      }
      if (strip.skipped === "oauth-present") {
        throw new Error(
          `${this.id}: relayed turn aborted — the native auth store holds an ` +
            `oauth login for '${provider}', which outranks the relayed env key. ` +
            `phantombot never deletes an interactive login: clear it from the ` +
            `native store (or re-onboard this persona) and retry; nothing was spawned.`,
        );
      }
    }

    /**
     * Spawn ONE pi attempt on the given model and stream its chunks. Fresh
     * subprocess per attempt (the shared engine arms its own kill coordinator
     * per spawn), same temp payload files (model-independent) and child env.
     */
    const runAttempt = async function* (
      this: PiHarness,
      model: string | undefined,
    ): AsyncGenerator<HarnessChunk> {
      const proc = spawnInNewSession([...this.command(), ...buildArgs(model)], {
        cwd: req.workingDir,
        env: childEnv,
        stdin: "ignore",
        stdout: "pipe",
        stderr: "pipe",
      });

      // Shared engine. Pi delivers its payload via argv (stdin ignored, so no
      // stdinPayload), and the terminal `done` meta records the argv byte count.
      yield* runHarnessProcess({
        proc,
        req,
        harnessId: this.id,
        parseEvent: parsePiEvent,
        toolBoundary: piToolBoundary,
        activity: piActivity,
        reasoningReplay:
          this.config.reasoningReplay ?? DEFAULT_REASONING_REPLAY,
        buildDoneMeta: () => ({ harnessId: this.id, payloadBytes: totalBytes }),
        // pi is the only harness with no native terminal `done` in its stream —
        // it derives completion from turn_end (mapped to a `done` marker in
        // parsePiEvent). Require that marker before accepting an exit-0 run as a
        // finished answer, so a narration-only mid-task exit falls through to the
        // next harness rather than being stored as the reply (issue #352).
        requireCompletion: true,
      });
    }.bind(this);

    if (!swapped) {
      yield* runAttempt(swapModel);
    } else {
      // ─────────────────────────────────────────────────────────────────
      // Coder-swap retry ladder (the "brain swap" fix).
      //
      // A swapped turn rides a DIFFERENT provider model than the primary —
      // and an intermittent provider hang (stream never starts, zero output
      // for the whole idle window) used to cost the turn outright: pi is
      // usually the LAST harness in the chain, so an idle kill had no
      // fallback and the user's message was silently lost. Now a swapped
      // turn gets up to CODER_SWAP_MAX_ATTEMPTS attempts on the coding
      // model, and when they're all exhausted the turn is re-run once on
      // the PRIMARY — a possibly-slower but known-good brain beats a lost
      // turn.
      //
      // Retry discipline (each rule exists for a reason):
      //   - Only when NOTHING happened yet this attempt — no text streamed AND
      //     no tool run. Text is not the only non-idempotent thing here: pi's
      //     tool executions surface as progress chunks, not text, and a retry
      //     after a bash/notify/vault tool ran would replay those side effects
      //     wholesale. `producedOutput` flips on any non-heartbeat chunk
      //     (heartbeat is payload-less by contract), which keeps the genuine
      //     "provider never started streaming" case — the one this ladder
      //     exists for — fully retryable while everything that got anywhere
      //     stays single-shot. Retrying after visible text would ALSO duplicate
      //     bubbles on screen (the streaming-first trade-off documented in
      //     fallback.ts).
      //   - Only recoverable, non-terminal errors — a policy violation or
      //     user /stop must not be retried onto another model.
      //   - NEVER on a hard wall-clock cap kill. The hard cap is the one timer
      //     that is supposed to be FINAL: a turn that legitimately kept the
      //     idle timer fed but never converged is exactly what it exists to
      //     kill. The ladder would multiply one 60-min cap into four hours.
      //   - Errors from the final PRIMARY attempt are yielded as-is so the
      //     orchestrator's normal harness chain still applies afterwards.
      // ─────────────────────────────────────────────────────────────────
      let lastFailure:
        | { error: string; recoverable?: boolean; httpStatus?: number }
        | undefined;
      for (
        let attempt = 1;
        attempt <= CODER_SWAP_MAX_ATTEMPTS && !req.signal?.aborted;
        attempt++
      ) {
        // Tracks whether this attempt produced output of ANY kind (text,
        // progress from a tool run, done). heartbeat is payload-less by
        // contract and is excluded, so a provider that never starts streaming
        // stays retryable — but an attempt that got as far as running a tool
        // is NOT, because tools have side effects and a re-run is a re-do.
        let producedOutput = false;
        let failure:
          | (HarnessChunk & { type: "error"; error: string })
          | undefined;
        for await (const chunk of runAttempt(swapModel)) {
          if (chunk.type === "error") {
            // Terminal in the shared engine: yielded last, generator returns
            // right after. Hold it back while a retry is still possible.
            failure = chunk;
            break;
          }
          if (chunk.type !== "heartbeat") producedOutput = true;
          yield chunk;
        }
        if (!failure) return; // completed (or the consumer stopped us)
        lastFailure = failure;
        const retryable =
          failure.recoverable !== false &&
          !failure.terminal &&
          !producedOutput &&
          !isHardCapError(failure.error) &&
          !req.signal?.aborted &&
          // Issue #559: a rate-limited provider is not going to accept work
          // on the next swap attempt either. Retrying the ladder against a
          // 429 just burns the coder-swap budget (and the wall clock) before
          // the orchestrator ever gets the chance to fall through to the
          // next harness — abort the internal ladder on the FIRST rate-limit
          // signal and let the chain advance immediately. Provider deaths
          // surface as a bare exit-code error plus a stderr tail, so the
          // classification reads both (stderr carries the provider's
          // "429 / rate limit / quota" prose).
          classifyFailure(
            [failure.error, ...(failure.stderrTail ?? [])].join("\n"),
            failure.httpStatus,
          ) !== "rate_limit";
        // Not retryable — surface the error exactly as the single-attempt
        // path always did: a policy violation, a /stop, a hard-cap kill (the
        // final timer must stay final), or a failure AFTER the attempt got
        // somewhere (streamed text OR ran a tool — a re-run would duplicate
        // bubbles and replay side-effecting tools, the very trade-off
        // fallback.ts warns against re-litigating).
        if (!retryable) {
          yield failure;
          return;
        }
        if (attempt < CODER_SWAP_MAX_ATTEMPTS) {
          log.warn("pi.invoke coder-swap attempt failed — retrying", {
            persona: req.persona,
            conversation: req.conversation,
            model: swapModel,
            attempt,
            of: CODER_SWAP_MAX_ATTEMPTS,
            error: failure.error,
          });
        }
      }
      // All swapped attempts failed CLEANLY (nothing ever happened — no text,
      // no tools), so the primary attempt starts from a blank slate: no
      // duplicated bubbles, no replayed tool side effects.
      // (If the loop exited early because the user aborted, stop here too.)
      if (req.signal?.aborted) return;
      log.warn("pi.invoke coder-swap exhausted — falling back to primary", {
        persona: req.persona,
        conversation: req.conversation,
        model: swapModel,
        fallbackModel: primaryModel ?? "(pi default)",
        error: lastFailure?.error,
      });
      yield* runAttempt(primaryModel);
    }

    } finally {
      // Remove the temp payload/system-prompt files once the child has exited
      // (or the consumer stopped iterating early).
      await temp.cleanup();
    }
  }
}

export async function probeNodeHeapLimitMb(): Promise<number | undefined> {
  try {
    const proc = Bun.spawn(
      [
        "node",
        "-e",
        "process.stdout.write(String(require('node:v8').getHeapStatistics().heap_size_limit / 1048576))",
      ],
      {
        stdin: "ignore",
        stdout: "pipe",
        stderr: "ignore",
        env: process.env,
        // This is warning-only startup telemetry. A wedged PATH shim must
        // degrade to no warning rather than hold daemon startup indefinitely.
        timeout: 2_000,
      },
    );
    const stdout = await new Response(proc.stdout).text();
    if ((await proc.exited) !== 0) return undefined;
    const value = Number(stdout.trim());
    return Number.isFinite(value) ? value : undefined;
  } catch {
    return undefined;
  }
}

/** Emit each distinct low-heap startup warning once. */
export async function warnLowPiHeapAtStartup(
  harnesses: readonly Harness[],
  err: WriteSink,
  probe?: () => Promise<number | undefined>,
): Promise<string[]> {
  const warnings = new Set<string>();
  let probeResult: Promise<number | undefined> | undefined;
  const sharedProbe = () =>
    (probeResult ??= (probe ?? probeNodeHeapLimitMb)());
  for (const harness of harnesses) {
    if (!(harness instanceof PiHarness)) continue;
    const warning = await harness.heapBudgetWarning(sharedProbe);
    if (warning) warnings.add(warning);
  }
  for (const warning of warnings) {
    log.warn("run: low Pi heap ceiling", { warning });
    err.write(`warning: ${warning}\n`);
  }
  return [...warnings];
}

/** Append the explicit cap; Node uses the final repeated flag, preserving quoted options. */
export function withMaxOldSpaceSize(
  nodeOptions: string | undefined,
  maxOldSpaceMb: number,
): string {
  const inherited = nodeOptions?.trim();
  const cap = `--max-old-space-size=${maxOldSpaceMb}`;
  return inherited ? `${inherited} ${cap}` : cap;
}

/**
 * Render the conversation payload Pi gets as its single positional arg.
 * Same rules as the Claude stdin payload — alternating user / assistant
 * blocks with assistant turns wrapped in <previous_response>.
 *
 * Exported for testing.
 */
export function renderPayload(req: HarnessRequest): string {
  return renderConversationPayload(req);
}

/**
 * Translate one pi stream-json line into a HarnessChunk.
 *
 * Schema (verified against pi v0.79.x with `--mode json`; older v0.67.x
 * event names — `tool_use_*`, `tool_name` — still accepted as fallback):
 *
 *   {"type":"message_update",
 *    "assistantMessageEvent":{
 *       "type":"text_delta"|"thinking_delta"|"toolcall_*"|...,
 *       "contentIndex": N,
 *       "delta": "...",     // for *_delta events
 *       "partial": {...},
 *    },
 *    "message": {...}}
 *
 *   {"type":"turn_end", ...}
 *   {"type":"agent_end", ...}
 *   {"type":"session", ...}    // emitted at startup
 *   {"type":"message_start"|"message_end", ...}
 *
 * `text_delta` events contribute to the user-facing reply.
 * `thinking_delta` events are the model's chain-of-thought; the content is
 * never surfaced as reply text (no leak into the bubble), but it IS captured
 * into the narration-decay replay buffer (issue #551) — the engine may
 * replay the newest un-emitted slice as a replay row after a
 * quiet window. The emitted chunk itself stays a payload-less `heartbeat`
 * so the channel layer can refresh its typing indicator. When the user
 * sees `typing…` come and go in real time, that's pi actually thinking — the
 * indicator vanishing means the model has gone silent (and may be wedged on
 * a tool call).
 *
 * tool_execution_start carries the useful tool name/args and is the primary
 * progress signal. Nameless toolcall_* (pi ≥0.79; formerly tool_use_*) events
 * inside assistantMessageEvent are only liveness noise, so they become
 * `heartbeat` unless they carry a real tool name or useful args.
 *
 * Exported for testing.
 */
export function parsePiEvent(parsed: unknown): ParseEventResult {
  if (typeof parsed !== "object" || parsed === null) return undefined;
  const obj = parsed as Record<string, unknown>;

  // tool_execution_start is a top-level event pi emits just before
  // it invokes a tool. Emit as `progress` so the channel layer
  // flushes any buffered narration into a bubble before the tool
  // runs (keeping the user oriented during the silence).
  if (obj.type === "tool_execution_start") {
    // pi 0.79.x renamed this field `tool_name` → `toolName` (camelCase).
    // Accept both so the adapter works across pi versions.
    const toolName =
      typeof obj.toolName === "string"
        ? obj.toolName
        : typeof obj.tool_name === "string"
          ? obj.tool_name
          : undefined;
    const args = obj.args ?? obj.input;
    const tool = buildToolCall(toolName, args);
    return { type: "progress", note: tool.title, tool };
  }

  // tool_execution_update is fired while a tool is mid-run, carrying its
  // partial result. The capability-routing `coder` tool emits these (via pi's
  // onUpdate) as its child makes real progress, so the PRIMARY stays visibly
  // alive while it's blocked awaiting the delegate. Surface a payload-less
  // heartbeat (no partialResult leak, no spurious bubble flush) — piActivity
  // classifies it as in-tool activity so it RESETS the idle watchdog. It is
  // emitted on genuine new output (bash streams stdout, the coder delegate
  // forwards its child), so a tool that goes truly silent still trips the idle
  // kill. A tool that instead TRICKLES output forever can't defeat the watchdog
  // indefinitely either: the shared engine caps how long tool activity alone
  // may keep the idle timer alive (runHarnessProcess toolTimeoutMs, issue #351).
  if (obj.type === "tool_execution_update") {
    return { type: "heartbeat" };
  }

  // turn_end is pi's end-of-turn COMPLETION signal — the model has finished
  // this turn. Verified against pi 0.80.x: a successful run always ends
  // turn_end → agent_end → agent_settled, in --no-tools mode too. Surface it
  // as a `done` marker (payload-less: the reply text already streamed as
  // text_delta chunks and is accumulated by the shared engine) so that engine
  // can distinguish a genuinely COMPLETED turn from an exit-0 that stopped
  // mid-task having emitted only tool narration — see runHarnessProcess's
  // `requireCompletion` gate and issue #352. We deliberately gate on turn_end
  // ALONE, not the later agent_end/agent_settled: a run that errors out can
  // still emit agent_end, and treating that as "done" would accept a broken
  // turn as complete. turn_end fires only when the turn itself finished.
  //
  // Version caveat: on a hypothetical pi build that does not emit turn_end,
  // every turn would fail the gate and fall through to the next harness. That
  // degrades safely — a recoverable fallback that still yields a real answer
  // (double work, not a wrong answer) — whereas the pre-fix behaviour returned
  // the trimmed narration as if it were the answer.
  if (obj.type === "turn_end") {
    return { type: "done", finalText: "", meta: undefined };
  }

  if (obj.type !== "message_update") return undefined;

  const ame = obj.assistantMessageEvent;
  if (!isObject(ame)) return undefined;

  if (ame.type === "text_delta") {
    const delta = ame.delta;
    if (typeof delta === "string" && delta.length > 0) {
      return { type: "text", text: delta };
    }
    return undefined;
  }

  if (ame.type === "thinking_delta") {
    // Chain-of-thought fragment. Content still never streams to the user as
    // reply text — but it IS captured into the narration-decay replay buffer
    // (issue #551), where the engine's quiet window decides if/when the
    // newest un-emitted slice surfaces as a replay row. The
    // chunk itself stays payload-less, exactly as before.
    const delta = ame.delta;
    if (typeof delta === "string" && delta.trim().length > 0) {
      return { reasoning: delta, chunk: { type: "heartbeat" } };
    }
    return { type: "heartbeat" };
  }

  if (typeof ame.type === "string") {
    // Pi also emits assistantMessageEvent toolcall_* / tool_use_* records while
    // streaming the assistant message. In practice these can be nameless
    // internal deltas; surfacing those as progress creates stacks of anonymous
    // "tool" rows in ACP clients. Keep them as liveness heartbeats unless the
    // event itself carries enough detail to title a real tool call. The
    // top-level tool_execution_start remains the canonical useful signal.
    if (ame.type.startsWith("toolcall") || ame.type.startsWith("tool_use")) {
      const tool = buildAssistantToolCall(ame);
      return tool
        ? { type: "progress", note: tool.title, tool }
        : { type: "heartbeat" };
    }
    // thinking_delta + anything else → heartbeat.
    // We intentionally do NOT include the content in the chunk (would leak
    // chain-of-thought to the user). The signal is just "pi is alive."
    return { type: "heartbeat" };
  }

  return undefined;
}

export function piToolBoundary(parsed: unknown) {
  if (typeof parsed !== "object" || parsed === null) return undefined;
  const obj = parsed as Record<string, unknown>;
  if (obj.type !== "tool_execution_start" && obj.type !== "tool_execution_end") return undefined;
  const id = typeof obj.toolCallId === "string"
    ? obj.toolCallId
    : typeof obj.tool_call_id === "string"
      ? obj.tool_call_id
      : undefined;
  if (!id) return undefined;
  return { phase: obj.type === "tool_execution_start" ? "start" as const : "end" as const, id };
}

export function piActivity(parsed: unknown, chunk: HarnessChunk): HarnessActivity {
  if (chunk.type === "text" || chunk.type === "done") return "productive";
  if (typeof parsed !== "object" || parsed === null) {
    return chunk.type === "heartbeat" ? "model" : "productive";
  }
  const obj = parsed as Record<string, unknown>;
  // tool_execution_start AND _update are both genuine in-tool activity: the
  // update only fires when the running tool reports real progress (e.g. the
  // coder delegate forwarding its child's output). Classifying as "tool" resets
  // the idle timer while keeping toolRunning set, so a long-but-working tool
  // stays alive without a generic model heartbeat being able to do the same.
  if (obj.type === "tool_execution_start" || obj.type === "tool_execution_update") {
    return "tool";
  }
  const ame = obj.assistantMessageEvent;
  if (isObject(ame) && typeof ame.type === "string") {
    // pi 0.79.x: `tool_use_*` → `toolcall_*`. Accept both.
    if (ame.type === "toolcall_end" || ame.type === "tool_use_end") {
      return "productive";
    }
    if (ame.type.startsWith("toolcall") || ame.type.startsWith("tool_use")) {
      return "tool";
    }
  }
  return chunk.type === "heartbeat" ? "model" : "productive";
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function buildAssistantToolCall(
  ame: Record<string, unknown>,
): ToolCallDetail | undefined {
  const partial = isObject(ame.partial) ? ame.partial : undefined;
  const toolName = firstString(
    ame.toolName,
    ame.tool_name,
    ame.name,
    partial?.toolName,
    partial?.tool_name,
    partial?.name,
  );
  const args =
    ame.args ??
    ame.input ??
    partial?.args ??
    partial?.input ??
    partial?.parameters;

  if (toolName) return buildToolCall(toolName, args);
  const detail = extractUsefulArgDetail(args);
  if (detail) return {title: `tool: ${detail}`, kind: "other", locations: []};
  return undefined;
}

function firstString(...values: unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) return value;
  }
  return undefined;
}

function extractUsefulArgDetail(args: unknown): string | undefined {
  if (!isObject(args)) return undefined;
  for (const key of [
    "command",
    "cmd",
    "file_path",
    "filePath",
    "path",
    "query",
    "pattern",
    "prompt",
  ]) {
    const value = args[key];
    if (typeof value === "string" && value.trim()) return value.trim();
    if (Array.isArray(value)) {
      const joined = value
        .filter((item): item is string => typeof item === "string")
        .join(" ")
        .trim();
      if (joined) return joined;
    }
  }
  return undefined;
}


/**
 * The delegate-model subset the capability-routing extension consumes, in the
 * same shape `piExtensionProvision.routingModels` stamps (phantombot#441) —
 * only defined fields, and deliberately NO coding model: that drives the
 * per-turn coding-brain swap in this file, not any tool the extension
 * registers, so handing it over would be dead weight the extension might one
 * day act on.
 */
export function routingModelsForChild(
  routing: PiRoutingConfig | undefined,
): { primaryModel?: string; imageModel?: string } {
  const out: { primaryModel?: string; imageModel?: string } = {};
  const primary = routing?.primaryModel?.trim();
  const image = routing?.imageModel?.trim();
  if (primary) out.primaryModel = primary;
  if (image) out.imageModel = image;
  return out;
}
