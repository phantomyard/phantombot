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
import { randomUUID } from "node:crypto";
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

/**
 * A durable fact — a long-lived statement about the principal / their world,
 * extracted at the eviction cliff (orchestrator/durableFacts.ts) from a turn
 * that is about to scroll out of the live window, and injected back into the
 * system prompt on later turns via a plain SQL read (no LLM on the read path).
 *
 * Scoped by (persona, conversation), like turns. De-duplicated within that
 * scope by `factNorm` (normalized text) so the same fact restated across many
 * turns is one row whose `confidence` is the best seen and whose `lastSeenAt`
 * tracks recency.
 */
export interface DurableFact {
  id: number;
  persona: string;
  conversation: string;
  /** Verbatim fact text as extracted. */
  fact: string;
  /** Extractor confidence, 0..1. Higher = more likely durable/true. */
  confidence: number;
  /** The turns.id this fact aged out of when extracted (best-effort ref). */
  sourceTurnId?: number;
  createdAt: Date;
  /** Recency: bumped every time the same normalized fact is re-extracted. */
  lastSeenAt: Date;
}

export interface UpsertDurableFactInput {
  persona: string;
  conversation: string;
  fact: string;
  /** 0..1; clamped on write. Defaults to 0.5 when omitted. */
  confidence?: number;
  /** turns.id the fact was extracted from, for provenance. */
  sourceTurnId?: number;
}

/** One fact to persist inside a token-guarded commitExtraction. */
export interface ExtractedFactWrite {
  fact: string;
  /** 0..1; clamped on write. */
  confidence: number;
  /** turns.id the fact was extracted from, for provenance. */
  sourceTurnId?: number;
}

/**
 * The result of claimEvictedForExtraction: the leased turns plus the ownership
 * token stamped on their lease rows. The token gates every subsequent
 * commit/release so only the pass that still holds the lease can write.
 */
export interface ClaimedExtraction {
  token: string;
  turns: Turn[];
}

