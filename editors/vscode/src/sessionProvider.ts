/**
 * phantombot **chat session** provider — registers phantombot as a first-class
 * agent in VS Code's native chat *sessions* surface (its own panel entry, no
 * `@mention`), the same slot Copilot CLI and Claude Code occupy.
 *
 * This is the `vscode`-importing glue. All decision-making lives in the pure,
 * bun-tested `sessionBridge.ts`; here we only:
 *   - list one durable session per workspace folder (item provider),
 *   - rehydrate its persisted transcript via ACP `session/load` and hand VS Code
 *     real history turns (content provider),
 *   - bridge each new turn (text + dragged/pasted attachments) to `session/prompt`.
 *
 * Uses the `chatSessionsProvider` proposed API (+ the `chatParticipantPrivate`
 * proposal for the constructable `ChatRequestTurn2` / `ChatResponseTurn2` history
 * classes). Both are enabled for this extension via `argv.json`
 * (`enable-proposed-api`). If the host has NOT enabled them the registration
 * functions are absent — we detect that and no-op so activation never throws.
 */

import * as vscode from "vscode";

import type { AcpClient } from "./acpClient.ts";
import {
  cwdFromResourcePath,
  imageMimeFromPath,
  isImageMime,
  makeReplayCollector,
  mintSessionId,
  promptBlocksFromRequest,
  resolveSessionCandidates,
  sessionResourcePath,
  SESSION_SCHEME,
  SESSION_TYPE,
  type ReplayTurn,
  type SessionAttachment,
} from "./sessionBridge.ts";

/** A live ACP connection backing one workspace's chat session. */
interface SessionConn {
  client: AcpClient;
  sessionId: string;
  cwd: string;
  /** True once `session/load` has registered the session id server-side. */
  loaded: boolean;
}

export interface SessionProviderDeps {
  /** Build a fresh (un-initialized) ACP client bound to `cwd`. */
  createClient(cwd: string): AcpClient;
  /** Resolve the active workspace cwd (fallback when a resource lacks one). */
  currentCwd(): string;
  /** Enumerate workspace folders as session candidates. */
  workspaceFolders(): Array<{ cwd: string; name: string }>;
  /** Human label for the bound persona (shown in the session description). */
  personaLabel(): string;
  /** The default chat participant associated with the session scheme. */
  participant: vscode.ChatParticipant;
  /** Participant id (used when constructing history turns). */
  participantId: string;
  /**
   * Called whenever the user opens the phantombot session (its content is
   * provided). Lets the host remember the session was open so it can be
   * auto-reopened on the next launch (the "sticky" behaviour). Optional.
   */
  onSessionOpened?(): void;
  output: vscode.OutputChannel;
}

/**
 * Register the phantombot chat-session item + content providers. Returns a
 * Disposable that tears down both registrations and every spawned ACP client.
 */
