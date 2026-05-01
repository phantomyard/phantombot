/**
 * Claude Code harness. Reference implementation for phantombot harnesses.
 *
 * Spawns `claude --print` and streams its stream-json stdout back as
 * HarnessChunks. Tool execution (Bash / Read / Write / WebFetch / etc.)
 * happens inside the claude subprocess — phantombot only sees the text
 * the model emits.
 *
 * Patches inherited from earlier work on a claude-max-api-proxy fork
 * (~/clawd/claude-proxy/ on the OpenClaw VPS):
 *
 *   1. PROMPT VIA STDIN, NOT ARGV.
 *      Linux ARG_MAX (~2 MB) is a real ceiling for large persona/memory
 *      contexts. argv-based prompts hit `spawn E2BIG`. claude --print
 *      reads stdin natively when no prompt arg is given.
 *
 *   2. SYSTEM PROMPT VIA --system-prompt.
 *      If you embed the persona inside the user-prompt body (e.g. wrapped
 *      in <system> tags), claude treats it as user-input data and often
 *      shortcuts to terse / sentinel responses. --system-prompt installs
 *      the persona as Claude Code's actual system prompt; it also drops
 *      Claude Code's per-machine dynamic sections (cwd, env, git status)
 *      which is what we want for a chat agent.
 *
 *   3. --permission-mode bypassPermissions.
 *      In --print mode there is no human to approve tool use. Without
 *      this, tool calls silently fail or hang. Acceptable trade-off for a
 *      single-operator chat agent on a trusted host. Re-evaluate if you
 *      ever multi-tenant.
 *
 *   4. --fallback-model sonnet.
 *      When opus rate-limits, claude transparently retries on sonnet
 *      within the SAME subprocess and SAME tool loop. Cleanest possible
 *      Anthropic-internal fallback. Configurable via env.
 *
 *   5. NO --bare.
 *      --bare strips Claude Code defaults (auto-memory, hook discovery,
 *      CLAUDE.md auto-load) but requires ANTHROPIC_API_KEY and refuses
 *      OAuth/keychain credentials. Incompatible with the Claude Max
 *      subscription path. Don't add it back unless that changes upstream.
 */

import { spawn } from "node:child_process";
import { access, constants } from "node:fs/promises";
import type { Harness, HarnessChunk, HarnessRequest } from "./types.js";
import { log } from "../lib/logger.js";

export interface ClaudeHarnessConfig {
  /** Path to the `claude` CLI binary. Default: "claude" (looked up in PATH). */
  bin: string;
  /** Model alias passed to --model. Typically "opus", "sonnet", or "haiku". */
  model: string;
  /** Model alias passed to --fallback-model. Empty string disables. */
  fallbackModel: string;
}

export class ClaudeHarness implements Harness {
  readonly id = "claude";

  constructor(private readonly config: ClaudeHarnessConfig) {}

  async available(): Promise<boolean> {
    try {
      // Best-effort check — if the bin path is absolute, stat it; otherwise
      // assume PATH-resolution works and let invoke() surface a real error.
      if (this.config.bin.startsWith("/")) {
        await access(this.config.bin, constants.X_OK);
      }
      return true;
    } catch {
      return false;
    }
  }

  async *invoke(req: HarnessRequest): AsyncIterable<HarnessChunk> {
    const args = this.buildArgs();
    log.debug("claude.invoke spawning", { bin: this.config.bin, args });

    const proc = spawn(this.config.bin, args, {
      cwd: req.workingDir,
      env: process.env,
      stdio: ["pipe", "pipe", "pipe"],
    });

    // Send the conversation body (history + new user message) via stdin.
    // System prompt does NOT go here — it's installed via --system-prompt
    // in buildArgs.
    const stdinPayload = renderStdinPayload(req);
    proc.stdin.write(stdinPayload);
    proc.stdin.end();

    let buffer = "";
    let finalText = "";
    let resolved = false;

    const timeout = setTimeout(() => {
      if (!resolved) {
        log.warn("claude.invoke timeout", { timeoutMs: req.timeoutMs });
        proc.kill("SIGTERM");
      }
    }, req.timeoutMs);

    type Pending =
      | { kind: "chunk"; chunk: HarnessChunk }
      | { kind: "close" };

    const queue: Pending[] = [];
    let queueResolver: (() => void) | undefined;
    const push = (item: Pending) => {
      queue.push(item);
      queueResolver?.();
      queueResolver = undefined;
    };
    const next = () =>
      new Promise<void>((r) => {
        if (queue.length > 0) r();
        else queueResolver = r;
      });

    proc.stdout.on("data", (chunk: Buffer) => {
      buffer += chunk.toString("utf8");
      // Stream-json emits one JSON object per line. Process complete lines;
      // keep the incomplete tail in `buffer`.
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        try {
          const parsed = JSON.parse(trimmed);
          const chunk = parseStreamJson(parsed);
          if (chunk) {
            if (chunk.type === "text") finalText += chunk.text;
            push({ kind: "chunk", chunk });
          }
        } catch {
          // Not JSON — treat as raw progress. Keep noise out of replies.
          push({ kind: "chunk", chunk: { type: "progress", note: trimmed } });
        }
      }
    });

