/**
 * Spawn a child `pi` process for a delegated subtask and capture its
 * structured JSON output.
 *
 * Mirrors the pattern in pi's own `examples/extensions/subagent/index.ts`:
 *   pi --mode json -p --no-session --model <model> --tools <...> \
 *      [--append-system-prompt <file>] "<task>"
 *
 * Each delegation is a FRESH pi process. That's deliberate: process startup is
 * expensive, so delegations are COARSE-GRAINED — one self-contained chunk, not a
 * chatty back-and-forth. The child gets an isolated context window and reports
 * usage/cost back, which we surface to the parent so cost is visible at the
 * call site.
 */

import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

/**
 * Minimal structural shape of pi's assistant `Message`, declared locally
 * instead of imported from `@earendil-works/pi-ai`. This extension is
 * deliberately dependency-free: it is stamped into the host pi's extension
 * directory and runs against whatever `pi-ai` that pi already ships, so the
 * repo does not vendor `pi-ai` — importing its types here would break
 * `tsc --noEmit`. We model only the fields we actually read, defensively, and
 * the JSON we parse off pi's stream is widened into this shape at the boundary.
 *
 * Content parts are a small discriminated union: a `text` part (the only shape
 * we read field-by-field) plus a generic non-text part for tool calls. The
 * non-text discriminant value is nominal — code only ever compares against
 * `"text"` — so it never participates in runtime branching.
 */
interface MessageUsage {
  input?: number;
  output?: number;
  cacheRead?: number;
  cacheWrite?: number;
  cost?: { total?: number };
  totalTokens?: number;
}
type MessageContentPart =
  | { type: "text"; text: string }
  | { type: "toolCall"; name?: string; toolName?: string; input?: unknown };
export interface Message {
  role: string;
  content: MessageContentPart[];
  usage?: MessageUsage;
  model?: string;
  stopReason?: string;
  errorMessage?: string;
}

export interface DelegateUsage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  cost: number;
  contextTokens: number;
  turns: number;
}

export interface DelegateResult {
  exitCode: number;
  messages: Message[];
  stderr: string;
  usage: DelegateUsage;
  model?: string;
  stopReason?: string;
  errorMessage?: string;
}

export interface DelegateOptions {
  /** Model id to pin via --model (bare name as printed by `pi --list-models`). */
  model: string;
  /**
   * Pi provider for this delegate (e.g. "openrouter", "openai"), threaded onto
   * `--provider`. MUST match the api-key's provider: Pi's `--provider` defaults
   * to google, so an OpenRouter key with no `--provider openrouter` is fired at
   * the wrong endpoint and auth fails. Sourced from the ACTIVE harness's routing
   * config (relayed via env by the parent pi), NOT a shared ambient env var —
   * that's what keeps a primary-Pi→OpenRouter / fallback-Pi→OpenAI box from
   * colliding two providers in one process namespace. Omit ⇒ no `--provider`
   * (Pi falls back to its own default, google).
   */
  provider?: string;
  /**
   * Per-turn Pi api-key, threaded onto `--api-key` exactly like the model is
   * threaded onto `--model` — never persisted into Pi's own auth store. Omit ⇒
   * no `--api-key`, and Pi falls back to its own env / local-store settings
   * (the "install later, no key" path). Pairs with `provider` above.
   */
  apiKey?: string;
  /** Comma-list passed to --tools. Omit/empty = pi's default tool set. */
  tools?: string[];
  /** Extra system prompt appended via --append-system-prompt (written to a temp file). */
  systemPrompt?: string;
  /** The task string (last positional arg). */
  task: string;
  /** Working directory for the child. Defaults to the parent's cwd. */
  cwd?: string;
  /** Abort signal — propagated as SIGTERM/SIGKILL to the child. */
  signal?: AbortSignal;
  /**
   * Idle timeout (ms). If the child produces NO output (neither stdout nor
   * stderr) for this long, it is treated as WEDGED: killed (SIGTERM → SIGKILL)
   * and the call returns with `stopReason: "timeout"` instead of hanging.
   *
   * This is the TOOL BOUNDARY. A delegate is a tool the primary called, like
   * bash; when it wedges it must surface as a tested failure the primary can
   * iterate on — NOT an unbounded hang that starves the primary's own idle
   * watchdog until the whole turn is killed and (wrongly) treated as a primary
   * failure. Set this comfortably UNDER the primary's idle window so the tool
   * returns first. Omit to disable (legacy unbounded behaviour).
   */
  idleTimeoutMs?: number;
  /**
   * Hard wall-clock cap (ms). Kills the child after this long regardless of
   * output. Omit to disable (rely on the parent's hard cap). Belt-and-braces
   * for a child that stays just-chatty-enough to dodge the idle timeout forever.
   */
  hardTimeoutMs?: number;
}

