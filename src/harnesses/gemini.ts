/**
 * Google Gemini CLI harness — wraps `gemini` (the open-source agentic
 * CLI from google-gemini/gemini-cli).
 *
 * Spawn shape: `gemini -p <new_user_message> -o stream-json -y [-m <model>]`.
 *   - `-p` (required) puts the binary in non-interactive headless mode.
 *     Per `gemini --help`, the -p value is appended to whatever's on
 *     stdin — so we send the system prompt + prior turns via stdin and
 *     use -p for just the new user message. This keeps the argv small
 *     enough that ARG_MAX isn't a concern (Pi has the same problem and
 *     guards it with maxPayloadBytes; gemini's stdin+argv split avoids it).
 *   - `-o stream-json` emits one JSON object per line for every internal
 *     event: init, user-echo, tool_use, tool_result, assistant-message
 *     deltas, and a final result with token stats. We map those into
 *     phantombot's HarnessChunk taxonomy (see parseGeminiEvent below).
 *     This replaces the v1 `-o text` mode, which collapsed everything
 *     to a single blob and gave the channel layer no way to distinguish
 *     "model is thinking" from "model is silent / wedged."
 *   - `-y` (yolo): auto-approve all tool calls. Required for headless
 *     because the default mode prompts for approval, which would block
 *     forever in a non-interactive subprocess. Same posture phantombot
 *     uses for Claude (`--permission-mode bypassPermissions`).
 *   - `-m` is only passed when config.model is non-empty; otherwise we
 *     let gemini-cli pick its own default.
 *
 * Auth (matches Pi's lighter touch, NOT Claude's strict filter): we
 * don't strip GEMINI_API_KEY / GOOGLE_API_KEY from the spawn env.
 * If the user has a key in ~/.env, gemini uses it. If they ran `gemini`
 * interactively once and OAuth'd, gemini uses that. Whichever wins is
 * up to gemini-cli's own resolution. Claude is the special case
 * (we filter ANTHROPIC_API_KEY) because a stray env var there would
 * silently switch from OAuth to API-key mode with different billing.
 *
 * No --system-prompt flag exists in gemini-cli. The harness builds the
 * prompt as a transcript: system text first, then "User: …" /
 * "Assistant: …" turns. Modern chat models recognize this format.
 */

import { access, constants } from "node:fs/promises";
import type { Harness, HarnessChunk, HarnessRequest } from "./types.ts";
import {
  createKillCoordinator,
  killCauseToErrorChunk,
} from "../lib/harnessRunner.ts";
import { log } from "../lib/logger.ts";
import { spawnInNewSession } from "../lib/processGroup.ts";

/**
 * Conservative ceiling on the bytes we'll put on argv via the `-p`
 * flag. Linux ARG_MAX is typically 2 MiB on modern desktop/server
 * kernels but can be as low as 128 KiB on embedded builds, and the
 * usable budget is reduced by environment + other argv. 1 MiB stays
 * well clear on every reasonable target while still being big enough
 * for any plausible chat / voice-transcript / paste.
 *
 * NOT exposed via GeminiHarnessConfig in v1 — if a user runs into it,
 * the recoverable error from the precheck guides them. We can promote
 * it to config later if it actually bites.
 */
const MAX_USER_MESSAGE_BYTES = 1_000_000;

export interface GeminiHarnessConfig {
  /** Path to the `gemini` CLI binary. Default: "gemini" (PATH lookup). */
  bin: string;
  /**
   * Model id (e.g. "gemini-2.5-pro"). Empty string means "let gemini-cli
   * pick its own default" — we don't pass `-m` at all.
   */
  model: string;
}

export class GeminiHarness implements Harness {
  readonly id = "gemini";

  constructor(private readonly config: GeminiHarnessConfig) {}

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
    // ARG_MAX guard. We do NOT declare class-level `maxPayloadBytes`
    // because the orchestrator's estimatePayloadBytes() sums
    // system+history+userMessage — which would over-skip Gemini for
    // big histories that travel via stdin and never touch argv. The
    // only thing that actually rides on argv is `-p <userMessage>`,
    // so we precheck just that one length and yield a recoverable
    // error if it would blow past ARG_MAX. The orchestrator then
    // falls through to the next harness in the chain.
    const userMessageBytes = Buffer.byteLength(req.userMessage, "utf8");
    if (userMessageBytes > MAX_USER_MESSAGE_BYTES) {
      yield {
        type: "error",
        error: `gemini userMessage ${userMessageBytes} bytes exceeds argv limit ${MAX_USER_MESSAGE_BYTES} (linux ARG_MAX); falling through to next harness`,
        recoverable: true,
      };
      return;
    }

