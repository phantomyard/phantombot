/**
 * `phantombot editor` — CLI backend for editor extensions (VS Code, Zed).
 *
 * Reads a JSON payload from stdin, runs it through the persona + harness
 * chain with `trusted: true` (local invocation = same OS user = principal),
 * and streams newline-delimited JSON chunks to stdout.
 *
 * The extension is a thin context-gathering surface; all intelligence
 * (memory, tools, persona, model routing) lives here.
 *
 * Trust model: this command is ONLY callable via local CLI. The user who
 * can execute `phantombot editor` already has filesystem access to
 * everything phantombot owns — there is nothing left to protect against.
 * The threat judge is skipped. This is a separate command with a clear
 * trust boundary, not a flag on `ask`.
 *
 * Exit codes:
 *   0  success
 *   1  generic failure (harness error, payload parse error)
 *   2  configuration error (no harnesses, persona missing)
 *   3  payload validation error (bad JSON, missing required fields)
 */

import { defineCommand } from "citty";
import { existsSync } from "node:fs";
import { homedir } from "node:os";

import { type Config, loadConfig, personaDir } from "../config.ts";
import { buildHarnessChain } from "../harnesses/buildChain.ts";
import { resolveHarnessBinsForConfig } from "../lib/harnessAvailability.ts";
import type { Harness } from "../harnesses/types.ts";
import type { WriteSink } from "../lib/io.ts";
import { openMemoryStore, type MemoryStore } from "../memory/store.ts";
import { runTurn } from "../orchestrator/turn.ts";
import { makeRetriever } from "../orchestrator/retrieval.ts";
import { makeTurnIndexer } from "../orchestrator/turnIndexer.ts";

// ── Payload types ──────────────────────────────────────────────────────

export interface EditorActiveFile {
  path: string;
  language: string;
  content: string;
  selection?: {
    startLine: number;
    endLine: number;
    text: string;
  };
}

export interface EditorDiagnostics {
  path: string;
  line: number;
  column: number;
  message: string;
  severity: "error" | "warning" | "info";
}

export interface EditorImage {
  mime: string;
  data: string; // base64-encoded
}

export interface EditorAttachedFile {
  path: string;
  content: string;
}

export interface EditorPayload {
  /** The user's message. Required. */
  message: string;

  /** Active file context. */
  activeFile?: EditorActiveFile;

  /** Workspace info. */
  workspace?: {
    root: string;
    openFiles: string[];
  };

  /** Diagnostics from the editor. */
  diagnostics?: EditorDiagnostics[];

  /** Attached images (screenshots, diagrams). Base64-encoded. */
  images?: EditorImage[];

  /** Attached files (dragged into chat). */
  attachedFiles?: EditorAttachedFile[];

  /** Model routing hint. Backend decides, but editor can suggest. */
  modelHint?: "vision" | "code" | "fast" | "reasoning";

  /** Conversation ID. Auto-derived from workspace if omitted. */
  conversationId?: string;

  /** Persona override. Default: config.defaultPersona. */
  persona?: string;
}

/** Streaming output chunk — newline-delimited JSON on stdout. */
export type EditorOutputChunk =
  | { type: "text"; content: string }
  | { type: "tool_use"; tool: string; command?: string }
  | { type: "tool_result"; output: string }
  | { type: "error"; message: string }
  | { type: "done"; model?: string };

// ── Helpers ────────────────────────────────────────────────────────────

/**
 * Build a rich context message from the editor payload. This wraps the
 * user's raw message with file context, diagnostics, and attachments so
 * the harness has everything it needs in a single prompt.
 */
