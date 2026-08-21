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
import type {
  Harness,
  HarnessChunk,
  HarnessModelInfo,
  HarnessRequest,
} from "./types.ts";
import { buildToolCall } from "./toolNote.ts";
import { reloadEnvFiles, withPersonaEnv } from "../lib/envBootstrap.ts";
import { reloadVaultForPersona } from "../lib/vault.ts";
import {
  type HarnessActivity,
  runHarnessProcess,
} from "../lib/harnessRunner.ts";
import { log } from "../lib/logger.ts";
import { spawnInNewSession } from "../lib/processGroup.ts";
import {
  argvNeedsTempFiles,
  createHarnessTempDir,
  type HarnessTempDir,
} from "../lib/harnessArgvFiles.ts";
import {
  buildForegroundMcpConfig,
  EMPTY_MCP_CONFIG,
} from "../mcp/harnessConfig.ts";

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

  constructor(
    private readonly config: ClaudeHarnessConfig,
    // Injectable so the Windows argv-length branch below is testable on a
    // POSIX CI runner. Prod callers pass only the config and get the real
    // platform.
    private readonly platform: NodeJS.Platform = process.platform,
  ) {}

  modelInfo(): HarnessModelInfo {
    return {
      model: this.config.model,
      fallbackModel: this.config.fallbackModel || undefined,
    };
  }

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
    // Argv-length workaround. Claude's conversation payload already travels on
    // stdin, but the persona/memory system prompt still rides on argv via
    // `--system-prompt <text>`, and that one string can outgrow what execve
    // will take:
    //
    //   - Windows: megan's BOOT.md alone blows the ~8,191-char command-line
    //     limit and the child fails with "The command line is too long."
    //   - Linux: a single argv string is capped at 131,071 bytes
    //     (MAX_ARG_STRLEN), so a persona with a large journal dies at spawn
    //     with `E2BIG: argument list too long` (#426).
    //
    // Either way the answer is the same: spill the system prompt to a temp
    // file and pass `--system-prompt-file <file>` instead. Sizing on the
    // system prompt specifically is right because it IS the single argv
    // element at risk - every other arg here is a short flag or a bounded
    // JSON blob. See harnessArgvFiles.
    const systemPromptBytes = Buffer.byteLength(req.systemPrompt, "utf8");
    const useTempFiles = argvNeedsTempFiles(this.platform, systemPromptBytes);
    let temp: HarnessTempDir | undefined;
    let systemPromptFile: string | undefined;
    if (useTempFiles) {
      // The spill is a best-effort OPTIMISATION, never a precondition. It
      // touches the filesystem (mkdir + write under the persona's own tmp), and
      // a filesystem can say no: disk full, read-only mount, a persona dir
      // whose perms drifted. None of those are a reason to refuse the turn, and
      // on a headless box nobody is watching to fix it, so a throw here must
      // degrade to the inline argument rather than propagate.
      //
      // What the degraded path costs is honest and bounded: on Linux the inline
      // `--system-prompt` still spawns fine for anything under MAX_ARG_STRLEN,
      // so a prompt in the 96 KB-128 KB spill band simply works. Above it (or on
      // Windows, where the whole command line is the budget) the spawn fails
      // with E2BIG / "command line is too long" - which runWithFallback now
      // catches and rolls to the next harness. Worst case is a slower turn on a
      // fallback harness; never a dead daemon.
      try {
        temp = await createHarnessTempDir(req.tmpBaseDir);
        systemPromptFile = await temp.file("system-prompt.md", req.systemPrompt);
      } catch (err) {
        log.warn("claude.invoke could not spill the system prompt to a file; passing it inline", {
          tmpBaseDir: req.tmpBaseDir,
          systemPromptBytes,
          error: err instanceof Error ? err.message : String(err),
        });
        // mkdtemp may have succeeded and only the write failed - drop the dir
        // rather than leak it. cleanup() never throws.
        await temp?.cleanup();
        temp = undefined;
        systemPromptFile = undefined;
      }
    }
    try {

    // Foreground turns run --strict-mcp-config pointed at phantombot's OWN
    // registry (empty until servers are registered), so account-level claude.ai
    // connectors never inject into a phantombot prompt. Background/nightly
    // (mcpMode "none") keep the zero-server config. Best-effort: any failure
    // resolves to the empty config, so the isolation holds regardless.
    const foregroundMcpConfig =
      req.mcpMode === "none" ? undefined : await buildForegroundMcpConfig(req.persona);

    const args = this.buildArgs(
      req.systemPrompt,
      req.toolsMode,
      systemPromptFile,
      req.mcpMode,
      foregroundMcpConfig,
    );
    log.debug("claude.invoke spawning", {
      bin: this.config.bin,
      argCount: args.length,
      tempFiles: useTempFiles,
      systemPromptBytes,
    });

    // Re-source the legacy/runtime env files so file-backed model, routing,
    // and voice settings changed on the previous turn are visible without a
    // daemon restart. Shell-exported keys remain sticky — see envBootstrap.ts.
    await reloadEnvFiles();
    // Then reconcile THIS persona's encrypted vault into the env (the canonical
    // credential store; the .env files above are only the legacy transitional
    // path). This makes a `vault set` from the previous turn visible now and
    // ensures the subprocess sees only this persona's secrets.
    await reloadVaultForPersona(req.persona);

    // OAuth-on-host: don't leak any ANTHROPIC_* / CLAUDE_CODE_* auth or
    // routing var into the subprocess env (reloadEnvFiles just re-sourced
    // ~/.env), so claude resolves credentials from ~/.claude/.credentials.json.
    const env = withPersonaEnv(
      {
        ...filterAuthEnv(process.env),
        // Background agents are disabled by product policy. This flag makes
        // the CLI strip `run_in_background` from the Bash and Task tool
        // SCHEMAS entirely (verified against claude 2.1.170), so the model
        // cannot background anything — the capability is never advertised.
        // It must be set HERE, after filterAuthEnv: the filter strips the
        // whole CLAUDE_CODE_* namespace from the inherited env, so exporting
        // it in ~/.env or the shell would silently NOT reach the subprocess
        // (and a stray CLAUDE_CODE_DISABLE_BACKGROUND_TASKS=0 out there must
        // not be able to re-enable backgrounding).
        CLAUDE_CODE_DISABLE_BACKGROUND_TASKS: "1",
      },
      req.persona,
      req.conversation,
      req.turnId,
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

    } finally {
      // Remove the temp system-prompt file once the child has exited (or the
      // consumer stopped iterating early). No-op on POSIX.
      await temp?.cleanup();
    }
  }

  private buildArgs(
    systemPrompt: string,
    toolsMode?: "none" | { allow: string[] },
    // When set (Windows, or an oversized prompt on any platform), the persona
    // system prompt is passed by FILE (`--system-prompt-file`) instead of
    // inline (`--system-prompt <text>`) to stay under the argv length limit.
    systemPromptFile?: string,
    // `"none"` runs this turn with ZERO MCP servers — see the block below.
    mcpMode?: "none",
    // Foreground turns only: the `--mcp-config` payload pointing at phantombot's
    // own registry/proxy. Undefined on background turns (mcpMode "none").
    foregroundMcpConfig?: string,
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
      //   --disallowedTools Workflow,Task
      //     Workflow: drops the Workflow tool from the available set. The
      //     "you typed 'workflow', use the Workflow tool" system nudge ONLY
      //     fires because that tool is loaded — removing the tool kills the
      //     nudge at source. (We deny by name rather than via the --settings
      //     deny-list because disallowedTools removes it from the advertised
      //     surface, which is what actually suppresses the injected reminder.)
      //     Task: removes the subagent tool entirely — foreground AND
      //     background. Subagents are disabled by product policy (the owner's
      //     standing rule is "no subagents, ever"); combined with
      //     CLAUDE_CODE_DISABLE_BACKGROUND_TASKS=1 in the env (strips
      //     run_in_background from the remaining tool schemas) and the
      //     subagent tripwire in parseStreamJson, background/side agents are
      //     structurally impossible rather than merely discouraged.
      //   --disable-slash-commands
      //     Suppresses the entire injected "available skills" block
      //     (deep-research / loop / schedule / verify / code-review / …).
      //   --exclude-dynamic-system-prompt-sections
      //     Explicitly drops the per-machine cwd/env/git cruft. --system-prompt
      //     already drops most of it; this is the canonical belt-and-suspenders.
      // NB: account-level claude.ai MCP connectors (Gmail / Calendar / Drive /
      // IBKR) are tools, not skills or Workflow, so --disallowedTools does not
      // touch them. Their isolation is handled separately by --strict-mcp-config
      // (see the MCP block below), which points claude at phantombot's OWN
      // registry so those connectors don't inject into a phantombot prompt while
      // staying available on Claude Desktop.
      "--disallowedTools", "Workflow,Task",
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
    } else if (toolsMode && toolsMode.allow.length > 0) {
      // Positive tool grant for background turns with a known job (#387).
      // `--tools "Bash,Edit,Read"` replaces the built-in set with exactly
      // these — same positive-grant shape as `--tools ""`, so it doesn't rot
      // as new tools ship. Nightly uses it to drop Glob/Grep: claude's native
      // search tools fan out across parallel workers and walk the tree from
      // cwd, which is what turned one confused stage into a barrage of macOS
      // TCC prompts. The stage has `phantombot memory search` (FTS +
      // semantic) and knows its own paths, so it never needed a tree walk.
      args.push("--tools", toolsMode.allow.join(","));
    }
    // MCP isolation — EVERY claude turn runs `--strict-mcp-config`, which tells
    // claude to use ONLY the servers in `--mcp-config` and ignore ~/.claude.json
    // AND the account-level claude.ai connectors bound to the Claude Max OAuth
    // login (IBKR / Gmail / Calendar / Drive). Two payloads:
    //
    //   - Background/nightly (mcpMode "none"): an EMPTY server map. Nightly needs
    //     no MCP, and an unauthenticated remote connector would otherwise block
    //     the `--print` init handshake on an OAuth flow that can never complete,
    //     so the stage emits nothing and is killed at the idle ceiling.
    //
    //   - Foreground persona turns: phantombot's OWN registry, projected via the
    //     loopback proxy (foregroundMcpConfig) — empty until the persona
    //     registers servers with `phantombot mcp add`. This is the #338 fix: the
    //     account connectors are wanted on Claude Desktop (account settings
    //     untouched) but must NOT inject their tool schemas + server
    //     instructions into every phantombot prompt, where they're noise and an
    //     untrusted-input surface. strict-mcp-config on foreground closes that.
    if (mcpMode === "none") {
      args.push("--strict-mcp-config", "--mcp-config", EMPTY_MCP_CONFIG);
    } else {
      args.push(
        "--strict-mcp-config",
        "--mcp-config",
        foregroundMcpConfig ?? EMPTY_MCP_CONFIG,
      );
    }
    // Per-invocation settings injection. Layers additively on top of the user's
    // own ~/.claude/settings.json — we don't touch that file, so an operator
    // running `claude` directly on this host (e.g. for emergency repairs) is
    // unaffected. See PHANTOMBOT_INJECTED_CLAUDE_SETTINGS for the policy.
    args.push("--settings", JSON.stringify(PHANTOMBOT_INJECTED_CLAUDE_SETTINGS));
    if (systemPromptFile) {
      // Read the persona system prompt from a file to keep it off the
      // length-limited command line. Verified against Claude Code.
      args.push("--system-prompt-file", systemPromptFile);
    } else {
      args.push("--system-prompt", systemPrompt);
    }
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
 * claude off the Max-subscription OAuth path. The env files and active persona
 * vault are reconciled into process.env right before this runs, so a stray
 * `phantombot vault set ANTHROPIC_AUTH_TOKEN …` would leak straight through.
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
/**
 * API-error statuses the claude CLI can stamp on an assistant message.
 * Taken from the CLI's own schema (v2.1.206):
 *
 *   authentication_failed · oauth_org_not_allowed · billing_error ·
 *   rate_limit · overloaded · invalid_request · model_not_found ·
 *   server_error · unknown · max_output_tokens
 *
 * When the account's 5-hour session (or weekly) cap is spent, the CLI wraps
 * its "You've hit your session limit · resets 1:40pm" notice as an ORDINARY
 * assistant text block and stamps the envelope with `error: "rate_limit"` and
 * `is_api_error_message: true`. The text is indistinguishable from a real
 * reply; the `error` field is not. We gate on the field.
 *
 * `max_output_tokens` is deliberately NOT treated as a synthetic error: it
 * means the model produced a genuine (if truncated) reply that hit the output
 * cap. Dropping it would discard real assistant output. Every other status is
 * a synthetic CLI-authored message that must never reach the user.
 *
 * Anything else non-empty is also treated as an error — an unknown future
 * status is far likelier to be a new synthetic error than a real reply, and
 * this direction fails SAFE: we fall through to the next harness, which
 * answers the turn. (The opposite default would stream CLI error prose to the
 * user as if it were the phantom talking.)
 */
