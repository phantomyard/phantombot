/**
 * Phantombot VS Code Extension
 *
 * Registers `@phantombot` as a chat participant in VS Code's Chat view.
 * Routes requests through `phantombot editor` — same persona, memory,
 * tools, and model routing as your Telegram/PhantomChat bot.
 *
 * Architecture:
 *   VS Code Chat → extension.ts → child_process.spawn("phantombot", ["editor"])
 *                                → streaming JSON response → rendered in Chat
 *
 * Trust model: local CLI = same OS user = principal. The `phantombot editor`
 * command sets trusted: true internally and skips the threat judge.
 */

import * as vscode from "vscode";
import { spawn, type ChildProcess } from "child_process";

// ── Types ──────────────────────────────────────────────────────────────

interface EditorPayload {
  message: string;
  activeFile?: {
    path: string;
    language: string;
    content: string;
    selection?: {
      startLine: number;
      endLine: number;
      text: string;
    };
  };
  workspace?: {
    root: string;
    openFiles: string[];
  };
  diagnostics?: Array<{
    path: string;
    line: number;
    column: number;
    message: string;
    severity: "error" | "warning" | "info";
  }>;
  images?: Array<{
    mime: string;
    data: string;
  }>;
  attachedFiles?: Array<{
    path: string;
    content: string;
  }>;
  modelHint?: "vision" | "code" | "fast" | "reasoning";
  conversationId?: string;
  persona?: string;
}

interface EditorOutputChunk {
  type: "text" | "tool_use" | "tool_result" | "error" | "done";
  content?: string;
  message?: string;
  tool?: string;
  command?: string;
  output?: string;
  model?: string;
}

// ── Config ─────────────────────────────────────────────────────────────

function getConfig() {
  const config = vscode.workspace.getConfiguration("phantombot");
  return {
    persona: config.get<string>("persona", ""),
    path: config.get<string>("path", "phantombot"),
    autoContext: config.get<boolean>("autoContext", true),
    maxContextFiles: config.get<number>("maxContextFiles", 10),
    conversationPersistence: config.get<boolean>("conversationPersistence", true),
  };
}

// ── Context Building ───────────────────────────────────────────────────

function buildPayload(
  request: vscode.ChatRequest,
  _chatContext: vscode.ChatContext,
): EditorPayload {
  const config = getConfig();
  const editor = vscode.window.activeTextEditor;
  const doc = editor?.document;
  const selection = editor?.selection;

  const payload: EditorPayload = {
    message: request.prompt,
  };

  // Persona override
  if (config.persona) {
    payload.persona = config.persona;
  }

  // Active file context
  if (config.autoContext && doc) {
    const activeSelection =
      selection && !selection.isEmpty
        ? {
            startLine: selection.start.line + 1,
            endLine: selection.end.line + 1,
            text: doc.getText(selection),
          }
        : undefined;

    payload.activeFile = {
      path: doc.uri.fsPath,
      language: doc.languageId,
      content: doc.getText(),
      selection: activeSelection,
    };
  }

  // Diagnostics for the active file
  if (config.autoContext && doc) {
    const diagnostics = vscode.languages.getDiagnostics(doc.uri);
    if (diagnostics.length > 0) {
      payload.diagnostics = diagnostics.map((d) => ({
        path: doc.uri.fsPath,
        line: d.range.start.line + 1,
        column: d.range.start.character + 1,
        message: d.message,
        severity: mapSeverity(d.severity),
      }));
    }
  }

  // Workspace context
  const workspaceFolders = vscode.workspace.workspaceFolders;
  if (workspaceFolders && workspaceFolders.length > 0) {
    const root = workspaceFolders[0].uri.fsPath;
    const openFiles = vscode.window.visibleTextEditors
      .map((e) => e.document.uri.fsPath)
      .filter((p) => p.startsWith(root))
      .slice(0, config.maxContextFiles);

    payload.workspace = { root, openFiles };
  }

  // Attached images (from chat context)
  if (request.references) {
    const images: Array<{ mime: string; data: string }> = [];
    const attachedFiles: Array<{ path: string; content: string }> = [];

    for (const ref of request.references) {
      if (ref.id.startsWith("vscode.chat.image")) {
        // Image reference — base64 data is in the value
        const value = ref.value as vscode.Uri;
        // VS Code provides image URIs; we note them but can't easily
        // extract base64 from the chat reference API directly.
        // The backend will handle this when the API matures.
      } else if (ref.id === "vscode.chat.codeBlock") {
        // Code block reference
        const code = ref.value as string;
        attachedFiles.push({ path: "selection", content: code });
      }
    }

    if (images.length > 0) payload.images = images;
    if (attachedFiles.length > 0) payload.attachedFiles = attachedFiles;
  }

  // Model hint from request command
  if (request.command === "vision") {
    payload.modelHint = "vision";
  } else if (request.command === "code") {
    payload.modelHint = "code";
  } else if (request.command === "fast") {
    payload.modelHint = "fast";
  } else if (request.command === "reason") {
    payload.modelHint = "reasoning";
  }

  return payload;
}

