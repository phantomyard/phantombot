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
 *   The entire ANTHROPIC_* / CLAUDE_CODE_* auth+routing namespace is
 *   filtered out of the subprocess env (see filterAuthEnv) so claude
 *   resolves credentials only from ~/.claude/.credentials.json (the OAuth
 *   path that backs Claude Max). Phantombot does not hold or pass any
 *   API keys, auth tokens, or base-URL overrides.
 */

import { access, constants } from "node:fs/promises";
import type { Harness, HarnessChunk, HarnessRequest } from "./types.ts";
import { buildToolNote } from "./toolNote.ts";
import { reloadEnvFiles, withPersonaEnv } from "../lib/envBootstrap.ts";
import {
  type HarnessActivity,
  runHarnessProcess,
} from "../lib/harnessRunner.ts";
import { log } from "../lib/logger.ts";
import { spawnInNewSession } from "../lib/processGroup.ts";

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
    const args = this.buildArgs(req.systemPrompt, req.toolsMode);
    log.debug("claude.invoke spawning", {
      bin: this.config.bin,
      argCount: args.length,
    });

    // Re-source ~/.env / ~/.config/phantombot/.env so secrets the agent
    // saved on the previous turn (`phantombot env set FOO bar`) are
    // visible in this turn's env without needing a daemon restart.
    // Shell-exported keys remain sticky — see envBootstrap.ts header.
    await reloadEnvFiles();

    // OAuth-on-host: don't leak any ANTHROPIC_* / CLAUDE_CODE_* auth or
    // routing var into the subprocess env (reloadEnvFiles just re-sourced
    // ~/.env), so claude resolves credentials from ~/.claude/.credentials.json.
    const env = withPersonaEnv(
      filterAuthEnv(process.env),
      req.persona,
      req.conversation,
    );

    const proc = spawnInNewSession([this.config.bin, ...args], {
      cwd: req.workingDir,
      env,
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
    });

    // Everything below the spawn — stdin write, kill coordinator, stdout JSONL
    // pump, kill-cause / exit-code → terminal chunk — is the shared engine. The
    // per-CLI variable points are the parser (parseStreamJson), the idle-timer
    // activity classifier (claudeActivity), and the done meta.
    yield* runHarnessProcess({
      proc,
      req,
      harnessId: this.id,
      stdinPayload: renderStdinPayload(req),
      parseEvent: parseStreamJson,
      activity: claudeActivity,
      buildDoneMeta: () => ({
        harnessId: this.id,
        model: this.config.model,
      }),
    });
  }

  private buildArgs(
    systemPrompt: string,
    toolsMode?: "none",
  ): string[] {
    const args = [
      "--print",
      "--output-format", "stream-json",
      "--verbose",
      "--include-partial-messages",
      "--no-session-persistence",
      "--permission-mode", "bypassPermissions",
      "--model", this.config.model,
      // Pre-prompting trim (phantombot supplies persona / memory / scheduling
      // itself, so Claude Code's daily-driver scaffolding is pure noise here):
      //   --disallowedTools Workflow
      //     Drops the Workflow tool from the available set. The "you typed
      //     'workflow', use the Workflow tool" system nudge ONLY fires because
      //     that tool is loaded — removing the tool kills the nudge at source.
      //     (We deny by name rather than via the --settings deny-list because
      //     disallowedTools removes it from the advertised surface, which is
      //     what actually suppresses the injected reminder.)
      //   --disable-slash-commands
      //     Suppresses the entire injected "available skills" block
      //     (deep-research / loop / schedule / verify / code-review / …).
      //   --exclude-dynamic-system-prompt-sections
      //     Explicitly drops the per-machine cwd/env/git cruft. --system-prompt
      //     already drops most of it; this is the canonical belt-and-suspenders.
      // NB: MCP connectors (Gmail / Calendar / Drive) are tools, not skills or
      // Workflow, so they are UNAFFECTED — Andrew uses those and they stay.
      "--disallowedTools", "Workflow",
      "--disable-slash-commands",
      "--exclude-dynamic-system-prompt-sections",
    ];
    if (this.config.fallbackModel) {
      args.push("--fallback-model", this.config.fallbackModel);
    }
    // Tool-less threat-judge mode. Per `claude --help`, `--tools ""` (empty
    // string) disables the ENTIRE built-in tool surface — a positive
    // zero-tools grant, not an enumerated deny-list that rots as new tools
    // ship. This is what makes "read, don't act" structural: a bare
    // classifier completion has nothing to act with. (bypassPermissions above
    // is moot when there are no tools to permit — belt and suspenders.)
    if (toolsMode === "none") {
      args.push("--tools", "");
    }
    // Per-invocation settings injection. Layers additively on top of the user's
    // own ~/.claude/settings.json — we don't touch that file, so an operator
    // running `claude` directly on this host (e.g. for emergency repairs) is
    // unaffected. See PHANTOMBOT_INJECTED_CLAUDE_SETTINGS for the policy.
    args.push("--settings", JSON.stringify(PHANTOMBOT_INJECTED_CLAUDE_SETTINGS));
    args.push("--system-prompt", systemPrompt);
    return args;
  }
}

