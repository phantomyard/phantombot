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
  /** Rows kept IN FULL, chronological — the order a journal is read in. */
  entries: JournalEntry[];
  /**
   * Rows that did not fit in full and came back as one-line stubs, also
   * chronological. A stub is not a kept entry and not a dropped one: the
   * content is gone but its EXISTENCE, its tags, its clock time and enough
   * head text to search on are still in the prompt (#467).
   */
  stubbed: JournalEntry[];
  /**
   * Rows not shown in full — stubbed ones included. Kept as "not in full" so
   * the number keeps meaning what it always meant; `droppedEntirely` is the
   * count that has no representation at all.
   */
  droppedForBudget: number;
  /**
   * Rows with NO representation in the block: no full text, not even a stub.
   * Only reachable when the budget is too small to hold the stubs themselves,
   * which on the production budget means a pathological day.
   */
  droppedEntirely: number;
  /**
   * Of `droppedForBudget`, how many were too large to keep in full because ONE
   * row is bigger than the whole budget. Counted apart because the remedy is
   * different: a normal overflow means the day was busy and the entry returns
   * on a quiet one, an oversized row never returns and wants splitting or
   * `memory search`. Since #467 these are stubbed like anything else rather
   * than vanishing.
   */
  droppedOversize: number;
  /** Rows withheld because they are machine chatter (`source: 'task'`). */
  withheldMechanical: number;
  /** Byte size of everything returned — full entries AND stubs — as rendered. */
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
 * Tag weights for recall ordering.
 *
 * A tag is a promotion instruction — it names the drawer an entry is on its
 * way to — so it is also the best available signal of how much a turn later
 * in the same day still needs that entry in front of it. `decision` is the
 * one thing a turn cannot re-derive from the code (it records a choice and
 * the reasoning that was rejected); a `lesson` is next; a `norm` or a
 * `person` fact is usually already durable somewhere else by the time it
 * matters.
 *
 * `commitment` is absent on purpose: commitments do not decay and are not
 * scored, they are simply first (see COMMITMENT_TAG below). That mirrors
 * `BELIEF_KINDS` in drawers.ts, which excludes commitments from decay for the
 * same reason — age makes an open commitment MORE urgent, not less relevant.
 * One decay model in the codebase, not two.
 */
export const JOURNAL_TAG_WEIGHTS: Record<string, number> = {
  decision: 1,
  lesson: 0.9,
  norm: 0.85,
  person: 0.8,
};

/** Any tag not in the table above. Still beats untagged narration outright. */
export const JOURNAL_DEFAULT_TAG_WEIGHT = 0.7;

const COMMITMENT_TAG = "commitment";

/**
 * Recency half-life WITHIN one day, in hours.
 *
 * The drawers decay in days because they hold beliefs that span months; a
 * journal day is only 24 hours wide, so an hour-scale half-life would be
 * indistinguishable from pure recency and a month-scale one from a constant.
 *
 * 48h is chosen so the weight table can actually change an ordering over the
 * gaps that occur inside a working day. Across the ~9 hours between a morning
 * root-cause `decision` and an afternoon `person` note the factor is 0.88, so
 * the decision (1 · 0.88) survives and the person note (0.8 · 1) is the one
 * stubbed — which is the case #467 was opened on. Shorten this and weight
 * stops mattering; lengthen it and the day stops being ordered by time at
 * all. Recency remains the dominant term either way: this tilts the ordering,
 * it does not invert it, and the BANDS above it are strict regardless.
 */
export const JOURNAL_RECALL_HALF_LIFE_HOURS = 48;

/**
 * Priority band. Lower sorts first. Bands are STRICT: no score in band 1 can
 * ever overtake band 0, and nothing tagged can be dropped before something
 * untagged. That strictness is the guarantee #463 makes and the byte-slice on
 * the markdown file could not — scoring happens INSIDE a band, never across.
 */
function recallBand(e: JournalEntry): 0 | 1 | 2 {
  if (e.tags.includes(COMMITMENT_TAG)) return 0;
  return e.tags.length > 0 ? 1 : 2;
}

