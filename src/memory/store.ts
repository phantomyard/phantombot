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

import type { FactSource } from "../config.ts";

export type Role = "user" | "assistant";

/**
 * Numeric trust priority per fact source. Used both in SQL (the upsert conflict
 * clause, inlined) and in JS to decide which source wins when the same
 * normalized fact arrives from two conversations under the persona-wide key:
 * the higher-trust source is kept. principal > self > other > unverified. So
 * when the SAME fact later arrives on a higher-trust turn — e.g. the principal
 * confirms an `unverified` claim, making it `principal` — the upsert promotes
 * it; a lower-trust re-sighting never demotes an already-earned tier.
 */
export const FACT_SOURCE_PRIORITY: Record<FactSource, number> = {
  principal: 3,
  self: 2,
  other: 1,
  unverified: 0,
};

/** Coerce a raw DB string to a known FactSource, defaulting to `principal`. */
export function asFactSource(v: unknown): FactSource {
  return v === "self" || v === "other" || v === "unverified"
    ? v
    : "principal";
}

/** Coerce a stored origin string; anything unrecognised reads as `channel`. */
export function asTurnOrigin(v: unknown): TurnOrigin {
  return isTurnOrigin(v) ? v : "channel";
}

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
  /**
   * Provenance of this turn's content, used by durable-fact extraction to
   * stamp each fact's trust tier. `principal` (owner, trusted turn),
   * `unverified` (the persona's own assistant turn by default — unconfirmed,
   * may carry untrusted tool-ingested bytes), `self` (a first-hand observation
   * that has EARNED trust via promotion), or `other` (a third party in a shared
   * conversation). Legacy rows written before this column default to
   * `principal`; the pre-provenance migration backfilled assistant rows to
   * `self`, but new assistant turns land `unverified`.
   */
  source: FactSource;
  /**
   * ORIGIN of this turn — the mechanism that produced it. Orthogonal to
   * `source`, which is a TRUST tier: the two answer different questions and
   * conflating them is what made scheduled-task output indistinguishable
   * from a stranger's message in a group chat (both land `source: "other"`,
   * see cli/tick.ts).
   *
   *   `channel`      — arrived over a chat surface (Telegram, phantomchat,
   *                    CLI, ACP): a human wrote it, or we replied to one.
   *   `task`         — a scheduled task wake. The prompt is one WE wrote and
   *                    the reply is our own reasoning, unreviewed by anyone.
   *   `notification` — a `phantombot notify` payload persisted for continuity.
   *   `internal`     — heartbeat / nightly / other machine-driven writes.
   *
   * Why it matters for retrieval: `task` and `internal` content is the
   * persona talking to itself. Surfaced later it reads as established fact
   * when it was never checked by anyone, so it is down-weighted and labelled
   * rather than filtered (weight + label, not a gate).
   *
   * Rows written before this column default to `channel`.
   */
  origin: TurnOrigin;
}

/**
 * How a turn came into existence. See `Turn.origin` — this is the ORIGIN
 * axis, deliberately separate from the `FactSource` TRUST axis.
 */
export type TurnOrigin = "channel" | "task" | "notification" | "internal";

export const TURN_ORIGINS: readonly TurnOrigin[] = [
  "channel",
  "task",
  "notification",
  "internal",
];

export function isTurnOrigin(v: unknown): v is TurnOrigin {
  return typeof v === "string" && TURN_ORIGINS.includes(v as TurnOrigin);
}

