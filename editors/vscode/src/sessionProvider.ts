/**
 * phantombot **chat session** provider — registers phantombot as a first-class
 * agent in VS Code's native chat *sessions* surface (its own panel entry, no
 * `@mention`), the same slot Copilot CLI and Claude Code occupy.
 *
 * MULTI-CHAT (Zed parity)
 * -----------------------
 * We surface a LIST of chats per workspace, each a server "thread" with its own
 * persisted transcript — exactly how Zed's agent panel works:
 *   - the AGENT owns transcript persistence + replay (ACP `session/new` /
 *     `session/load`);
 *   - the CLIENT (this extension) owns the list, titles and rename, stored ONLY
 *     in VS Code's own `workspaceState` (see sessionStore.ts) — never in the
 *     phantombot domain.
 *
 * A chat's identity is the opaque server thread token, carried in the session
 * resource URI's `query`. Opening a listed chat → `session/load` that token →
 * its history replays. Opening a fresh ("untitled") chat mints a new thread on
 * first open; the record is only written to the list on the FIRST prompt (so an
 * opened-but-never-used blank chat leaves no junk), and its title is
 * auto-derived from that prompt (Zed-style).
 *
 * This is the thin `vscode`-importing glue. All decision-making lives in the
 * pure, bun-tested `sessionBridge.ts` / `sessionStore.ts`.
 *
 * Uses the `chatSessionsProvider` proposed API (+ `chatParticipantPrivate` for
 * the constructable history turn classes). Both are enabled via `argv.json`
 * (`enable-proposed-api`); if the host hasn't enabled them the registration
 * functions are absent and we no-op so activation never throws.
 */

import * as vscode from "vscode";

import type { AcpClient } from "./acpClient.ts";
import {
  cwdFromResourcePath,
  decodeSessionResource,
  imageMimeFromPath,
  isImageMime,
  makeReplayCollector,
  promptBlocksFromRequest,
  promptTextWithCommand,
  resolveSessionCandidates,
  sessionResourcePath,
  SESSION_SCHEME,
  SESSION_TYPE,
  type ReplayTurn,
  type SessionAttachment,
} from "./sessionBridge.ts";
import {
  DEFAULT_SESSION_TITLE,
  deriveSessionTitle,
  findSession,
  listSessions,
  patchSession,
  upsertSession,
  type SessionKv,
} from "./sessionStore.ts";

/** One live ACP connection per workspace cwd, multiplexing all its threads. */
interface CwdConn {
  client: AcpClient;
  /** Session tokens the server already knows this run (new'd or loaded). */
  loaded: Set<string>;
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
  /** VS Code-owned KV (workspaceState) holding the chat list + titles. */
  kv: SessionKv;
  /**
   * Called whenever the user opens a phantombot session. Lets the host remember
   * a session was open so it can be auto-reopened next launch. Optional.
   */
  onSessionOpened?(): void;
  output: vscode.OutputChannel;
}

/** What {@link registerChatSessionProvider} hands back: a Disposable plus a
 * `refresh()` the host can call (e.g. after a rename) to re-list the items. */
export interface SessionProviderHandle extends vscode.Disposable {
  refresh(): void;
}

/**
 * Register the phantombot chat-session item + content providers. Returns a
 * handle that tears down both registrations + every spawned ACP client, and
 * exposes `refresh()` to re-emit the session list.
 */
