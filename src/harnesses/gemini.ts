/**
 * Google Gemini CLI harness — wraps `gemini` (the open-source agentic
 * CLI from google-gemini/gemini-cli).
 *
 * Spawn shape: `gemini -p <new_user_message> -o text -y [-m <model>]`.
 *   - `-p` (required) puts the binary in non-interactive headless mode.
 *     Per `gemini --help`, the -p value is appended to whatever's on
 *     stdin — so we send the system prompt + prior turns via stdin and
 *     use -p for just the new user message. This keeps the argv small
 *     enough that ARG_MAX isn't a concern (Pi has the same problem and
 *     guards it with maxPayloadBytes; gemini's stdin+argv split avoids it).
 *   - `-o text` (v1): collect all stdout, emit one text + one done
 *     chunk on exit 0. Stream-json upgrade is a follow-up — needs a
 *     real schema sample, not a guess.
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
import { log } from "../lib/logger.ts";

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
    const stdinPayload = renderStdinPayload(req);
    const args: string[] = [
      "-p", req.userMessage,
      "-o", "text",
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

    const proc = Bun.spawn([this.config.bin, ...args], {
      cwd: req.workingDir,
      env: process.env,
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
    });

    // Same boolean-state-machine pattern as the Claude / Pi harnesses:
    // a 3-state enum fights TS narrowing inside the for-await loop.
    let timedOut = false;
    const timeout = setTimeout(() => {
      if (!timedOut) {
        timedOut = true;
        log.warn("gemini.invoke timeout", { timeoutMs: req.timeoutMs });
        proc.kill("SIGTERM");
      }
    }, req.timeoutMs);

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

    let finalText = "";
    const decoder = new TextDecoder();

    try {
      for await (const chunk of proc.stdout as ReadableStream<Uint8Array>) {
        finalText += decoder.decode(chunk, { stream: true });
      }
      // Flush any pending bytes in the decoder.
      finalText += decoder.decode();
    } finally {
      clearTimeout(timeout);
    }

    if (timedOut) {
      yield {
        type: "error",
        error: `gemini timed out after ${req.timeoutMs}ms`,
        recoverable: true,
      };
      return;
    }

    const code = await proc.exited;

    if (code !== 0) {
      yield {
        type: "error",
        error: `gemini exited with code ${code}${finalText ? `: ${finalText.slice(0, 200)}` : ""}`,
        // 127 = "command not found"; not recoverable by retrying the next harness
        // (the binary itself is missing). Other non-zero exits are typically
        // model/network/auth issues that the next harness in the chain can handle.
        recoverable: code !== 127,
      };
      return;
    }

    // v1 emits the whole reply as one text chunk + a done. Stream-json
    // upgrade is a follow-up.
    if (finalText.length > 0) {
      yield { type: "text", text: finalText };
    }
    yield {
      type: "done",
      finalText,
      meta: {
        harnessId: this.id,
        model: this.config.model || "(default)",
        replyBytes: Buffer.byteLength(finalText, "utf8"),
      },
    };
  }
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
          log.debug("gemini stderr", { text: line.slice(0, 500) });
        }
      }
    }
  } catch {
    /* swallow */
  }
}
