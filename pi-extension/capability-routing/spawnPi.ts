/**
 * Spawn a child `pi` process for a delegated subtask and capture its
 * structured JSON output.
 *
 * Mirrors the pattern in pi's own `examples/extensions/subagent/index.ts`:
 *   pi --mode json -p --no-session --model <model> --tools <...> \
 *      [--append-system-prompt <file>] "<task>"
 *
 * Each delegation is a FRESH pi process. That's deliberate (and the headline
 * caveat for the `coder` tool): process startup is expensive, so delegations
 * are COARSE-GRAINED — one big PR/MR-scoped chunk, not a chatty back-and-forth.
 * The child gets an isolated context window and reports usage/cost back, which
 * we surface to the parent so cost is visible at the call site.
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

/**
 * A single tool call the assistant made this turn, with its (best-effort)
 * input so the progress sink can render the meaningful argument — the file
 * being edited, the command being run — rather than just the bare tool name.
 */
export interface ToolCall {
  /** Tool name (edit, bash, write, read, …), lowercased-as-reported. */
  name: string;
  /** The tool's input object, if pi reported one. Shape is tool-specific. */
  input?: Record<string, unknown>;
}

/**
 * A single per-turn progress event forwarded from the child as it streams.
 * Emitted from the child's OWN json output (one per assistant `message_end`),
 * so we surface exactly what Pi already reports — no invented protocol.
 */
export interface DelegateProgress {
  /** 1-based assistant turn index within this delegation. */
  turn: number;
  /** Trimmed snippet of the assistant's text for this turn, if any. */
  text?: string;
  /** Tool calls (name + input) the assistant invoked this turn. */
  toolCalls: ToolCall[];
  /** True once this turn carries a terminal stopReason (the final answer). */
  terminal: boolean;
}

/**
 * Best-effort extraction of tool-call names from an assistant message's content
 * parts. Pi's exact part shape isn't pinned here (the extension runs against
 * whatever pi-ai the host pi ships), so this reads defensively: anything that
 * isn't a text part and exposes a string name is treated as a tool call.
 */
/**
 * Classify a turn's stopReason. Pi sets a stopReason on EVERY assistant turn,
 * not just the last one: tool-use continuation turns carry `stopReason:
 * "toolUse"`, while the run genuinely ends with `"stop"` (final answer),
 * `"length"` (truncation), or an error/abort state. A turn is "terminal" only
 * when it ENDS the delegation — i.e. any stopReason other than `"toolUse"`.
 *
 * This is the crux of progress streaming: the sink drops terminal turns (their
 * text is the final answer the parent already gets as the tool result), so a
 * naive `Boolean(stopReason)` would mis-flag every edit/bash/write turn as
 * terminal and silently swallow exactly the progress worth reporting.
 */
export function isTerminalStop(stopReason: string | undefined): boolean {
  return Boolean(stopReason) && stopReason !== "toolUse";
}

/**
 * Build a per-turn progress event from a completed assistant message. Pure and
 * side-effect-free so it can be unit-tested without spawning pi: extracts the
 * first non-empty text snippet, the tool-call names, and the terminal flag.
 */
export function buildProgress(msg: Message, turn: number): DelegateProgress {
  let text: string | undefined;
  for (const part of msg.content) {
    if (part.type === "text" && part.text.trim()) {
      text = part.text.trim();
      break;
    }
  }
  return {
    turn,
    text,
    toolCalls: toolCallsOf(msg),
    terminal: isTerminalStop(msg.stopReason),
  };
}

/**
 * Best-effort extraction of tool calls (name + input) from an assistant
 * message's content parts. Pi's exact part shape isn't pinned here (the
 * extension runs against whatever pi-ai the host pi ships), so this reads
 * defensively: anything that isn't a text part and exposes a string name is
 * treated as a tool call. The `input` (also seen as `arguments`/`args`/`params`
 * across SDK versions) is captured when it's an object so the sink can render
 * the meaningful argument; on anything unexpected the call still surfaces with
 * just its name.
 */
