import { createRequire } from "node:module";
var __require = /* @__PURE__ */ createRequire(import.meta.url);

// extensions/vscode-phantombot/src/extension.ts
import * as vscode from "vscode";
import { spawn } from "child_process";
function getConfig() {
  const config = vscode.workspace.getConfiguration("phantombot");
  return {
    persona: config.get("persona", ""),
    path: config.get("path", "phantombot"),
    autoContext: config.get("autoContext", true),
    maxContextFiles: config.get("maxContextFiles", 10),
    conversationPersistence: config.get("conversationPersistence", true)
  };
}
function buildPayload(request, _chatContext) {
  const config = getConfig();
  const editor = vscode.window.activeTextEditor;
  const doc = editor?.document;
  const selection = editor?.selection;
  const payload = {
    message: request.prompt
  };
  if (config.persona) {
    payload.persona = config.persona;
  }
  if (config.autoContext && doc) {
    const activeSelection = selection && !selection.isEmpty ? {
      startLine: selection.start.line + 1,
      endLine: selection.end.line + 1,
      text: doc.getText(selection)
    } : undefined;
    payload.activeFile = {
      path: doc.uri.fsPath,
      language: doc.languageId,
      content: doc.getText(),
      selection: activeSelection
    };
  }
  if (config.autoContext && doc) {
    const diagnostics = vscode.languages.getDiagnostics(doc.uri);
    if (diagnostics.length > 0) {
      payload.diagnostics = diagnostics.map((d) => ({
        path: doc.uri.fsPath,
        line: d.range.start.line + 1,
        column: d.range.start.character + 1,
        message: d.message,
        severity: mapSeverity(d.severity)
      }));
    }
  }
  const workspaceFolders = vscode.workspace.workspaceFolders;
  if (workspaceFolders && workspaceFolders.length > 0) {
    const root = workspaceFolders[0].uri.fsPath;
    const openFiles = vscode.window.visibleTextEditors.map((e) => e.document.uri.fsPath).filter((p) => p.startsWith(root)).slice(0, config.maxContextFiles);
    payload.workspace = { root, openFiles };
  }
  if (request.references) {
    const images = [];
    const attachedFiles = [];
    for (const ref of request.references) {
      if (ref.id.startsWith("vscode.chat.image")) {
        const value = ref.value;
      } else if (ref.id === "vscode.chat.codeBlock") {
        const code = ref.value;
        attachedFiles.push({ path: "selection", content: code });
      }
    }
    if (images.length > 0)
      payload.images = images;
    if (attachedFiles.length > 0)
      payload.attachedFiles = attachedFiles;
  }
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
function mapSeverity(severity) {
  switch (severity) {
    case vscode.DiagnosticSeverity.Error:
      return "error";
    case vscode.DiagnosticSeverity.Warning:
      return "warning";
    default:
      return "info";
  }
}
function resolvePhantombot() {
  const config = getConfig();
  const customPath = config.path;
  if (customPath && customPath !== "phantombot") {
    return customPath;
  }
  return "phantombot";
}
async function* streamPhantombot(payload) {
  const bin = resolvePhantombot();
  const proc = spawn(bin, ["editor"], {
    stdio: ["pipe", "pipe", "pipe"],
    env: { ...process.env }
  });
  proc.stdin.write(JSON.stringify(payload));
  proc.stdin.end();
  let buffer = "";
  yield* readStream(proc, buffer);
  const exitCode = await new Promise((resolve) => {
    proc.on("close", (code) => resolve(code ?? 1));
  });
  if (exitCode !== 0) {
    yield {
      type: "error",
      message: `phantombot exited with code ${exitCode}`
    };
  }
}
async function* readStream(proc, buffer) {
  if (!proc.stdout)
    return;
  const controller = new AbortController;
  const { signal } = controller;
  proc.stdout.on("data", (chunk) => {
    buffer += chunk.toString();
  });
  await new Promise((resolve) => {
    proc.on("close", () => {
      controller.abort();
      resolve();
    });
  });
  const lines = buffer.split(`
`).filter((l) => l.trim());
  for (const line of lines) {
    try {
      const parsed = JSON.parse(line);
      yield parsed;
    } catch {
      yield { type: "text", content: line };
    }
  }
}
function createChatParticipant(context) {
  const participant = vscode.chat.createChatParticipant("phantombot", handleChatRequest);
  participant.followupProvider = {
    provideFollowups(_result, _context, _token) {
      return [
        { prompt: "/code Refactor this function", label: "Refactor" },
        { prompt: "/vision What does this error mean?", label: "Vision" },
        { prompt: "/fast Explain this in simple terms", label: "Simple explain" }
      ];
    }
  };
  return participant;
}
async function handleChatRequest(request, chatContext, stream, token) {
  const payload = buildPayload(request, chatContext);
  const controller = new AbortController;
  token.onCancellationRequested(() => controller.abort());
  try {
    for await (const chunk of streamPhantombot(payload)) {
      if (token.isCancellationRequested)
        break;
      switch (chunk.type) {
        case "text":
          if (chunk.content) {
            stream.markdown(chunk.content);
          }
          break;
        case "tool_use":
          stream.progress(chunk.command ? `Running ${chunk.tool}: ${chunk.command}` : `Running ${chunk.tool}...`);
          break;
        case "tool_result":
          if (chunk.output) {
            stream.markdown(`\`\`\`
${chunk.output}
\`\`\`
`);
          }
          break;
        case "error":
          stream.markdown(`⚠️ ${chunk.message || "Unknown error"}`);
          break;
        case "done":
          break;
      }
    }
  } catch (err) {
    const msg = err.message;
    if (msg.includes("ENOENT")) {
      stream.markdown("⚠️ **Phantombot not found.** Install phantombot and ensure it's on PATH, " + "or set `phantombot.path` in VS Code settings.");
    } else {
      stream.markdown(`⚠️ **Error:** ${msg}`);
    }
  }
  return {};
}
function activate(context) {
  const participant = createChatParticipant(context);
  context.subscriptions.push(participant);
  const statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
  statusBarItem.text = "$(brain) Phantombot";
  statusBarItem.tooltip = "Phantombot is active — @phantombot in Chat";
  statusBarItem.show();
  context.subscriptions.push(statusBarItem);
  context.subscriptions.push(vscode.commands.registerCommand("phantombot.selectPersona", async () => {
    const persona = await vscode.window.showInputBox({
      prompt: "Enter persona name (empty = default)",
      placeHolder: "e.g. kai, lena, robbie"
    });
    if (persona !== undefined) {
      const config = vscode.workspace.getConfiguration("phantombot");
      await config.update("persona", persona, vscode.ConfigurationTarget.Global);
      vscode.window.showInformationMessage(`Phantombot persona set to: ${persona || "(default)"}`);
    }
  }));
  context.subscriptions.push(vscode.commands.registerCommand("phantombot.checkStatus", async () => {
    const { spawn: spawn2 } = await import("child_process");
    const bin = resolvePhantombot();
    return new Promise((resolve) => {
      const proc = spawn2(bin, ["--version"], {
        stdio: ["pipe", "pipe", "pipe"]
      });
      let stdout = "";
      proc.stdout?.on("data", (d) => stdout += d.toString());
      proc.on("close", (code) => {
        if (code === 0) {
          vscode.window.showInformationMessage(`Phantombot: ${stdout.trim()}`);
        } else {
          vscode.window.showErrorMessage("Phantombot not responding. Check installation.");
        }
        resolve();
      });
      proc.on("error", () => {
        vscode.window.showErrorMessage("Phantombot not found on PATH. Set `phantombot.path` in settings.");
        resolve();
      });
    });
  }));
}
function deactivate() {}
export {
  deactivate,
  activate
};

//# debugId=D9C03708944D295164756E2164756E21