function mapSeverity(
  severity: vscode.DiagnosticSeverity,
): "error" | "warning" | "info" {
  switch (severity) {
    case vscode.DiagnosticSeverity.Error:
      return "error";
    case vscode.DiagnosticSeverity.Warning:
      return "warning";
    default:
      return "info";
  }
}

// ── Phantombot Process Management ──────────────────────────────────────

/** Resolve the phantombot binary path. */
function resolvePhantombot(): string {
  const config = getConfig();
  const customPath = config.path;
  if (customPath && customPath !== "phantombot") {
    return customPath;
  }
  // Default: assume phantombot is on PATH
  return "phantombot";
}

/**
 * Spawn `phantombot editor` with the given payload and stream the response.
 * Returns an async iterator of output chunks.
 */
async function* streamPhantombot(
  payload: EditorPayload,
): AsyncGenerator<EditorOutputChunk> {
  const bin = resolvePhantombot();

  const proc = spawn(bin, ["editor"], {
    stdio: ["pipe", "pipe", "pipe"],
    env: { ...process.env },
  });

  // Send payload on stdin
  proc.stdin.write(JSON.stringify(payload));
  proc.stdin.end();

  // Buffer for partial lines
  let buffer = "";

  // Yield chunks from stdout
  yield* readStream(proc, buffer);

  // Wait for process to exit
  const exitCode = await new Promise<number>((resolve) => {
    proc.on("close", (code) => resolve(code ?? 1));
  });

  if (exitCode !== 0) {
    yield {
      type: "error",
      message: `phantombot exited with code ${exitCode}`,
    };
  }
}

async function* readStream(
  proc: ChildProcess,
  buffer: string,
): AsyncGenerator<EditorOutputChunk> {
  if (!proc.stdout) return;

  const controller = new AbortController();
  const { signal } = controller;

  proc.stdout.on("data", (chunk: Buffer) => {
    buffer += chunk.toString();
  });

  // Wait for the process to close, then yield remaining buffer
  await new Promise<void>((resolve) => {
    proc.on("close", () => {
      controller.abort();
      resolve();
    });
  });

  // Process all complete lines
  const lines = buffer.split("\n").filter((l) => l.trim());
  for (const line of lines) {
    try {
      const parsed = JSON.parse(line) as EditorOutputChunk;
      yield parsed;
    } catch {
      // Non-JSON output — yield as text
      yield { type: "text", content: line };
    }
  }
}

// ── Chat Participant ───────────────────────────────────────────────────

interface PhantombotChatResult extends vscode.ChatResult {
  metadata?: {
    command?: string;
  };
}

function createChatParticipant(
  context: vscode.ExtensionContext,
): vscode.ChatParticipant {
  const participant = vscode.chat.createChatParticipant(
    "phantombot",
    handleChatRequest,
  );

  // Slash command suggestions
  participant.followupProvider = {
    provideFollowups(
      _result: PhantombotChatResult,
      _token: vscode.CancellationToken,
    ) {
      return [
        { prompt: "/code Refactor this function", label: "Refactor" },
        { prompt: "/vision What does this error mean?", label: "Vision" },
        { prompt: "/fast Explain this in simple terms", label: "Simple explain" },
      ];
    },
  };

  return participant;
}

