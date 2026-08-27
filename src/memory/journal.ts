/**
 * The daily journal as ROWS — issue #461.
 *
 * The journal was the last markdown blob in the memory system, and the only
 * part of the prompt that grew monotonically through the day: every turn
 * injected the whole of today's file, verbatim, capped at 32KB by a tripwire
 * (#426) that existed because nothing selected, nothing deduped and nothing
 * decayed. Measured on a heavy day: 17.6KB of journal in an ~80KB prompt, and
 * 41% of that journal was literal duplication, because
 * `memory capture --tag decision --tag lesson` wrote the SAME paragraph once
 * per tag and both copies were injected on every turn.
 *
 * This is the treatment the five drawers already got in #417/#418, applied to
 * the one table that never received it. Four properties the file cannot have:
 *
 *   1. ONE ROW PER CAPTURE, NOT ONE PER TAG. Tags are a COLUMN. The multi-tag
 *      duplication disappears structurally rather than by asking a writer to
 *      behave — and the markdown ingest collapses the existing copies on the
 *      way in, because two lines that differ only in their `[tag]` marker
 *      normalize to the same `content_norm`.
 *   2. RECALL SELECTS INSTEAD OF DUMPING. `selectForRecall` fills a byte
 *      BUDGET newest-first and returns the kept rows in chronological order.
 *      The prompt stops scaling with how busy the day was, which is what makes
 *      the E2BIG cap stop being load-bearing.
 *   3. DEDUPE ON WRITE. `UNIQUE (persona, date, content_norm)` makes a
 *      repeated capture a no-op — same contract as `drawerEntryId`. Two turns
 *      that learn the same lesson file one row, and the second one merely
 *      unions its tags in.
 *   4. MECHANICAL WRITERS ARE SEPARABLE. Task commitments ("task 577 fires at
 *      …") are machine rows. As `source='task'` they can be summarised as a
 *      count instead of being injected as prose the model reads as its own
 *      reasoning. They are still stored, still exported, still searchable.
 *
 * NOTHING IS DELETED. Ingest is one-way and idempotent (ids are content
 * derived), closed days keep their original markdown on disk untouched, and
 * `renderDay` can write any day back out as markdown for a human.
 */

import { createHash } from "node:crypto";
import type { Database } from "bun:sqlite";

import { normalizeFact } from "./store.ts";

/**
 * Where a journal row came from. This is an ORIGIN axis, not a trust tier —
 * the same distinction `turns.origin` draws, and for the same reason: a row
 * the scheduler wrote about itself must be separable at recall time from a
 * line the persona chose to write.
 *
 *   self      — a `memory capture` or an agent write. The default.
 *   heartbeat — a mechanical maintenance note (drawer import log, etc).
 *   task      — the scheduler talking about the scheduler.
 *   channel   — written on behalf of a chat surface.
 */
export const JOURNAL_SOURCES = ["self", "heartbeat", "task", "channel"] as const;

export type JournalSource = (typeof JOURNAL_SOURCES)[number];

export function asJournalSource(v: unknown): JournalSource {
  return (JOURNAL_SOURCES as readonly string[]).includes(v as string)
    ? (v as JournalSource)
    : "self";
}

export interface JournalEntry {
  id: string;
  persona: string;
  /** UTC day this entry belongs to, `YYYY-MM-DD`. */
  date: string;
  content: string;
  /** Tag set, already lowercased and de-duplicated. May be empty. */
  tags: string[];
  source: JournalSource;
  conversation?: string;
  createdAt: Date;
}

export interface AppendJournalInput {
  persona: string;
  date: string;
  content: string;
  tags?: string[];
  source?: JournalSource;
  conversation?: string;
  /** Defaults to now. Set explicitly when ingesting a dated markdown line. */
  createdAt?: Date;
}

