/**
 * Pure, `vscode`-free store for the VS Code chat-session LIST — the multi-chat
 * history surface (save / rename / retrieve older chats), modelled on how Zed's
 * agent panel owns its own thread list.
 *
 * DESIGN — who owns what (mirrors Zed):
 *   - The AGENT (phantombot) owns transcript PERSISTENCE + replay. Each chat is a
 *     server "thread": an opaque, self-describing session token
 *     (`acp_<cwdhash>_<thread>`) whose turns live server-side and are replayed via
 *     ACP `session/load`.
 *   - The CLIENT (this extension) owns the LIST, the TITLES and RENAME. We keep a
 *     small record per thread — its token, display title, timestamps — so we can
 *     list past chats, reopen one (→ `session/load`), and rename it. Naming and
 *     listing NEVER touch the phantombot domain.
 *
 * WHERE THIS LIVES: entirely in VS Code's own storage (the extension's
 * `workspaceState` Memento), reached through the {@link SessionKv} facade. Nothing
 * here writes to phantombot's memory store — that was an explicit requirement.
 *
 * This module is intentionally free of any `vscode` import so it runs under
 * `bun test` with zero host, exactly like sessionBridge.ts / participant.ts.
 */

/** One persisted chat thread in a workspace's list. */
export interface ChatSessionRecord {
  /** Opaque server thread token (`acp_<cwdhash>_<thread>`). The reload key. */
  sessionId: string;
  /** Human-readable label shown in the sessions list. */
  title: string;
  /** ms since epoch — when the thread's first turn landed. */
  createdAt: number;
  /** ms since epoch — when the thread was last prompted (list sort key). */
  lastUsedAt: number;
  /**
   * True once the title is "settled" — either auto-derived from the first prompt
   * or explicitly renamed by the user. Gates the one-shot auto-title so a rename
   * is never clobbered by a later turn.
   */
  titleSettled: boolean;
}

/**
 * Minimal KV facade over VS Code's `Memento` (workspaceState). `update` is
 * fire-and-forget here; the glue adapts the real `Thenable`-returning method.
 */
export interface SessionKv {
  get<T>(key: string): T | undefined;
  update(key: string, value: unknown): void;
}

/** Storage key. Bump the vN suffix if the record shape changes incompatibly. */
export const STORE_KEY = "phantombot.chatSessions.v1";

/** Placeholder title before the first prompt settles a real one. */
export const DEFAULT_SESSION_TITLE = "New Chat";

/** Max characters for an auto-derived title before ellipsis. */
const TITLE_MAX = 60;

/** The whole store: cwd → its ordered list of chat records. */
type StoreShape = Record<string, ChatSessionRecord[]>;

function readAll(kv: SessionKv): StoreShape {
  const raw = kv.get<StoreShape>(STORE_KEY);
  return raw && typeof raw === "object" ? raw : {};
}

function writeAll(kv: SessionKv, all: StoreShape): void {
  kv.update(STORE_KEY, all);
}

/** Normalise a stored record array, dropping anything malformed. */
function sanitize(list: unknown): ChatSessionRecord[] {
  if (!Array.isArray(list)) return [];
  const out: ChatSessionRecord[] = [];
  for (const r of list) {
    const rec = r as Partial<ChatSessionRecord>;
    if (rec && typeof rec.sessionId === "string" && rec.sessionId.length > 0) {
      out.push({
        sessionId: rec.sessionId,
        title:
          typeof rec.title === "string" && rec.title.trim()
            ? rec.title
            : DEFAULT_SESSION_TITLE,
        createdAt: typeof rec.createdAt === "number" ? rec.createdAt : 0,
        lastUsedAt:
          typeof rec.lastUsedAt === "number"
            ? rec.lastUsedAt
            : typeof rec.createdAt === "number"
              ? rec.createdAt
              : 0,
        titleSettled: rec.titleSettled === true,
      });
    }
  }
  return out;
}

/**
 * List a workspace's chats, most-recently-used first. Pure read; the sort makes
 * the list stable and puts the chat you last touched at the top (Zed-style).
 */
export function listSessions(kv: SessionKv, cwd: string): ChatSessionRecord[] {
  const list = sanitize(readAll(kv)[cwd]);
  return list
    .slice()
    .sort((a, b) => b.lastUsedAt - a.lastUsedAt || b.createdAt - a.createdAt);
}

/** Find one record by its session token, or undefined. */
export function findSession(
  kv: SessionKv,
  cwd: string,
  sessionId: string,
): ChatSessionRecord | undefined {
  return sanitize(readAll(kv)[cwd]).find((r) => r.sessionId === sessionId);
}

/**
 * Insert or replace a record (matched on `sessionId`) in a workspace's list.
 * Returns the written record.
 */
export function upsertSession(
  kv: SessionKv,
  cwd: string,
  rec: ChatSessionRecord,
): ChatSessionRecord {
  const all = readAll(kv);
  const list = sanitize(all[cwd]);
  const idx = list.findIndex((r) => r.sessionId === rec.sessionId);
  if (idx >= 0) list[idx] = rec;
  else list.push(rec);
  all[cwd] = list;
  writeAll(kv, all);
  return rec;
}

/**
 * Patch an existing record in place. No-op (returns undefined) if the session
 * isn't in the list. Returns the merged record on success.
 */
export function patchSession(
  kv: SessionKv,
  cwd: string,
  sessionId: string,
  patch: Partial<Omit<ChatSessionRecord, "sessionId">>,
): ChatSessionRecord | undefined {
  const all = readAll(kv);
  const list = sanitize(all[cwd]);
  const idx = list.findIndex((r) => r.sessionId === sessionId);
  const base = idx >= 0 ? list[idx] : undefined;
  if (!base) return undefined;
  // Field-by-field merge so an absent patch key never overwrites with undefined.
  const merged: ChatSessionRecord = {
    sessionId,
    title: patch.title ?? base.title,
    createdAt: patch.createdAt ?? base.createdAt,
    lastUsedAt: patch.lastUsedAt ?? base.lastUsedAt,
    titleSettled: patch.titleSettled ?? base.titleSettled,
  };
  list[idx] = merged;
  all[cwd] = list;
  writeAll(kv, all);
  return merged;
}

/** Remove a record from a workspace's list. Silent if it wasn't there. */
export function removeSession(
  kv: SessionKv,
  cwd: string,
  sessionId: string,
): void {
  const all = readAll(kv);
  const list = sanitize(all[cwd]).filter((r) => r.sessionId !== sessionId);
  all[cwd] = list;
  writeAll(kv, all);
}

/**
 * Derive a chat title from the first prompt's text (Zed-style auto-naming).
 *
 * First non-empty line, whitespace-collapsed, trimmed to {@link TITLE_MAX} with a
 * single-character ellipsis. A leading slash-command (`/status …`) keeps its
 * text — it's still the most descriptive thing the user typed. Falls back to
 * {@link DEFAULT_SESSION_TITLE} when there's nothing usable (image-only turn).
 */
export function deriveSessionTitle(prompt: string): string {
  const firstLine =
    prompt
      .split(/\r?\n/)
      .map((l) => l.trim())
      .find((l) => l.length > 0) ?? "";
  const collapsed = firstLine.replace(/\s+/g, " ").trim();
  if (!collapsed) return DEFAULT_SESSION_TITLE;
  if (collapsed.length <= TITLE_MAX) return collapsed;
  return collapsed.slice(0, TITLE_MAX - 1).trimEnd() + "…";
}