async function handleChatRequest(
  request: vscode.ChatRequest,
  chatContext: vscode.ChatContext,
  stream: vscode.ChatResponseStream,
  token: vscode.CancellationToken,
): Promise<PhantombotChatResult> {
  const payload = buildPayload(request, chatContext);

  // Cancellation support
  const controller = new AbortController();
  token.onCancellationRequested(() => controller.abort());

  try {
    for await (const chunk of streamPhantombot(payload)) {
      if (token.isCancellationRequested) break;

      switch (chunk.type) {
        case "text":
          if (chunk.content) {
            stream.markdown(chunk.content);
          }
          break;

        case "tool_use":
          stream.progress(
            chunk.command
              ? `Running ${chunk.tool}: ${chunk.command}`
              : `Running ${chunk.tool}...`,
          );
          break;

        case "tool_result":
          // Tool results shown as code block
          if (chunk.output) {
            stream.markdown(`\`\`\`\n${chunk.output}\n\`\`\`\n`);
          }
          break;

        case "error":
          stream.markdown(`⚠️ ${chunk.message || "Unknown error"}`);
          break;

        case "done":
          // Final chunk — nothing to render
          break;
      }
    }
  } catch (err) {
    const msg = (err as Error).message;
    if (msg.includes("ENOENT")) {
      stream.markdown(
        "⚠️ **Phantombot not found.** Install phantombot and ensure it's on PATH, " +
          "or set `phantombot.path` in VS Code settings.",
      );
    } else {
      stream.markdown(`⚠️ **Error:** ${msg}`);
    }
  }

  return {};
}

// ── Activation ─────────────────────────────────────────────────────────

export function activate(context: vscode.ExtensionContext) {
  const participant = createChatParticipant(context);
  context.subscriptions.push(participant);

  // Status bar indicator
  const statusBarItem = vscode.window.createStatusBarItem(
    vscode.StatusBarAlignment.Right,
    100,
  );
  statusBarItem.text = "$(brain) Phantombot";
  statusBarItem.tooltip = "Phantombot is active — @phantombot in Chat";
  statusBarItem.show();
  context.subscriptions.push(statusBarItem);

  // Command to configure persona
  context.subscriptions.push(
    vscode.commands.registerCommand(
      "phantombot.selectPersona",
      async () => {
        const persona = await vscode.window.showInputBox({
          prompt: "Enter persona name (empty = default)",
          placeHolder: "e.g. kai, lena, robbie",
        });
        if (persona !== undefined) {
          const config = vscode.workspace.getConfiguration("phantombot");
          await config.update("persona", persona, vscode.ConfigurationTarget.Global);
          vscode.window.showInformationMessage(
            `Phantombot persona set to: ${persona || "(default)"}`,
          );
        }
      },
    ),
  );

  // Command to check phantombot status
  context.subscriptions.push(
    vscode.commands.registerCommand("phantombot.checkStatus", async () => {
      const { spawn } = require("child_process") as typeof import("child_process");
      const bin = resolvePhantombot();

      return new Promise<void>((resolve) => {
        const proc = spawn(bin, ["--version"], {
          stdio: ["pipe", "pipe", "pipe"],
        });
        let stdout = "";
        proc.stdout?.on("data", (d: Buffer) => (stdout += d.toString()));
        proc.on("close", (code: number | null) => {
          if (code === 0) {
            vscode.window.showInformationMessage(
              `Phantombot: ${stdout.trim()}`,
            );
          } else {
            vscode.window.showErrorMessage(
              "Phantombot not responding. Check installation.",
            );
          }
          resolve();
        });
        proc.on("error", () => {
          vscode.window.showErrorMessage(
            "Phantombot not found on PATH. Set `phantombot.path` in settings.",
          );
          resolve();
        });
      });
    }),
  );
}

export function deactivate() {}