export function registerChatSessionProvider(
  deps: SessionProviderDeps,
): vscode.Disposable {
  const chatApi = vscode.chat as unknown as {
    registerChatSessionItemProvider?: (
      type: string,
      provider: vscode.ChatSessionItemProvider,
    ) => vscode.Disposable;
    registerChatSessionContentProvider?: (
      scheme: string,
      provider: vscode.ChatSessionContentProvider,
      participant: vscode.ChatParticipant,
      capabilities?: vscode.ChatSessionCapabilities,
    ) => vscode.Disposable;
  };

  if (
    !chatApi.registerChatSessionItemProvider ||
    !chatApi.registerChatSessionContentProvider
  ) {
    deps.output.appendLine(
      "[session] chat sessions API unavailable — the chatSessionsProvider " +
        "proposed API is not enabled for this extension (see argv.json " +
        '"enable-proposed-api"). Falling back to the @phantombot participant.',
    );
    return { dispose() {} };
  }

  const conns = new Map<string, SessionConn>();

  const ensureConn = async (cwd: string): Promise<SessionConn> => {
    const existing = conns.get(cwd);
    if (existing) return existing;
    const client = deps.createClient(cwd);
    await client.initialize();
    const conn: SessionConn = {
      client,
      sessionId: mintSessionId(),
      cwd,
      loaded: false,
    };
    conns.set(cwd, conn);
    return conn;
  };

  const dropConn = (cwd: string): void => {
    const c = conns.get(cwd);
    if (c) {
      c.client.dispose();
      conns.delete(cwd);
    }
  };

  // ── Item provider: one durable session per workspace folder ───────────────
  const onDidChangeItems = new vscode.EventEmitter<void>();
  const onDidCommitItem = new vscode.EventEmitter<{
    original: vscode.ChatSessionItem;
    modified: vscode.ChatSessionItem;
  }>();

  const itemProvider: vscode.ChatSessionItemProvider = {
    onDidChangeChatSessionItems: onDidChangeItems.event,
    onDidCommitChatSessionItem: onDidCommitItem.event,
    provideChatSessionItems() {
      const persona = deps.personaLabel();
      const desc = persona ? `phantombot · ${persona}` : "phantombot";
      // One session per open folder, with a folderless fallback so phantombot
      // stays visible in an empty window or a folderless `.code-workspace`.
      const candidates = resolveSessionCandidates(
        deps.workspaceFolders(),
        deps.currentCwd(),
      );
      return candidates.map((f) => ({
        resource: vscode.Uri.from({
          scheme: SESSION_SCHEME,
          path: sessionResourcePath(f.cwd),
        }),
        label: f.name,
        iconPath: new vscode.ThemeIcon("hubot"),
        description: desc,
      }));
    },
  };

  // ── Content provider: history rehydration + per-turn request handling ──────
  const contentProvider: vscode.ChatSessionContentProvider = {
    async provideChatSessionContent(resource: vscode.Uri) {
      // The user just opened phantombot — remember it for sticky auto-open.
      deps.onSessionOpened?.();

      const cwd =
        resource.scheme === SESSION_SCHEME && resource.path
          ? cwdFromResourcePath(resource.path)
          : deps.currentCwd();

      let history: unknown[] = [];
      try {
        const conn = await ensureConn(cwd);
        const { handlers, turns } = makeReplayCollector();
        await conn.client.loadSession(conn.sessionId, cwd, handlers);
        conn.loaded = true;
        history = buildHistory(turns, deps.participantId);
      } catch (e) {
        const msg = (e as Error).message;
        deps.output.appendLine(`[session] load failed for ${cwd}: ${msg}`);
        dropConn(cwd);
      }

      return {
        history: history as never,
        requestHandler: makeRequestHandler(cwd),
      };
    },
  };

  /** Build the per-turn handler bound to a workspace cwd. */
  function makeRequestHandler(cwd: string): vscode.ChatRequestHandler {
    return async (request, _ctx, stream, token) => {
      let conn: SessionConn;
      try {
        conn = await ensureConn(cwd);
        if (!conn.loaded) {
          await conn.client.loadSession(conn.sessionId, cwd);
          conn.loaded = true;
        }
      } catch (e) {
        const msg = (e as Error).message;
        stream.markdown(`**phantombot could not start.**\n\n${msg}`);
        dropConn(cwd);
        return { errorDetails: { message: msg } };
      }

      const attachments = await extractAttachments(request, deps.output);
      const blocks = promptBlocksFromRequest(request.prompt, attachments);
      if (blocks.length === 0) {
        stream.markdown("_(nothing to send)_");
        return {};
      }

      let cancelSub: vscode.Disposable | undefined;
      if (token.isCancellationRequested) {
        conn.client.cancel(conn.sessionId);
      } else {
        cancelSub = token.onCancellationRequested(() =>
          conn.client.cancel(conn.sessionId),
        );
      }

      try {
        const stopReason = await conn.client.prompt(conn.sessionId, blocks, {
          onText: (t) => stream.markdown(t),
          onToolCall: (title) => stream.progress(title),
        });
        if (stopReason === "refusal") {
          stream.markdown("\n\n_(phantombot declined this turn.)_");
        }
        return {};
      } catch (e) {
        const msg = (e as Error).message;
        dropConn(cwd);
        stream.markdown(`\n\n**phantombot error:** ${msg}`);
        deps.output.appendLine(`[session] prompt failed: ${msg}`);
        return { errorDetails: { message: msg } };
      } finally {
        cancelSub?.dispose();
      }
    };
  }

  const reg1 = chatApi.registerChatSessionItemProvider(SESSION_TYPE, itemProvider);
  const reg2 = chatApi.registerChatSessionContentProvider(
    SESSION_SCHEME,
    contentProvider,
    deps.participant,
    { supportsInterruptions: true },
  );

  deps.output.appendLine(
    'phantombot chat session provider registered (open "Phantombot" in the ' +
      "chat sessions list — no @mention needed).",
  );

  return {
    dispose() {
      reg1.dispose();
      reg2.dispose();
      onDidChangeItems.dispose();
      onDidCommitItem.dispose();
      for (const [, c] of conns) c.client.dispose();
      conns.clear();
    },
  };
}

