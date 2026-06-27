/**
 * phantombot VS Code extension — `activate()` registers the `@phantombot` chat
 * participant in VS Code's native Chat panel and bridges every turn to an
 * embedded ACP client (a spawned `phantombot acp` subprocess).
 *
 * This is the ONLY module that imports `vscode`. Everything it leans on
 * (binary resolution, the ACP client, the prompt bridge) is pure and unit
 * tested under `bun test` with no `vscode` dependency. extension.ts is the thin
 * glue: resolve the binary, lazily spawn one ACP client per workspace, open a
 * session keyed on the workspace folder, and route chat requests through the
 * bridge.
 *
 * PR2 will bundle this as a `.vsix` and auto-install it via
 * reconcileEditorConnectors() (a VS Code EditorSpec slots beside ZED_EDITOR).
 * Nothing here precludes that — the binary the editor spawns is exactly the one
 * the connector will register.
 */

import * as vscode from "vscode";

import { AcpClient } from "./acpClient.ts";
import {
  notFoundMessage,
  resolvePhantombotBinary,
  type ResolveResult,
} from "./binaryResolver.ts";
import { bridgePromptToStream } from "./participant.ts";
import { createLanguageModelChatProvider } from "./lmProvider.ts";
import { registerChatSessionProvider } from "./sessionProvider.ts";

const PARTICIPANT_ID = "phantombot.chat";

/**
 * One ACP client + session per workspace folder. The session id is opaque to
 * us; phantombot keys its memory on the cwd (see session.ts), so reopening the
 * same workspace lands in the same conversation server-side.
 */
interface WorkspaceConn {
  client: AcpClient;
  sessionId: string;
  cwd: string;
}

export function activate(context: vscode.ExtensionContext): void {
  const output = vscode.window.createOutputChannel("phantombot");
  context.subscriptions.push(output);

  // workspace cwd → live connection, spawned lazily on first prompt.
  const conns = new Map<string, WorkspaceConn>();

  const disposeAll = () => {
    for (const [, conn] of conns) conn.client.dispose();
    conns.clear();
  };
  context.subscriptions.push({ dispose: disposeAll });

  const handler: vscode.ChatRequestHandler = async (
    request,
    _ctx,
    stream,
    token,
  ) => {
    const cwd = currentWorkspaceCwd();

    let conn: WorkspaceConn;
    try {
      conn = await ensureConnection(cwd, output, conns, context);
    } catch (e) {
      const msg = (e as Error).message;
      stream.markdown(`**phantombot could not start.**\n\n${msg}`);
      output.appendLine(`[activate] connection failed: ${msg}`);
      return { errorDetails: { message: msg } };
    }

    try {
      const { stopReason } = await bridgePromptToStream({
        client: conn.client,
        sessionId: conn.sessionId,
        request: { prompt: request.prompt },
        stream: {
          markdown: (v) => stream.markdown(v),
          progress: (v) => stream.progress(v),
        },
        token: {
          isCancellationRequested: token.isCancellationRequested,
          onCancellationRequested: (l) => token.onCancellationRequested(l),
        },
      });
      if (stopReason === "refusal") {
        stream.markdown("\n\n_(phantombot declined this turn.)_");
      }
      return {};
    } catch (e) {
      // The subprocess died mid-turn, or the agent errored. Surface it — never
      // a silent hang. Drop the dead connection so the next turn respawns.
      const msg = (e as Error).message;
      conn.client.dispose();
      conns.delete(conn.cwd);
      stream.markdown(`\n\n**phantombot error:** ${msg}`);
      output.appendLine(`[prompt] ${msg}`);
      return { errorDetails: { message: msg } };
    }
  };

  const participant = vscode.chat.createChatParticipant(PARTICIPANT_ID, handler);
  // Icon ships with the extension; falls back to the default robot if absent.
  participant.iconPath = new vscode.ThemeIcon("hubot");
  context.subscriptions.push(participant);

  // ── First-class agent (no @mention, persistent history) ───────────────────
  // Register phantombot as its own entry in VS Code's native chat *sessions*
  // surface — the dedicated panel Copilot CLI and Claude Code live in. This is
  // the real Zed "External Agent" twin: own session, own scrollback, history
  // rehydrated from phantombot's server-side memory. Uses the chatSessionsProvider
  // proposed API; registerChatSessionProvider no-ops cleanly if that proposal
  // isn't enabled for this extension (see argv.json "enable-proposed-api").
  context.subscriptions.push(
    registerChatSessionProvider({
      createClient: (cwd) => makeSessionClient(cwd, output),
      currentCwd: currentWorkspaceCwd,
      workspaceFolders: () =>
        (vscode.workspace.workspaceFolders ?? []).map((f) => ({
          cwd: f.uri.fsPath,
          name: f.name,
        })),
      personaLabel: () =>
        vscode.workspace
          .getConfiguration("phantombot")
          .get<string>("persona")
          ?.trim() ?? "",
      participant,
      participantId: PARTICIPANT_ID,
      output,
    }),
  );

  // ── First-class chat model (no @mention, native history) ─────────────────
  // Register phantombot as a selectable model in the native Chat view via the
  // Language Model Chat Provider API. Shares the SAME per-workspace ACP
  // connection manager as the @phantombot participant above — the participant
  // stays as a fallback surface. `vscode.lm` may be absent on very old hosts;
  // guard so activation never throws on a stale VS Code.
  if (vscode.lm?.registerLanguageModelChatProvider) {
    const lmProvider = createLanguageModelChatProvider({
      ensureConnection: (cwd) => ensureConnection(cwd, output, conns, context),
      dropConnection: (cwd) => {
        const c = conns.get(cwd);
        if (c) {
          c.client.dispose();
          conns.delete(cwd);
        }
      },
      currentCwd: currentWorkspaceCwd,
      personaLabel: () =>
        vscode.workspace
          .getConfiguration("phantombot")
          .get<string>("persona")
          ?.trim() ?? "",
      output,
    });
    context.subscriptions.push(
      vscode.lm.registerLanguageModelChatProvider("phantombot", lmProvider),
    );
    output.appendLine(
      'phantombot language model provider registered (pick "Phantombot" in the chat model list).',
    );
  }

  output.appendLine(
    "phantombot chat participant registered (backs the first-class session agent).",
  );
}