/**
 * Resolve how to re-invoke pi. When the extension runs under a compiled pi
 * single-ELF, `process.execPath` IS pi, so we call it directly. Under a
 * node/bun runtime running pi from source, re-run the same script. Falls back
 * to "pi" on PATH. Lifted from the subagent example's getPiInvocation.
 */
function getPiInvocation(args: string[]): { command: string; args: string[] } {
  const currentScript = process.argv[1];
  const isBunVirtualScript = currentScript?.startsWith("/$bunfs/root/");
  if (currentScript && !isBunVirtualScript && fs.existsSync(currentScript)) {
    return { command: process.execPath, args: [currentScript, ...args] };
  }
  const execName = path.basename(process.execPath).toLowerCase();
  const isGenericRuntime = /^(node|bun)(\.exe)?$/.test(execName);
  if (!isGenericRuntime) {
    return { command: process.execPath, args };
  }
  // Bare "pi" fallback. On Windows, node's spawn(shell:false) does NOT apply
  // PATHEXT, so a bare "pi" never resolves to the real `pi.cmd`/`pi.exe` shim
  // and dies with ENOENT (uv_spawn 'pi') — this is exactly the memory/nightly
  // failure on the Windows port. Resolve the concrete file ourselves so the
  // spawn stays shell:false (no arg-quoting hazard). No-op on POSIX.
  return { command: resolveCommandOnPath("pi"), args };
}

/**
 * Resolve a bare command name to a concrete executable path on Windows using
 * PATH × PATHEXT (the lookup cmd.exe does but node's spawn(shell:false) does
 * not). Returns the input unchanged on POSIX, when already a path, or when
 * nothing matches (so the caller still gets a sensible ENOENT to surface).
 */
function resolveCommandOnPath(cmd: string): string {
  if (process.platform !== "win32") return cmd;
  if (path.isAbsolute(cmd) || cmd.includes(path.sep) || cmd.includes("/")) return cmd;
  const exts = (process.env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD")
    .split(";")
    .map((e) => e.trim())
    .filter(Boolean);
  const dirs = (process.env.PATH ?? process.env.Path ?? "").split(path.delimiter);
  for (const dir of dirs) {
    if (!dir) continue;
    // An explicit extension already present? Probe it verbatim first.
    if (fs.existsSync(path.join(dir, cmd))) return path.join(dir, cmd);
    for (const ext of exts) {
      const candidate = path.join(dir, cmd + ext);
      if (fs.existsSync(candidate)) return candidate;
    }
  }
  return cmd;
}

function emptyUsage(): DelegateUsage {
  return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 };
}

/**
 * Detach a timer from the event loop's ref-count so a pending idle/hard timeout
 * can never keep the process alive on its own. Guards `unref` defensively — the
 * timer handle is typed `number` under some lib configs even though Node's real
 * return value carries `unref()`.
 */
function unrefTimer(t: ReturnType<typeof setTimeout>): void {
  if (typeof (t as { unref?: () => void }).unref === "function") {
    (t as { unref: () => void }).unref();
  }
}

/** Write the appended system prompt to a temp file; pi reads it by path. */
function writePromptTempFile(prompt: string): { dir: string; filePath: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "phantombot-route-"));
  const filePath = path.join(dir, "system.md");
  fs.writeFileSync(filePath, prompt, "utf-8");
  return { dir, filePath };
}

/** Last assistant text block — the delegate's answer. */
export function finalText(messages: Message[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (msg?.role === "assistant") {
      for (const part of msg.content) {
        if (part.type === "text") return part.text;
      }
    }
  }
  return "";
}

/**
 * Most recent NON-EMPTY assistant text the delegate produced. Unlike
 * `finalText` (which returns the last assistant block even if blank), this
 * skips blank turns so a timeout report can show the last thing the coder
 * actually said before it stalled. Empty string when there's nothing.
 */
export function lastProgressText(messages: Message[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (msg?.role === "assistant") {
      for (const part of msg.content) {
        if (part.type === "text" && part.text.trim()) return part.text.trim();
      }
    }
  }
  return "";
}

/**
 * True when a delegation FAILED: a non-zero exit, or a failure stopReason —
 * `error`, `aborted`, or a `timeout` we imposed at the tool boundary. The tool
 * surfaces these via `delegateFailureText` as an isError result so the primary
 * iterates. A clean `stop`/`toolUse`/undefined stopReason with exit 0 is success.
 */