export interface AppendTurnInput {
  persona: string;
  conversation: string;
  role: Role;
  text: string;
  /**
   * Provenance tier for durable-fact extraction (see Turn.source). Optional on
   * input: when omitted it defaults to `unverified` for assistant turns and
   * `principal` for user turns. (The assistant default was `self` before the
   * #327 provenance tightening — an assistant turn is now untrusted until the
   * principal engages with it.)
   */
  source?: FactSource;
  /**
   * Origin axis (see Turn.origin). Optional on input; defaults to `channel`,
   * which is correct for every chat-surface write. Non-channel writers
   * (tick task wakes, notify, heartbeat/nightly) pass theirs explicitly.
   */
  origin?: TurnOrigin;
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
 * Scoped by PERSONA (not conversation): every conversation for one persona
 * reads and writes ONE shared pool, so a fact learned in a task run or one DM
 * is available in the next. De-duplicated per persona by `factNorm`
 * (normalized text) — the same fact restated across turns or conversations
 * collapses to one row whose `confidence` is the best seen, whose `source` is
 * the highest-trust asserter seen, and whose `lastSeenAt` tracks recency. The
 * `conversation` column is retained as origin provenance only; it is not part
 * of the de-dupe key or the read scope.
 */
export interface DurableFact {
  id: number;
  persona: string;
  conversation: string;
  /** Verbatim fact text as extracted. */
  fact: string;
  /** Extractor confidence, 0..1. Higher = more likely durable/true. */
  confidence: number;
  /**
   * Provenance/trust tier of this fact (highest source seen for this
   * normalized text). Drives the read path's source-weighting + per-tier decay
   * and the write path's retirement floor.
   */
  source: FactSource;
  /** The turns.id this fact aged out of when extracted (best-effort ref). */
  sourceTurnId?: number;
  createdAt: Date;
  /**
   * Recency clock: bumped when the same normalized fact is re-extracted AND
   * when the fact is recalled (injected). Age from now drives decay + prune, so
   * any use resets the clock and only genuinely-unused facts age out.
   */
  lastSeenAt: Date;
}

export interface UpsertDurableFactInput {
  persona: string;
  conversation: string;
  fact: string;
  /** 0..1; clamped on write. Defaults to 0.5 when omitted. */
  confidence?: number;
  /** Provenance tier. Defaults to `principal` when omitted. */
  source?: FactSource;
  /** turns.id the fact was extracted from, for provenance. */
  sourceTurnId?: number;
}

/** One fact to persist inside a token-guarded commitExtraction. */
export interface ExtractedFactWrite {
  fact: string;
  /** 0..1; clamped on write. */
  confidence: number;
  /** Provenance tier of the turn this fact came from. */
  source: FactSource;
  /** turns.id the fact was extracted from, for provenance. */
  sourceTurnId?: number;
}

/** Per-source ISO cutoff timestamps for pruning: facts with last_seen_at < cutoff retire. */
export type FactPruneCutoffs = Record<FactSource, string>;

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
   * Hard-delete a conversation's turns plus its per-conversation extractor
   * state (cursor + in-flight leases) in one transaction; returns the turn
   * count. Persona-wide durable FACTS are deliberately left alone.
   *
   * NOT wired to /reset — that only moves the conversation's reset watermark
   * (`resetConversationContext`) so history survives. This is genuine
   * destruction, reserved for explicit administrative deletion.
   */
  deleteConversation(persona: string, conversation: string): Promise<number>;
  /**
   * NON-DESTRUCTIVE /reset: advance this conversation's live-context
   * watermark to its newest turn, so `recentTurns` replays nothing until new
   * turns arrive. Turns, their embeddings, durable facts and extractor state
   * all SURVIVE — only the replayed window is cleared, which is what /reset
   * is actually for. Returns the number of turns dropped out of the window
   * (those above the previous watermark). Idempotent: a second reset with no
   * new turns drops 0. The watermark is monotonic and never lowered.
   */
  resetConversationContext(
    persona: string,
    conversation: string,
  ): Promise<number>;
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
   * a concurrent hard delete wiped it (so the facts belong to a conversation that no
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
   * for this PERSONA — bump its recency (`last_seen_at`), keep the higher
   * `confidence`, promote to the higher-trust `source`, and refresh its origin
   * refs. De-dupe key is (persona, normalized fact text), so the same fact
   * from two conversations collapses to one persona-wide row.
   */
  upsertDurableFact(input: UpsertDurableFactInput): Promise<void>;
  /**
   * Candidate durable facts for a PERSONA (all conversations), ordered by
   * confidence then recency, capped at `opts.limit`. PURE SQL — the per-turn
   * read path; it MUST never invoke an LLM. This returns the raw candidate
   * pool; source-weighting + time-decay ranking and the final top-N cut happen
   * in the caller (durableFacts.ts) so ranking policy stays out of the store.
   * Empty when there are no facts at/above `minConfidence`.
   */
  topDurableFacts(
    persona: string,
    opts: TopDurableFactsOptions,
  ): Promise<DurableFact[]>;
  /** Count durable facts for a PERSONA. For tests / diagnostics. */
  countDurableFacts(persona: string): Promise<number>;
  /**
   * Refresh `last_seen_at` to now for the given fact ids — the recall bump.
   * Called out of band by the read path when a fact is injected, so a fact
   * that keeps being used never decays/retires while genuinely-unused ones
   * age out. No-op for an empty list. Best-effort: never throws into a turn.
   */
  touchDurableFacts(ids: number[]): Promise<void>;
  /**
   * Hard-delete durable facts for a PERSONA whose `last_seen_at` predates their
   * source tier's cutoff — the retirement floor. Runs out of band (write path).
   * Returns the number of rows pruned.
   */
  pruneExpiredDurableFacts(
    persona: string,
    cutoffs: FactPruneCutoffs,
  ): Promise<number>;
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
  /**
   * Path this store was opened from, when it has one.
   *
   * Optional on the interface on purpose: it is a LOCATOR, not behaviour, and
   * making it required would break every hand-rolled test fake for the sake
   * of a string. Its one production use is letting a caller that already
   * holds a store reach a SIBLING table in the same database — the journal
   * (#461) — without threading the config through another dozen signatures.
   */
  dbPath?: string;
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
  embeddable   INTEGER NOT NULL DEFAULT 1,
  -- Provenance tier for durable-fact extraction:
  -- 'principal' | 'self' | 'other' | 'unverified'. New assistant turns land
  -- 'unverified' (own unconfirmed voice); legacy rows default to 'principal'
  -- and the pre-provenance migration backfilled assistant rows to 'self'.
  source       TEXT NOT NULL DEFAULT 'principal',
  -- ORIGIN axis (how the turn was produced), orthogonal to the source
  -- TRUST axis: 'channel' | 'task' | 'notification' | 'internal'.
  -- Legacy rows default to 'channel'. See Turn.origin.
  origin       TEXT NOT NULL DEFAULT 'channel'
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

-- Durable facts extracted at the eviction cliff. De-duplicated PER PERSONA
-- (not per conversation) by fact_norm (normalized text): every conversation
-- shares one persona-wide pool. confidence is the best seen, source is the
-- highest-trust asserter seen, last_seen_at tracks recency. The conversation
-- column is retained as origin provenance only — NOT part of key or read scope.
-- Read back per-turn with a plain SELECT — no LLM on the read path.
CREATE TABLE IF NOT EXISTS durable_facts (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  persona        TEXT NOT NULL,
  conversation   TEXT NOT NULL,
  fact           TEXT NOT NULL,
  fact_norm      TEXT NOT NULL,
  confidence     REAL NOT NULL DEFAULT 0.5,
  -- Provenance tier: 'principal' | 'self' | 'other' | 'unverified'. Drives
  -- read-path weighting + decay and write-path retirement. Legacy rows →
  -- 'principal'. A fact promotes to a higher tier when re-asserted on a
  -- higher-trust turn (unverified → principal when the owner confirms it).
  source         TEXT NOT NULL DEFAULT 'principal',
  source_turn_id INTEGER,
  created_at     TEXT NOT NULL,
  last_seen_at   TEXT NOT NULL,
  UNIQUE (persona, fact_norm)
);
CREATE INDEX IF NOT EXISTS idx_durable_facts_rank
  ON durable_facts (persona, confidence DESC, last_seen_at DESC);

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
-- the lease — because deleteConversation wiped the row, or the lease expired and another
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

-- Live-context watermark for /reset. A row means "replay only turns with
-- id > reset_turn_id in this conversation's live history window". The turns
-- themselves are NEVER deleted — /reset draws a line, it does not destroy the
-- record, so retrieval, the turn index, and durable-fact extraction keep
-- seeing the full history. Monotonic: the watermark only ever
-- rises, so a reset can't un-hide turns an earlier reset already hid.
CREATE TABLE IF NOT EXISTS conversation_reset (
  persona       TEXT NOT NULL,
  conversation  TEXT NOT NULL,
  reset_turn_id INTEGER NOT NULL DEFAULT 0,
  updated_at    TEXT NOT NULL,
  PRIMARY KEY (persona, conversation)
);
`;

interface RawDisplayRow {
  id: number;
  persona: string;
  conversation: string;
  role: Role;
  text: string;
  created_at: string;
  embeddable: number;
  source: string;
  origin: string;
}

class SqliteMemoryStore implements MemoryStore {
  /** Set by openMemoryStore; see MemoryStore.dbPath. */
  dbPath?: string;
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
  private touchDurableFactsBase: string;
  private pruneDurableFactsStmt;
  private claimEvictedSelectStmt;
  private upsertPendingStmt;
  private getPendingTokenStmt;
  private commitPendingStmt;
  private releasePendingStmt;
  private deleteDurableFactCursorStmt;
  private deleteDurableFactPendingStmt;
  private claimEvictedTxn;
  private commitExtractionTxn;
  private deleteConversationTxn;
  private maxTurnIdStmt;
  private getResetWatermarkStmt;
  private countTurnsAboveWatermarkStmt;
  private upsertResetWatermarkStmt;
  private resetConversationContextTxn;
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
    // Idempotent migration: add turns.source (provenance tier). Existing user
    // turns were the principal and assistant turns were the persona itself, so
    // backfill assistant → 'self' and leave the rest at the 'principal' default.
    const hasTurnSource = (
      db.query("PRAGMA table_info(turns)").all() as Array<{ name: string }>
    ).some((c) => c.name === "source");
    if (!hasTurnSource) {
      db.exec(
        "ALTER TABLE turns ADD COLUMN source TEXT NOT NULL DEFAULT 'principal'",
      );
      db.exec("UPDATE turns SET source = 'self' WHERE role = 'assistant'");
    }
    // Idempotent migration: add turns.origin (origin axis — see Turn.origin).
    // Existing rows default to 'channel'. Two deterministic retro-tags are
    // applied, both keyed on markers the writers emit verbatim rather than on
    // any fuzzy guess:
    //   - notify.ts prefixes every persisted notification with
    //     "[notification] ", so an assistant row with that exact prefix is a
    //     notification and nothing else can be.
    //   - tick task wakes run in a conversation keyed "tick:<id>"; heartbeat
    //     and nightly run under "system:<...>".
    // Anything unmatched stays 'channel', which is the pre-column behaviour.
    const hasTurnOrigin = (
      db.query("PRAGMA table_info(turns)").all() as Array<{ name: string }>
    ).some((c) => c.name === "origin");
    if (!hasTurnOrigin) {
      db.exec(
        "ALTER TABLE turns ADD COLUMN origin TEXT NOT NULL DEFAULT 'channel'",
      );
      db.exec("UPDATE turns SET origin = 'task' WHERE conversation LIKE 'tick:%'");
      db.exec(
        "UPDATE turns SET origin = 'internal' WHERE conversation LIKE 'system:%'",
      );
      db.exec(
        "UPDATE turns SET origin = 'notification' " +
          "WHERE role = 'assistant' AND text LIKE '[notification] %'",
      );
    }
    // Migration: re-scope durable_facts from (persona, conversation) to
    // (persona) + add the `source` provenance column. Changing a UNIQUE
    // constraint needs a table rebuild in SQLite, so we detect the pre-PR shape
    // by the absent `source` column and rebuild in one transaction: collapse
    // duplicate (persona, fact_norm) rows keeping MAX(confidence) + latest
    // last_seen_at, stamp legacy rows 'principal' (they predate provenance), and
    // swap in the persona-wide unique + rank index. A fresh DB already got the
    // new shape from SCHEMA above, so `source` is present and this is skipped.
    const durableFactsExists = (
      db
        .query(
          "SELECT name FROM sqlite_master WHERE type='table' AND name='durable_facts'",
        )
        .all() as Array<{ name: string }>
    ).length > 0;
    const hasFactSource =
      durableFactsExists &&
      (
        db.query("PRAGMA table_info(durable_facts)").all() as Array<{
          name: string;
        }>
      ).some((c) => c.name === "source");
    if (durableFactsExists && !hasFactSource) {
      db.transaction(() => {
        db.exec(`
          CREATE TABLE durable_facts_new (
            id             INTEGER PRIMARY KEY AUTOINCREMENT,
            persona        TEXT NOT NULL,
            conversation   TEXT NOT NULL,
            fact           TEXT NOT NULL,
            fact_norm      TEXT NOT NULL,
            confidence     REAL NOT NULL DEFAULT 0.5,
            source         TEXT NOT NULL DEFAULT 'principal',
            source_turn_id INTEGER,
            created_at     TEXT NOT NULL,
            last_seen_at   TEXT NOT NULL,
            UNIQUE (persona, fact_norm)
          );
          INSERT INTO durable_facts_new
            (persona, conversation, fact, fact_norm, confidence, source,
             source_turn_id, created_at, last_seen_at)
          SELECT persona, MIN(conversation), MIN(fact), fact_norm,
                 MAX(confidence), 'principal', MIN(source_turn_id),
                 MIN(created_at), MAX(last_seen_at)
          FROM durable_facts
          GROUP BY persona, fact_norm;
          DROP TABLE durable_facts;
          ALTER TABLE durable_facts_new RENAME TO durable_facts;
          CREATE INDEX IF NOT EXISTS idx_durable_facts_rank
            ON durable_facts (persona, confidence DESC, last_seen_at DESC);
        `);
      })();
    }
    this.appendStmt = db.prepare(
      "INSERT INTO turns (persona, conversation, role, text, created_at, embeddable, source, origin) " +
        "VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    );
    // Inner query gets most-recent-N descending; outer flips back to chronological.
    // The live-history window, floored at the /reset watermark: turns at or
    // below it stay in the DB (and in the index, and in durable facts) but are
    // no longer replayed into the prompt. COALESCE covers the common case of a
    // conversation that has never been reset (no row → 0 → everything shows).
    this.recentStmt = db.prepare(
      `SELECT role, text FROM (
         SELECT id, role, text, created_at
         FROM turns
         WHERE persona = ? AND conversation = ?
           AND id > COALESCE((SELECT reset_turn_id FROM conversation_reset
                              WHERE persona = ? AND conversation = ?), 0)
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
           -- Correlated (not bound): this spans MANY sibling conversations,
           -- each with its own watermark. Without it, a sibling that was
           -- /reset would leak its pre-reset turns back in through the
           -- cross-conversation briefing window.
           AND id > COALESCE((SELECT r.reset_turn_id FROM conversation_reset r
                              WHERE r.persona = turns.persona
                                AND r.conversation = turns.conversation), 0)
         ORDER BY created_at DESC, id DESC
         LIMIT ?
       ) ORDER BY created_at ASC, id ASC`,
    );
    this.recentDisplayStmt = db.prepare(
      `SELECT id, persona, conversation, role, text, created_at, embeddable, source, origin FROM (
         SELECT id, persona, conversation, role, text, created_at, embeddable, source, origin
         FROM turns
         WHERE persona = ?
         ORDER BY created_at DESC, id DESC
         LIMIT ?
       ) ORDER BY created_at ASC, id ASC`,
    );
    this.turnsAfterIdStmt = db.prepare(
      `SELECT id, persona, conversation, role, text, created_at, embeddable, source, origin
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
      `SELECT id, persona, conversation, role, text, created_at, embeddable, source, origin
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
    // Upsert on the PERSONA-WIDE (persona, fact_norm) de-dupe key: a restated
    // fact keeps the higher confidence, refreshes recency + origin refs, and is
    // PROMOTED to the higher-trust source. The source CASE compares numeric
    // priorities (principal 3 > self 2 > other 1) so a principal restating a
    // fact the persona first observed itself upgrades it to principal trust,
    // but a later `other`/`self` mention never downgrades a principal fact.
    this.upsertDurableFactStmt = db.prepare(
      `INSERT INTO durable_facts
         (persona, conversation, fact, fact_norm, confidence, source, source_turn_id, created_at, last_seen_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (persona, fact_norm) DO UPDATE SET
         confidence     = MAX(confidence, excluded.confidence),
         last_seen_at   = excluded.last_seen_at,
         source_turn_id = excluded.source_turn_id,
         conversation   = excluded.conversation,
         source = CASE
           WHEN (CASE excluded.source WHEN 'principal' THEN 3 WHEN 'self' THEN 2 WHEN 'other' THEN 1 ELSE 0 END)
              >  (CASE source          WHEN 'principal' THEN 3 WHEN 'self' THEN 2 WHEN 'other' THEN 1 ELSE 0 END)
           THEN excluded.source ELSE source END`,
    );
    // Persona-wide candidate pull (no conversation filter). Returns the raw
    // pool; decay/weight ranking + final top-N happen in durableFacts.ts.
    this.topDurableFactsStmt = db.prepare(
      `SELECT id, persona, conversation, fact, confidence, source, source_turn_id,
              created_at, last_seen_at
       FROM durable_facts
       WHERE persona = ? AND confidence >= ?
       ORDER BY confidence DESC, last_seen_at DESC, id DESC
       LIMIT ?`,
    );
    this.countDurableFactsStmt = db.prepare(
      `SELECT COUNT(*) AS n FROM durable_facts WHERE persona = ?`,
    );
    // Recall bump: refresh last_seen_at for a set of injected facts. The id list
    // is interpolated (ints only, built internally) rather than bound.
    this.touchDurableFactsBase =
      `UPDATE durable_facts SET last_seen_at = ? WHERE persona IS NOT NULL AND id IN`;
    // Retirement floor prune: delete facts whose last_seen_at predates their
    // source tier's cutoff. One statement, three (source, cutoff) pairs bound.
    this.pruneDurableFactsStmt = db.prepare(
      `DELETE FROM durable_facts
       WHERE persona = ?
         AND ( (source = 'principal'  AND last_seen_at < ?)
            OR (source = 'self'       AND last_seen_at < ?)
            OR (source = 'other'      AND last_seen_at < ?)
            OR (source = 'unverified' AND last_seen_at < ?) )`,
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
      `SELECT t.id, t.persona, t.conversation, t.role, t.text, t.created_at, t.embeddable, t.source
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
    // Gating on the token means a row wiped by a conversation delete (gone) or re-stamped by a
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
    // Hard-delete helpers — the per-conversation extractor state wiped
    // alongside turns in deleteConversationTxn. NOTE: durable_facts are NO
    // LONGER wiped here. They are persona-wide shared knowledge now, not
    // conversation-owned, so deleting one conversation must not destroy facts
    // other conversations rely on. Only the conversation's turns, extractor
    // cursor, and in-flight leases are cleared.
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
            asFactSource(f.source),
            f.sourceTurnId ?? null,
            now,
            now,
          );
        }
        this.commitPendingStmt.run(persona, conversation, turnId, token);
        return true;
      },
    );
    // Hard delete: wipes the conversation's turns and its per-conversation
    // extractor state (cursor + in-flight leases) in one transaction. This is
    // NOT the /reset path — /reset only advances the reset watermark. Facts are
    // deliberately NOT wiped: they are persona-wide shared knowledge now, not
    // conversation-owned, so resetting one conversation must not delete facts
    // other conversations depend on (the whole point of persona-scoping).
    this.deleteConversationTxn = db.transaction(
      (persona: string, conversation: string): number => {
        const turns = this.deleteStmt.run(persona, conversation).changes;
        this.deleteDurableFactCursorStmt.run(persona, conversation);
        this.deleteDurableFactPendingStmt.run(persona, conversation);
        return turns;
      },
    );
    this.maxTurnIdStmt = db.prepare(
      "SELECT COALESCE(MAX(id), 0) AS maxId FROM turns WHERE persona = ? AND conversation = ?",
    );
    this.getResetWatermarkStmt = db.prepare(
      "SELECT reset_turn_id AS mark FROM conversation_reset WHERE persona = ? AND conversation = ?",
    );
    this.countTurnsAboveWatermarkStmt = db.prepare(
      "SELECT COUNT(*) AS n FROM turns WHERE persona = ? AND conversation = ? AND id > ?",
    );
    // MAX(existing, new) keeps the watermark monotonic. Belt-and-braces: the
    // txn already refuses to lower it, but a concurrent writer that inserted
    // turns between our read and write must not be able to rewind it either.
    this.upsertResetWatermarkStmt = db.prepare(
      `INSERT INTO conversation_reset (persona, conversation, reset_turn_id, updated_at)
       VALUES (?, ?, ?, ?)
       ON CONFLICT (persona, conversation) DO UPDATE SET
         reset_turn_id = MAX(conversation_reset.reset_turn_id, excluded.reset_turn_id),
         updated_at    = excluded.updated_at`,
    );
    // Non-destructive /reset. Deliberately touches NOTHING but the watermark:
    // no turn deletes, no index deletes, and the durable-fact cursor/leases
    // are left alone precisely BECAUSE the turns survive — wiping the cursor
    // here would re-extract the entire history from the top on the next pass.
    this.resetConversationContextTxn = db.transaction(
      (persona: string, conversation: string, ts: string): number => {
        const prev =
          (
            this.getResetWatermarkStmt.get(persona, conversation) as
              | { mark: number }
              | undefined
          )?.mark ?? 0;
        const max =
          (
            this.maxTurnIdStmt.get(persona, conversation) as {
              maxId: number;
            }
          ).maxId;
        const hidden = (
          this.countTurnsAboveWatermarkStmt.get(
            persona,
            conversation,
            prev,
          ) as { n: number }
        ).n;
        this.upsertResetWatermarkStmt.run(
          persona,
          conversation,
          Math.max(prev, max),
          ts,
        );
        return hidden;
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
          defaultTurnSource(u),
          u.origin ?? "channel",
        );
        this.appendStmt.run(
          a.persona,
          a.conversation,
          a.role,
          a.text,
          ts,
          embeddableInt(a.embeddable),
          defaultTurnSource(a),
          a.origin ?? "channel",
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
      defaultTurnSource(t),
      t.origin ?? "channel",
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
    return this.recentStmt.all(
      persona,
      conversation,
      persona,
      conversation,
      n,
    ) as Array<{
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
      asFactSource(input.source),
      input.sourceTurnId ?? null,
      now,
      now,
    );
  }

  async topDurableFacts(
    persona: string,
    opts: TopDurableFactsOptions,
  ): Promise<DurableFact[]> {
    const rows = this.topDurableFactsStmt.all(
      persona,
      opts.minConfidence ?? 0,
      Math.max(1, Math.floor(opts.limit)),
    ) as RawDurableFactRow[];
    return rows.map(mapDurableFactRow);
  }

  async countDurableFacts(persona: string): Promise<number> {
    const row = this.countDurableFactsStmt.get(persona) as { n: number };
    return row.n;
  }

  async touchDurableFacts(ids: number[]): Promise<void> {
    const clean = ids
      .filter((n) => Number.isFinite(n))
      .map((n) => Math.floor(n));
    if (clean.length === 0) return;
    // Ints are validated above, so interpolating them into the IN list is safe
    // (bun:sqlite can't bind a variable-length list directly).
    const placeholders = clean.join(", ");
    this.db
      .prepare(`${this.touchDurableFactsBase} (${placeholders})`)
      .run(new Date().toISOString());
  }

  async pruneExpiredDurableFacts(
    persona: string,
    cutoffs: FactPruneCutoffs,
  ): Promise<number> {
    const res = this.pruneDurableFactsStmt.run(
      persona,
      cutoffs.principal,
      cutoffs.self,
      cutoffs.other,
      cutoffs.unverified,
    );
    return res.changes;
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
    // Wipes turns plus the conversation's extractor cursor and in-flight
    // leases in one transaction; persona-wide durable facts survive. Returns
    // the turn count. Not called by /reset — see resetConversationContext.
    return this.deleteConversationTxn(persona, conversation) as number;
  }

  async resetConversationContext(
    persona: string,
    conversation: string,
  ): Promise<number> {
    return this.resetConversationContextTxn(
      persona,
      conversation,
      new Date().toISOString(),
    ) as number;
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
 * Resolve a turn's stored provenance source. An explicit `source` wins;
 * otherwise default by role — assistant turns are the persona's own UNCONFIRMED
 * voice (`unverified`: the harness reply may carry untrusted tool-ingested bytes
 * we can't separate at this layer, so it is never first-hand `self` until the
 * principal engages), user turns default to `principal` (the pre-provenance
 * behaviour). Callers that know the trust bit (orchestrator/turn.ts) pass
 * `source` explicitly so a group third-party lands as `other`. Fail-closed: a
 * caller that forgets to stamp an assistant turn gets `unverified`, never `self`.
 */
function defaultTurnSource(t: AppendTurnInput): FactSource {
  if (t.source) return t.source;
  return t.role === "assistant" ? "unverified" : "principal";
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
  source: string;
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
    source: asFactSource(r.source),
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
    source: asFactSource(r.source),
    origin: asTurnOrigin(r.origin),
  }));
}

