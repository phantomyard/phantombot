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
 *   tool_execution_start            → { type: "progress", note: "running <tool>" }
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
import { log } from "../lib/logger.ts";

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

    const proc = Bun.spawn([this.config.bin, ...args], {
      cwd: req.workingDir,
      env: process.env,
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    });

    // Same state-machine fix as the Claude harness — boolean instead of
    // a 3-state enum so TS narrowing doesn't fight us.
    let timedOut = false;
    const timeout = setTimeout(() => {
      if (!timedOut) {
        timedOut = true;
        log.warn("pi.invoke timeout", { timeoutMs: req.timeoutMs });
        proc.kill("SIGTERM");
      }
    }, req.timeoutMs);

    void consumeStderr(proc.stderr);

    let buffer = "";
    let finalText = "";
    const decoder = new TextDecoder();

    try {
      for await (const chunk of proc.stdout as ReadableStream<Uint8Array>) {
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
      clearTimeout(timeout);
    }

    if (timedOut) {
      yield {
        type: "error",
        error: `pi timed out after ${req.timeoutMs}ms`,
        recoverable: true,
      };
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
 * Only `assistantMessageEvent.type === "text_delta"` events contribute
 * to the assistant's reply. `thinking_delta` events are the model's
 * chain-of-thought and must be excluded — they'd otherwise leak the
 * model's reasoning into the user-facing reply.
 *
 * Tool execution events (when they appear in the schema for tool-using
 * runs) would map to progress chunks here. Not yet observed in the
 * --print --mode json output for plain conversational turns.
 *
 * Exported for testing.
 */
export function parsePiEvent(parsed: unknown): HarnessChunk | undefined {
  if (typeof parsed !== "object" || parsed === null) return undefined;
  const obj = parsed as Record<string, unknown>;
  if (obj.type !== "message_update") return undefined;

  const ame = obj.assistantMessageEvent;
  if (!isObject(ame)) return undefined;

  if (ame.type === "text_delta") {
    const delta = ame.delta;
    if (typeof delta === "string" && delta.length > 0) {
      return { type: "text", text: delta };
    }
  }

  // tool_use_start (or whatever pi names it for this version) would map to
  // a progress chunk here when we observe it in the wild.

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
