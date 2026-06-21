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
 * Auth (OAuth-on-host model): phantombot does NOT pass --api-key. Pi
 * resolves credentials from its own configured state (~/.config/pi/ or
 * similar). `phantombot doctor` surfaces failure if Pi isn't configured.
 *
 * ARG_MAX guard: declares maxPayloadBytes so the orchestrator's fallback
 * skips Pi for oversized turns. Internal precheck mirrors that so a
 * direct invoke() with a too-large payload still fails recoverably.
 */

import { access, constants } from "node:fs/promises";
import type { Harness, HarnessChunk, HarnessRequest } from "./types.ts";
import {
  ENV_CODING_MODEL,
  ENV_IMAGE_MODEL,
  ENV_PRIMARY_MODEL,
  type PiRoutingConfig,
} from "../lib/piRouting.ts";
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
   * it does two runtime things, both required for routing to actually take
   * effect (a TOML-only install would otherwise be inert):
   *   1. `primaryModel` pins the orchestrator model via `--model` on the Pi
   *      CLI — without this the saved primary is never honored, Pi just uses
   *      its own default.
   *   2. all three resolved models are projected into the spawned Pi env
   *      (PHANTOMBOT_PRIMARY/IMAGE/CODING_MODEL) so the bundled extension sees
   *      them even when they live only in config.toml (the wizard's ~/.env
   *      write would otherwise be the only path that reaches the child).
   * Absent = no per-capability routing (Pi uses its configured default model).
   */
  routing?: PiRoutingConfig;
}

/**
 * Project the resolved routing models onto a child-process env. Only DEFINED
 * values are written; undefined keys are left untouched so a directly-exported
 * env var is never clobbered (the wizard already clears stale keys at write
 * time via computeRoutingWrites). Exported for testing.
 */
export function applyRoutingEnv(
  env: Record<string, string | undefined>,
  routing: PiRoutingConfig | undefined,
): Record<string, string | undefined> {
  if (!routing) return env;
  const out = { ...env };
  if (routing.primaryModel !== undefined) out[ENV_PRIMARY_MODEL] = routing.primaryModel;
  if (routing.imageModel !== undefined) out[ENV_IMAGE_MODEL] = routing.imageModel;
  if (routing.codingModel !== undefined) out[ENV_CODING_MODEL] = routing.codingModel;
  return out;
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
    const primaryModel = this.config.routing?.primaryModel;
    if (primaryModel) {
      args.push("--model", primaryModel);
    }
    // Tool-less threat-judge mode. Per `pi --help`, `--no-tools` disables all
    // tools (built-in, extension, and custom) — true zero-tools, native flag,
    // no deny-list to maintain.
    if (req.toolsMode === "none") {
      args.push("--no-tools");
    }
    // Payload is the LAST positional arg (pi reads it from argv, not stdin).
    args.push(payload);
    log.debug("pi.invoke spawning", {
      bin: this.config.bin,
      payloadBytes: totalBytes,
    });

    // Re-source ~/.env so secrets saved by the agent on the previous turn
    // (`phantombot env set FOO bar`) are visible here without a daemon
    // restart. See envBootstrap.ts for the sticky-vs-reloadable rules.
    await reloadEnvFiles();

    const proc = spawnInNewSession([this.config.bin, ...args], {
      cwd: req.workingDir,
      // Project resolved routing models into the child so the bundled
      // extension sees them even on a TOML-only install (no ~/.env write).
      env: applyRoutingEnv(
        withPersonaEnv(process.env, req.persona, req.conversation),
        this.config.routing,
      ),
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
 * toolcall_* (pi ≥0.79; formerly tool_use_*) event types inside
 * assistantMessageEvent → `progress` so the channel layer flushes narration
 * into a bubble before the tool runs. thinking_delta + other event types →
 * `heartbeat`.
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
    return { type: "progress", note: toolName ? `tool: ${toolName}` : "tool" };
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
    // toolcall_* assistantMessageEvent: the model has decided to call
    // a tool — emit `progress` so the channel layer flushes narration
    // into a bubble before the tool runs. Previously these were mapped
    // to heartbeats, which kept the typing indicator alive but never
    // triggered a bubble flush (defeating the purpose of PR #74).
    //
    // pi 0.79.x renamed these events `tool_use_*` → `toolcall_*`. Match
    // both prefixes so narration surfaces across pi versions.
    if (ame.type.startsWith("toolcall") || ame.type.startsWith("tool_use")) {
      return { type: "progress", note: "tool" };
    }
    // thinking_delta + anything else → heartbeat.
    // We intentionally do NOT include the content in the chunk (would leak
    // chain-of-thought to the user). The signal is just "pi is alive."
    return { type: "heartbeat" };
  }

  return undefined;
}

function piActivity(parsed: unknown, chunk: HarnessChunk): HarnessActivity {
  if (chunk.type === "text" || chunk.type === "done") return "productive";
  if (typeof parsed !== "object" || parsed === null) {
    return chunk.type === "heartbeat" ? "model" : "productive";
  }
  const obj = parsed as Record<string, unknown>;
  if (obj.type === "tool_execution_start") return "tool";
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