const NON_ERROR_API_STATUSES = new Set(["max_output_tokens"]);

/**
 * Does this stream-json envelope carry subagent lineage? Three markers,
 * all verified against claude 2.1.170:
 *   - `subagent_type` on the envelope — stamped on messages belonging to a
 *     Task-spawned subagent.
 *   - `isSidechain: true` — the CLI's own sidechain (subagent) flag.
 *   - a `tool_use` block named `Task` — the spawn call itself.
 * Exported for testing.
 */
export function isSubagentActivity(obj: Record<string, unknown>): boolean {
  if (typeof obj.subagent_type === "string" && obj.subagent_type.length > 0) {
    return true;
  }
  if (obj.isSidechain === true) return true;
  const message = obj.message as Record<string, unknown> | undefined;
  const content = message?.content;
  if (Array.isArray(content)) {
    for (const part of content) {
      if (typeof part !== "object" || part === null) continue;
      const p = part as Record<string, unknown>;
      if (p.type === "tool_use" && p.name === "Task") return true;
    }
  }
  return false;
}

/**
 * The API-error status stamped on a stream-json envelope, if any.
 *
 * NOTE: this is exit-code independent, and that matters. Observed on the wire
 * with a forced `model_not_found`, the CLI emitted the error message and then
 * exited **0** with `{"subtype":"success","is_error":true}`. The orchestrator's
 * fall-through only triggers on a non-zero exit OR a recoverable error chunk —
 * so gating on the exit code alone would stream the CLI's error text to the
 * user as the phantom's answer and never fail over. Emitting a recoverable
 * error chunk the moment we see this field fixes both.
 *
 * Exported for testing.
 */
