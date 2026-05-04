/**
 * Inflection Pi harness.
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
  createKillCoordinator,
  killCauseToErrorChunk,
} from "../lib/harnessRunner.ts";
import { log } from "../lib/logger.ts";
import { spawnInNewSession } from "../lib/processGroup.ts";

export interface PiHarnessConfig {
  /** Path to the `pi` CLI binary. Default: "pi" (looked up in PATH). */
  bin: string;
  /** Maximum payload size in bytes (system prompt + rendered conversation). */
  maxPayloadBytes: number;
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
      payload,
    ];
    log.debug("pi.invoke spawning", {
      bin: this.config.bin,
      payloadBytes: totalBytes,
    });

    const proc = spawnInNewSession([this.config.bin, ...args], {
      cwd: req.workingDir,
      env: process.env,
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    });

    // Idle + hard timer + abort listener; SIGTERM-then-SIGKILL the whole
    // process group on any of those firing. See harnessRunner.ts for the
    // state machine.
    const killer = createKillCoordinator({
      proc,
      idleTimeoutMs: req.idleTimeoutMs,
      hardTimeoutMs: req.hardTimeoutMs,
      signal: req.signal,
      harnessId: this.id,
    });

    void consumeStderr(proc.stderr);

    let buffer = "";
    let finalText = "";
    const decoder = new TextDecoder();

    try {
      for await (const chunk of proc.stdout as ReadableStream<Uint8Array>) {
        killer.touch();
        buffer += decoder.decode(chunk, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";
        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed) continue;
          let parsed: unknown;
          try {
            parsed = JSON.parse(trimmed);
          } catch {
            yield { type: "progress", note: trimmed };
            continue;
          }
          const c = parsePiEvent(parsed);
          if (c) {
            if (c.type === "text") finalText += c.text;
            yield c;
          }
        }
      }
    } finally {
      await killer.dispose();
    }

    const errChunk = killCauseToErrorChunk(
      killer.killCause(),
      this.id,
      req.hardTimeoutMs,
      req.idleTimeoutMs,
    );
    if (errChunk) {
      yield errChunk;
      return;
    }

    const code = await proc.exited;

    if (code === 0) {
      yield {
        type: "done",
        finalText,
        meta: { harnessId: this.id, payloadBytes: totalBytes },
      };
    } else {
      yield {
        type: "error",
        error: `pi exited with code ${code}`,
        recoverable: code !== 127,
      };
    }
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
 * Schema (verified against pi v0.67.x with `--mode json`):
 *
 *   {"type":"message_update",
 *    "assistantMessageEvent":{
 *       "type":"text_delta"|"thinking_delta"|"tool_use_*"|...,
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
 * tool_use_* event types inside assistantMessageEvent → `progress`
 * so the channel layer flushes narration into a bubble before the tool
 * runs. thinking_delta + other event types → `heartbeat`.
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
    const toolName = typeof obj.tool_name === "string" ? obj.tool_name : undefined;
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
    // tool_use_* assistantMessageEvent: the model has decided to call
    // a tool — emit `progress` so the channel layer flushes narration
    // into a bubble before the tool runs. Previously these were mapped
    // to heartbeats, which kept the typing indicator alive but never
    // triggered a bubble flush (defeating the purpose of PR #74).
    if ((ame.type as string).startsWith("tool_use")) {
      return { type: "progress", note: "tool" };
    }
    // thinking_delta + anything else → heartbeat.
    // We intentionally do NOT include the content in the chunk (would leak
    // chain-of-thought to the user). The signal is just "pi is alive."
    return { type: "heartbeat" };
  }

  return undefined;
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

async function consumeStderr(
  stream: ReadableStream<Uint8Array>,
): Promise<void> {
  const decoder = new TextDecoder();
  let buf = "";
  try {
    for await (const chunk of stream) {
      buf += decoder.decode(chunk, { stream: true });
      const lines = buf.split("\n");
      buf = lines.pop() ?? "";
      for (const line of lines) {
        if (line.trim()) {
          log.debug("pi stderr", { text: line.slice(0, 500) });
        }
      }
    }
  } catch {
    /* swallow */
  }
}