export function toolCallsOf(msg: Message): ToolCall[] {
  const calls: ToolCall[] = [];
  for (const part of (msg.content ?? []) as unknown[]) {
    const p = part as {
      type?: string;
      name?: unknown;
      toolName?: unknown;
      input?: unknown;
      arguments?: unknown;
      args?: unknown;
      params?: unknown;
    };
    if (p.type === "text") continue;
    const name =
      typeof p.name === "string"
        ? p.name
        : typeof p.toolName === "string"
          ? p.toolName
          : undefined;
    if (!name) continue;
    const rawInput = p.input ?? p.arguments ?? p.args ?? p.params;
    const input =
      rawInput && typeof rawInput === "object" && !Array.isArray(rawInput)
        ? (rawInput as Record<string, unknown>)
        : undefined;
    calls.push({ name, input });
  }
  return calls;
}

export interface DelegateOptions {
  /** Model id to pin via --model (bare name as printed by `pi --list-models`). */
  model: string;
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
   * Optional per-turn progress sink. Invoked as each assistant `message_end`
   * arrives on the child's json stream. Kept side-effect-free here — the caller
   * decides what to do (e.g. throttle + `phantombot notify`). Any throw is
   * swallowed so a noisy sink can never break the delegation.
   */
  onProgress?: (ev: DelegateProgress) => void;
  /**
   * Optional end-of-run hook, invoked once in `delegate()`'s `finally` block
   * after the child exits (success, error, or abort). Lets a batching sink
   * drain whatever it has buffered so the final lines are never lost. Any
   * throw is swallowed, like onProgress.
   */
  onProgressEnd?: () => void;
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
  return { command: "pi", args };
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

export async function delegate(opts: DelegateOptions): Promise<DelegateResult> {
  const args: string[] = ["--mode", "json", "-p", "--no-session", "--model", opts.model];
  if (opts.tools && opts.tools.length > 0) args.push("--tools", opts.tools.join(","));

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
      // Reset the idle window on every raw chunk from the child (stdout OR
      // stderr). Wired into both data handlers below.
      const onChildActivity = (): void => {
        if (opts.idleTimeoutMs === undefined || timedOut || aborted) return;
        if (idleTimer) clearTimeout(idleTimer);
        idleTimer = setTimeout(() => killTimedOut("idle"), opts.idleTimeoutMs);
        unrefTimer(idleTimer);
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

            if (opts.onProgress) {
              try {
                opts.onProgress(buildProgress(msg, result.usage.turns));
              } catch {
                /* a noisy sink must never break the delegation */
              }
            }
          }
        }
        if (event.type === "tool_result_end" && event.message) {
          result.messages.push(event.message);
        }
      };

      proc.stdout.on("data", (data) => {
        onChildActivity();
        buffer += data.toString();
        const lines = buffer.split("\n");
        buffer = lines.pop() || "";
        for (const line of lines) processLine(line);
      });
      proc.stderr.on("data", (data) => {
        onChildActivity();
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
    // Drain any buffered progress before we return so the tail isn't lost.
    if (opts.onProgressEnd) {
      try {
        opts.onProgressEnd();
      } catch {
        /* a noisy sink must never break the delegation */
      }
    }
    if (tmpPath) try { fs.unlinkSync(tmpPath); } catch { /* ignore */ }
    if (tmpDir) try { fs.rmdirSync(tmpDir); } catch { /* ignore */ }
  }
}

/** Max chars of a rendered tool argument (command/file) before we ellipsize. */
const PROGRESS_ARG_MAX = 60;
/** Max chars of the model's own narration carried into a progress line. */
const PROGRESS_TEXT_MAX = 120;

/** Collapse whitespace and clip to `max` chars with an ellipsis. */
function clip(s: string, max: number): string {
  const flat = s.replace(/\s+/g, " ").trim();
  return flat.length > max ? flat.slice(0, max - 1).trimEnd() + "…" : flat;
}

/** basename without depending on node:path semantics for odd inputs. */
function baseName(p: string): string {
  const flat = p.replace(/[\\/]+$/, "");
  const i = Math.max(flat.lastIndexOf("/"), flat.lastIndexOf("\\"));
  return i >= 0 ? flat.slice(i + 1) : flat;
}

function str(v: unknown): string | undefined {
  return typeof v === "string" && v.trim() ? v.trim() : undefined;
}