    const stdinPayload = renderStdinPayload(req);
    const args: string[] = [
      "-p", req.userMessage,
      "-o", "stream-json",
      "-y",
    ];
    if (this.config.model && this.config.model.length > 0) {
      args.push("-m", this.config.model);
    }
    log.debug("gemini.invoke spawning", {
      bin: this.config.bin,
      model: this.config.model || "(default)",
      stdinBytes: Buffer.byteLength(stdinPayload, "utf8"),
      userMessageBytes: Buffer.byteLength(req.userMessage, "utf8"),
    });

    const proc = spawnInNewSession([this.config.bin, ...args], {
      cwd: req.workingDir,
      env: process.env,
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
    });

    // Idle + hard timer + abort listener. SIGTERM the whole process group
    // on any of those firing, escalate to SIGKILL after 5s grace. The
    // grandchild kill is the whole point: gemini-cli routinely spawns
    // tool subprocesses (the kw-openclaw bug was `gemini usage` wedged
    // on a TCP read; without process-group kill, that orphan survived
    // its parent dying and held the socket open).
    const killer = createKillCoordinator({
      proc,
      idleTimeoutMs: req.idleTimeoutMs,
      hardTimeoutMs: req.hardTimeoutMs,
      signal: req.signal,
      harnessId: this.id,
    });

    // Write the system prompt + history to stdin and close it. gemini
    // appends the -p value (the new user message) to whatever stdin
    // delivers, so the model sees: <system>\n\n<history>\n\n<user msg>.
    try {
      proc.stdin.write(stdinPayload);
      await proc.stdin.end();
    } catch (e) {
      log.warn("gemini.invoke stdin write failed", {
        error: (e as Error).message,
      });
    }

    void consumeStderr(proc.stderr);

    let buffer = "";
    let finalText = "";
    let resultMeta: Record<string, unknown> | undefined;
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
          // Tolerate non-JSON noise that gemini-cli sometimes prints
          // ahead of the stream (e.g. terminal-color warnings, "YOLO
          // mode is enabled"). Surfaced as low-noise progress notes
          // rather than dropped, so they show up in /status diagnostics.
          // Also logged at debug level so a future gemini-cli schema
          // change that produces unexpected non-JSON shows up in the
          // journal without needing to reproduce live.
          let parsed: unknown;
          try {
            parsed = JSON.parse(trimmed);
          } catch {
            log.debug("gemini: non-JSON stdout line", {
              line: trimmed.slice(0, 200),
            });
            yield { type: "progress", note: trimmed.slice(0, 200) };
            continue;
          }
          const c = parseGeminiEvent(parsed);
          if (!c) continue;
          if (c.type === "text") finalText += c.text;
          if (c.type === "done") {
            // gemini's `result` event carries the authoritative stats.
            // We hold them in resultMeta and emit a single done chunk
            // after the loop so the orchestrator sees one terminal event.
            resultMeta = c.meta;
            continue;
          }
          yield c;
        }
      }
      // Flush any pending bytes in the decoder.
      buffer += decoder.decode();
      const tail = buffer.trim();
      if (tail) {
        try {
          const c = parseGeminiEvent(JSON.parse(tail));
          if (c) {
            if (c.type === "text") finalText += c.text;
            if (c.type === "done") resultMeta = c.meta;
            else yield c;
          }
        } catch {
          /* drop trailing partial line */
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

    if (code !== 0) {
      yield {
        type: "error",
        error: `gemini exited with code ${code}`,
        // 127 = "command not found"; not recoverable by retrying the next harness
        // (the binary itself is missing). Other non-zero exits are typically
        // model/network/auth issues that the next harness in the chain can handle.
        recoverable: code !== 127,
      };
      return;
    }

    yield {
      type: "done",
      finalText,
      meta: {
        harnessId: this.id,
        model: this.config.model || "(default)",
        replyBytes: Buffer.byteLength(finalText, "utf8"),
        ...(resultMeta ?? {}),
      },
    };
  }
}

