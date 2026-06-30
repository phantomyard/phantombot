/**
 * Pi harness (https://pi.dev — Pi Coding Agent from Earendil Works).
 *
 * Spawns `pi --print --mode json` with the system prompt as a flag and the
 * full rendered payload (history + new message) as the LAST positional
 * argument. Pi ignores stdin in --print mode, so the payload travels via
 * argv — bounded by Linux ARG_MAX.
 *
 * Stream-json events translated to phantombot HarnessChunks:
 *   message_update with text_delta  → { type: "text", text }
 *   tool_execution_start            → { type: "progress", note: "tool: <name>" }
 *   anything else (agent_start,
 *     tool_execution_end, turn_end,
 *     extension_*) → ignored        (the done chunk is emitted from process exit)
 *
 * Auth (per-turn, with local-store fallback): when PHANTOMBOT_PI_API_KEY is
 * set, phantombot threads it onto `--api-key` per turn (the same way it threads
 * `--model`) — never persisting it into Pi's own auth store. When it's UNSET,
 * phantombot passes no `--api-key` and Pi falls back to its own env / local
 * store settings, so an "install later, no key" or legacy install keeps working.
 * `phantombot doctor` surfaces failure if neither path yields credentials.
 *
 * Provider: the configured routing provider is threaded onto `--provider` every
 * turn. This is REQUIRED for a non-google key to work — Pi's `--provider`
 * defaults to google, so an OpenRouter key with no `--provider openrouter` is
 * sent to the wrong endpoint and fails. The wizard scopes all routed models to
 * one provider, so a single `--provider` is correct even after a coding swap.
 *
 * ARG_MAX guard: declares maxPayloadBytes so the orchestrator's fallback
 * skips Pi for oversized turns. Internal precheck mirrors that so a
 * direct invoke() with a too-large payload still fails recoverably.
 */

import { access, constants } from "node:fs/promises";
import type { Harness, HarnessChunk, HarnessRequest } from "./types.ts";
import { ENV_PI_API_KEY, ENV_PI_PROVIDER, type PiRoutingConfig } from "../lib/piRouting.ts";
import { getCoderSwapOverride, resolveSwapModel } from "../lib/coderSwap.ts";
import { buildToolNote } from "./toolNote.ts";
import { reloadEnvFiles, withPersonaEnv } from "../lib/envBootstrap.ts";
import {
  type HarnessActivity,
  runHarnessProcess,
} from "../lib/harnessRunner.ts";
import { log } from "../lib/logger.ts";
import { spawnInNewSession } from "../lib/processGroup.ts";

export interface PiHarnessConfig {
  /** Path to the `pi` CLI binary. Default: "pi" (looked up in PATH). */
  bin: string;
  /** Maximum payload size in bytes (system prompt + rendered conversation). */
  maxPayloadBytes: number;
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
}

export class PiHarness implements Harness {
  readonly id = "pi";

  constructor(private readonly config: PiHarnessConfig) {}

  get maxPayloadBytes(): number {
    return this.config.maxPayloadBytes;
  }

  async available(): Promise<boolean> {
    try {
      if (this.config.bin.startsWith("/")) {
        await access(this.config.bin, constants.X_OK);
      }
      return true;
    } catch {
      return false;
    }
  }

