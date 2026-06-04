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
import { reloadEnvFiles, withPersonaEnv } from "../lib/envBootstrap.ts";
import {
  type HarnessActivity,
  runHarnessProcess,
} from "../lib/harnessRunner.ts";
import { log } from "../lib/logger.ts";
import { killProcessGroup, spawnInNewSession } from "../lib/processGroup.ts";

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
      // Skip gemini-cli's per-session workspace-trust handshake. In headless
      // mode the trust prompt can stall startup; phantombot already runs on a
      // trusted host. Safe for both normal and judge (read-only) modes.
      // NB: we deliberately keep `-o stream-json` (NOT `-o text`) — the
      // stream-json event feed is what drives heartbeats / wedge detection;
      // collapsing to text would blind the channel layer (see header comment).
      // We also do NOT pass `-e` (extension pinning) so any Workspace
      // connector extensions Andrew configures keep loading.
      "--skip-trust",
    ];
    // Tool-less threat-judge mode → `--approval-mode plan` (per `gemini
    // --help`: "plan (read-only mode)"). The judge may read but cannot act.
    // Normal turns → `-y` (yolo: auto-approve all tools) so headless tool
    // loops don't block on an approval prompt.
    if (req.toolsMode === "none") {
      args.push("--approval-mode", "plan");
    } else {
      args.push("-y");
    }
    if (this.config.model && this.config.model.length > 0) {
      args.push("-m", this.config.model);
    }
    log.debug("gemini.invoke spawning", {
      bin: this.config.bin,
      model: this.config.model || "(default)",
      stdinBytes: Buffer.byteLength(stdinPayload, "utf8"),
      userMessageBytes: Buffer.byteLength(req.userMessage, "utf8"),
    });

    // Re-source ~/.env so secrets saved by the agent on the previous turn
    // (`phantombot env set FOO bar`) are visible here without a daemon
    // restart. See envBootstrap.ts for the sticky-vs-reloadable rules.
    await reloadEnvFiles();

    const proc = spawnInNewSession([this.config.bin, ...args], {
      cwd: req.workingDir,
      env: withPersonaEnv(process.env, req.persona),
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
    });

    // Watch stderr for HTTP 4XX errors emerging from gemini-cli's built-in
    // retryWithBackoff loop. Once we spot a 4XX, kill the subprocess
    // immediately so the orchestrator can fall through to the next harness
    // without waiting for gemini-cli to finish its own ~2-minute retry budget.
    // The status is stored here and surfaced in the post-loop error chunk
    // (runHarnessProcess's earlyError hook, which wins over kill-cause/exit).
    // The grandchild kill via process group is the whole point: gemini-cli
    // routinely spawns tool subprocesses (the kw-openclaw bug was `gemini
    // usage` wedged on a TCP read; without process-group kill that orphan
    // survived its parent and held the socket open).
    const httpStatusBox: { status?: number } = {};
    const onStderrLine = (line: string): void => {
      const text = line.slice(0, 500);
      if (GEMINI_STDERR_BANNER_PATTERNS.some((re) => re.test(line))) {
        log.debug("gemini stderr (banner)", { text });
        return;
      }
      const status = extractHttpStatus(line);
      if (status !== undefined) {
        log.info("gemini stderr", { text });
        if (httpStatusBox.status === undefined) {
          httpStatusBox.status = status; // first one wins
          log.warn(
            "gemini stderr: 4XX detected, killing early for fast fallback",
            { httpStatus: status },
          );
          // Fire-and-forget — process group SIGTERM → 5 s grace → SIGKILL.
          // The shared pump's for-await over stdout ends naturally as the
          // kernel closes the pipe.
          void killProcessGroup(proc, 5000);
        }
        return;
      }
      log.info("gemini stderr", { text });
    };

    // Shared engine. gemini's extras: payload split (system+history on stdin,
    // new message via -p in args), a decoder-tail flush for the trailing
    // result line, non-JSON lines logged at debug, and the 4XX early-error
    // hook above. The terminal `done` meta carries reply bytes + result stats.
    yield* runHarnessProcess({
      proc,
      req,
      harnessId: this.id,
      stdinPayload,
      parseEvent: parseGeminiEvent,
      activity: geminiActivity,
      progressNoteLimit: 200,
      flushTail: true,
      onNonJsonLine: (line) =>
        log.debug("gemini: non-JSON stdout line", { line: line.slice(0, 200) }),
      onStderrLine,
      earlyError: () =>
        httpStatusBox.status === undefined
          ? undefined
          : {
              type: "error",
              error: `gemini upstream HTTP ${httpStatusBox.status}; aborted gemini-cli's internal retry loop for fast fallback`,
              recoverable: true,
              httpStatus: httpStatusBox.status,
            },
      buildDoneMeta: (finalText, captured) => ({
        harnessId: this.id,
        model: this.config.model || "(default)",
        replyBytes: Buffer.byteLength(finalText, "utf8"),
        ...(captured ?? {}),
      }),
    });
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

function geminiActivity(
  parsed: unknown,
  chunk: HarnessChunk,
): HarnessActivity {
  if (chunk.type === "text" || chunk.type === "done") return "productive";
  if (typeof parsed !== "object" || parsed === null) {
    return chunk.type === "heartbeat" ? "model" : "productive";
  }
  const type = (parsed as Record<string, unknown>).type;
  if (type === "tool_use") return "tool";
  if (type === "tool_result") return "productive";
  return chunk.type === "heartbeat" ? "model" : "productive";
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

/**
 * Match patterns for HTTP status lines emitted by gemini-cli's
 * Gaxios-based fetch wrapper. The shapes seen in production
 * (verified against gemini-cli v0.40.x stderr on a 429 capacity
 * exhaustion):
 *
 *   "Attempt 1 failed with status 429. Retrying with backoff..."
 *   "status: 429,"
 *
 * The first form is gemini-cli's retryWithBackoff trace; the second
 * is the Gaxios error body Node.js stringifies. We look for either —
 * the first signal we see kicks the early-kill path. Capturing only
 * 4XX (4\d\d) on purpose: 5XX is genuinely transient and the
 * upstream's own retry usually clears it within a couple of seconds,
 * which is faster than burning a fallback hop.
 *
 * Exported for testing.
 */
export const GEMINI_HTTP_STATUS_PATTERNS: readonly RegExp[] = [
  /Attempt\s+\d+\s+failed\s+with\s+status\s+(4\d\d)\b/i,
  /^\s*status:\s*(4\d\d)\s*,?\s*$/i,
];

/**
 * Scan one stderr line for a 4XX HTTP status; return the captured
 * code if any pattern matches. Exported for testing.
 */
export function extractHttpStatus(line: string): number | undefined {
  for (const re of GEMINI_HTTP_STATUS_PATTERNS) {
    const m = re.exec(line);
    if (m && m[1]) {
      const code = Number.parseInt(m[1], 10);
      if (Number.isFinite(code) && code >= 400 && code < 500) {
        return code;
      }
    }
  }
  return undefined;
}