/**
 * Settings injected into every `claude --print` invocation via `--settings`.
 *
 * The Claude Code harness ships a small set of "deferred" tools the model can
 * call from inside a session — including `CronCreate` / `CronDelete` /
 * `CronList`, an in-memory single-session scheduler. They're session-bound:
 * dies with the subprocess, invisible to `phantombot task list`, no audit
 * trail, no persistence across phantombot restarts.
 *
 * That makes them a foot-gun for our use case. A persona ("matt") asked for a
 * recurring check called CronCreate — the schedule lived ~5 seconds (until
 * the --print subprocess exited) and the user had no way to verify. The
 * positive fix is the SCHEDULING_TOOLS_SECTION in persona/builder.ts which
 * teaches the model to use `phantombot task` instead. THIS deny-list is the
 * backstop: even if the model reaches for CronCreate in a moment of weakness,
 * the harness refuses.
 *
 * We deliberately deny only the three scheduler tools. Bash, Read, Edit,
 * WebFetch, and the rest of the Claude Code surface remain available — we're
 * not crippling the harness, just removing the one footgun that has zero
 * legitimate use given `phantombot task` exists.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * FRAME THIS CORRECTLY: the FEATURE is `phantombot task`, not the deny-list.
 *
 * Denying Cron* is not phantombot lacking a scheduler — it is phantombot
 * REPLACING a deliberately-inferior one with a better one. `phantombot task`
 * is a real, persistent scheduler: SQLite-backed, survives restarts and
 * crashes, visible in `phantombot task list`, every fire logged to
 * `task_runs`, cancelable by id, with two-layer delivery guarantees. The
 * harness's Cron* tools are the opposite on every axis — session-bound,
 * vanish when the --print subprocess exits seconds later, invisible to the
 * user, no fire log, no persistence. They LOOK like they work and silently
 * don't.
 *
 * So this is a phantombot capability that goes above and beyond the harness
 * default, not a hole in it. Do NOT "restore functionality" by removing this
 * deny-list — that re-opens the exact silent-failure footgun (`phantombot
 * task` already covers every legitimate use). Intentional, load-bearing.
 * ─────────────────────────────────────────────────────────────────────────
 *
 * Layering: --settings is additive on top of ~/.claude/settings.json. The
 * operator's own user settings are NOT modified by phantombot, so running
 * `claude` directly outside phantombot (emergency repairs, dev work) is
 * unaffected by this injection.
 *
 * Exported for testing and so the doc-string above is greppable.
 */
export const PHANTOMBOT_INJECTED_CLAUDE_SETTINGS = {
  permissions: {
    deny: [
      "CronCreate",
      "CronDelete",
      "CronList",
    ],
  },
} as const;

/**
 * Prefixes whose entire namespace is treated as authentication/routing
 * config for the claude subprocess. Anything matching one of these is
 * dropped from the inherited env UNLESS it is explicitly allow-listed in
 * AUTH_ENV_ALLOW below.
 *
 * Denylisting individual names (the old behaviour, which only stripped
 * ANTHROPIC_API_KEY) is fragile: ANTHROPIC_AUTH_TOKEN, ANTHROPIC_BASE_URL,
 * CLAUDE_CODE_OAUTH_TOKEN, CLAUDE_CODE_USE_BEDROCK, etc. all silently flip
 * claude off the Max-subscription OAuth path. reloadEnvFiles() re-sources
 * ~/.env into process.env right before this runs, so a stray
 * `phantombot env set ANTHROPIC_AUTH_TOKEN …` would leak straight through.
 * Allow-listing the namespace closes the whole family at once.
 */
const AUTH_ENV_PREFIXES = ["ANTHROPIC_", "CLAUDE_CODE_"] as const;

/**
 * Known-safe vars inside the auth namespace that may still pass through to
 * the subprocess. Empty today — the codebase reads none of these itself,
 * and the claude subprocess must take its credentials only from
 * ~/.claude/.credentials.json. Add a name here only with a clear reason.
 */
const AUTH_ENV_ALLOW = new Set<string>([]);