/** An entry is worth its heaviest tag, not the average of them. */
function tagWeight(e: JournalEntry): number {
  let best = 0;
  for (const t of e.tags) {
    best = Math.max(best, JOURNAL_TAG_WEIGHTS[t] ?? JOURNAL_DEFAULT_TAG_WEIGHT);
  }
  return best || JOURNAL_DEFAULT_TAG_WEIGHT;
}

/**
 * Order the eligible rows by band, then by decayed weight inside band 1.
 *
 * The decay clock is the NEWEST entry in the set, not `Date.now()`. Selection
 * must be a pure function of its input: a wall clock makes the same journal
 * select differently depending on when the turn ran, which is untestable and,
 * worse, means a day's ordering silently changes as it ages in the same
 * prompt.
 */
function prioritize(eligible: readonly JournalEntry[]): JournalEntry[] {
  let ref = 0;
  for (const e of eligible) ref = Math.max(ref, e.createdAt.getTime());
  const halfLifeMs = JOURNAL_RECALL_HALF_LIFE_HOURS * 3_600_000;
  const score = (e: JournalEntry): number => {
    const ageMs = Math.max(0, ref - e.createdAt.getTime());
    return tagWeight(e) * Math.pow(2, -ageMs / halfLifeMs);
  };
  return [...eligible].sort((a, b) => {
    const band = recallBand(a) - recallBand(b);
    if (band !== 0) return band;
    // Bands 0 and 2 are pure recency: a commitment is not a belief to be
    // scored, and untagged narration has no tag to weigh.
    if (recallBand(a) === 1) {
      const s = score(b) - score(a);
      if (Math.abs(s) > 1e-9) return s;
    }
    return (
      b.createdAt.getTime() - a.createdAt.getTime() || a.id.localeCompare(b.id)
    );
  });
}

/**
 * Share of the budget held back for stubs when anything overflows — 15%.
 *
 * Held back rather than spent afterwards, because the full-entry pass would
 * otherwise consume the last byte and leave nothing to say what it displaced.
 * Nothing is reserved on a day that fits: the pass runs once at the full
 * budget first, and only re-runs against the reserve when it finds leftovers.
 * 15% of 16KB is ~2.4KB, i.e. ~17 stubs — comfortably more than the 14 rows
 * that overflowed on the day #467 was measured.
 */
export const JOURNAL_STUB_RESERVE_FRACTION = 0.15;

/**
 * Hard cap on one stub, bytes — the WHOLE rendered line, not just its head
 * text. Both variable parts are bounded to hold it: the tag list at
 * `JOURNAL_STUB_TAG_BYTES` and the head text by whatever is left.
 */
export const JOURNAL_STUB_MAX_BYTES = 160;

/**
 * Cap on the tag list inside one stub, bytes. Tags are unbounded in principle
 * (`memory capture` takes any `--tag`), so without this the "hard cap" above
 * is not one: a long enough tag list alone overruns it and the head text gets
 * squeezed to nothing. Extra tags become a `+N` marker — the count still says
 * the entry was tagged more heavily than shown, and the band it was selected
 * in is decided by the row, not by this line.
 */
export const JOURNAL_STUB_TAG_BYTES = 40;

const STUB_SUFFIX = "… · elided — `memory search`";

/** Byte-safe prefix: take whole characters while they fit in `maxBytes`. */
function headBytes(text: string, maxBytes: number): string {
  if (Buffer.byteLength(text, "utf8") <= maxBytes) return text;
  let out = "";
  let n = 0;
  for (const ch of text) {
    const w = Buffer.byteLength(ch, "utf8");
    if (n + w > maxBytes) break;
    out += ch;
    n += w;
  }
  // Prefer a word boundary, but only if one is close enough that cutting
  // there does not throw away most of the search terms.
  const sp = out.lastIndexOf(" ");
  return sp > maxBytes * 0.6 ? out.slice(0, sp) : out;
}

