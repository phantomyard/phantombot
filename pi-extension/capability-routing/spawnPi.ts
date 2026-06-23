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
import type { Message } from "@earendil-works/pi-ai";

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
 * A single per-turn progress event forwarded from the child as it streams.
 * Emitted from the child's OWN json output (one per assistant `message_end`),
 * so we surface exactly what Pi already reports — no invented protocol.
 */
export interface DelegateProgress {
  /** 1-based assistant turn index within this delegation. */
  turn: number;
  /** Trimmed snippet of the assistant's text for this turn, if any. */
  text?: string;
  /** Tool names the assistant invoked this turn (edit, bash, write, …). */
  tools: string[];
  /** True once this turn carries a terminal stopReason (the final answer). */
  terminal: boolean;
}

/**
 * Best-effort extraction of tool-call names from an assistant message's content
 * parts. Pi's exact part shape isn't pinned here (the extension runs against
 * whatever pi-ai the host pi ships), so this reads defensively: anything that
 * isn't a text part and exposes a string name is treated as a tool call.
 */
function toolNamesOf(msg: Message): string[] {
  const names: string[] = [];
  for (const part of (msg.content ?? []) as unknown[]) {
    const p = part as { type?: string; name?: unknown; toolName?: unknown };
    if (p.type === "text") continue;
    const name = typeof p.name === "string" ? p.name
      : typeof p.toolName === "string" ? p.toolName
      : undefined;
    if (name) names.push(name);
  }
  return names;
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
    const exitCode = await new Promise<number>((resolve) => {
      const inv = getPiInvocation(args);
      const proc = spawn(inv.command, inv.args, {
        cwd: opts.cwd,
        shell: false,
        stdio: ["ignore", "pipe", "pipe"],
      });

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
              let text: string | undefined;
              for (const part of msg.content) {
                if (part.type === "text" && part.text.trim()) {
                  text = part.text.trim();
                  break;
                }
              }
              try {
                opts.onProgress({
                  turn: result.usage.turns,
                  text,
                  tools: toolNamesOf(msg),
                  terminal: Boolean(msg.stopReason),
                });
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
        buffer += data.toString();
        const lines = buffer.split("\n");
        buffer = lines.pop() || "";
        for (const line of lines) processLine(line);
      });
      proc.stderr.on("data", (data) => {
        result.stderr += data.toString();
      });
      proc.on("close", (code) => {
        if (buffer.trim()) processLine(buffer);
        resolve(code ?? 0);
      });
      proc.on("error", () => resolve(1));

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
    }
    return result;
  } finally {
    if (tmpPath) try { fs.unlinkSync(tmpPath); } catch { /* ignore */ }
    if (tmpDir) try { fs.rmdirSync(tmpDir); } catch { /* ignore */ }
  }
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