export interface TopDurableFactsOptions {
  /** Max facts to return. */
  limit: number;
  /** Only return facts at or above this confidence. Default 0 (no floor). */
  minConfidence?: number;
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
  /**
   * Most recent N turns across every conversation whose key starts with
   * `prefix`, oldest first, optionally excluding one conversation.
   *
   * The ACP connector uses this to brief a FRESH editor thread on what has been
   * happening in its workspace: conversations are keyed `acp:<cwdhash>:<thread>`,
   * so the workspace prefix `acp:<cwdhash>` spans every thread in that project
   * while the new thread's own (empty) history stays untouched. `exclude` keeps
   * the current thread's turns out — `runTurn` already replays those as real
   * history and they must not be duplicated as reference data.
   *
   * `prefix` is matched with LIKE and is NOT escaped: callers pass an internally
   * constructed key (hex + separators), never user input.
   */
  recentTurnsForConversationPrefix(
    persona: string,
    prefix: string,
    n: number,
    exclude?: string,
  ): Promise<Array<{ conversation: string; role: Role; text: string }>>;
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
  /**
   * Delete ALL per-conversation state for a (persona, conversation) pair —
   * turns AND the durable-fact stores (facts, extractor cursor, in-flight
   * leases) — in one transaction. Used by /reset; returns the turn count.
   */
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
  /**
   * Full turn rows that have aged OUT of the most-recent `windowSize` turns
   * (the live-history cliff) AND have id > `afterId`, oldest first. This is
   * the newly-evicted, not-yet-extracted slice the durable-fact extractor
   * pulls at the cliff. `afterId` is the extractor's cursor
   * (see durableFactCursor); pass 0 to scan from the beginning. Returns at
   * most `limit` rows.
   */
  turnsEvictedFromWindow(
    persona: string,
    conversation: string,
    windowSize: number,
    afterId: number,
    limit: number,
  ): Promise<Turn[]>;
  /**
   * ATOMICALLY claim (lease) the next slice of evicted turns for the
   * durable-fact extractor. In one serialized transaction this reads the
   * high-water cursor, selects eligible evicted turns — those above the cursor
   * OR with a STALE lease (a failed/crashed prior pass), and never those under a
   * LIVE lease — writes a lease row for each, and advances the cursor
   * monotonically. `leaseMs` is the crash-recovery window: a claimed turn whose
   * pass dies without commit/release becomes re-claimable once the lease
   * expires. Concurrency-safe (SQLite serializes the txn, so racing passes get
   * DISJOINT batches) and, unlike a claim-and-advance cursor, LOSSLESS under
   * partial failure — retries ride the lease ledger, not a cursor rewind
   * (Kai, PR #320). Returns the claimed turns (oldest first) plus a per-claim
   * OWNERSHIP TOKEN stamped on every lease row: pass it back to commitExtraction
   * / commitExtractedTurn / releaseExtractionLease so those writes act ONLY
   * while this pass still holds the lease. If the lease was wiped (a concurrent
   * /reset) or re-stamped by another pass (this lease expired and was
   * re-claimed), the token no longer matches and the stale write is discarded —
   * which is what stops a late finisher repopulating a reset conversation or
   * double-writing a re-claimed turn (Kai, PR #320). Pair every claimed turn
   * with exactly one commitExtraction/commitExtractedTurn (success) or
   * releaseExtractionLease (failure).
   */
  claimEvictedForExtraction(
    persona: string,
    conversation: string,
    windowSize: number,
    limit: number,
    leaseMs: number,
  ): Promise<ClaimedExtraction>;
  /**
   * ATOMICALLY commit an extraction: in one transaction, verify the turn still
   * holds THIS pass's lease (pending row present AND lease_token === token),
   * write its facts, and drop the lease. Returns true when it committed, false
   * when it wrote NOTHING because the lease was gone or owned by another pass —
   * a concurrent /reset wiped it (so the facts belong to a conversation that no
   * longer exists and must not be repopulated) or the lease expired and another
   * pass re-claimed the turn (so that pass owns the write). Guarding the fact
   * write behind the live lease is what closes the reset-repopulation and
   * lease-expiry races (Kai, PR #320).
   */
  commitExtraction(
    persona: string,
    conversation: string,
    turnId: number,
    token: string,
    facts: ExtractedFactWrite[],
  ): Promise<boolean>;
  /**
   * COMMIT a claimed turn that produced no facts (quiet/skipped): drop its lease
   * row IFF it still carries THIS pass's token. The turn then sits below the
   * cursor with no pending row, so it is never claimed again. No-op when the
   * lease is gone or re-stamped by another pass. Idempotent.
   */
  commitExtractedTurn(
    persona: string,
    conversation: string,
    turnId: number,
    token: string,
  ): Promise<void>;
  /**
   * RELEASE claimed turns whose extraction failed: set each lease to expired so
   * the next pass re-claims them immediately, without waiting out `leaseMs` —
   * but only for leases this pass still owns (lease_token === token), so a
   * turn already re-claimed by another pass is never clobbered. This is the
   * at-least-once recovery for the common harness reject/timeout — a hard crash
   * between claim and release is covered by the lease expiry instead. No-op for
   * turn ids with no matching pending row.
   */
  releaseExtractionLease(
    persona: string,
    conversation: string,
    turnIds: number[],
    token: string,
  ): Promise<void>;
  /**
   * Insert a durable fact, or — when the same normalized text already exists
   * for this (persona, conversation) — bump its recency (`last_seen_at`),
   * keep the higher `confidence`, and refresh its source ref. De-dupe key is
   * the normalized fact text, so "He uses Deye inverters." and "he uses deye
   * inverters" collapse to one row.
   */
  upsertDurableFact(input: UpsertDurableFactInput): Promise<void>;
  /**
   * Top durable facts for (persona, conversation), ranked by confidence then
   * recency (`last_seen_at`). PURE SQL — the per-turn read path that injects
   * facts into the prompt; it MUST never invoke an LLM. Empty when there are
   * no facts at/above `minConfidence`.
   */
  topDurableFacts(
    persona: string,
    conversation: string,
    opts: TopDurableFactsOptions,
  ): Promise<DurableFact[]>;
  /** Count durable facts for (persona, conversation). For tests / diagnostics. */
  countDurableFacts(persona: string, conversation: string): Promise<number>;
  /**
   * The durable-fact extractor's cursor for (persona, conversation): the
   * highest turns.id already considered for extraction. 0 when unset. Mirrors
   * the turn-index cursor — it lets the extractor skip turns it has already
   * seen (including turns that produced no facts), so a quiet turn isn't
   * re-extracted forever.
   */
  durableFactCursor(persona: string, conversation: string): Promise<number>;
  /** Advance the durable-fact extractor's cursor. Upserts the row. */
  setDurableFactCursor(
    persona: string,
    conversation: string,
    turnId: number,
  ): Promise<void>;
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

-- Durable facts extracted at the eviction cliff. De-duplicated within a
-- (persona, conversation) by fact_norm (normalized text); confidence is the
-- best seen, last_seen_at tracks recency. Read back per-turn with a plain
-- SELECT — no LLM on the read path.
CREATE TABLE IF NOT EXISTS durable_facts (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  persona        TEXT NOT NULL,
  conversation   TEXT NOT NULL,
  fact           TEXT NOT NULL,
  fact_norm      TEXT NOT NULL,
  confidence     REAL NOT NULL DEFAULT 0.5,
  source_turn_id INTEGER,
  created_at     TEXT NOT NULL,
  last_seen_at   TEXT NOT NULL,
  UNIQUE (persona, conversation, fact_norm)
);
CREATE INDEX IF NOT EXISTS idx_durable_facts_rank
  ON durable_facts (persona, conversation, confidence DESC, last_seen_at DESC);

-- Per-conversation cursor for the durable-fact extractor: the highest
-- turns.id ever CLAIMED, so newly-evicted turns aren't re-claimed from the top
-- each pass. Monotonic — it only ever rises. Retrying a turn that failed after
-- the cursor passed it is driven by durable_fact_pending (below), NOT by
-- lowering this cursor, which is what keeps concurrent passes race-free.
CREATE TABLE IF NOT EXISTS durable_fact_cursor (
  persona                TEXT NOT NULL,
  conversation           TEXT NOT NULL,
  last_extracted_turn_id INTEGER NOT NULL DEFAULT 0,
  updated_at             TEXT NOT NULL,
  PRIMARY KEY (persona, conversation)
);

-- In-flight lease ledger for the durable-fact extractor (claim/commit/release).
-- A row means "turn_id has been CLAIMED but not yet committed". lease_expires_at
-- (epoch ms) is the crash-recovery deadline: once now >= it, the lease is stale
-- and the turn is re-claimable even though it sits below the cursor. On a
-- successful extraction the row is DELETED (commit); on a harness failure it is
-- released (lease set to 0 = immediately re-claimable). This per-turn state is
-- what makes extraction at-least-once under concurrency + failure: a turn is
-- never dropped just because the cursor advanced past it (Kai, PR #320).
-- lease_token: a per-claim ownership token (see claimEvictedTxn). Every
-- commit/release is gated on it, so a write from a pass that no longer holds
-- the lease — because a /reset wiped the row, or the lease expired and another
-- pass re-stamped it — is discarded instead of corrupting the store (Kai, #320).
CREATE TABLE IF NOT EXISTS durable_fact_pending (
  persona          TEXT NOT NULL,
  conversation     TEXT NOT NULL,
  turn_id          INTEGER NOT NULL,
  lease_expires_at INTEGER NOT NULL,
  lease_token      TEXT NOT NULL DEFAULT '',
  updated_at       TEXT NOT NULL,
  PRIMARY KEY (persona, conversation, turn_id)
);
CREATE INDEX IF NOT EXISTS idx_durable_fact_pending_conv
  ON durable_fact_pending (persona, conversation, turn_id);
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
  private recentPrefixStmt;
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
  private turnsEvictedStmt;
  private upsertDurableFactStmt;
  private topDurableFactsStmt;
  private countDurableFactsStmt;
  private durableFactCursorStmt;
  private setDurableFactCursorStmt;
  private claimEvictedSelectStmt;
  private upsertPendingStmt;
  private getPendingTokenStmt;
  private commitPendingStmt;
  private releasePendingStmt;
  private deleteDurableFactsStmt;
  private deleteDurableFactCursorStmt;
  private deleteDurableFactPendingStmt;
  private claimEvictedTxn;
  private commitExtractionTxn;
  private deleteConversationTxn;
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
    // Newest N turns across every conversation under a key prefix, returned
    // oldest-first. `exclude` is compared with `IS NOT`, not `<>`: a NULL
    // exclude then matches nothing (SQL `<> NULL` is NULL, which would drop
    // every row), so binding NULL keeps the whole window.
    this.recentPrefixStmt = db.prepare(
      `SELECT conversation, role, text FROM (
         SELECT id, conversation, role, text, created_at
         FROM turns
         WHERE persona = ?
           AND conversation LIKE ? || '%'
           AND conversation IS NOT ?
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
    // Turns that have fallen OUT of the most-recent `windowSize` rows (the
    // subquery is the live window) and sit after the extractor's cursor.
    // Oldest-first so the cursor advances monotonically.
    this.turnsEvictedStmt = db.prepare(
      `SELECT id, persona, conversation, role, text, created_at, embeddable
       FROM turns
       WHERE persona = ? AND conversation = ? AND id > ?
         AND id NOT IN (
           SELECT id FROM turns
           WHERE persona = ? AND conversation = ?
           ORDER BY created_at DESC, id DESC
           LIMIT ?
         )
       ORDER BY id ASC
       LIMIT ?`,
    );
    // Upsert on the (persona, conversation, fact_norm) de-dupe key: a restated
    // fact keeps the higher confidence and refreshes recency + provenance.
    this.upsertDurableFactStmt = db.prepare(
      `INSERT INTO durable_facts
         (persona, conversation, fact, fact_norm, confidence, source_turn_id, created_at, last_seen_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (persona, conversation, fact_norm) DO UPDATE SET
         confidence     = MAX(confidence, excluded.confidence),
         last_seen_at   = excluded.last_seen_at,
         source_turn_id = excluded.source_turn_id`,
    );
    this.topDurableFactsStmt = db.prepare(
      `SELECT id, persona, conversation, fact, confidence, source_turn_id,
              created_at, last_seen_at
       FROM durable_facts
       WHERE persona = ? AND conversation = ? AND confidence >= ?
       ORDER BY confidence DESC, last_seen_at DESC, id DESC
       LIMIT ?`,
    );
    this.countDurableFactsStmt = db.prepare(
      `SELECT COUNT(*) AS n FROM durable_facts
       WHERE persona = ? AND conversation = ?`,
    );
    this.durableFactCursorStmt = db.prepare(
      `SELECT last_extracted_turn_id AS id FROM durable_fact_cursor
       WHERE persona = ? AND conversation = ?`,
    );
    this.setDurableFactCursorStmt = db.prepare(
      `INSERT INTO durable_fact_cursor
         (persona, conversation, last_extracted_turn_id, updated_at)
       VALUES (?, ?, ?, ?)
       ON CONFLICT (persona, conversation) DO UPDATE SET
         last_extracted_turn_id =
           MAX(last_extracted_turn_id, excluded.last_extracted_turn_id),
         updated_at             = excluded.updated_at`,
    );
    // Claim SELECT for the lease-based extractor. Returns evicted turns that are
    // eligible to claim: those ABOVE the high-water cursor (newly evicted), OR
    // those with a STALE pending lease (lease_expires_at <= now — a failed/
    // crashed pass, re-claimable even though the cursor already passed them);
    // and NEVER those holding a LIVE lease (a concurrent pass owns them). That
    // "stale-lease re-claim below the cursor" branch is what lets a monotonic
    // cursor coexist with at-least-once retries (Kai, PR #320): the cursor never
    // has to move backwards, so it can never race, yet no turn is lost.
    // Params: persona, conversation, persona, conversation, windowSize,
    //         cursor, now(stale), now(live), limit.
    this.claimEvictedSelectStmt = db.prepare(
      `SELECT t.id, t.persona, t.conversation, t.role, t.text, t.created_at, t.embeddable
       FROM turns t
       WHERE t.persona = ? AND t.conversation = ?
         AND t.id NOT IN (
           SELECT id FROM turns
           WHERE persona = ? AND conversation = ?
           ORDER BY created_at DESC, id DESC
           LIMIT ?
         )
         AND (
           t.id > ?
           OR EXISTS (
             SELECT 1 FROM durable_fact_pending p
             WHERE p.persona = t.persona AND p.conversation = t.conversation
               AND p.turn_id = t.id AND p.lease_expires_at <= ?
           )
         )
         AND NOT EXISTS (
           SELECT 1 FROM durable_fact_pending p2
           WHERE p2.persona = t.persona AND p2.conversation = t.conversation
             AND p2.turn_id = t.id AND p2.lease_expires_at > ?
         )
       ORDER BY t.id ASC
       LIMIT ?`,
    );
    // Claim/lease a turn: insert a pending row (or refresh its lease deadline +
    // stamp a fresh ownership token if re-claiming a stale one). Re-stamping the
    // token on re-claim is what invalidates a prior owner's late write.
    this.upsertPendingStmt = db.prepare(
      `INSERT INTO durable_fact_pending
         (persona, conversation, turn_id, lease_expires_at, lease_token, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT (persona, conversation, turn_id) DO UPDATE SET
         lease_expires_at = excluded.lease_expires_at,
         lease_token      = excluded.lease_token,
         updated_at       = excluded.updated_at`,
    );
    // Read a turn's current lease token (used inside commitExtractionTxn to gate
    // the fact write on continued ownership).
    this.getPendingTokenStmt = db.prepare(
      `SELECT lease_token FROM durable_fact_pending
       WHERE persona = ? AND conversation = ? AND turn_id = ?`,
    );
    // Commit a turn: drop its pending row IFF it still carries this pass's token.
    // Gating on the token means a row wiped by /reset (gone) or re-stamped by a
    // newer pass (different token) is left untouched. It now sits below the
    // cursor with no pending row, so the claim SELECT will never return it again.
    this.commitPendingStmt = db.prepare(
      `DELETE FROM durable_fact_pending
       WHERE persona = ? AND conversation = ? AND turn_id = ? AND lease_token = ?`,
    );
    // Release a turn's lease on failure: set the deadline to 0 so the very next
    // pass re-claims it immediately (no wait for the crash-recovery timeout).
    // Token-gated so a lease already re-claimed by another pass isn't clobbered.
    this.releasePendingStmt = db.prepare(
      `UPDATE durable_fact_pending SET lease_expires_at = 0, updated_at = ?
       WHERE persona = ? AND conversation = ? AND turn_id = ? AND lease_token = ?`,
    );
    // /reset helpers — the three per-conversation durable stores wiped alongside
    // turns in deleteConversationTxn.
    this.deleteDurableFactsStmt = db.prepare(
      "DELETE FROM durable_facts WHERE persona = ? AND conversation = ?",
    );
    this.deleteDurableFactCursorStmt = db.prepare(
      "DELETE FROM durable_fact_cursor WHERE persona = ? AND conversation = ?",
    );
    this.deleteDurableFactPendingStmt = db.prepare(
      "DELETE FROM durable_fact_pending WHERE persona = ? AND conversation = ?",
    );
    // Atomic claim for the durable-fact extractor. Wrapping the cursor read, the
    // eligibility SELECT, the per-turn lease writes, and the monotonic cursor
    // advance in ONE db.transaction() makes them a single serialized unit:
    // bun:sqlite runs it synchronously and SQLite serializes writers, so two
    // concurrent out-of-band extractors never claim overlapping turns (each
    // leased turn is excluded from the other's SELECT). Unlike the old
    // claim-and-advance-then-rollback, the cursor here only ever RISES; retries
    // ride on durable_fact_pending, so there is no cursor regression to race.
    this.claimEvictedTxn = db.transaction(
      (
        persona: string,
        conversation: string,
        windowSize: number,
        limit: number,
        leaseMs: number,
        token: string,
      ): RawDisplayRow[] => {
        const cur = this.durableFactCursorStmt.get(persona, conversation) as
          | { id: number }
          | undefined;
        const cursor = cur?.id ?? 0;
        const now = Date.now();
        const rows = this.claimEvictedSelectStmt.all(
          persona,
          conversation,
          persona,
          conversation,
          Math.max(0, Math.floor(windowSize)),
          cursor,
          now,
          now,
          Math.max(1, Math.floor(limit)),
        ) as RawDisplayRow[];
        if (rows.length === 0) return rows;
        const iso = new Date().toISOString();
        const expiry = now + Math.max(0, Math.floor(leaseMs));
        let maxId = cursor;
        for (const r of rows) {
          // Stamp every leased row with this claim's ownership token; a later
          // re-claim overwrites it, invalidating the prior owner's late write.
          this.upsertPendingStmt.run(
            persona,
            conversation,
            r.id,
            expiry,
            token,
            iso,
          );
          if (r.id > maxId) maxId = r.id;
        }
        // Monotonic advance to the batch max (>= current cursor by construction).
        this.setDurableFactCursorStmt.run(persona, conversation, maxId, iso);
        return rows;
      },
    );
    // Atomic, token-gated commit of one turn's extraction: verify the lease is
    // still ours, write the facts, drop the lease — one serialized unit so a
    // concurrent /reset can't interleave BETWEEN the ownership check and the
    // fact write. Returns whether it actually wrote (false = lease gone/reclaimed
    // → facts discarded, closing the reset-repopulation + lease-expiry races).
    this.commitExtractionTxn = db.transaction(
      (
        persona: string,
        conversation: string,
        turnId: number,
        token: string,
        facts: ExtractedFactWrite[],
      ): boolean => {
        const row = this.getPendingTokenStmt.get(
          persona,
          conversation,
          turnId,
        ) as { lease_token: string } | undefined;
        if (!row || row.lease_token !== token) return false;
        const now = new Date().toISOString();
        for (const f of facts) {
          this.upsertDurableFactStmt.run(
            persona,
            conversation,
            f.fact,
            normalizeFact(f.fact),
            clampConfidence(f.confidence),
            f.sourceTurnId ?? null,
            now,
            now,
          );
        }
        this.commitPendingStmt.run(persona, conversation, turnId, token);
        return true;
      },
    );
    // /reset must wipe EVERY per-conversation store, not just turns: durable
    // facts, the extractor cursor, and any in-flight leases. One transaction so
    // a reset can't half-clear and leak facts into the next conversation on the
    // same key (Kai, PR #320).
    this.deleteConversationTxn = db.transaction(
      (persona: string, conversation: string): number => {
        const turns = this.deleteStmt.run(persona, conversation).changes;
        this.deleteDurableFactsStmt.run(persona, conversation);
        this.deleteDurableFactCursorStmt.run(persona, conversation);
        this.deleteDurableFactPendingStmt.run(persona, conversation);
        return turns;
      },
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

  async recentTurnsForConversationPrefix(
    persona: string,
    prefix: string,
    n: number,
    exclude?: string,
  ): Promise<Array<{ conversation: string; role: Role; text: string }>> {
    return this.recentPrefixStmt.all(
      persona,
      prefix,
      exclude ?? null,
      n,
    ) as Array<{ conversation: string; role: Role; text: string }>;
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

  async turnsEvictedFromWindow(
    persona: string,
    conversation: string,
    windowSize: number,
    afterId: number,
    limit: number,
  ): Promise<Turn[]> {
    const rows = this.turnsEvictedStmt.all(
      persona,
      conversation,
      Math.max(0, Math.floor(afterId)),
      persona,
      conversation,
      Math.max(0, Math.floor(windowSize)),
      Math.max(1, Math.floor(limit)),
    ) as RawDisplayRow[];
    return mapDisplayRows(rows);
  }

  async claimEvictedForExtraction(
    persona: string,
    conversation: string,
    windowSize: number,
    limit: number,
    leaseMs: number,
  ): Promise<ClaimedExtraction> {
    // One fresh token per claim, stamped on every leased row. Everything this
    // pass writes later is gated on it (see commitExtraction).
    const token = randomUUID();
    const rows = this.claimEvictedTxn(
      persona,
      conversation,
      windowSize,
      limit,
      Math.max(0, Math.floor(leaseMs)),
      token,
    ) as RawDisplayRow[];
    return { token, turns: mapDisplayRows(rows) };
  }

  async commitExtraction(
    persona: string,
    conversation: string,
    turnId: number,
    token: string,
    facts: ExtractedFactWrite[],
  ): Promise<boolean> {
    return this.commitExtractionTxn(
      persona,
      conversation,
      Math.floor(turnId),
      token,
      facts,
    ) as boolean;
  }

  async commitExtractedTurn(
    persona: string,
    conversation: string,
    turnId: number,
    token: string,
  ): Promise<void> {
    this.commitPendingStmt.run(
      persona,
      conversation,
      Math.floor(turnId),
      token,
    );
  }

  async releaseExtractionLease(
    persona: string,
    conversation: string,
    turnIds: number[],
    token: string,
  ): Promise<void> {
    if (turnIds.length === 0) return;
    const iso = new Date().toISOString();
    for (const id of turnIds) {
      this.releasePendingStmt.run(
        iso,
        persona,
        conversation,
        Math.floor(id),
        token,
      );
    }
  }

  async upsertDurableFact(input: UpsertDurableFactInput): Promise<void> {
    const now = new Date().toISOString();
    this.upsertDurableFactStmt.run(
      input.persona,
      input.conversation,
      input.fact,
      normalizeFact(input.fact),
      clampConfidence(input.confidence),
      input.sourceTurnId ?? null,
      now,
      now,
    );
  }

  async topDurableFacts(
    persona: string,
    conversation: string,
    opts: TopDurableFactsOptions,
  ): Promise<DurableFact[]> {
    const rows = this.topDurableFactsStmt.all(
      persona,
      conversation,
      opts.minConfidence ?? 0,
      Math.max(1, Math.floor(opts.limit)),
    ) as RawDurableFactRow[];
    return rows.map(mapDurableFactRow);
  }

  async countDurableFacts(
    persona: string,
    conversation: string,
  ): Promise<number> {
    const row = this.countDurableFactsStmt.get(persona, conversation) as {
      n: number;
    };
    return row.n;
  }

  async durableFactCursor(
    persona: string,
    conversation: string,
  ): Promise<number> {
    const row = this.durableFactCursorStmt.get(persona, conversation) as
      | { id: number }
      | undefined;
    return row?.id ?? 0;
  }

  async setDurableFactCursor(
    persona: string,
    conversation: string,
    turnId: number,
  ): Promise<void> {
    this.setDurableFactCursorStmt.run(
      persona,
      conversation,
      Math.max(0, Math.floor(turnId)),
      new Date().toISOString(),
    );
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
    // Wipes turns AND the durable-fact stores (facts, cursor, leases) in one
    // transaction so a reset never leaks facts into the next conversation on the
    // same key. Returns the turn count for back-compat.
    return this.deleteConversationTxn(persona, conversation) as number;
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

/**
 * Normalized form of a fact used as the de-dupe key: lowercased, whitespace
 * collapsed, surrounding quotes and trailing sentence punctuation stripped.
 * "He uses Deye inverters." and "  he uses  deye inverters  " collapse to the
 * same key. Exported for the extractor + tests.
 */
export function normalizeFact(fact: string): string {
  return fact
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^["'`]+|["'`]+$/g, "")
    .replace(/[.,;:!?]+$/g, "")
    .trim();
}

/** Clamp a confidence into 0..1, defaulting to 0.5 for undefined/NaN. */
function clampConfidence(c: number | undefined): number {
  if (c === undefined || !Number.isFinite(c)) return 0.5;
  return Math.max(0, Math.min(1, c));
}

interface RawDurableFactRow {
  id: number;
  persona: string;
  conversation: string;
  fact: string;
  confidence: number;
  source_turn_id: number | null;
  created_at: string;
  last_seen_at: string;
}

function mapDurableFactRow(r: RawDurableFactRow): DurableFact {
  return {
    id: r.id,
    persona: r.persona,
    conversation: r.conversation,
    fact: r.fact,
    confidence: r.confidence,
    sourceTurnId: r.source_turn_id ?? undefined,
    createdAt: new Date(r.created_at),
    lastSeenAt: new Date(r.last_seen_at),
  };
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