/**
 * One line standing in for an entry that did not fit: tags, head text, clock.
 *
 * The point is not to convey the entry — it is to make the entry REACHABLE. A
 * bare count ("14 earlier entries not shown") is honest and useless, because a
 * turn cannot search for something whose existence it does not know; the head
 * text is what carries the search terms. Bounded at
 * JOURNAL_STUB_MAX_BYTES so a day of stubs is a fixed cost per row and not a
 * second unbounded blob.
 *
 * Stubs live ONLY in the injected block. `renderEntry` / `renderDay` — the
 * markdown that reaches disk and round-trips through `parseJournalLine` — are
 * untouched, so nothing lossy can ever be written back over a day's rows.
 */
function stubTagList(tags: readonly string[]): string {
  if (tags.length === 0) return "";
  const fits = (list: readonly string[]): boolean =>
    Buffer.byteLength(list.join(","), "utf8") <= JOURNAL_STUB_TAG_BYTES;
  const kept: string[] = [];
  for (const t of tags) {
    if (!fits([...kept, t])) break;
    kept.push(t);
  }
  const dropped = tags.length - kept.length;
  if (dropped === 0) return `[${kept.join(",")}] `;
  // Make room for the marker itself, so the cap holds even when a single tag
  // is longer than the whole allowance (kept ends up empty and the stub says
  // only how many tags there were).
  const marker = `+${dropped}`;
  while (kept.length > 0 && !fits([...kept, marker])) kept.pop();
  return `[${[...kept, marker].join(",")}] `;
}

export function renderStub(e: JournalEntry): string {
  const tags = stubTagList(e.tags);
  const stamp = ` · ${e.createdAt.toISOString().slice(11, 16)}Z`;
  const fixed = Buffer.byteLength(
    `- ${tags}${STUB_SUFFIX}${stamp}`,
    "utf8",
  );
  // No `Math.max` floor here: `fixed` is bounded by construction (constant
  // prefix + suffix + stamp, plus a tag list capped above), so the room left
  // for head text is always positive and the cap is arithmetic, not a hope.
  const room = JOURNAL_STUB_MAX_BYTES - fixed;
  // Collapse newlines: a multi-line capture must still be ONE line here, or
  // the stub is neither bounded nor parseable by eye.
  const flat = e.content.replace(/\s+/g, " ").trim();
  return `- ${tags}${headBytes(flat, room)}${STUB_SUFFIX}${stamp}`;
}

const sizeOf = (text: string): number => Buffer.byteLength(text, "utf8") + 1;

/** Pack full entries into `budget`, in the order given. Returns the leftovers. */
function packFull(
  ordered: readonly JournalEntry[],
  budget: number,
): { kept: JournalEntry[]; bytes: number; leftovers: JournalEntry[]; oversize: number } {
  const kept: JournalEntry[] = [];
  const leftovers: JournalEntry[] = [];
  let bytes = 0;
  let oversize = 0;
  for (const e of ordered) {
    const size = sizeOf(renderEntry(e));
    if (size > budget) {
      // One row bigger than the entire budget. It can never be kept without
      // making the budget a suggestion, and `memory capture` caps nothing — a
      // single pasted log or stack trace is enough. Since #467 it is not lost
      // either: it falls through to the stub pass like any other leftover.
      oversize++;
      leftovers.push(e);
      continue;
    }
    if (bytes + size > budget) {
      // Keep walking: a later, smaller entry may still fit where this one did
      // not. Skipping the rest would drop a 40-byte decision because a 4KB
      // narration happened to come first.
      leftovers.push(e);
      continue;
    }
    kept.push(e);
    bytes += size;
  }
  return { kept, bytes, leftovers, oversize };
}

const chronological = (a: JournalEntry, b: JournalEntry): number =>
  a.createdAt.getTime() - b.createdAt.getTime() || a.id.localeCompare(b.id);