export const JOURNAL_SCHEMA = `
CREATE TABLE IF NOT EXISTS journal_entries (
  -- sha256(persona, date, content_norm), first 16 hex. Content-derived, so a
  -- re-ingest of the same markdown is free and an append is idempotent.
  id            TEXT PRIMARY KEY,
  persona       TEXT NOT NULL,
  date          TEXT NOT NULL,
  content       TEXT NOT NULL,
  -- De-dupe key: normalizeFact(content), the same normalizer the drawers and
  -- the durable-fact pool use. Two restatements differing only in whitespace,
  -- case or trailing punctuation collide here instead of both being stored.
  content_norm  TEXT NOT NULL,
  -- Comma-separated tag SET (e.g. 'decision,lesson'). A COLUMN, not a copy:
  -- this is the field whose absence made a two-tag capture write two rows.
  tags          TEXT NOT NULL DEFAULT '',
  source        TEXT NOT NULL DEFAULT 'self',
  conversation  TEXT,
  created_at    TEXT NOT NULL,
  UNIQUE (persona, date, content_norm)
);
CREATE INDEX IF NOT EXISTS idx_journal_entries_day
  ON journal_entries (persona, date, created_at);
CREATE INDEX IF NOT EXISTS idx_journal_entries_tagged
  ON journal_entries (persona, date, tags);

-- One row per day that has been RENDERED to markdown and verified.
--
-- The rows are the write path; the markdown is a derived artefact the nightly
-- produces once the day is closed. This table is the handshake between them,
-- and it exists so that pruning a day's rows is conditional on evidence that
-- the artefact actually landed — not on the clock. fingerprint is a hash of
-- the markdown as READ BACK FROM DISK, so a truncated write, a full disk or a
-- read-only mount leaves the day unverified and its rows intact.
CREATE TABLE IF NOT EXISTS journal_days (
  persona     TEXT NOT NULL,
  date        TEXT NOT NULL,
  rendered_at TEXT NOT NULL,
  fingerprint TEXT NOT NULL,
  entry_count INTEGER NOT NULL,
  -- NULL until the rows are dropped. Set on the NEXT successful nightly after
  -- the render verified, so there is always at least one full day where the
  -- content exists in both places.
  pruned_at   TEXT,
  PRIMARY KEY (persona, date)
);
`;

export function ensureJournalSchema(db: Database): void {
  db.exec(JOURNAL_SCHEMA);
}

/** Stable row id — sha256 over persona, date and NORMALIZED content. */
export function journalEntryId(
  persona: string,
  date: string,
  content: string,
): string {
  return createHash("sha256")
    .update(`${persona}\0${date}\0${normalizeFact(content)}`)
    .digest("hex")
    .slice(0, 16);
}

/** Lowercase, de-duplicate and order a tag list so the column is canonical. */
export function normalizeTags(tags: readonly string[] | undefined): string[] {
  if (!tags) return [];
  const seen = new Set<string>();
  for (const t of tags) {
    const v = t.trim().toLowerCase();
    if (v) seen.add(v);
  }
  return [...seen].sort();
}

interface RawJournalRow {
  id: string;
  persona: string;
  date: string;
  content: string;
  tags: string;
  source: string;
  conversation: string | null;
  created_at: string;
}

function mapRow(r: RawJournalRow): JournalEntry {
  return {
    id: r.id,
    persona: r.persona,
    date: r.date,
    content: r.content,
    tags: r.tags ? r.tags.split(",").filter(Boolean) : [],
    source: asJournalSource(r.source),
    conversation: r.conversation ?? undefined,
    createdAt: new Date(r.created_at),
  };
}

export interface AppendOutcome {
  entry: JournalEntry;
  /** True when this call created the row; false when it merged into one. */
  inserted: boolean;
}

/** True for the `UNIQUE (persona, date, content_norm)` collision. */
function isUniqueViolation(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return msg.includes("UNIQUE constraint failed");
}

export class JournalStore {
  private readonly inWriteTx: <T>(fn: () => T) => T;

  constructor(private db: Database) {
    ensureJournalSchema(db);
    const tx = db.transaction((fn: () => unknown) => fn());
    this.inWriteTx = ((fn: () => unknown) => tx.immediate(fn)) as <T>(
      fn: () => T,
    ) => T;
  }

  /**
   * Append an entry, or MERGE into the one already there.
   *
   * The merge path is the point. Tags UNION (a `--tag decision --tag lesson`
   * capture is one row carrying both, and a later `--tag norm` on the same
   * text adds a third rather than writing a fourth copy), and `created_at`
   * only ever moves BACKWARD to the earliest sighting — the journal is a
   * record of when something was first written down, so a re-capture must not
   * make an 08:00 note look like a 17:00 one and reorder the day.
   *
   * Concurrency: read-then-write is a TOCTOU under the concurrent turns this
   * runtime allows (#391), so the whole thing runs in one IMMEDIATE
   * transaction, and a UNIQUE collision from another connection retries onto
   * the merge path instead of being thrown at the caller.
   */
  append(input: AppendJournalInput): AppendOutcome {
    const id = journalEntryId(input.persona, input.date, input.content);
    try {
      return this.inWriteTx(() => this.appendNow(id, input));
    } catch (err) {
      if (!isUniqueViolation(err)) throw err;
      return this.inWriteTx(() => this.appendNow(id, input));
    }
  }