export function registerChatSessionProvider(
  deps: SessionProviderDeps,
): SessionProviderHandle {
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
    return { dispose() {}, refresh() {} };
  }

  const conns = new Map<string, CwdConn>();
  // Untitled resource URI → the thread token minted for it at open time, so the
  // first prompt in a brand-new chat reuses that thread instead of minting again.
  const pendingThread = new Map<string, string>();

  const ensureClient = async (cwd: string): Promise<CwdConn> => {
    const existing = conns.get(cwd);
    if (existing) return existing;
    const client = deps.createClient(cwd);
    await client.initialize();
    const conn: CwdConn = { client, loaded: new Set() };
    conns.set(cwd, conn);
    return conn;
  };

  const dropClient = (cwd: string): void => {
    const c = conns.get(cwd);
    if (c) {
      c.client.dispose();
      conns.delete(cwd);
    }
  };

  /** Build the session resource URI for a (cwd, thread) pair. Empty token → a
   * fresh untitled chat the content provider will bind on open. */
  const resourceFor = (cwd: string, sessionId = ""): vscode.Uri =>
    vscode.Uri.from({
      scheme: SESSION_SCHEME,
      path: sessionResourcePath(cwd),
      query: sessionId,
    });

  // ── Item provider: one entry per stored chat, newest first ────────────────
  const onDidChangeItems = new vscode.EventEmitter<void>();
  const onDidCommitItem = new vscode.EventEmitter<{
    original: vscode.ChatSessionItem;
    modified: vscode.ChatSessionItem;
  }>();
  const refresh = () => onDidChangeItems.fire();

  const itemProvider: vscode.ChatSessionItemProvider = {
    onDidChangeChatSessionItems: onDidChangeItems.event,
    onDidCommitChatSessionItem: onDidCommitItem.event,
    provideChatSessionItems() {
      const persona = deps.personaLabel();
      const desc = persona ? `phantombot · ${persona}` : "phantombot";
      const candidates = resolveSessionCandidates(
        deps.workspaceFolders(),
        deps.currentCwd(),
      );
      const items: vscode.ChatSessionItem[] = [];
      for (const f of candidates) {
        for (const rec of listSessions(deps.kv, f.cwd)) {
          items.push({
            resource: resourceFor(f.cwd, rec.sessionId),
            label: rec.title,
            iconPath: new vscode.ThemeIcon("hubot"),
            description: desc,
            // Real created time keeps the age stable and off the Unix epoch
            // (which newer builds render as "57 yrs ago" then auto-archive).
            timing: { created: rec.createdAt || Date.now() },
          });
        }
      }
      return items;
    },
  };

  // ── Content provider: replay one thread's history + handle its turns ───────
  const contentProvider: vscode.ChatSessionContentProvider = {
    async provideChatSessionContent(resource: vscode.Uri) {
      deps.onSessionOpened?.();

      const { cwd, sessionId } = decodeResource(resource, deps.currentCwd());

      // Existing thread → load + replay its transcript.
      if (sessionId) {
        let history: unknown[] = [];
        try {
          const conn = await ensureClient(cwd);
          const { handlers, turns } = makeReplayCollector();
          await conn.client.loadSession(sessionId, cwd, handlers);
          conn.loaded.add(sessionId);
          history = buildHistory(turns, deps.participantId);
        } catch (e) {
          const msg = (e as Error).message;
          deps.output.appendLine(`[session] load failed for ${cwd}: ${msg}`);
          dropClient(cwd);
        }
        return {
          history: history as never,
          requestHandler: makeRequestHandler(cwd, sessionId, resource),
        };
      }

      // Fresh ("untitled") chat → mint a thread now so the first prompt has one,
      // but DON'T persist it to the list until that prompt actually lands.
      let minted: string | undefined;
      try {
        const conn = await ensureClient(cwd);
        minted = await conn.client.newSession(cwd);
        conn.loaded.add(minted);
        pendingThread.set(resource.toString(), minted);
      } catch (e) {
        const msg = (e as Error).message;
        deps.output.appendLine(`[session] new thread failed for ${cwd}: ${msg}`);
        dropClient(cwd);
      }
      return {
        history: [] as never,
        requestHandler: makeRequestHandler(cwd, minted, resource),
      };
    },
  };

  /**
   * Per-turn handler bound to a workspace cwd + its thread token. `sessionId`
   * may be undefined for a brand-new chat whose mint failed at open time — we
   * recover the pending token or mint fresh on the first prompt.
   */
  function makeRequestHandler(
    cwd: string,
    sessionId: string | undefined,
    resource: vscode.Uri,
  ): vscode.ChatRequestHandler {
    return async (request, _ctx, stream, token) => {
      let conn: CwdConn;
      let sid = sessionId;
      try {
        conn = await ensureClient(cwd);
        if (!sid) {
          sid = pendingThread.get(resource.toString());
          if (!sid) {
            sid = await conn.client.newSession(cwd);
            conn.loaded.add(sid);
            pendingThread.set(resource.toString(), sid);
          }
        }
        if (!conn.loaded.has(sid)) {
          await conn.client.loadSession(sid, cwd);
          conn.loaded.add(sid);
        }
      } catch (e) {
        const msg = (e as Error).message;
        stream.markdown(`**phantombot could not start.**\n\n${msg}`);
        dropClient(cwd);
        return { errorDetails: { message: msg } };
      }

      const attachments = await extractAttachments(request, deps.output);
      const promptText = promptTextWithCommand(request.prompt, request.command);
      const blocks = promptBlocksFromRequest(promptText, attachments);
      if (blocks.length === 0) {
        stream.markdown("_(nothing to send)_");
        return {};
      }

      recordTurn(cwd, sid, promptText, resource);

      let cancelSub: vscode.Disposable | undefined;
      if (token.isCancellationRequested) {
        conn.client.cancel(sid);
      } else {
        cancelSub = token.onCancellationRequested(() => conn.client.cancel(sid!));
      }

      try {
        const stopReason = await conn.client.prompt(sid, blocks, {
          onText: (t) => stream.markdown(t),
          onToolCall: (title) => stream.progress(title),
        });
        if (stopReason === "refusal") {
          stream.markdown("\n\n_(phantombot declined this turn.)_");
        } else if (stopReason === "cancelled") {
          // The user interrupted this turn by submitting another prompt (or hit
          // stop). The server aborted it cleanly — mark it quietly, chat-channel
          // style, rather than letting a half-finished turn read like an error.
          stream.markdown("\n\n_(interrupted)_");
        }
        return {};
      } catch (e) {
        const msg = (e as Error).message;
        dropClient(cwd);
        stream.markdown(`\n\n**phantombot error:** ${msg}`);
        deps.output.appendLine(`[session] prompt failed: ${msg}`);
        return { errorDetails: { message: msg } };
      } finally {
        cancelSub?.dispose();
      }
    };
  }

  /**
   * First-prompt bookkeeping. Creates the list record (auto-titled from the
   * prompt) the first time a thread is used, migrating the untitled resource to
   * a committed one that carries the token; on later turns just bumps
   * `lastUsedAt` (and settles a still-default title if it can).
   */
  function recordTurn(
    cwd: string,
    sessionId: string,
    promptText: string,
    resource: vscode.Uri,
  ): void {
    const now = Date.now();
    const existing = findSession(deps.kv, cwd, sessionId);
    if (!existing) {
      const title = deriveSessionTitle(promptText);
      upsertSession(deps.kv, cwd, {
        sessionId,
        title,
        createdAt: now,
        lastUsedAt: now,
        titleSettled: title !== DEFAULT_SESSION_TITLE,
      });
      // Migrate untitled → committed so reopen/list find this chat by token.
      if (!resource.query) {
        const committed = resourceFor(cwd, sessionId);
        onDidCommitItem.fire({
          original: { resource, label: title },
          modified: {
            resource: committed,
            label: title,
            iconPath: new vscode.ThemeIcon("hubot"),
          },
        });
        pendingThread.delete(resource.toString());
      }
      refresh();
      return;
    }

    const patch: Partial<{ title: string; lastUsedAt: number; titleSettled: boolean }> =
      { lastUsedAt: now };
    if (!existing.titleSettled) {
      const title = deriveSessionTitle(promptText);
      if (title !== DEFAULT_SESSION_TITLE) {
        patch.title = title;
        patch.titleSettled = true;
      }
    }
    patchSession(deps.kv, cwd, sessionId, patch);
    refresh();
  }

  const reg1 = chatApi.registerChatSessionItemProvider(SESSION_TYPE, itemProvider);
  const reg2 = chatApi.registerChatSessionContentProvider(
    SESSION_SCHEME,
    contentProvider,
    deps.participant,
    { supportsInterruptions: true },
  );

  deps.output.appendLine(
    'phantombot chat session provider registered (multi-chat; open "Phantombot" ' +
      "in the chat sessions list — no @mention needed).",
  );

  return {
    refresh,
    dispose() {
      reg1.dispose();
      reg2.dispose();
      onDidChangeItems.dispose();
      onDidCommitItem.dispose();
      for (const [, c] of conns) c.client.dispose();
      conns.clear();
      pendingThread.clear();
    },
  };
}

/** Decode a session resource → { cwd, sessionId? }, tolerating a bare fallback. */
function decodeResource(
  resource: vscode.Uri,
  fallbackCwd: string,
): { cwd: string; sessionId?: string } {
  if (resource.scheme === SESSION_SCHEME && resource.path) {
    return decodeSessionResource(resource.path, resource.query);
  }
  // Untitled/foreign resource (e.g. a blank editor) → bind to the active cwd.
  return { cwd: fallbackCwd };
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
 * or file references. Images become inline image blocks; other dropped files
 * become reference links. Best-effort: a failed attachment is logged and
 * skipped, never fatal to the turn.
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
      output.appendLine(`[session] attachment skipped: ${(e as Error).message}`);
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

/** Recover a workspace cwd from a session resource (used by the rename command). */
export function cwdFromSessionResource(resource: vscode.Uri): string {
  return cwdFromResourcePath(resource.path);
}