/**
 * Switch a database to WAL journal mode, retrying on SQLITE_BUSY.
 *
 * Converting a rollback-journal DB to WAL needs a momentary EXCLUSIVE lock,
 * and SQLite does NOT invoke the busy handler for that conversion — so
 * `busy_timeout` cannot wait it out. Empirically, if any other connection
 * holds a write lock at that instant, the switch throws SQLITE_BUSY in 0ms
 * regardless of the configured timeout. This bites a fresh install whose
 * scheduler fires two processes at once (e.g. a Windows phantom's `run` and
 * `tick` tasks aligned on boot) against a brand-new memory.sqlite: one wins
 * the conversion, the other throws and crash-loops the daemon.
 *
 * Exported so the drawer connection (`memory/drawerSync.ts`) opens the shared
 * file with the SAME pragma sequence rather than a second, subtly different
 * copy of it — on a fresh install either connection may be the one that
 * creates the database.
 *
 * So we retry on our own deadline instead of relying on busy_timeout. Once
 * the file is in WAL mode (the steady state after first boot) this pragma is
 * a lock-free no-op and the first attempt returns immediately, even while
 * another process holds a write lock.
 */
export async function enableWalMode(db: Database, deadlineMs = 5000): Promise<void> {
  const deadline = Date.now() + deadlineMs;
  for (;;) {
    try {
      db.exec("PRAGMA journal_mode = WAL");
      return;
    } catch (err) {
      const busy = (err as { code?: string } | null)?.code === "SQLITE_BUSY";
      if (!busy || Date.now() >= deadline) throw err;
      await Bun.sleep(50);
    }
  }
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
  //
  // Set busy_timeout FIRST so every statement below — schema DDL, the
  // idempotent migrations, and normal writes — is covered. The WAL switch
  // is the one thing busy_timeout can't protect (see enableWalMode), so it
  // gets its own retry loop.
  db.exec("PRAGMA busy_timeout = 5000");
  await enableWalMode(db);
  db.exec("PRAGMA foreign_keys = ON");
  const store = new SqliteMemoryStore(db);
  store.dbPath = path;
  return store;
}