export function deactivate(): void {
  // Subscriptions (incl. the disposeAll hook) are torn down by VS Code.
}

/** Resolve the workspace cwd, falling back to the home dir when none is open. */
function currentWorkspaceCwd(): string {
  const folder = vscode.workspace.workspaceFolders?.[0];
  if (folder) return folder.uri.fsPath;
  return process.cwd();
}

/**
 * Lazily spawn + handshake an ACP client for a workspace, caching it. On any
 * failure (binary not found, handshake error) this throws with an actionable
 * message — the caller renders it into the panel.
 */
async function ensureConnection(
  cwd: string,
  output: vscode.OutputChannel,
  conns: Map<string, WorkspaceConn>,
  _context: vscode.ExtensionContext,
): Promise<WorkspaceConn> {
  const existing = conns.get(cwd);
  if (existing) return existing;

  const resolved = resolveBinaryOrThrow(output);
  output.appendLine(
    `[activate] using phantombot at ${resolved.path} (via ${resolved.source})`,
  );

  const persona = vscode.workspace
    .getConfiguration("phantombot")
    .get<string>("persona");

  const client = new AcpClient({
    binaryPath: resolved.path,
    persona: persona && persona.trim() ? persona.trim() : undefined,
    cwd,
    onDiagnostic: (text) => output.append(text.endsWith("\n") ? text : text + "\n"),
  });

  await client.initialize();
  const sessionId = await client.newSession(cwd);

  const conn: WorkspaceConn = { client, sessionId, cwd };
  conns.set(cwd, conn);
  return conn;
}

/**
 * Build a fresh (un-initialized) ACP client for a workspace cwd — used by the
 * chat-session provider, which owns its own initialize/load/prompt lifecycle.
 * Throws (with an actionable message) if the binary can't be resolved.
 */
function makeSessionClient(
  cwd: string,
  output: vscode.OutputChannel,
): AcpClient {
  const resolved = resolveBinaryOrThrow(output);
  const persona = vscode.workspace
    .getConfiguration("phantombot")
    .get<string>("persona");
  return new AcpClient({
    binaryPath: resolved.path,
    persona: persona && persona.trim() ? persona.trim() : undefined,
    cwd,
    onDiagnostic: (text) =>
      output.append(text.endsWith("\n") ? text : text + "\n"),
  });
}

/** Resolve the binary from settings/PATH/install-locations or throw. */
function resolveBinaryOrThrow(output: vscode.OutputChannel): ResolveResult {
  const configuredPath = vscode.workspace
    .getConfiguration("phantombot")
    .get<string>("binaryPath");

  const resolved = resolvePhantombotBinary({
    platform: process.platform,
    env: process.env,
    configuredPath: configuredPath || undefined,
  });

  if (!resolved) {
    const msg = notFoundMessage(process.platform);
    output.appendLine(`[activate] ${msg}`);
    throw new Error(msg);
  }
  return resolved;
}
