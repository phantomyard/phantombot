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
 *
 * Auth model under phantombot:
 *   ANTHROPIC_API_KEY is filtered out of the subprocess env so claude
 *   resolves credentials from ~/.claude/.credentials.json (the OAuth
 *   path that backs Claude Max). Phantombot does not hold or pass any
 *   API keys.
 */

import { access, constants } from "node:fs/promises";
import type { Harness, HarnessChunk, HarnessRequest } from "./types.ts";
import { log } from "../lib/logger.ts";

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

  async *invoke(req: HarnessRequest): AsyncGenerator<HarnessChunk> {
    const args = this.buildArgs(req.systemPrompt);
    log.debug("claude.invoke spawning", {
      bin: this.config.bin,
      argCount: args.length,
    });

    // OAuth-on-host: don't leak ANTHROPIC_API_KEY into the subprocess env,
    // so claude resolves credentials from ~/.claude/.credentials.json.
    const env = filterAuthEnv(process.env);

    const proc = Bun.spawn([this.config.bin, ...args], {
      cwd: req.workingDir,
      env,
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
    });

    proc.stdin.write(renderStdinPayload(req));
    proc.stdin.end();

    // STATE-MACHINE FIX (was the timeout-vs-close bug in the Node skeleton):
    // a SIGTERM-by-timeout kill must be distinguishable from a normal exit.
    // The pre-Bun version emitted `done` with whatever partial text it had
    // collected, which masked timeouts as successful short replies. We track
    // the timeout via a closure-captured boolean so the post-loop branch
    // surfaces the timeout as a recoverable error instead.
    let timedOut = false;
    const timeout = setTimeout(() => {
      if (!timedOut) {
        timedOut = true;
        log.warn("claude.invoke timeout", { timeoutMs: req.timeoutMs });
        proc.kill("SIGTERM");
      }
    }, req.timeoutMs);

    // Drain stderr in the background; surface as debug logs only.
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
            // Not stream-json — surface as out-of-band progress note.
            yield { type: "progress", note: trimmed };
            continue;
          }
          const c = parseStreamJson(parsed);
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
        error: `claude timed out after ${req.timeoutMs}ms`,
        recoverable: true,
      };
      return;
    }

    const code = await proc.exited;

    if (code === 0) {
      yield {
        type: "done",
        finalText,
        meta: {
          harnessId: this.id,
          model: this.config.model,
        },
      };
    } else {
      yield {
        type: "error",
        error: `claude exited with code ${code}`,
        // 127 = command not found — terminal, no point falling through. Anything
        // else (rate limits, network blips, transient model errors) should let
        // the orchestrator try the next harness.
        recoverable: code !== 127,
      };
    }
  }

  private buildArgs(systemPrompt: string): string[] {
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
    args.push("--system-prompt", systemPrompt);
    return args;
  }
}

/**
 * Strip ANTHROPIC_API_KEY from the inherited env so the subprocess uses
 * OAuth credentials at ~/.claude/.credentials.json. Exported for testing.
 */
export function filterAuthEnv(
  source: NodeJS.ProcessEnv,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(source)) {
    if (k === "ANTHROPIC_API_KEY") continue;
    if (v !== undefined) out[k] = v;
  }
  return out;
}

/**
 * Build the stdin payload. Format: history rendered as alternating
 * blocks, then the new user message at the end. Claude Code reads this
 * as the (single) user-side input in --print mode.
 *
 * Exported for testing.
 */
export function renderStdinPayload(req: HarnessRequest): string {
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
 *
 * Exported for testing.
 */
export function parseStreamJson(parsed: unknown): HarnessChunk | undefined {
  if (typeof parsed !== "object" || parsed === null) return undefined;
  const obj = parsed as Record<string, unknown>;
  if (obj.type !== "assistant") return undefined;

  const message = obj.message as Record<string, unknown> | undefined;
  if (!message) return undefined;
  const content = message.content;
  if (!Array.isArray(content)) return undefined;

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
          log.debug("claude stderr", { text: line.slice(0, 500) });
        }
      }
    }
  } catch {
    /* swallow — stderr drain shouldn't take down the harness */
  }
}

// ---- Note for the next maintainer ----
// If you're tempted to add a tool-call passthrough here (translating Claude's
// internal tool_use events into something phantombot can act on), STOP. The
// whole architectural premise of phantombot is "let the harness do tools."
// If you build a tool layer here, you're rebuilding OpenClaw. Use the
// orchestrator's harness fallback chain instead, or extend the persona with
// instructions for the harness to do whatever the new feature needs.
