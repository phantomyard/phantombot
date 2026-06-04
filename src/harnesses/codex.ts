/**
 * Codex harness.
 *
 * Uses `codex exec --json` for non-interactive JSONL streaming. We run in
 * YOLO mode (`--dangerously-bypass-approvals-and-sandbox`) and with
 * `--ephemeral --ignore-user-config --ignore-rules` so phantombot-managed
 * persona/memory stays authoritative and Codex local memory/rules do not leak
 * into agent behavior.
 */

import { access, constants } from "node:fs/promises";
import type { Harness, HarnessChunk, HarnessRequest } from "./types.ts";
import { reloadEnvFiles, withPersonaEnv } from "../lib/envBootstrap.ts";
import {
  createKillCoordinator,
  type HarnessActivity,
  killCauseToErrorChunk,
} from "../lib/harnessRunner.ts";
import { log } from "../lib/logger.ts";
import { spawnInNewSession } from "../lib/processGroup.ts";

export interface CodexHarnessConfig {
  bin: string;
  model: string;
}

export class CodexHarness implements Harness {
  readonly id = "codex";

  constructor(private readonly config: CodexHarnessConfig) {}

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
    const args = this.buildArgs(req.toolsMode);
    log.debug("codex.invoke spawning", {
      bin: this.config.bin,
      argCount: args.length,
    });

    await reloadEnvFiles();

    const proc = spawnInNewSession([this.config.bin, ...args], {
      cwd: req.workingDir,
      env: withPersonaEnv(process.env, req.persona),
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
    });

    try {
      proc.stdin.write(renderStdinPayload(req));
      await proc.stdin.end();
    } catch (e) {
      log.warn("codex.invoke stdin write failed", {
        error: (e as Error).message,
      });
    }

    const killer = createKillCoordinator({
      proc,
      idleTimeoutMs: req.idleTimeoutMs,
      hardTimeoutMs: req.hardTimeoutMs,
      signal: req.signal,
      harnessId: this.id,
    });

    void consumeStderr(proc.stderr);

    let buffer = "";
    let finalText = "";
    let usageMeta: Record<string, unknown> | undefined;
    const decoder = new TextDecoder();

    try {
      for await (const chunk of proc.stdout as ReadableStream<Uint8Array>) {
        // NB: do NOT touch() here. The idle timer must measure time since
        // last *productive* output, not since last raw chunk — otherwise
        // synthetic heartbeats keep postponing the idle kill on a wedged
        // turn. See issue #123.
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
            killer.touch("productive"); // non-JSON line is real output
            yield { type: "progress", note: trimmed.slice(0, 200) };
            continue;
          }
          const c = parseCodexEvent(parsed);
          if (!c) continue;
          killer.touch(codexActivity(parsed, c));
          if (c.type === "text") finalText += c.text;
          if (c.type === "done") {
            usageMeta = c.meta;
            continue;
          }
          yield c;
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
        error: `codex exited with code ${code}`,
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
        ...(usageMeta ?? {}),
      },
    };
  }

  private buildArgs(toolsMode?: "none"): string[] {
    const args = [
      "exec",
      "--json",
      "--skip-git-repo-check",
      // Tool-less threat-judge mode → read-only sandbox (the judge may read
      // but cannot mutate state or act); normal turns → bypass sandbox.
      ...(toolsMode === "none"
        ? PHANTOMBOT_JUDGE_CODEX_FLAGS
        : PHANTOMBOT_INJECTED_CODEX_FLAGS),
    ];
    if (this.config.model) {
      args.push("-m", this.config.model);
    }
    args.push("-");
    return args;
  }
}

export function renderStdinPayload(req: HarnessRequest): string {
  const parts: string[] = [];
  if (req.systemPrompt && req.systemPrompt.trim().length > 0) {
    parts.push(req.systemPrompt.trim());
  }
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

export const PHANTOMBOT_INJECTED_CODEX_FLAGS = [
  "--dangerously-bypass-approvals-and-sandbox",
  "--ephemeral",
  "--ignore-user-config",
  "--ignore-rules",
] as const;

/**
 * Flags for the tool-less threat judge (toolsMode "none"). Swaps the YOLO
 * bypass for codex's native `--sandbox read-only` policy (per `codex exec
 * --help`: read-only restricts model-generated shell commands to reads). The
 * judge can READ but cannot mutate state or act — a sufficient floor since the
 * screener consumes only the judge's number. Keeps --ephemeral/--ignore-* so
 * the judge spawn stays isolated from user config/rules.
 */
export const PHANTOMBOT_JUDGE_CODEX_FLAGS = [
  "--sandbox", "read-only",
  "--ephemeral",
  "--ignore-user-config",
  "--ignore-rules",
] as const;

export function parseCodexEvent(parsed: unknown): HarnessChunk | undefined {
  if (typeof parsed !== "object" || parsed === null) return undefined;
  const obj = parsed as Record<string, unknown>;
  const type = obj.type;
  if (type === "item.started") {
    const item = obj.item;
    if (typeof item !== "object" || item === null) return undefined;
    const it = item as Record<string, unknown>;
    if (typeof it.type === "string" && it.type.includes("tool")) {
      return { type: "progress", note: "tool" };
    }
    // Non-tool starts are still useful liveness signals while the model is
    // preparing output, but they should not flush user-visible narration.
    return { type: "heartbeat" };
  }
  if (type === "item.completed") {
    const item = obj.item;
    if (typeof item !== "object" || item === null) return undefined;
    const it = item as Record<string, unknown>;
    if (it.type === "agent_message" && typeof it.text === "string") {
      return { type: "text", text: it.text };
    }
    if (typeof it.type === "string" && it.type.includes("tool")) {
      return { type: "progress", note: "tool" };
    }
    return { type: "heartbeat" };
  }
  if (type === "turn.started") return { type: "heartbeat" };
  if (type === "turn.completed") {
    const usage = obj.usage;
    if (typeof usage === "object" && usage !== null) {
      return { type: "done", finalText: "", meta: { usage } };
    }
    return { type: "done", finalText: "", meta: undefined };
  }
  return undefined;
}

function codexActivity(
  parsed: unknown,
  chunk: HarnessChunk,
): HarnessActivity {
  if (chunk.type === "text" || chunk.type === "done") return "productive";
  if (typeof parsed !== "object" || parsed === null) {
    return chunk.type === "heartbeat" ? "model" : "productive";
  }
  const obj = parsed as Record<string, unknown>;
  const item = obj.item;
  const itemType =
    typeof item === "object" && item !== null
      ? (item as Record<string, unknown>).type
      : undefined;
  if (obj.type === "item.started" && typeof itemType === "string" && itemType.includes("tool")) {
    return "tool";
  }
  if (obj.type === "item.completed" && typeof itemType === "string" && itemType.includes("tool")) {
    return "productive";
  }
  return chunk.type === "heartbeat" ? "model" : "productive";
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
          log.info("codex stderr", { text: line.slice(0, 500) });
        }
      }
    }
  } catch {
    /* swallow */
  }
}
