/**
 * Memory store. SQLite-backed via bun:sqlite (no native compile, no extra deps).
 *
 * Schema is two tables:
 *   turns(id, persona, conversation, role, text, created_at)
 *   capture_log(id, persona, conversation, tags, created_at)
 *
 * `capture_log` records every `phantombot memory capture` invocation —
 * it gives the otherwise-invisible capture protocol a queryable trace
 * and backs the mechanical "N turns without a capture" nudge.
 *
 * Turns are scoped by (persona, conversation). The conversation key is
 * 'cli:default' for v1 — phantombot is a single-operator CLI tool, so all
 * CLI invocations share one conversation per persona. Per-channel scoping
 * (telegram:1234, signal:abc) is reserved for a future channels phase.
 *
 * Search indexing lives in lib/memoryIndex.ts. This store remains the source
 * of truth for raw turns; indexers read from here and maintain their own
 * derived FTS/vector rows.
 */

import { Database } from "bun:sqlite";
import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";

export type Role = "user" | "assistant";

export interface Turn {
  id: number;
  persona: string;
  conversation: string;
  role: Role;
  text: string;
  createdAt: Date;
  /**
   * Whether this turn is eligible for FTS/vector indexing. Default true.
   * A `false` row is QUARANTINED untrusted payload (a held-episode user
   * turn written by the screener): it MUST still appear in the recentTurns
   * history replay so the principal's approve/deny reply is grounded, but
   * it must NEVER land in the search index — see turnIndexer.ts, which
   * skips embeddable=false rows, and purgeQuarantined, which drops them
   * once a trusted turn has ruled on them.
   */
  embeddable: boolean;
}

export interface AppendTurnInput {
  persona: string;
  conversation: string;
  role: Role;
  text: string;
  /**
   * Index-eligibility flag. Defaults to true. Set false to QUARANTINE the
   * row — it persists and replays in history, but the turn indexer skips it
   * (never FTS-indexed, never embedded) and purgeQuarantined can later drop
   * it. Used by the screener's held-episode write to keep verbatim untrusted
   * payload out of the search index. See the `embeddable` doc on Turn.
   */
  embeddable?: boolean;
}

export interface AppendCaptureInput {
  persona: string;
  conversation: string;
  /** Tags applied to this capture (already validated by the caller). */
  tags: string[];
}