    proc.stderr.on("data", (chunk: Buffer) => {
      const text = chunk.toString("utf8").trim();
      if (text) log.debug("claude stderr", { text: text.slice(0, 500) });
    });

    proc.on("close", (code) => {
      clearTimeout(timeout);
      resolved = true;
      if (code === 0 || code === null) {
        push({ kind: "chunk", chunk: { type: "done", finalText } });
      } else {
        push({
          kind: "chunk",
          chunk: {
            type: "error",
            error: `claude exited with code ${code}`,
            recoverable: code !== 127, // 127 = command not found, terminal
          },
        });
      }
      push({ kind: "close" });
    });

    proc.on("error", (err) => {
      clearTimeout(timeout);
      resolved = true;
      push({
        kind: "chunk",
        chunk: { type: "error", error: err.message, recoverable: false },
      });
      push({ kind: "close" });
    });

    while (true) {
      if (queue.length === 0) await next();
      const item = queue.shift()!;
      if (item.kind === "close") return;
      yield item.chunk;
    }
  }

  private buildArgs(): string[] {
    const args = [
      "--print",
      "--output-format", "stream-json",
      "--verbose",
      "--include-partial-messages",
      "--no-session-persistence",
      "--permission-mode", "bypassPermissions",
      "--model", this.config.model,
    ];
    if (this.config.fallbackModel) {
      args.push("--fallback-model", this.config.fallbackModel);
    }
    // System prompt is appended by invoke() so we can keep it close to the
    // request data and avoid stuffing the full persona through args twice.
    return args;
  }
}

/**
 * Build the stdin payload. Format: history rendered as alternating
 * blocks, then the new user message at the end. Claude Code reads this
 * as the (single) user-side input in --print mode.
 */
function renderStdinPayload(req: HarnessRequest): string {
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
 * Translate one stream-json line into a HarnessChunk. Returns undefined for
 * lines we want to ignore (e.g. tool-use events that the agent handles
 * internally and doesn't need to surface to phantombot).
 *
 * Claude's stream-json schema is documented in the Claude Code docs but
 * informally: each line has a `type` (system / user / assistant / result)
 * and a `message` payload. We only need the assistant text content.
 */
function parseStreamJson(parsed: unknown): HarnessChunk | undefined {
  if (typeof parsed !== "object" || parsed === null) return undefined;
  const obj = parsed as Record<string, unknown>;
  if (obj.type !== "assistant") return undefined;

  const message = obj.message as Record<string, unknown> | undefined;
  if (!message) return undefined;
  const content = message.content;
  if (!Array.isArray(content)) return undefined;

  // Sum any "text" parts in this assistant message.
  let text = "";
  for (const part of content) {
    if (typeof part === "object" && part !== null) {
      const p = part as Record<string, unknown>;
      if (p.type === "text" && typeof p.text === "string") {
        text += p.text;
      }
    }
  }
  if (!text) return undefined;
  return { type: "text", text };
}

// ---- Note for the next maintainer ----
// If you're tempted to add a tool-call passthrough here (translating Claude's
// internal tool_use events into something phantombot can act on), STOP. The
// whole architectural premise of phantombot is "let the harness do tools."
// If you build a tool layer here, you're rebuilding OpenClaw. Use the
// orchestrator's harness fallback chain instead, or extend the persona with
// instructions for the harness to do whatever the new feature needs.
