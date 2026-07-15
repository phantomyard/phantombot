/**
 * ACP session registry.
 *
 * Editors (Zed / VS Code / JetBrains) mint a session per CHAT THREAD. We hold
 * an in-memory `Map<sessionId, AcpSession>` for the life of the stdio server.
 *
 * TWO KEYS, DELIBERATELY DIFFERENT
 * --------------------------------
 * 1. WORKSPACE key — `acp:<sha256(cwd)[0..12]>`. Stable per project directory.
 *    Scopes durable, workspace-wide things: the image inbox, and the briefing
 *    we hand a fresh thread (see briefing.ts).
 *
 * 2. CONVERSATION key — `acp:<cwdhash>:<threadid>`. Stable per THREAD.
 *    Scopes phantombot's turn history — the last-N window `runTurn` replays.
 *
 * We used to key the CONVERSATION on cwd alone, so every new editor thread in a
 * project silently inherited the previous thread's turn history. Those turns are
 * replayed as USER messages, so a brand-new thread opened after a working
 * session began with a trailing queue of live-looking work orders ("open a PR…",
 * "Go.", "Yes, please."). The user typed "hello" into what LOOKED like an empty
 * thread, and the model — reading the last thing the user had apparently asked
 * for — went off and did work nobody wanted. A new thread is now a NEW
 * conversation: empty history, with the workspace's recent activity supplied
 * instead as clearly-labelled REFERENCE DATA (briefing.ts).
 *
 * The thread id is embedded in the opaque sessionId (`acp_<cwdhash>_<thread>`)
 * so `session/load` can re-derive the exact same conversation key from the token
 * the editor persisted — no server-side map to keep, no state to lose. Reopening
 * an old thread therefore resumes it verbatim.
 *
 * LEGACY TOKENS: sessions minted before this change look like `acp_<24 hex>` (no
 * embedded workspace hash). They still resolve to the old cwd-keyed conversation,
 * so a thread created against the previous build reopens with its history intact.
 */

import { createHash, randomBytes } from "node:crypto";

import type { ActiveTurnHandle } from "../../channels/commands.ts";

export interface AcpSession {
  /** Opaque token handed to the editor. Stable for the thread's lifetime. */
  readonly sessionId: string;
  /** Workspace working directory the editor opened the session in. */
  readonly cwd: string;
  /** Workspace scope — `acp:<cwdhash>`. Inbox + briefing lookups. */
  readonly workspace: string;
  /** Per-thread conversation key — phantombot's turn-history scope. */
  readonly conversation: string;
  /** Persona bound to this session (from the `--persona` flag or config default). */
  readonly persona: string;
  /**
   * The in-flight prompt for this session, if any. `session/cancel` and the
   * out-of-band `/stop` + `/reset` commands abort it; `session/prompt` installs
   * a fresh handle at the start of each turn and clears it when the turn settles.
   */
  activeTurn?: ActiveTurnHandle;
}

/** Short, stable hash of a workspace cwd. */
function cwdHash(cwd: string): string {
  return createHash("sha256").update(cwd).digest("hex").slice(0, 12);
}

/**
 * The WORKSPACE key for a cwd — `acp:<hash>`.
 *
 * This was the conversation key before threads got their own. It remains the
 * scope for the image inbox and the workspace briefing, and it is still the
 * conversation key that LEGACY (pre-thread) sessionIds resolve to.
 */
export function conversationForCwd(cwd: string): string {
  return `acp:${cwdHash(cwd)}`;
}

/** Alias that says what it actually means at the call sites that want scope. */
export const workspaceForCwd = conversationForCwd;

/**
 * Mint an opaque session token that EMBEDS the workspace hash and a random
 * thread id: `acp_<cwdhash>_<thread>`. The editor treats it as opaque; we use it
 * to re-derive the conversation key on `session/load` without persisting a
 * sessionId → conversation map anywhere.
 */
export function mintSessionId(cwd: string): string {
  return `acp_${cwdHash(cwd)}_${randomBytes(8).toString("hex")}`;
}

/** New-form token: `acp_<12 hex>_<hex>`. The legacy form has no second underscore. */
const THREADED_SESSION_ID = /^acp_([0-9a-f]{12})_([0-9a-f]{8,})$/;

/**
 * Resolve the conversation key for a sessionId.
 *
 *   - threaded token → `acp:<cwdhash>:<thread>` (per-thread history)
 *   - legacy token   → `acp:<cwdhash>` derived from `cwd` (old cwd-wide history)
 *
 * The workspace hash comes from the TOKEN when it carries one, so a thread
 * resumes into the same conversation even if the editor reports the workspace
 * path differently (trailing slash, symlink) than when the thread was created.
 */
export function conversationForSessionId(sessionId: string, cwd: string): string {
  const m = THREADED_SESSION_ID.exec(sessionId);
  if (!m) return conversationForCwd(cwd);
  return `acp:${m[1]}:${m[2]}`;
}

export class SessionRegistry {
  private readonly sessions = new Map<string, AcpSession>();

  /**
   * Create + register a session.
   *
   * `sessionId` omitted (session/new) → mint a fresh threaded token, so the new
   * thread starts with an EMPTY conversation.
   *
   * `sessionId` provided (session/load) → the editor is reopening a thread it
   * persisted; the conversation key is re-derived from that token, resuming the
   * thread verbatim.
   */
  create(cwd: string, persona: string, sessionId?: string): AcpSession {
    const id = sessionId ?? mintSessionId(cwd);
    const session: AcpSession = {
      sessionId: id,
      cwd,
      workspace: workspaceForCwd(cwd),
      conversation: conversationForSessionId(id, cwd),
      persona,
    };
    this.sessions.set(session.sessionId, session);
    return session;
  }

  get(sessionId: string): AcpSession | undefined {
    return this.sessions.get(sessionId);
  }

  has(sessionId: string): boolean {
    return this.sessions.has(sessionId);
  }

  delete(sessionId: string): void {
    this.sessions.delete(sessionId);
  }
}