/**
 * Translate one gemini stream-json event line into a HarnessChunk.
 *
 * Schema (verified against gemini-cli v0.40.x with `-o stream-json`):
 *
 *   {"type":"init","session_id":"...","model":"..."}
 *   {"type":"message","role":"user","content":"..."}            // input echo
 *   {"type":"tool_use","tool_name":"...","tool_id":"...",
 *      "parameters":{...}}
 *   {"type":"tool_result","tool_id":"...","status":"success"}
 *   {"type":"message","role":"assistant","content":"...",
 *      "delta":true}                                             // reply token
 *   {"type":"result","status":"...","stats":{
 *      "total_tokens":N, "input_tokens":N, "output_tokens":N,
 *      "duration_ms":N, "tool_calls":N, ... }}
 *
 * Mapping rules:
 *   - assistant message (delta or full) → `text` chunk
 *   - tool_use → `progress` chunk; the note is "tool: <name>" so /status
 *     can surface "currently: tool: run_shell_command" without the channel
 *     layer needing gemini-specific knowledge
 *   - tool_result → `heartbeat` (signal only; the actual output already
 *     went into the model's context for synthesis)
 *   - result → synthetic `done` chunk carrying the stats as meta
 *   - init / user-echo → ignored (no signal value for the user)
 *
 * Exported for testing.
 */
export function parseGeminiEvent(parsed: unknown): HarnessChunk | undefined {
  if (typeof parsed !== "object" || parsed === null) return undefined;
  const obj = parsed as Record<string, unknown>;
  const type = obj.type;
  if (typeof type !== "string") return undefined;

  if (type === "message") {
    if (obj.role !== "assistant") return undefined;
    const content = obj.content;
    if (typeof content !== "string" || content.length === 0) return undefined;
    return { type: "text", text: content };
  }

  if (type === "tool_use") {
    const name =
      typeof obj.tool_name === "string" ? obj.tool_name : "(unknown tool)";
    return { type: "progress", note: `tool: ${name}` };
  }

  if (type === "tool_result") {
    return { type: "heartbeat" };
  }

  if (type === "result") {
    // Caller treats this as a "done"-shaped event for stats capture.
    const stats =
      typeof obj.stats === "object" && obj.stats !== null
        ? (obj.stats as Record<string, unknown>)
        : undefined;
    return {
      type: "done",
      finalText: "", // caller maintains its own running concat from text chunks
      meta: stats ? { stats } : undefined,
    };
  }

  return undefined;
}

/**
 * Build the stdin payload: system prompt + alternating "User:/Assistant:"
 * turns of prior history. The new user message is delivered via -p (NOT
 * here) and gemini-cli appends it after stdin per the documented contract.
 *
 * Exported for testing.
 */
export function renderStdinPayload(req: HarnessRequest): string {
  const parts: string[] = [];
  if (req.systemPrompt && req.systemPrompt.trim().length > 0) {
    parts.push(req.systemPrompt.trim());
  }
  if (req.history.length > 0) {
    const lines: string[] = [];
    for (const turn of req.history) {
      const tag = turn.role === "user" ? "User" : "Assistant";
      lines.push(`${tag}: ${turn.text}`);
    }
    parts.push(lines.join("\n\n"));
  }
  // Trailing newline so gemini's append doesn't run -p text into the
  // last line of stdin without a separator.
  return parts.join("\n\n") + (parts.length > 0 ? "\n\n" : "");
}

/**
 * Per-invocation banner lines that gemini-cli always prints — useless
 * noise at info level. Anything else (auth failures, quota errors,
 * network warnings) gets surfaced so journalctl shows it without needing
 * PHANTOMBOT_LOG_LEVEL=debug.
 */
const GEMINI_STDERR_BANNER_PATTERNS: readonly RegExp[] = [
  /^Warning: 256-color support not detected/i,
  /^YOLO mode is enabled/i,
  /^Ripgrep is not available/i,
];

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
        const trimmed = line.trim();
        if (!trimmed) continue;
        if (GEMINI_STDERR_BANNER_PATTERNS.some((re) => re.test(trimmed))) {
          log.debug("gemini stderr (banner)", { text: trimmed.slice(0, 500) });
          continue;
        }
        log.info("gemini stderr", { text: trimmed.slice(0, 500) });
      }
    }
  } catch {
    /* swallow */
  }
}
