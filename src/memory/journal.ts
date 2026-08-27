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
}

export interface RecallSelection {
  /** Kept rows, chronological — the order a journal is read in. */
  entries: JournalEntry[];
  /** Rows dropped because the budget ran out (oldest first). */
  droppedForBudget: number;
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
 * Fill a byte budget from one day's rows, newest FIRST.
 *
 * Newest-first is the same reasoning the old file-tail cap used — a journal is
 * append-ordered, so the newest entries are the ones a turn most likely needs,
 * and the older ones are the ones distillation reaches first. The difference
 * is that this drops WHOLE ENTRIES and can say how many, where the file cap
 * sliced the day mid-morning and could only report bytes.
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

  const kept: JournalEntry[] = [];
  let bytes = 0;
  for (let i = eligible.length - 1; i >= 0; i--) {
    const e = eligible[i]!;
    const size = Buffer.byteLength(renderEntry(e), "utf8") + 1;
    if (bytes + size > budgetBytes && kept.length > 0) break;
    // The single newest entry is always kept even if it alone busts the
    // budget: "the prompt has no journal at all" is a worse failure than one
    // oversized entry, and a caller with a tiny budget is a test, not prod.
    kept.push(e);
    bytes += size;
    if (bytes >= budgetBytes) break;
  }
  kept.reverse();
  return {
    entries: kept,
    droppedForBudget: eligible.length - kept.length,
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