function buildEnrichedMessage(payload: EditorPayload): string {
  const parts: string[] = [];

  // Active file context
  if (payload.activeFile) {
    const f = payload.activeFile;
    const sel = f.selection
      ? `\n\nSelected lines ${f.selection.startLine}–${f.selection.endLine}:\n\`\`\`${f.language}\n${f.selection.text}\n\`\`\``
      : "";
    parts.push(
      `## Active file: ${f.path} (${f.language})\n\`\`\`${f.language}\n${f.content}\n\`\`\`${sel}`,
    );
  }

  // Diagnostics
  if (payload.diagnostics && payload.diagnostics.length > 0) {
    const diagLines = payload.diagnostics.map(
      (d) => `  ${d.severity.toUpperCase()}: ${d.path}:${d.line}:${d.column} — ${d.message}`,
    );
    parts.push(`## Diagnostics\n${diagLines.join("\n")}`);
  }

  // Attached files
  if (payload.attachedFiles && payload.attachedFiles.length > 0) {
    for (const af of payload.attachedFiles) {
      parts.push(
        `## Attached: ${af.path}\n\`\`\`\n${af.content}\n\`\`\``,
      );
    }
  }

  // Images (note presence — actual base60 data goes via the message, not here,
  // because harnesses handle images at the API level, not in prompt text)
  if (payload.images && payload.images.length > 0) {
    parts.push(
      `## Attached images: ${payload.images.map((i) => i.mime).join(", ")}`,
    );
  }

  // Workspace context
  if (payload.workspace) {
    const openList = payload.workspace.openFiles.slice(0, 20).join("\n  ");
    parts.push(
      `## Workspace: ${payload.workspace.root}\nOpen files:\n  ${openList}`,
    );
  }

  // Model hint (as an instruction, not metadata)
  if (payload.modelHint) {
    parts.push(`## Model hint: use the ${payload.modelHint} model for this turn`);
  }

  // The actual user message
  parts.push(`## Request\n${payload.message}`);

  return parts.join("\n\n");
}

/**
 * Derive a conversation ID from the workspace root. This scopes
 * multi-turn history per-project so different workspaces don't collide.
 */
function deriveConversationId(payload: EditorPayload): string {
  if (payload.conversationId) return payload.conversationId;
  if (payload.workspace?.root) {
    // Simple hash of the workspace path for a stable, short ID
    let hash = 0;
    for (let i = 0; i < payload.workspace.root.length; i++) {
      hash = ((hash << 5) - hash + payload.workspace.root.charCodeAt(i)) | 0;
    }
    return `editor:${Math.abs(hash).toString(36)}`;
  }
  return "editor:default";
}

/**
 * Write a JSON chunk to stdout followed by a newline.
 */
function writeChunk(out: WriteSink, chunk: EditorOutputChunk): void {
  out.write(JSON.stringify(chunk) + "\n");
}

// ── Core runner ────────────────────────────────────────────────────────

export interface RunEditorInput {
  payload: EditorPayload;
  config?: Config;
  memory?: MemoryStore;
  harnesses?: Harness[];
  out?: WriteSink;
  err?: WriteSink;
  signal?: AbortSignal;
}