/**
 * Render one tool call as a friendly verb + the meaningful argument, e.g.
 *   `✏️ edit auth.ts`, `⚡ bash: npm test`, `📝 write routing.json`,
 *   `📖 read config.toml`. Unknown tools fall back to `🔧 <name>` (with an arg
 *   if one looks renderable). Never throws on missing/odd input.
 */
export function formatToolCall(call: ToolCall): string {
  const name = (call.name || "tool").trim();
  const lower = name.toLowerCase();
  const input = call.input ?? {};
  const file = str(input.file_path) ?? str(input.path) ?? str(input.filename);
  const cmd = str(input.command) ?? str(input.cmd) ?? str(input.script);

  switch (lower) {
    case "edit":
    case "str_replace":
    case "str_replace_editor":
      return file ? `✏️ edit ${baseName(file)}` : "✏️ edit";
    case "write":
    case "create":
    case "create_file":
      return file ? `📝 write ${baseName(file)}` : "📝 write";
    case "read":
    case "view":
    case "cat":
      return file ? `📖 read ${baseName(file)}` : "📖 read";
    case "bash":
    case "shell":
    case "sh":
    case "exec":
    case "run":
      return cmd ? `⚡ bash: ${clip(cmd, PROGRESS_ARG_MAX)}` : "⚡ bash";
    case "grep":
    case "search":
    case "ripgrep": {
      const q = str(input.pattern) ?? str(input.query) ?? str(input.q);
      return q ? `🔎 ${lower}: ${clip(q, PROGRESS_ARG_MAX)}` : `🔎 ${lower}`;
    }
    case "glob":
    case "find":
    case "ls": {
      const q = str(input.pattern) ?? str(input.path) ?? str(input.glob);
      return q ? `📁 ${lower} ${clip(q, PROGRESS_ARG_MAX)}` : `📁 ${lower}`;
    }
    default: {
      // Unknown tool: surface the name and the first renderable string arg.
      const arg =
        file ??
        cmd ??
        str(input.pattern) ??
        str(input.query) ??
        str(input.url) ??
        str(input.name);
      return arg ? `🔧 ${name}: ${clip(arg, PROGRESS_ARG_MAX)}` : `🔧 ${name}`;
    }
  }
}

/**
 * The leading emoji of a rendered tool line (e.g. `⚡` for bash, `✏️` for edit).
 * Used to give a narration line the look of the action that produced it without
 * the verbose verb+arg tail. Never throws.
 */
export function toolIcon(call: ToolCall): string {
  return formatToolCall(call).split(" ")[0] ?? "🔧";
}

/**
 * Build the progress line(s) for one streamed turn — NARRATION with tool icon.
 *
 * Surfaces ONLY the coder's own words (the model's narration), prefixed with the
 * emoji of the tool it was running so the stream stays pretty and tool-flavoured
 * (`⚡ running the test suite`, `✏️ adding the retry guard`). Turns where the
 * coder said nothing are SKIPPED entirely — no verb+arg noise, only lines that
 * carry words. A pure-narration turn (no tool) renders a 💬 speech line.
 *
 * Pure and side-effect-free for unit testing.
 */
export function formatProgressLines(ev: DelegateProgress): string[] {
  const narration = ev.text ? clip(ev.text, PROGRESS_TEXT_MAX) : undefined;

  // Only lines with words show. A silent tool-only turn is dropped.
  if (!narration) return [];

  // Prefix the narration with the first tool's emoji so it reads as one
  // tool-flavoured thought: `⚡ running the test suite`. No tool → speech line.
  const firstCall = ev.toolCalls[0];
  if (firstCall) {
    return [`${toolIcon(firstCall)} ${narration}`];
  }
  return [`💬 ${narration}`];
}

/**
 * A scheduled, cancellable idle callback. setTimeout-shaped by default;
 * injectable so the batcher's idle-flush timing is unit-testable without real
 * timers. `cancel()` must be idempotent.
 */
export interface IdleScheduler {
  schedule(ms: number, fn: () => void): { cancel(): void };
}

const DEFAULT_SCHEDULER: IdleScheduler = {
  schedule(ms, fn) {
    const t = setTimeout(fn, ms);
    if (typeof (t as { unref?: () => void }).unref === "function") {
      (t as { unref: () => void }).unref();
    }
    return { cancel: () => clearTimeout(t) };
  },
};