  private appendNow(id: string, input: AppendJournalInput): AppendOutcome {
    const createdAt = input.createdAt ?? new Date();
    const tags = normalizeTags(input.tags);
    const existing = this.get(id);
    if (existing) {
      const merged = normalizeTags([...existing.tags, ...tags]);
      const earliest =
        createdAt < existing.createdAt ? createdAt : existing.createdAt;
      this.db
        .query(
          `UPDATE journal_entries
              SET tags = ?, created_at = ?, conversation = COALESCE(conversation, ?)
            WHERE id = ?`,
        )
        .run(
          merged.join(","),
          earliest.toISOString(),
          input.conversation ?? null,
          id,
        );
      return { entry: this.get(id)!, inserted: false };
    }
    this.db
      .query(
        `INSERT INTO journal_entries
           (id, persona, date, content, content_norm, tags, source, conversation, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        input.persona,
        input.date,
        input.content,
        normalizeFact(input.content),
        tags.join(","),
        input.source ?? "self",
        input.conversation ?? null,
        createdAt.toISOString(),
      );
    return { entry: this.get(id)!, inserted: true };
  }

  get(id: string): JournalEntry | undefined {
    const row = this.db
      .query("SELECT * FROM journal_entries WHERE id = ?")
      .get(id) as RawJournalRow | null;
    return row ? mapRow(row) : undefined;
  }

  /** Every entry for one day, oldest first. */
  listDay(persona: string, date: string): JournalEntry[] {
    const rows = this.db
      .query(
        `SELECT * FROM journal_entries
          WHERE persona = ? AND date = ?
          ORDER BY created_at ASC, id ASC`,
      )
      .all(persona, date) as RawJournalRow[];
    return rows.map(mapRow);
  }

  /** Days that have at least one row, newest first. */
  dates(persona: string): string[] {
    const rows = this.db
      .query(
        `SELECT DISTINCT date FROM journal_entries
          WHERE persona = ? ORDER BY date DESC`,
      )
      .all(persona) as Array<{ date: string }>;
    return rows.map((r) => r.date);
  }

  countDay(persona: string, date: string): number {
    const row = this.db
      .query(
        "SELECT COUNT(*) AS n FROM journal_entries WHERE persona = ? AND date = ?",
      )
      .get(persona, date) as { n: number };
    return row.n;
  }

  /** Today's tagged rows — what the heartbeat promotes into the drawers. */
  taggedForDay(persona: string, date: string): JournalEntry[] {
    const rows = this.db
      .query(
        `SELECT * FROM journal_entries
          WHERE persona = ? AND date = ? AND tags <> ''
          ORDER BY created_at ASC, id ASC`,
      )
      .all(persona, date) as RawJournalRow[];
    return rows.map(mapRow);
  }

  // ---------------------------------------------------------------------
  // Day lifecycle: rows -> verified markdown -> pruned rows.
  //
  // The invariant this half enforces is that a day's rows are only ever
  // dropped once its markdown has been written AND read back AND matched,
  // and then only on a LATER nightly than the one that rendered it. A
  // nightly that never runs, runs half-way, or writes to a full disk costs
  // disk space in `journal_entries` — never content.
  // ---------------------------------------------------------------------

  /** Record a verified render. Idempotent; re-rendering updates in place. */
  markRendered(
    persona: string,
    date: string,
    fingerprint: string,
    entryCount: number,
    now = new Date(),
  ): void {
    this.db
      .query(
        `INSERT INTO journal_days (persona, date, rendered_at, fingerprint, entry_count)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT (persona, date) DO UPDATE SET
           rendered_at = excluded.rendered_at,
           fingerprint = excluded.fingerprint,
           entry_count = excluded.entry_count,
           -- A re-render un-prunes: the day is live again until the next
           -- nightly re-confirms it.
           pruned_at   = NULL`,
      )
      .run(persona, date, now.toISOString(), fingerprint, entryCount);
  }

  dayRecord(persona: string, date: string): JournalDayRecord | undefined {
    const row = this.db
      .query("SELECT * FROM journal_days WHERE persona = ? AND date = ?")
      .get(persona, date) as RawJournalDayRow | null;
    return row ? mapDayRow(row) : undefined;
  }

  /** Forget a render record — used when its artefact no longer verifies. */
  clearDayRecord(persona: string, date: string): void {
    this.db
      .query("DELETE FROM journal_days WHERE persona = ? AND date = ?")
      .run(persona, date);
  }

  /**
   * Closed days holding rows that have never been verified as markdown,
   * oldest first.
   *
   * Keyed on DATE, not on "since the last run": a nightly that has not fired
   * for three days finds three dates here and renders three correct daily
   * files, rather than one merged blob or a duplicate of today. TODAY is
   * excluded by construction — it is still being appended to, so any render
   * of it would fail its own fingerprint on the next capture.
   */
  unrenderedDates(persona: string, today: string): string[] {
    const rows = this.db
      .query(
        `SELECT DISTINCT e.date AS date
           FROM journal_entries e
           LEFT JOIN journal_days d
             ON d.persona = e.persona AND d.date = e.date
          WHERE e.persona = ? AND e.date < ? AND d.date IS NULL
          ORDER BY e.date ASC`,
      )
      .all(persona, today) as Array<{ date: string }>;
    return rows.map((r) => r.date);
  }

  /**
   * Days whose render verified on an EARLIER day than `today` and whose rows
   * are still present — the prune candidates.
   *
   * The `rendered_at < today` clause is the retention overlap. Pruning in the
   * same pass that rendered would mean a nightly which renders and then dies
   * before its own artefact is confirmed by a second, independent run takes
   * the rows with it.
   */
  prunableDates(persona: string, today: string): string[] {
    const rows = this.db
      .query(
        `SELECT DISTINCT d.date AS date
           FROM journal_days d
           JOIN journal_entries e
             ON e.persona = d.persona AND e.date = d.date
          WHERE d.persona = ? AND d.pruned_at IS NULL
            AND substr(d.rendered_at, 1, 10) < ?
          ORDER BY d.date ASC`,
      )
      .all(persona, today) as Array<{ date: string }>;
    return rows.map((r) => r.date);
  }

  /** Drop one day's rows and stamp the day pruned. */
  pruneDay(persona: string, date: string, now = new Date()): number {
    return this.inWriteTx(() => {
      const n = this.countDay(persona, date);
      this.db
        .query("DELETE FROM journal_entries WHERE persona = ? AND date = ?")
        .run(persona, date);
      this.db
        .query(
          "UPDATE journal_days SET pruned_at = ? WHERE persona = ? AND date = ?",
        )
        .run(now.toISOString(), persona, date);
      return n;
    });
  }
}

export interface JournalDayRecord {
  persona: string;
  date: string;
  renderedAt: Date;
  fingerprint: string;
  entryCount: number;
  prunedAt?: Date;
}

interface RawJournalDayRow {
  persona: string;
  date: string;
  rendered_at: string;
  fingerprint: string;
  entry_count: number;
  pruned_at: string | null;
}

function mapDayRow(r: RawJournalDayRow): JournalDayRecord {
  return {
    persona: r.persona,
    date: r.date,
    renderedAt: new Date(r.rendered_at),
    fingerprint: r.fingerprint,
    entryCount: r.entry_count,
    prunedAt: r.pruned_at ? new Date(r.pruned_at) : undefined,
  };
}

/**
 * Hash of a day's markdown.
 *
 * Deliberately computed over the RENDERED TEXT rather than over the rows: the
 * question the nightly has to answer before it drops anything is "is the
 * artefact on disk the artefact I meant to write", and only the text can
 * answer that. Hashing the rows would verify the renderer against itself.
 */
export function dayFingerprint(text: string): string {
  return createHash("sha256").update(text).digest("hex").slice(0, 32);
}

export interface RecallSelection {
  /** Kept rows, chronological — the order a journal is read in. */
  entries: JournalEntry[];
  /** Rows dropped because the budget ran out (oldest first). */
  droppedForBudget: number;
  /**
   * Of `droppedForBudget`, how many were dropped because ONE row is bigger
   * than the whole budget. Counted apart because the remedy is different: a
   * normal drop means the day was busy, an oversized drop means a single
   * capture needs `memory search` (or splitting) and no amount of quiet day
   * will bring it back.
   */
  droppedOversize: number;
  /** Rows withheld because they are machine chatter (`source: 'task'`). */
  withheldMechanical: number;
  /** Byte size of the kept entries as rendered. */
  bytes: number;
}

export interface RecallOptions {
  /**
   * Drop `source: 'task'` rows from the injected block and report them as a
   * count instead. On by default: scheduler bookkeeping is the persona
   * talking to itself about its own plumbing, and injected inline it reads as
   * established fact. It stays in the table and in the export.
   */
  includeMechanical?: boolean;
}

/**
 * Fill a byte budget from one day's rows.
 *
 * Two orderings are in play and they are not the same one:
 *
 *   PRIORITY decides what is dropped when the budget runs out. Not age alone
 *   — CLASS first, then age. A tagged capture (`decision`, `lesson`,
 *   `commitment`, `person`, `norm`) is something the persona deliberately
 *   wrote down for later; untagged narration is what it happened to say while
 *   doing the work. When a day overflows, the chatter goes and the decisions
 *   stay. The old byte-slice on the file did the exact opposite: it cut from
 *   the FRONT, so the first casualty was the morning's tagged captures.
 *
 *   READ order is chronological, always. A journal read out of order is a
 *   different document.
 *
 * Overflow is not loss. Every row remains in the table and in the index, so a
 * dropped entry is one `memory search` away — which is why the caller is
 * expected to SAY it dropped some. Truncation the model cannot see reads as
 * absence, and absence is what makes it re-derive what it already knew.
 *
 * The budget is a HARD bound, including against a single row bigger than the
 * whole of it. Nothing caps the length of one `memory capture`, so one pasted
 * log is enough; letting the highest-priority row through unmeasured would
 * make the budget advisory and hand back exactly the unbounded prompt this
 * table exists to bound. An oversized row is skipped, counted separately, and
 * left to `memory search` — the one case where a day can legitimately come
 * back with no entries at all, which the caller must report rather than
 * mistake for an empty day.
 */
export function selectForRecall(
  entries: readonly JournalEntry[],
  budgetBytes: number,
  opts: RecallOptions = {},
): RecallSelection {
  const eligible = opts.includeMechanical
    ? [...entries]
    : entries.filter((e) => e.source !== "task");
  const withheldMechanical = entries.length - eligible.length;

  // Newest first within each class; tagged class considered first.
  const byPriority = [
    ...eligible.filter((e) => e.tags.length > 0).reverse(),
    ...eligible.filter((e) => e.tags.length === 0).reverse(),
  ];

  const kept: JournalEntry[] = [];
  let bytes = 0;
  let droppedOversize = 0;
  for (const e of byPriority) {
    const size = Buffer.byteLength(renderEntry(e), "utf8") + 1;
    if (size > budgetBytes) {
      // One row bigger than the entire budget. It can never be kept without
      // making the budget a suggestion, and `memory capture` caps nothing —
      // a single pasted log or stack trace is enough. Keeping it "because
      // something is better than nothing" is how the bounded prompt this
      // whole change exists to guarantee turns back into an unbounded one,
      // and an unbounded prompt is the spawn-size failure, not a big read.
      droppedOversize++;
      continue;
    }
    if (bytes + size > budgetBytes) {
      // Keep walking: a later, smaller entry may still fit where this one
      // did not. Skipping the rest would drop a 40-byte decision because a
      // 4KB narration happened to come first.
      continue;
    }
    kept.push(e);
    bytes += size;
  }
  kept.sort(
    (a, b) =>
      a.createdAt.getTime() - b.createdAt.getTime() || a.id.localeCompare(b.id),
  );
  return {
    entries: kept,
    droppedForBudget: eligible.length - kept.length,
    droppedOversize,
    withheldMechanical,
    bytes,
  };
}

/** One markdown line for one entry: `- [decision,lesson] text · 07:18Z`. */
export function renderEntry(e: JournalEntry): string {
  const tags = e.tags.length > 0 ? `[${e.tags.join(",")}] ` : "";
  const stamp = ` · ${e.createdAt.toISOString().slice(11, 16)}Z`;
  return `- ${tags}${e.content}${stamp}`;
}

/** A whole day as markdown — the human-readable artefact, header included. */
export function renderDay(date: string, entries: readonly JournalEntry[]): string {
  return [`# ${date}`, ...entries.map(renderEntry)].join("\n") + "\n";
}