export function isDelegateFailure(r: DelegateResult): boolean {
  return (
    r.exitCode !== 0 ||
    r.stopReason === "error" ||
    r.stopReason === "aborted" ||
    r.stopReason === "timeout"
  );
}

/**
 * Build the tool-result failure string for a failed/timed-out delegation.
 * Never throws.
 *
 * This is the user-facing half of the TOOL BOUNDARY: a delegate that failed —
 * including a wedge we killed via the idle/hard timeout — returns this string as
 * a normal (isError) tool result so the PRIMARY can read it and iterate, exactly
 * like a non-zero bash exit. On a timeout we also surface the last thing the
 * delegate managed to say and an explicit nudge to retry-or-report, so the
 * primary treats it as a recoverable tool failure rather than a dead end.
 */
export function delegateFailureText(kind: string, r: DelegateResult): string {
  const reason = r.stopReason ?? `exit ${r.exitCode}`;
  const detail = r.errorMessage || r.stderr.trim() || "no output";
  let text = `${kind} failed (${reason}): ${detail}`;
  if (r.stopReason === "timeout") {
    const partial = lastProgressText(r.messages);
    text += partial
      ? `\n\nLast progress before it was stopped: ${clip(partial, 280)}`
      : `\n\nIt produced no usable output before it was stopped.`;
    text +=
      `\n\nThis is a TOOL failure you can recover from — treat it like a failed ` +
      `command: refine the task (smaller scope, clearer steps) and call ${kind} ` +
      `again, or report back what you tried and where it stalled.`;
  }
  return text;
}

/**
 * Build the leading (static) argv for a delegate `pi` invocation: the model,
 * the provider/api-key auth pair, and the optional tool list — everything
 * BEFORE the per-run `--append-system-prompt` and the positional task. Pure and
 * exported so the auth threading is unit-testable without spawning a process.
 *
 * The provider + api-key are threaded as a PAIR, scoped to this delegate's
 * active harness: Pi's `--provider` defaults to google, so a non-google key
 * (e.g. OpenRouter) with no matching `--provider` is fired at the wrong endpoint
 * and auth fails. Either omitted ⇒ its flag is dropped and Pi falls back to its
 * own default / local store for that piece.
 */
export function buildDelegateBaseArgs(
  opts: Pick<DelegateOptions, "model" | "provider" | "apiKey" | "tools">,
): string[] {
  const args: string[] = ["--mode", "json", "-p", "--no-session", "--model", opts.model];
  const provider = opts.provider?.trim();
  if (provider) args.push("--provider", provider);
  const apiKey = opts.apiKey?.trim();
  if (apiKey) args.push("--api-key", apiKey);
  if (opts.tools && opts.tools.length > 0) args.push("--tools", opts.tools.join(","));
  return args;
}