/**
 * Strip the entire ANTHROPIC_* / CLAUDE_CODE_* auth+routing namespace from
 * the inherited env so the subprocess uses OAuth credentials at
 * ~/.claude/.credentials.json. Exported for testing.
 */
export function filterAuthEnv(
  source: NodeJS.ProcessEnv,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(source)) {
    if (v === undefined) continue;
    const inAuthNamespace = AUTH_ENV_PREFIXES.some((p) => k.startsWith(p));
    if (inAuthNamespace && !AUTH_ENV_ALLOW.has(k)) continue;
    out[k] = v;
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
 * lines we want to ignore.
 *
 * Claude's stream-json schema is documented in the Claude Code docs but
 * informally: each line has a `type` (system / user / assistant / result)
 * and a `message` payload. The assistant content is an array of blocks
 * with their own `type`: `text`, `thinking`, `tool_use`, `tool_result`.
 * Claude reports tool results in user-typed messages; we surface those as
 * heartbeats too so the timeout coordinator can clear the tool-running latch
 * without flushing user-visible narration.
 *
 * Channel layers want three distinct signals from us:
 *   - `text` blocks → user-visible reply (concatenate, surface verbatim).
 *   - `tool_use` blocks → `progress` so the channel layer can flush pending
 *     narration before the model runs its tool.
 *   - `thinking` / `tool_result` → `heartbeat` (refreshes typing indicator,
 *     but does NOT flush narration — mirrors pi.ts behavior).
 *
 * If a single assistant message contains BOTH text and non-text blocks,
 * text wins (it carries strictly more signal). If it has both tool_use
 * and thinking, progress wins (tool_use is the signal that matters).
 * Thinking-only messages get a heartbeat — they don't fragment the
 * narration bubble.
 *
 * Actual content stays inside the subprocess; we never leak
 * chain-of-thought.
 *
 * Exported for testing.
 */
export function parseStreamJson(parsed: unknown): HarnessChunk | undefined {
  if (typeof parsed !== "object" || parsed === null) return undefined;
  const obj = parsed as Record<string, unknown>;

  const message = obj.message as Record<string, unknown> | undefined;
  if (!message) return undefined;
  const content = message.content;
  if (!Array.isArray(content)) return undefined;

  if (obj.type !== "assistant") {
    return content.some((part) => {
      if (typeof part !== "object" || part === null) return false;
      return (part as Record<string, unknown>).type === "tool_result";
    })
      ? { type: "heartbeat" }
      : undefined;
  }

  let text = "";
  let toolName: string | undefined;
  let toolInput: unknown;
  let sawOtherNonText = false;
  for (const part of content) {
    if (typeof part === "object" && part !== null) {
      const p = part as Record<string, unknown>;
      if (p.type === "text" && typeof p.text === "string") {
        text += p.text;
      } else if (p.type === "tool_use") {
        toolName = typeof p.name === "string" ? p.name : toolName ?? "tool";
        toolInput = p.input;
      } else if (typeof p.type === "string") {
        sawOtherNonText = true;
      }
    }
  }
  if (text) return { type: "text", text };
  if (toolName) return { type: "progress", note: buildToolNote(toolName, toolInput) };
  if (sawOtherNonText) return { type: "heartbeat" };
  return undefined;
}

function claudeActivity(
  parsed: unknown,
  chunk: HarnessChunk,
): HarnessActivity {
  if (chunk.type === "text" || chunk.type === "done") return "productive";
  if (typeof parsed !== "object" || parsed === null) {
    return chunk.type === "heartbeat" ? "model" : "productive";
  }
  const obj = parsed as Record<string, unknown>;
  const message = obj.message as Record<string, unknown> | undefined;
  const content = message?.content;
  if (Array.isArray(content)) {
    let hasToolUse = false;
    let hasToolResult = false;
    for (const part of content) {
      if (typeof part !== "object" || part === null) continue;
      const type = (part as Record<string, unknown>).type;
      hasToolUse ||= type === "tool_use";
      hasToolResult ||= type === "tool_result";
    }
    if (hasToolUse) return "tool";
    if (hasToolResult) return "productive";
  }
  return chunk.type === "heartbeat" ? "model" : "productive";
}

// ---- Note for the next maintainer ----
// If you're tempted to add a tool-call passthrough here (translating Claude's
// internal tool_use events into something phantombot can act on), STOP. The
// whole architectural premise of phantombot is "let the harness do tools."
// If you build a tool layer here, you're rebuilding OpenClaw. Use the
// orchestrator's harness fallback chain instead, or extend the persona with
// instructions for the harness to do whatever the new feature needs.