/**
 * Convert replayed role-tagged turns into VS Code history turns. The turn
 * classes (`ChatRequestTurn2` / `ChatResponseTurn2`) come from the
 * `chatParticipantPrivate` proposal and are reached through a loose cast so the
 * extension compiles against only the vendored `chatSessionsProvider` d.ts.
 */
function buildHistory(turns: readonly ReplayTurn[], participantId: string): unknown[] {
  const v = vscode as unknown as {
    ChatRequestTurn2: new (...args: unknown[]) => unknown;
    ChatResponseTurn2: new (...args: unknown[]) => unknown;
  };
  const out: unknown[] = [];
  for (const t of turns) {
    if (t.role === "user") {
      // (prompt, command, references, participant, toolReferences,
      //  editedFileEvents, id, modelId, modeInstructions2)
      out.push(
        new v.ChatRequestTurn2(
          t.text,
          undefined,
          [],
          participantId,
          [],
          undefined,
          undefined,
          undefined,
          undefined,
        ),
      );
    } else {
      const part = new vscode.ChatResponseMarkdownPart(
        new vscode.MarkdownString(t.text),
      );
      out.push(new v.ChatResponseTurn2([part], {}, participantId));
    }
  }
  return out;
}

/**
 * Pull dragged/pasted attachments off a chat request and resolve them to bytes
 * or file references. Images (pasted binary or dropped image files) become
 * inline image blocks; other dropped files become reference links. Best-effort:
 * a failed attachment is logged and skipped, never fatal to the turn.
 */
export async function extractAttachments(
  request: vscode.ChatRequest,
  output: vscode.OutputChannel,
): Promise<SessionAttachment[]> {
  const out: SessionAttachment[] = [];
  const refs = (request as unknown as { references?: unknown }).references;
  if (!Array.isArray(refs)) return out;

  for (const ref of refs) {
    const value = (ref as { value?: unknown })?.value;
    const name = (ref as { name?: string })?.name;
    try {
      // Pasted binary data (e.g. a screenshot): ChatReferenceBinaryData with
      // an async data() accessor + mimeType.
      const bin = value as { mimeType?: unknown; data?: unknown };
      if (
        bin &&
        typeof bin.mimeType === "string" &&
        typeof bin.data === "function"
      ) {
        if (isImageMime(bin.mimeType)) {
          const bytes = (await (bin.data as () => Promise<Uint8Array>)()) as Uint8Array;
          out.push({
            kind: "image",
            mimeType: bin.mimeType,
            base64: Buffer.from(bytes).toString("base64"),
          });
        }
        continue;
      }

      const uri = asUri(value);
      if (!uri) {
        const shape =
          value && typeof value === "object"
            ? Object.keys(value as object).join(",")
            : typeof value;
        output.appendLine(
          `[session] unhandled reference '${name ?? "?"}' (shape: ${shape}) — skipped`,
        );
        continue;
      }
      const mime = imageMimeFromPath(uri.path);
      if (mime) {
        const bytes = await vscode.workspace.fs.readFile(uri);
        out.push({
          kind: "image",
          mimeType: mime,
          base64: Buffer.from(bytes).toString("base64"),
        });
      } else {
        out.push({
          kind: "file",
          uri: uri.toString(),
          name: name ?? baseName(uri.path),
        });
      }
    } catch (e) {
      output.appendLine(
        `[session] attachment skipped: ${(e as Error).message}`,
      );
    }
  }
  return out;
}

/** Coerce a reference value into a Uri (handles Uri and Location shapes). */
function asUri(value: unknown): vscode.Uri | undefined {
  if (value instanceof vscode.Uri) return value;
  const loc = value as { uri?: unknown };
  if (loc && loc.uri instanceof vscode.Uri) return loc.uri;
  return undefined;
}

/** Last path segment, separator-agnostic. */
function baseName(p: string): string {
  const parts = p.split(/[\\/]/);
  return parts[parts.length - 1] || p;
}