export async function delegate(opts: DelegateOptions): Promise<DelegateResult> {
  const args: string[] = buildDelegateBaseArgs(opts);

  const result: DelegateResult = {
    exitCode: 0,
    messages: [],
    stderr: "",
    usage: emptyUsage(),
    model: opts.model,
  };

  let tmpDir: string | null = null;
  let tmpPath: string | null = null;
  try {
    if (opts.systemPrompt?.trim()) {
      const tmp = writePromptTempFile(opts.systemPrompt);
      tmpDir = tmp.dir;
      tmpPath = tmp.filePath;
      args.push("--append-system-prompt", tmpPath);
    }
    args.push(opts.task);

    let aborted = false;
    let timedOut: "idle" | "hard" | undefined;
    const exitCode = await new Promise<number>((resolve) => {
      const inv = getPiInvocation(args);
      const proc = spawn(inv.command, inv.args, {
        cwd: opts.cwd,
        shell: false,
        stdio: ["ignore", "pipe", "pipe"],
        // Suppress the console window Windows opens for the delegate pi child.
        // No-op on POSIX.
        windowsHide: true,
      });

      // ── Tool-boundary timeouts ────────────────────────────────────────────
      // A wedged child must return a tested failure, not hang forever (see
      // DelegateOptions.idleTimeoutMs). The idle timer resets on ANY raw output
      // from the child; the hard timer never resets. On expiry we kill the
      // child and record `timedOut` so the post-await block sets a `timeout`
      // stopReason the tool surfaces to the primary.
      let idleTimer: ReturnType<typeof setTimeout> | undefined;
      let hardTimer: ReturnType<typeof setTimeout> | undefined;
      const clearTimers = (): void => {
        if (idleTimer) { clearTimeout(idleTimer); idleTimer = undefined; }
        if (hardTimer) { clearTimeout(hardTimer); hardTimer = undefined; }
      };
      const killTimedOut = (which: "idle" | "hard"): void => {
        if (timedOut || aborted) return;
        timedOut = which;
        clearTimers();
        proc.kill("SIGTERM");
        unrefTimer(setTimeout(() => {
          if (!proc.killed) proc.kill("SIGKILL");
        }, 5000));
      };
      // Called on every raw chunk from the child (stdout OR stderr) to reset
      // the idle window — a child that keeps producing output is alive, so the
      // idle timeout only fires when it goes genuinely silent.
      const resetIdle = (): void => {
        if (timedOut || aborted) return;
        if (opts.idleTimeoutMs !== undefined) {
          if (idleTimer) clearTimeout(idleTimer);
          idleTimer = setTimeout(() => killTimedOut("idle"), opts.idleTimeoutMs);
          unrefTimer(idleTimer);
        }
      };
      if (opts.idleTimeoutMs !== undefined) {
        idleTimer = setTimeout(() => killTimedOut("idle"), opts.idleTimeoutMs);
        unrefTimer(idleTimer);
      }
      if (opts.hardTimeoutMs !== undefined) {
        hardTimer = setTimeout(() => killTimedOut("hard"), opts.hardTimeoutMs);
        unrefTimer(hardTimer);
      }

      let buffer = "";
      const processLine = (line: string) => {
        if (!line.trim()) return;
        let event: { type?: string; message?: Message };
        try {
          event = JSON.parse(line);
        } catch {
          return;
        }
        if (event.type === "message_end" && event.message) {
          const msg = event.message;
          result.messages.push(msg);
          if (msg.role === "assistant") {
            result.usage.turns++;
            const u = msg.usage;
            if (u) {
              result.usage.input += u.input || 0;
              result.usage.output += u.output || 0;
              result.usage.cacheRead += u.cacheRead || 0;
              result.usage.cacheWrite += u.cacheWrite || 0;
              result.usage.cost += u.cost?.total || 0;
              result.usage.contextTokens = u.totalTokens || 0;
            }
            if (!result.model && msg.model) result.model = msg.model;
            if (msg.stopReason) result.stopReason = msg.stopReason;
            if (msg.errorMessage) result.errorMessage = msg.errorMessage;
          }
        }
        if (event.type === "tool_result_end" && event.message) {
          result.messages.push(event.message);
        }
      };

      proc.stdout.on("data", (data) => {
        resetIdle();
        buffer += data.toString();
        const lines = buffer.split("\n");
        buffer = lines.pop() || "";
        for (const line of lines) processLine(line);
      });
      proc.stderr.on("data", (data) => {
        resetIdle();
        result.stderr += data.toString();
      });
      proc.on("close", (code) => {
        clearTimers();
        if (buffer.trim()) processLine(buffer);
        resolve(code ?? 0);
      });
      proc.on("error", () => {
        clearTimers();
        resolve(1);
      });

      if (opts.signal) {
        const kill = () => {
          aborted = true;
          proc.kill("SIGTERM");
          setTimeout(() => {
            if (!proc.killed) proc.kill("SIGKILL");
          }, 5000);
        };
        if (opts.signal.aborted) kill();
        else opts.signal.addEventListener("abort", kill, { once: true });
      }
    });

    result.exitCode = exitCode;
    if (aborted) {
      result.stopReason = "aborted";
      result.errorMessage = "delegation aborted";
    } else if (timedOut) {
      result.stopReason = "timeout";
      const ms = timedOut === "idle" ? opts.idleTimeoutMs! : opts.hardTimeoutMs!;
      const secs = Math.round(ms / 1000);
      result.errorMessage =
        timedOut === "idle"
          ? `no output for ${secs}s (likely wedged on a tool call)`
          : `exceeded the ${secs}s hard time cap`;
    }
    return result;
  } finally {
    if (tmpPath) try { fs.unlinkSync(tmpPath); } catch { /* ignore */ }
    if (tmpDir) try { fs.rmdirSync(tmpDir); } catch { /* ignore */ }
  }
}

/** Collapse whitespace and clip to `max` chars with an ellipsis. */
function clip(s: string, max: number): string {
  const flat = s.replace(/\s+/g, " ").trim();
  return flat.length > max ? flat.slice(0, max - 1).trimEnd() + "…" : flat;
}

/** One-line usage summary for surfacing cost back to the parent model. */
export function usageLine(r: DelegateResult): string {
  const u = r.usage;
  const parts = [`${u.turns} turn${u.turns === 1 ? "" : "s"}`];
  if (u.input) parts.push(`↑${u.input}`);
  if (u.output) parts.push(`↓${u.output}`);
  if (u.cost) parts.push(`$${u.cost.toFixed(4)}`);
  if (r.model) parts.push(r.model);
  return parts.join(" ");
}