export interface MemoryStore {
  /** Persist one turn. Auto-stamps created_at to "now" UTC. */
  appendTurn(turn: AppendTurnInput): Promise<void>;
  /**
   * Persist a user+assistant turn pair atomically: both rows land or
   * neither does. Guards against a crash between the two inserts leaving
   * a half-turn (user with no assistant reply) in history.
   */
  appendTurnPair(
    userTurn: AppendTurnInput,
    assistantTurn: AppendTurnInput,
  ): Promise<void>;
  /** Most recent N turns within (persona, conversation), oldest first. */
  recentTurns(
    persona: string,
    conversation: string,
    n: number,
  ): Promise<Array<{ role: Role; text: string }>>;
  /** Most recent N turns across all conversations for one persona, full rows, oldest first. */
  recentTurnsForDisplay(persona: string, n: number): Promise<Turn[]>;
  /** Full turn rows after a known id within one conversation, oldest first. */
  turnsAfterId(
    persona: string,
    conversation: string,
    afterId: number,
    limit?: number,
  ): Promise<Turn[]>;
  /** Count user turns in a conversation. Used by predictable indexing triggers. */
  countUserTurns(persona: string, conversation: string): Promise<number>;
  /**
   * Distinct conversation keys that have at least one turn for this persona,
   * sorted. Used by the turn-index sweep (heartbeat + `memory index --turns`)
   * to find every conversation that might have an unindexed tail.
   */
  listConversations(persona: string): Promise<string[]>;
  /** Delete all turns for a (persona, conversation) pair. Used by /reset. */
  deleteConversation(persona: string, conversation: string): Promise<number>;
  /**
   * Delete the quarantined (embeddable=0) turns for a (persona,
   * conversation) pair; returns rows deleted. Called after a TRUSTED turn
   * succeeds (orchestrator/turn.ts): by then the held untrusted payload has
   * been replayed into context once to ground the principal's approve/deny,
   * so the raw verbatim text can be dropped — only the judge-reasoning turn
   * and any decision capture are kept. No-op (returns 0) when there are no
   * quarantined rows.
   */
  purgeQuarantined(persona: string, conversation: string): Promise<number>;
  /** Record one `memory capture` invocation. Auto-stamps created_at UTC. */
  appendCapture(input: AppendCaptureInput): Promise<void>;
  /**
   * ISO timestamp of the most recent capture in (persona, conversation),
   * or undefined if this pair has never captured.
   */
  lastCaptureAt(
    persona: string,
    conversation: string,
  ): Promise<string | undefined>;
  /**
   * Count `role = 'user'` turns in (persona, conversation) with
   * `created_at > since`. Used by the mechanical capture nudge.
   */
  countUserTurnsSince(
    persona: string,
    conversation: string,
    since: string,
  ): Promise<number>;
  /**
   * Count capture_log rows for one persona with `created_at >= since`.
   * Used by `doctor` to detect a fully dry capture day.
   */
  countCapturesSince(persona: string, since: string): Promise<number>;
  /**
   * Count `role = 'user'` turns for one persona, across conversations
   * matching `conversationPrefix` (SQL LIKE-escaped), with
   * `created_at >= since`. Used by `doctor`'s capture-health check.
   */
  countUserTurnsForPersonaSince(
    persona: string,
    conversationPrefix: string,
    since: string,
  ): Promise<number>;
  /** Close the underlying SQLite connection. Safe to call once; idempotent thereafter. */
  close(): Promise<void>;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS turns (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  persona      TEXT NOT NULL,
  conversation TEXT NOT NULL,
  role         TEXT NOT NULL CHECK (role IN ('user','assistant')),
  text         TEXT NOT NULL,
  created_at   TEXT NOT NULL,
  -- 1 = indexable (default), 0 = QUARANTINED untrusted payload that must
  -- replay in history but never reach the search index. See Turn.embeddable.
  embeddable   INTEGER NOT NULL DEFAULT 1
);
CREATE INDEX IF NOT EXISTS idx_turns_persona_conv_time
  ON turns (persona, conversation, created_at);
CREATE INDEX IF NOT EXISTS idx_turns_persona_time
  ON turns (persona, created_at);

CREATE TABLE IF NOT EXISTS capture_log (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  persona      TEXT NOT NULL,
  conversation TEXT NOT NULL,
  tags         TEXT NOT NULL,
  created_at   TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_capture_persona_conv_time
  ON capture_log (persona, conversation, created_at);
`;

interface RawDisplayRow {
  id: number;
  persona: string;
  conversation: string;
  role: Role;
  text: string;
  created_at: string;
  embeddable: number;
}

class SqliteMemoryStore implements MemoryStore {
  private appendStmt;
  private recentStmt;
  private recentDisplayStmt;
  private turnsAfterIdStmt;
  private deleteStmt;
  private purgeQuarantinedStmt;
  private appendCaptureStmt;
  private lastCaptureStmt;
  private countUserTurnsStmt;
  private listConversationsStmt;
  private countTurnsSinceStmt;
  private countCapturesSinceStmt;
  private appendPairTxn;
  private closed = false;

  constructor(private db: Database) {
    db.exec(SCHEMA);
    // Idempotent migration for DBs created before the embeddable column
    // existed: SCHEMA's CREATE TABLE IF NOT EXISTS leaves an old `turns`
    // table untouched, so add the column in place. Existing rows default to
    // 1 (indexable) — the pre-quarantine behaviour, which is correct since
    // nothing written before this column was ever a quarantined payload.
    const hasEmbeddable = (
      db.query("PRAGMA table_info(turns)").all() as Array<{ name: string }>
    ).some((c) => c.name === "embeddable");
    if (!hasEmbeddable) {
      db.exec(
        "ALTER TABLE turns ADD COLUMN embeddable INTEGER NOT NULL DEFAULT 1",
      );
    }
    this.appendStmt = db.prepare(
      "INSERT INTO turns (persona, conversation, role, text, created_at, embeddable) VALUES (?, ?, ?, ?, ?, ?)",
    );
    // Inner query gets most-recent-N descending; outer flips back to chronological.
    this.recentStmt = db.prepare(
      `SELECT role, text FROM (
         SELECT id, role, text, created_at
         FROM turns
         WHERE persona = ? AND conversation = ?
         ORDER BY created_at DESC, id DESC
         LIMIT ?
       ) ORDER BY created_at ASC, id ASC`,
    );
    this.recentDisplayStmt = db.prepare(
      `SELECT id, persona, conversation, role, text, created_at, embeddable FROM (
         SELECT id, persona, conversation, role, text, created_at, embeddable
         FROM turns
         WHERE persona = ?
         ORDER BY created_at DESC, id DESC
         LIMIT ?
       ) ORDER BY created_at ASC, id ASC`,
    );
    this.turnsAfterIdStmt = db.prepare(
      `SELECT id, persona, conversation, role, text, created_at, embeddable
       FROM turns
       WHERE persona = ? AND conversation = ? AND id > ?
       ORDER BY id ASC
       LIMIT ?`,
    );
    this.deleteStmt = db.prepare(
      "DELETE FROM turns WHERE persona = ? AND conversation = ?",
    );
    this.purgeQuarantinedStmt = db.prepare(
      "DELETE FROM turns WHERE persona = ? AND conversation = ? AND embeddable = 0",
    );
    this.appendCaptureStmt = db.prepare(
      "INSERT INTO capture_log (persona, conversation, tags, created_at) VALUES (?, ?, ?, ?)",
    );
    this.lastCaptureStmt = db.prepare(
      `SELECT created_at FROM capture_log
       WHERE persona = ? AND conversation = ?
       ORDER BY created_at DESC, id DESC LIMIT 1`,
    );
    this.countUserTurnsStmt = db.prepare(
      `SELECT COUNT(*) AS n FROM turns
       WHERE persona = ? AND conversation = ? AND role = 'user'`,
    );
    this.listConversationsStmt = db.prepare(
      `SELECT DISTINCT conversation FROM turns
       WHERE persona = ? ORDER BY conversation`,
    );
    this.countTurnsSinceStmt = db.prepare(
      `SELECT COUNT(*) AS n FROM turns
       WHERE persona = ? AND conversation = ?
         AND role = 'user' AND created_at > ?`,
    );
    this.countCapturesSinceStmt = db.prepare(
      `SELECT COUNT(*) AS n FROM capture_log
       WHERE persona = ? AND created_at >= ?`,
    );
    // Atomic user+assistant pair insert. Both rows share the same
    // created_at; ordering tiebreaks on the autoincrement id, so the
    // user turn (inserted first) always sorts before the assistant turn.
    // Per-turn embeddable is passed in so a held-episode pair can quarantine
    // the user (raw payload, embeddable=0) while keeping the assistant turn
    // (judge reasoning, embeddable=1) indexable.
    this.appendPairTxn = db.transaction(
      (u: AppendTurnInput, a: AppendTurnInput, ts: string) => {
        this.appendStmt.run(
          u.persona,
          u.conversation,
          u.role,
          u.text,
          ts,
          embeddableInt(u.embeddable),
        );
        this.appendStmt.run(
          a.persona,
          a.conversation,
          a.role,
          a.text,
          ts,
          embeddableInt(a.embeddable),
        );
      },
    );
  }

  async appendTurn(t: AppendTurnInput): Promise<void> {
    this.appendStmt.run(
      t.persona,
      t.conversation,
      t.role,
      t.text,
      new Date().toISOString(),
      embeddableInt(t.embeddable),
    );
  }

  async appendTurnPair(
    userTurn: AppendTurnInput,
    assistantTurn: AppendTurnInput,
  ): Promise<void> {
    // `.immediate` takes the write lock at BEGIN rather than on first
    // write, so a concurrent writer in another process (tick vs run)
    // blocks-and-retries (busy_timeout) instead of racing into the
    // read→upgrade deadlock a deferred transaction would risk.
    this.appendPairTxn.immediate(
      userTurn,
      assistantTurn,
      new Date().toISOString(),
    );
  }

  async recentTurns(
    persona: string,
    conversation: string,
    n: number,
  ): Promise<Array<{ role: Role; text: string }>> {
    return this.recentStmt.all(persona, conversation, n) as Array<{
      role: Role;
      text: string;
    }>;
  }

  async recentTurnsForDisplay(persona: string, n: number): Promise<Turn[]> {
    const rows = this.recentDisplayStmt.all(persona, n) as RawDisplayRow[];
    return mapDisplayRows(rows);
  }

  async turnsAfterId(
    persona: string,
    conversation: string,
    afterId: number,
    limit = 1000,
  ): Promise<Turn[]> {
    const rows = this.turnsAfterIdStmt.all(
      persona,
      conversation,
      Math.max(0, Math.floor(afterId)),
      Math.max(1, Math.floor(limit)),
    ) as RawDisplayRow[];
    return mapDisplayRows(rows);
  }

  async countUserTurns(persona: string, conversation: string): Promise<number> {
    const row = this.countUserTurnsStmt.get(persona, conversation) as {
      n: number;
    };
    return row.n;
  }

  async listConversations(persona: string): Promise<string[]> {
    const rows = this.listConversationsStmt.all(persona) as Array<{
      conversation: string;
    }>;
    return rows.map((r) => r.conversation);
  }

  async appendCapture(input: AppendCaptureInput): Promise<void> {
    this.appendCaptureStmt.run(
      input.persona,
      input.conversation,
      input.tags.join(","),
      new Date().toISOString(),
    );
  }

  async lastCaptureAt(
    persona: string,
    conversation: string,
  ): Promise<string | undefined> {
    const row = this.lastCaptureStmt.get(persona, conversation) as
      | { created_at: string }
      | undefined;
    return row?.created_at;
  }

  async countUserTurnsSince(
    persona: string,
    conversation: string,
    since: string,
  ): Promise<number> {
    const row = this.countTurnsSinceStmt.get(persona, conversation, since) as {
      n: number;
    };
    return row.n;
  }

  async countCapturesSince(persona: string, since: string): Promise<number> {
    const row = this.countCapturesSinceStmt.get(persona, since) as {
      n: number;
    };
    return row.n;
  }

  async countUserTurnsForPersonaSince(
    persona: string,
    conversationPrefix: string,
    since: string,
  ): Promise<number> {
    // Escape LIKE wildcards in the caller-supplied prefix, then anchor it
    // with a trailing % so `telegram:` matches `telegram:123` etc.
    const escaped = conversationPrefix.replace(/[\\%_]/g, "\\$&");
    const row = this.db
      .prepare(
        `SELECT COUNT(*) AS n FROM turns
         WHERE persona = ? AND role = 'user' AND created_at >= ?
           AND conversation LIKE ? ESCAPE '\\'`,
      )
      .get(persona, since, `${escaped}%`) as { n: number };
    return row.n;
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.db.close();
  }

  async deleteConversation(
    persona: string,
    conversation: string,
  ): Promise<number> {
    const result = this.deleteStmt.run(persona, conversation);
    return result.changes;
  }

  async purgeQuarantined(
    persona: string,
    conversation: string,
  ): Promise<number> {
    const result = this.purgeQuarantinedStmt.run(persona, conversation);
    return result.changes;
  }
}

/** Normalize the optional embeddable flag to a SQLite int (default 1 = true). */
function embeddableInt(embeddable: boolean | undefined): number {
  return embeddable === false ? 0 : 1;
}

function mapDisplayRows(rows: RawDisplayRow[]): Turn[] {
  return rows.map((r) => ({
    id: r.id,
    persona: r.persona,
    conversation: r.conversation,
    role: r.role,
    text: r.text,
    createdAt: new Date(r.created_at),
    embeddable: r.embeddable !== 0,
  }));
}

export async function openMemoryStore(path: string): Promise<MemoryStore> {
  if (path !== ":memory:") {
    await mkdir(dirname(path), { recursive: true });
  }
  const db = new Database(path, { create: true });
  // WAL keeps reads non-blocking, but the file is in fact shared across
  // processes — `phantombot run` persists turns while `phantombot tick`
  // records task runs against the same DB. WAL permits one writer at a
  // time; without busy_timeout a concurrent writer gets an immediate
  // SQLITE_BUSY throw. busy_timeout makes it block-and-retry instead.
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA busy_timeout = 5000");
  db.exec("PRAGMA foreign_keys = ON");
  return new SqliteMemoryStore(db);
}