export function apiErrorStatus(obj: Record<string, unknown>): string | undefined {
  const err = obj.error;
  if (typeof err !== "string") return undefined;
  const status = err.trim();
  if (status.length === 0) return undefined;
  if (NON_ERROR_API_STATUSES.has(status)) return undefined;
  return status;
}

export function parseStreamJson(parsed: unknown): HarnessChunk | undefined {
  if (typeof parsed !== "object" || parsed === null) return undefined;
  const obj = parsed as Record<string, unknown>;

  // Subagent tripwire. Background agents and the Task tool are disabled by
  // policy (CLAUDE_CODE_DISABLE_BACKGROUND_TASKS in the env + Task in
  // --disallowedTools), so the CLI should never emit subagent activity. If a
  // future CLI version routes around those guards, any envelope carrying
  // subagent lineage becomes a RECOVERABLE, TERMINAL error: the runner kills
  // the subprocess immediately and suppresses every line after this one, and
  // the orchestrator falls through to the next harness instead of letting an
  // unmonitored agent run loose. Fail-safe direction, same as the API-error
  // gate below.
  if (isSubagentActivity(obj)) {
    return {
      type: "error",
      error: "claude emitted subagent activity (disabled by phantombot policy)",
      recoverable: true,
      terminal: true,
    };
  }

  // API-error gate. Checked BEFORE content, and before the `message`/`content`
  // shape guards, so not one byte of a CLI-authored error message can stream to
  // the user. A synthetic error message looks exactly like a real assistant
  // reply (`model: "<synthetic>"`, a plain text block) — the only reliable
  // discriminator is the envelope's `error` field. Converting it to a
  // RECOVERABLE error here makes the orchestrator fall through to the next
  // harness silently: pi answers the turn, and the user never learns claude was
  // capped, overloaded, or misconfigured.
  if (obj.type === "assistant") {
    const status = apiErrorStatus(obj);
    if (status) {
      return {
        type: "error",
        error: `claude api error: ${status}`,
        recoverable: true,
      };
    }
  }

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
  if (toolName) {
    const tool = buildToolCall(toolName, toolInput);
    return { type: "progress", note: tool.title, tool };
  }
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