/**
 * Fill a byte budget from one day's rows.
 *
 * Two orderings are in play and they are not the same one:
 *
 *   PRIORITY decides what is dropped when the budget runs out. Not age alone
 *   — BAND first, then score, then age. A tagged capture (`decision`,
 *   `lesson`, `commitment`, `person`, `norm`) is something the persona
 *   deliberately wrote down for later; untagged narration is what it happened
 *   to say while doing the work. When a day overflows, the chatter goes and
 *   the decisions stay. The old byte-slice on the file did the exact
 *   opposite: it cut from the FRONT, so the first casualty was the morning's
 *   tagged captures. Inside the tagged band, ordering is by decayed tag
 *   weight rather than by clock (#467) — measured on the day that motivated
 *   it, every row of an over-budget day was tagged, so the class tier bought
 *   nothing and pure recency was deciding which decisions survived.
 *
 *   READ order is chronological, always, and stubs are interleaved with kept
 *   entries in it. A journal read out of order is a different document.
 *
 * Overflow is DEGRADATION, not loss. What does not fit in full comes back as
 * a one-line stub carrying its tags, its clock and enough head text to search
 * on; every row also remains in the table and in the index. That is the whole
 * difference between "this never happened" and "this happened, go read it" —
 * and it is the second one that makes a turn reach for `memory search`
 * instead of re-deriving what it already knew this morning.
 *
 * The budget is a HARD bound including the stubs, and including against a
 * single row bigger than the whole of it. Nothing caps the length of one
 * `memory capture`, so one pasted log is enough; letting the highest-priority
 * row through unmeasured would make the budget advisory and hand back exactly
 * the unbounded prompt this table exists to bound. When even the stubs will
 * not fit, the remainder is dropped and counted, which the caller must report
 * rather than mistake for an empty day.
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

  const ordered = prioritize(eligible);

  // First pass at the FULL budget: a day that fits pays nothing for a stub
  // reserve it does not need.
  let pass = packFull(ordered, budgetBytes);
  // Measured against the FULL budget, and kept from this pass only: pass 2
  // runs against `budgetBytes - reserve`, where a row at 90% of the budget
  // would also count as "oversize" and make the dailyRecall note claim it is
  // bigger than the whole budget — which is the one thing that count exists
  // to mean, because it is what distinguishes "returns on a quiet day" from
  // "never returns; split it or search for it".
  const oversize = pass.oversize;
  const stubbed: JournalEntry[] = [];
  let stubBytes = 0;

  if (pass.leftovers.length > 0) {
    const need = pass.leftovers.reduce(
      (n, e) => n + sizeOf(renderStub(e)),
      0,
    );
    // Floor of one whole stub, ceiling of half the budget. The fraction alone
    // is right at 16KB and useless at 400 bytes, where 15% cannot hold a
    // single stub and the reserve would silently buy nothing; the half-budget
    // ceiling stops the reverse case, a tiny budget spending everything on
    // stubs and showing no entry in full at all.
    const reserve = Math.min(
      need,
      Math.max(
        Math.floor(budgetBytes * JOURNAL_STUB_RESERVE_FRACTION),
        JOURNAL_STUB_MAX_BYTES + 1,
      ),
      Math.floor(budgetBytes / 2),
    );
    pass = packFull(ordered, budgetBytes - reserve);
    let remaining = budgetBytes - pass.bytes;
    for (const e of pass.leftovers) {
      const size = sizeOf(renderStub(e));
      if (size > remaining) continue;
      stubbed.push(e);
      stubBytes += size;
      remaining -= size;
    }
  }

  const kept = [...pass.kept].sort(chronological);
  stubbed.sort(chronological);
  return {
    entries: kept,
    stubbed,
    droppedForBudget: eligible.length - kept.length,
    droppedEntirely: eligible.length - kept.length - stubbed.length,
    droppedOversize: oversize,
    withheldMechanical,
    bytes: pass.bytes + stubBytes,
  };
}

/**
 * The injected text for a selection: kept entries and stubs, interleaved in
 * clock order.
 *
 * Interleaved rather than appended as a separate "elided" section, because
 * the block is read as a narrative of the day — a stub in its right place
 * says "something happened here at 09:12 that you cannot see"; the same stub
 * in a footer at the bottom says nothing about when.
 */
export function renderRecall(sel: RecallSelection): string {
  const stubs = new Set(sel.stubbed.map((e) => e.id));
  return [...sel.entries, ...sel.stubbed]
    .sort(chronological)
    .map((e) => (stubs.has(e.id) ? renderStub(e) : renderEntry(e)))
    .join("\n");
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