/**
 * Hybrid-batching accumulator (Option C) for coder progress lines.
 *
 * Lines accumulate into a buffer and flush as ONE digest when EITHER:
 *   (a) the coder has been idle `idleMs` since the last add, OR
 *   (b) the buffer reaches `maxLines`
 * — whichever comes first. `drain()` flushes whatever remains (call it from
 * delegate()'s finally so the tail is never lost). `emit` receives the joined
 * buffer body; it does the actual side-effect (e.g. `phantombot notify`).
 *
 * Pure of any I/O itself, and the idle clock is injected, so the flush triggers
 * can be unit-tested deterministically.
 */
export class ProgressBatcher {
  private buf: string[] = [];
  private pending: { cancel(): void } | undefined;
  private firstEmitted = false;

  constructor(
    private readonly opts: {
      maxLines: number;
      idleMs: number;
      emit: (body: string) => void;
      scheduler?: IdleScheduler;
      /**
       * When true (default), the very first batch of lines flushes
       * immediately instead of waiting for the idle/cap trigger. This
       * restores the "work has started" signal at the top of a coder run —
       * an active coder rarely idles `idleMs`, so without this the first
       * digest can be 20-30s late and the run looks dead. Subsequent lines
       * batch normally.
       */
      flushFirst?: boolean;
    },
  ) {}

  /** Add zero or more lines; may trigger a line-cap flush immediately. */
  add(lines: string[]): void {
    if (lines.length === 0) return;
    for (const l of lines) this.buf.push(l);
    // Start-of-run signal: flush the first batch immediately so the user
    // sees the coder come alive, then fall back to digest batching.
    if (!this.firstEmitted && (this.opts.flushFirst ?? true)) {
      this.firstEmitted = true;
      this.flush();
      return;
    }
    if (this.buf.length >= this.opts.maxLines) {
      this.flush();
      return;
    }
    this.arm();
  }

  /** Flush now if non-empty, cancelling any pending idle timer. */
  flush(): void {
    this.disarm();
    if (this.buf.length === 0) return;
    const body = this.buf.splice(0, this.buf.length).join("\n");
    this.opts.emit(body);
  }

  /** End-of-run drain — alias for flush(), named for the finally-block intent. */
  drain(): void {
    this.flush();
  }

  /**
   * Discard any buffered lines without emitting, cancelling the idle timer.
   * Use when a per-conversation `/viewcoder off` override should suppress a
   * later flush — clearing guarantees a subsequent drain() is a no-op.
   */
  clear(): void {
    this.disarm();
    this.buf.length = 0;
  }

  /** Buffered line count, for tests/introspection. */
  get size(): number {
    return this.buf.length;
  }

  private arm(): void {
    this.disarm();
    const sched = this.opts.scheduler ?? DEFAULT_SCHEDULER;
    this.pending = sched.schedule(this.opts.idleMs, () => {
      this.pending = undefined;
      this.flush();
    });
  }

  private disarm(): void {
    if (this.pending) {
      this.pending.cancel();
      this.pending = undefined;
    }
  }
}

/** One-line usage summary for surfacing cost back to the parent model. */
/**
 * Build the argv for the fire-and-forget `phantombot notify` that ships a
 * coder-progress digest. Persona-scoped: bare `notify` targets the DEFAULT
 * persona, which misroutes progress to the wrong owner on a multi-persona host
 * (Kai/Lena/Jake share a box). When `persona` is set we forward
 * `--persona <persona>` so the digest reaches the persona actually running this
 * coder job; when it is unset we omit the flag so single-persona hosts keep
 * their existing default behaviour. Pure + dependency-free so it's unit-tested
 * without the host Pi SDK on the import path.
 */
export function notifyArgs(
  persona: string | undefined,
  body: string,
): string[] {
  return persona
    ? ["notify", "--persona", persona, "--message", body]
    : ["notify", "--message", body];
}

export function usageLine(r: DelegateResult): string {
  const u = r.usage;
  const parts = [`${u.turns} turn${u.turns === 1 ? "" : "s"}`];
  if (u.input) parts.push(`↑${u.input}`);
  if (u.output) parts.push(`↓${u.output}`);
  if (u.cost) parts.push(`$${u.cost.toFixed(4)}`);
  if (r.model) parts.push(r.model);
  return parts.join(" ");
}
