/**
 * Codex harness.
 *
 * Uses `codex exec --json` for non-interactive JSONL streaming. We run in
 * YOLO mode (`--dangerously-bypass-approvals-and-sandbox`) and with
 * `--ephemeral --ignore-rules` so phantombot-managed persona/memory stays
 * authoritative and Codex's local rules/memory do not leak into agent
 * behavior. We deliberately let user config (~/.codex/config.toml) load on
 * normal turns so MCP connectors (Google Workspace, etc.) remain available.
 * The tool-less threat judge is the exception — it keeps `--ignore-user-config`
 * (see PHANTOMBOT_JUDGE_CODEX_FLAGS) for maximum isolation when reading
 * untrusted input.
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
      env: withPersonaEnv(process.env, req.persona, req.conversation),
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
    });

    // Shared engine. Codex's only extras over the baseline: non-JSON progress
    // notes are capped at 200 chars, and the terminal `done` meta folds in the
    // usage stats captured from the turn.completed event.
    yield* runHarnessProcess({
      proc,
      req,
      harnessId: this.id,
      stdinPayload: renderStdinPayload(req),
      parseEvent: parseCodexEvent,
      activity: codexActivity,
      progressNoteLimit: 200,
      buildDoneMeta: (_finalText, captured) => ({
        harnessId: this.id,
        model: this.config.model || "(default)",
        ...(captured ?? {}),
      }),
    });
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
  // NOTE: we intentionally do NOT pass `--ignore-user-config` on normal turns.
  // Codex's MCP connectors (Gmail / Google Calendar / Google Drive, etc.) are
  // configured in ~/.codex/config.toml; --ignore-user-config would skip that
  // file entirely and silently disable every connector. Andrew wants those
  // Workspace connectors available, so user config loads. We still keep
  // `--ignore-rules` below so Codex's local AGENTS.md / project rules / memory
  // do NOT leak into behavior — phantombot's persona stays authoritative.
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
      const name = typeof it.name === "string" ? it.name : undefined;
      return { type: "progress", note: buildToolNote(name, it) };
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
      const name = typeof it.name === "string" ? it.name : undefined;
      return { type: "progress", note: buildToolNote(name, it) };
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