  async *invoke(req: HarnessRequest): AsyncGenerator<HarnessChunk> {
    const payload = renderPayload(req);
    const totalBytes =
      Buffer.byteLength(req.systemPrompt, "utf8") +
      Buffer.byteLength(payload, "utf8");
    if (totalBytes > this.config.maxPayloadBytes) {
      yield {
        type: "error",
        error: `pi payload ${totalBytes} bytes exceeds maxPayloadBytes ${this.config.maxPayloadBytes}`,
        recoverable: true,
      };
      return;
    }

    const args = [
      "--print",
      "--mode", "json",
      "--system-prompt", req.systemPrompt,
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
    let primaryModel = this.config.routing?.primaryModel;
    if (req.toolsMode !== "none" && this.config.routing?.codingModel) {
      const override =
        req.persona && req.conversation
          ? await getCoderSwapOverride({
              persona: req.persona,
              conversation: req.conversation,
            })
          : undefined;
      const decision = resolveSwapModel({
        text: req.userMessage,
        override,
        primaryModel: this.config.routing.primaryModel,
        codingModel: this.config.routing.codingModel,
        // Pass conversation history so the current message is judged IN CONTEXT
        // (recency-decayed ratio over recent USER turns) rather than alone — a
        // natural-language follow-up mid-review no longer drops the coding brain.
        // History is already rebuilt for buildPayload() below, so this is free.
        history: req.history,
      });
      primaryModel = decision.model;
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
    const provider = this.config.routing?.provider;
    if (provider) {
      args.push("--provider", provider);
    }
    if (primaryModel) {
      args.push("--model", primaryModel);
    }
    // Tool-less threat-judge mode. Per `pi --help`, `--no-tools` disables all
    // tools (built-in, extension, and custom) — true zero-tools, native flag,
    // no deny-list to maintain.
    if (req.toolsMode === "none") {
      args.push("--no-tools");
    }

    // Re-source ~/.env so secrets saved by the agent on the previous turn
    // (`phantombot env set FOO bar`) are visible here without a daemon
    // restart — and so the Pi API key below is read fresh. See envBootstrap.ts
    // for the sticky-vs-reloadable rules.
    await reloadEnvFiles();

    // Per-turn Pi auth: thread the API key onto `--api-key` exactly the way the
    // model is threaded onto `--model`. We do NOT persist it into Pi's own auth
    // store — Phantomops owns key storage; this just relays whatever is in the
    // env this turn. Three-tier fallback (see ENV_PI_API_KEY): key present ⇒
    // pass it (wins); ABSENT ⇒ omit the flag so Pi falls back to its OWN env /
    // local store settings (the "install later, no key" path keeps legacy
    // installs working); neither ⇒ Pi errors as usual. Must precede the
    // positional payload below.
    const piApiKey = process.env[ENV_PI_API_KEY]?.trim();
    if (piApiKey) {
      args.push("--api-key", piApiKey);
    }

    // Payload is the LAST positional arg (pi reads it from argv, not stdin).
    args.push(payload);
    log.debug("pi.invoke spawning", {
      bin: this.config.bin,
      payloadBytes: totalBytes,
    });

    // Relay THIS harness's provider + api-key into the child env so the bundled
    // capability-routing extension threads them onto its OWN delegate children
    // (look_at_image / coder) as `--provider`/`--api-key`. Delegate MODELS still
    // travel via the managed routing.json, but the auth PAIR is per-turn and
    // scoped to the active harness — projecting it here (rather than leaning on a
    // shared ambient env var) is what keeps a primary-Pi→OpenRouter /
    // fallback-Pi→OpenAI box from colliding two providers in one namespace: each
    // pi subtree inherits exactly its own pair. We set the provider explicitly
    // (it was previously only an argv flag, invisible to the extension) and
    // re-assert the api-key so the child sees the value we just resolved. An
    // empty string CLEARS the key — so a harness with no provider/key actively
    // unsets any stale ambient value rather than leaking it into the subtree.
    // Clone, never mutate in place: withPersonaEnv returns the SAME process.env
    // reference when there's no persona/conversation, so assigning onto it would
    // clobber the parent's global env. The spread guarantees a fresh object.
    const childEnv = { ...withPersonaEnv(process.env, req.persona, req.conversation) };
    childEnv[ENV_PI_PROVIDER] = provider ?? "";
    childEnv[ENV_PI_API_KEY] = piApiKey ?? "";
    const proc = spawnInNewSession([this.config.bin, ...args], {
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
      activity: piActivity,
      buildDoneMeta: () => ({ harnessId: this.id, payloadBytes: totalBytes }),
    });
  }
}

/**
 * Render the conversation payload Pi gets as its single positional arg.
 * Same rules as the Claude stdin payload — alternating user / assistant
 * blocks with assistant turns wrapped in <previous_response>.
 *
 * Exported for testing.
 */
export function renderPayload(req: HarnessRequest): string {
  const parts: string[] = [];
  for (const turn of req.history) {
    if (turn.role === "user") {
      parts.push(turn.text);
    } else {
      parts.push(`<previous_response>\n${turn.text}\n</previous_response>`);
    }
  }
  parts.push(req.userMessage);
  return parts.join("\n\n");
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
 * `thinking_delta` events are the model's chain-of-thought; we deliberately
 * do NOT surface their content (would leak reasoning into the reply), but
 * we DO emit a payload-less `heartbeat` so the channel layer can refresh
 * its typing indicator. When the user sees `typing…` come and go in real
 * time, that's pi actually thinking — the indicator vanishing means the
 * model has gone silent (and may be wedged on a tool call).
 *
 * tool_execution_start carries the useful tool name/args and is the primary
 * progress signal. Nameless toolcall_* (pi ≥0.79; formerly tool_use_*) events
 * inside assistantMessageEvent are only liveness noise, so they become
 * `heartbeat` unless they carry a real tool name or useful args.
 *
 * Exported for testing.
 */
export function parsePiEvent(parsed: unknown): HarnessChunk | undefined {
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
    return { type: "progress", note: buildToolNote(toolName, args) };
  }

  // tool_execution_update is fired while a tool is mid-run, carrying its
  // partial result. The capability-routing `coder` tool emits these (via pi's
  // onUpdate) as its child makes real progress, so the PRIMARY stays visibly
  // alive while it's blocked awaiting the delegate. Surface a payload-less
  // heartbeat (no partialResult leak, no spurious bubble flush) — piActivity
  // classifies it as in-tool activity so it RESETS the idle watchdog. Only ever
  // emitted on genuine child output, so a wedged tool still trips the idle kill.
  if (obj.type === "tool_execution_update") {
    return { type: "heartbeat" };
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

  if (typeof ame.type === "string") {
    // Pi also emits assistantMessageEvent toolcall_* / tool_use_* records while
    // streaming the assistant message. In practice these can be nameless
    // internal deltas; surfacing those as progress creates stacks of anonymous
    // "tool" rows in ACP clients. Keep them as liveness heartbeats unless the
    // event itself carries enough detail to title a real tool call. The
    // top-level tool_execution_start remains the canonical useful signal.
    if (ame.type.startsWith("toolcall") || ame.type.startsWith("tool_use")) {
      const note = buildAssistantToolNote(ame);
      return note
        ? { type: "progress", note }
        : { type: "heartbeat" };
    }
    // thinking_delta + anything else → heartbeat.
    // We intentionally do NOT include the content in the chunk (would leak
    // chain-of-thought to the user). The signal is just "pi is alive."
    return { type: "heartbeat" };
  }

  return undefined;
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

function buildAssistantToolNote(ame: Record<string, unknown>): string | undefined {
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

  if (toolName) return buildToolNote(toolName, args);
  const detail = extractUsefulArgDetail(args);
  if (detail) return `tool: ${detail}`;
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