export async function runEditor(input: RunEditorInput): Promise<number> {
  const out = input.out ?? process.stdout;
  const err = input.err ?? process.stderr;
  const payload = input.payload;

  // Validate required fields
  if (!payload.message || typeof payload.message !== "string") {
    writeChunk(out, { type: "error", message: "payload.message is required" });
    return 3;
  }

  let config = input.config ?? (await loadConfig());
  const persona = payload.persona ?? config.defaultPersona;
  const agentDir = personaDir(config, persona);

  if (!existsSync(agentDir)) {
    writeChunk(out, {
      type: "error",
      message: `persona '${persona}' not found at ${agentDir}`,
    });
    return 2;
  }

  // Resolve harnesses
  let harnesses = input.harnesses;
  if (!harnesses) {
    ({ config } = await resolveHarnessBinsForConfig(config, { err }));
    harnesses = buildHarnessChain(config, err);
  }
  if (harnesses.length === 0) {
    writeChunk(out, {
      type: "error",
      message: "no harnesses configured. Run `phantombot harness` to pick at least one.",
    });
    return 2;
  }

  const memory = input.memory ?? (await openMemoryStore(config.memoryDbPath));
  const ownsMemory = !input.memory;

  const conversation = deriveConversationId(payload);
  const enrichedMessage = buildEnrichedMessage(payload);

  // Set the working directory to the workspace root if available, so
  // harness tools (file ops, git, tests) resolve relative to the project.
  const workingDir = payload.workspace?.root ?? homedir();

  let succeeded = false;
  let finalText = "";

  try {
    // CRITICAL: `trusted: true` — local CLI invocation = same OS user = principal.
    // The threat judge is skipped entirely. This is the key trust decision:
    // anyone who can execute `phantombot editor` already has full filesystem
    // access to phantombot's data. There's nothing left to protect against.
    for await (const chunk of runTurn({
      persona,
      conversation,
      userMessage: enrichedMessage,
      agentDir,
      harnesses,
      memory,
      workingDir,
      idleTimeoutMs: config.harnessIdleTimeoutMs,
      hardTimeoutMs: config.harnessHardTimeoutMs,
      noHistory: false, // editor sessions are always threaded
      trusted: true,
      retrieve: makeRetriever(config, persona, agentDir, conversation),
      indexTurns: makeTurnIndexer(config, persona, conversation, memory),
      toolNarration: true, // streaming benefit: let the editor show progress
      signal: input.signal,
    })) {
      switch (chunk.type) {
        case "text":
          writeChunk(out, { type: "text", content: chunk.text });
          finalText += chunk.text;
          break;

        case "progress":
          // Narration text — surface as text chunk for the editor to display
          writeChunk(out, { type: "text", content: chunk.note });
          break;

        case "heartbeat":
          // Silence — editor doesn't need typing indicators
          break;

        case "done":
          finalText = chunk.finalText;
          succeeded = true;
          writeChunk(out, {
            type: "done",
            model: (chunk.meta?.model as string) ?? undefined,
          });
          break;

        case "error":
          writeChunk(out, { type: "error", message: chunk.error });
          break;
      }
    }
  } catch (e) {
    writeChunk(out, {
      type: "error",
      message: (e as Error).message,
    });
    if (ownsMemory) await memory.close();
    return 1;
  }

  if (ownsMemory) await memory.close();

  if (!succeeded) {
    writeChunk(out, {
      type: "error",
      message: "harness chain produced no reply",
    });
    return 1;
  }

  return 0;
}

// ── CLI definition ─────────────────────────────────────────────────────

export default defineCommand({
  meta: {
    name: "editor",
    description:
      "CLI backend for editor extensions. Reads JSON from stdin, streams response to stdout. Trusted by default (local invocation).",
  },
  args: {
    conversation: {
      type: "string",
      description:
        "Override conversation ID. Default: auto-derived from workspace root.",
    },
    persona: {
      type: "string",
      description: "Persona override. Default: the configured default persona.",
    },
  },
  async run({ args }) {
    // Read JSON payload from stdin
    if (process.stdin.isTTY) {
      process.stderr.write(
        "phantombot editor: stdin is a TTY. Pipe a JSON payload.\n" +
          'Example: echo \'{"message":"explain this"}\' | phantombot editor\n',
      );
      process.exitCode = 3;
      return;
    }

    const chunks: Buffer[] = [];
    for await (const chunk of process.stdin) {
      chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
    }
    const raw = Buffer.concat(chunks).toString("utf8").trim();

    if (!raw) {
      process.stderr.write("phantombot editor: empty stdin\n");
      process.exitCode = 3;
      return;
    }

    let payload: EditorPayload;
    try {
      payload = JSON.parse(raw) as EditorPayload;
    } catch {
      process.stderr.write("phantombot editor: invalid JSON on stdin\n");
      process.exitCode = 3;
      return;
    }

    // CLI flag overrides
    if (args.conversation) {
      payload.conversationId = String(args.conversation);
    }
    if (args.persona) {
      payload.persona = String(args.persona);
    }

    process.exitCode = await runEditor({ payload });
  },
});
