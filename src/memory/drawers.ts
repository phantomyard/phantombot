/**
 * Drawer entries as rows — stage two of issue #410.
 *
 * The five drawers (`people`, `decisions`, `lessons`, `commitments`, `norms`)
 * are append-only markdown today. Stage one gave the nightly a compaction half
 * but deliberately left the drawers alone, because dedupe over prose is an LLM
 * pass that would be thrown away the moment the entries became rows. This is
 * that move.
 *
 * Four properties the markdown files cannot have:
 *
 *   1. STABLE IDENTITY. An entry's id is derived from its normalized content,
 *      so re-filing the same entry twice — from a capture, a heartbeat, a
 *      nightly, or a third-party tool — collides on a UNIQUE constraint rather
 *      than appending a 64th copy. Dedupe stops being a prompt instruction
 *      nobody can follow (#410's "read the 663KB drawer first") and becomes a
 *      constraint the database enforces for free.
 *   2. SUPERSESSION. A newer entry can invalidate an older one by id. The old
 *      row goes `superseded` instead of sitting in the retrieval pool
 *      competing with the thing that replaced it. This is the mechanism a
 *      custom phantomtool uses to correct a norm it filed earlier: it does not
 *      edit or delete, it files a new entry that names the old one.
 *   3. DECAY — BUT ONLY FOR BELIEFS. `norms`, `lessons` and `decisions` are
 *      claims about how the world works; they go stale, and an unreaffirmed
 *      2024 decision must not outrank a 2026 one. `commitments` and `people`
 *      do NOT decay: a commitment is open, discharged or overdue — age makes
 *      it MORE urgent, not less relevant, so decaying it would silently bury
 *      the one thing that needed surfacing. A person fact ("date of birth") is
 *      not less true for going a year unmentioned. Those two move by `status`
 *      alone. Getting this wrong in either direction is a data-loss bug, so
 *      the split lives in one exported list (`BELIEF_KINDS`), not in a comment.
 *   4. LIFECYCLE. `status` carries what a flat file could only imply, so a
 *      discharged commitment stops ranking against a live one.
 *
 * NOTHING IS EVER DELETED here either — the same rule stage one runs on. A
 * superseded, dormant or discharged entry stays queryable forever; it just
 * stops being injected. Retirement is a ranking decision, not a DELETE.
 */

import { createHash } from "node:crypto";
import type { Database } from "bun:sqlite";
import type { FactSource } from "../config.ts";
import { asFactSource, normalizeFact } from "./store.ts";

/** The five drawers, in the order the distill stage writes them. */
export const DRAWER_KINDS = [
  "people",
  "decisions",
  "lessons",
  "commitments",
  "norms",
] as const;

export type DrawerKind = (typeof DRAWER_KINDS)[number];

/**
 * The drawers that hold BELIEFS about the world, and therefore decay.
 *
 * Deliberately excludes `commitments` (time makes them urgent, not stale) and
 * `people` (durable identity data). See the header note — this list is the
 * single point of truth for that split; nothing else may re-derive it.
 */
export const BELIEF_KINDS: readonly DrawerKind[] = [
  "decisions",
  "lessons",
  "norms",
] as const;

export function decays(kind: DrawerKind): boolean {
  return BELIEF_KINDS.includes(kind);
}

export function isDrawerKind(v: unknown): v is DrawerKind {
  return (
    typeof v === "string" && (DRAWER_KINDS as readonly string[]).includes(v)
  );
}

/**
 * Entry lifecycle.
 *
 *   active     — live; eligible for injection and search.
 *   superseded — a newer entry names this one in `supersedes`. Queryable,
 *                never injected.
 *   dormant    — a belief whose decayed score fell under the floor. Queryable,
 *                never injected, and revived automatically by a reaffirmation.
 *   discharged — a commitment that was met.
 *   expired    — a commitment whose window closed unmet. Distinct from
 *                `discharged` on purpose: "we missed it" is not "we did it",
 *                and a postmortem needs to tell them apart.
 */
export const DRAWER_STATUSES = [
  "active",
  "superseded",
  "dormant",
  "discharged",
  "expired",
] as const;

export type DrawerStatus = (typeof DRAWER_STATUSES)[number];

/** Statuses each kind may legally hold. Enforced on write, not just documented. */
const ALLOWED_STATUSES: Record<DrawerKind, readonly DrawerStatus[]> = {
  people: ["active", "superseded"],
  decisions: ["active", "superseded", "dormant"],
  lessons: ["active", "superseded", "dormant"],
  norms: ["active", "superseded", "dormant"],
  commitments: ["active", "superseded", "discharged", "expired"],
};

export function statusAllowed(kind: DrawerKind, status: DrawerStatus): boolean {
  return ALLOWED_STATUSES[kind].includes(status);
}

export function allowedStatuses(kind: DrawerKind): readonly DrawerStatus[] {
  return ALLOWED_STATUSES[kind];
}

/**
 * Decay half-life per belief kind, in days: score halves every this many days
 * without reaffirmation. Mirrors the durable-fact tiers in config.ts — same
 * `weight · 2^(-ageDays / halfLifeDays)` shape, so there is one decay model in
 * the codebase and not two.
 *
 * Norms are the slowest: a standing house rule the owner set holds until they
 * change it, and crying stale on one makes the threat judge cry wolf. Lessons
 * are the fastest: they are usually about a specific version of a specific
 * system, and that system moves.
 */
export const HALF_LIFE_DAYS: Record<DrawerKind, number> = {
  norms: 365,
  decisions: 180,
  lessons: 120,
  // Not consulted — both kinds are excluded by BELIEF_KINDS. Present so the
  // record is total and a future kind cannot silently default to 0.
  commitments: 0,
  people: 0,
};

/**
 * Below this decayed score a belief goes `dormant`: it stops being injected,
 * stays queryable, and any reaffirmation brings it straight back. Chosen so a
 * default-weight entry survives three half-lives of total silence before going
 * quiet — long enough that dormancy means genuinely unused, not merely old.
 */
export const DORMANT_FLOOR = 0.125;

/** Default ranking weight. 0 is legal and means "never inject". */
export const DEFAULT_WEIGHT = 1;

/**
 * Trust tier a first-ever insert lands in when the caller names none.
 *
 * `self` — the persona's own filed belief — NOT `principal`. The top tier means
 * "the principal asserted this first-hand", and the main external consumer of
 * this contract is a third-party phantomtool that will often omit `source`
 * entirely. Silence must not buy the highest trust tier; `principal` has to be
 * claimed explicitly.
 */
export const DEFAULT_SOURCE: FactSource = "self";

export interface DrawerEntry {
  id: string;
  persona: string;
  kind: DrawerKind;
  content: string;
  weight: number;
  status: DrawerStatus;
  /** Id of the entry this one replaces, if any. */
  supersedes?: string;
  source: FactSource;
  /** Where it came from: a markdown drawer path, or a tool name. */
  origin?: string;
  assertedAt: Date;
  lastReaffirmedAt: Date;
}

export interface FileDrawerEntryInput {
  persona: string;
  kind: DrawerKind;
  content: string;
  weight?: number;
  supersedes?: string;
  source?: FactSource;
  origin?: string;
  /** Defaults to now. Set explicitly when ingesting dated markdown. */
  assertedAt?: Date;
}

export const DRAWER_SCHEMA = `
CREATE TABLE IF NOT EXISTS drawer_entries (
  id                 TEXT PRIMARY KEY,
  persona            TEXT NOT NULL,
  kind               TEXT NOT NULL,
  content            TEXT NOT NULL,
  -- De-dupe key: normalizeFact(content). Two restatements that differ only in
  -- whitespace, case or trailing punctuation collide here instead of both
  -- being filed. Same normalizer the durable-fact pool uses.
  content_norm       TEXT NOT NULL,
  weight             REAL NOT NULL DEFAULT 1,
  status             TEXT NOT NULL DEFAULT 'active',
  supersedes         TEXT,
  source             TEXT NOT NULL DEFAULT 'self',
  origin             TEXT,
  asserted_at        TEXT NOT NULL,
  last_reaffirmed_at TEXT NOT NULL,
  UNIQUE (persona, kind, content_norm)
);
CREATE INDEX IF NOT EXISTS idx_drawer_entries_rank
  ON drawer_entries (persona, kind, status, last_reaffirmed_at DESC);
CREATE INDEX IF NOT EXISTS idx_drawer_entries_supersedes
  ON drawer_entries (persona, supersedes);
`;

export function ensureDrawerSchema(db: Database): void {
  db.exec(DRAWER_SCHEMA);
}

/**
 * Stable entry id — sha256 over persona, kind and NORMALIZED content, first 16
 * hex chars. Deterministic across processes and machines, which is what lets an
 * ingest merge by id rather than blind-append, and lets a tool name the entry
 * it supersedes without ever having seen the row.
 */
export function drawerEntryId(
  persona: string,
  kind: DrawerKind,
  content: string,
): string {
  return createHash("sha256")
    .update(`${persona}\0${kind}\0${normalizeFact(content)}`)
    .digest("hex")
    .slice(0, 16);
}

interface RawDrawerRow {
  id: string;
  persona: string;
  kind: string;
  content: string;
  weight: number;
  status: string;
  supersedes: string | null;
  source: string;
  origin: string | null;
  asserted_at: string;
  last_reaffirmed_at: string;
}

function mapRow(r: RawDrawerRow): DrawerEntry {
  return {
    id: r.id,
    persona: r.persona,
    kind: r.kind as DrawerKind,
    content: r.content,
    weight: r.weight,
    status: r.status as DrawerStatus,
    supersedes: r.supersedes ?? undefined,
    source: asFactSource(r.source),
    origin: r.origin ?? undefined,
    assertedAt: new Date(r.asserted_at),
    lastReaffirmedAt: new Date(r.last_reaffirmed_at),
  };
}

/** Decayed score for one entry. Non-belief kinds are weight-only (no clock). */
export function scoreEntry(entry: DrawerEntry, now: Date = new Date()): number {
  if (!decays(entry.kind)) return entry.weight;
  const halfLife = HALF_LIFE_DAYS[entry.kind];
  if (halfLife <= 0) return entry.weight;
  const ageDays =
    (now.getTime() - entry.lastReaffirmedAt.getTime()) / 86_400_000;
  if (!Number.isFinite(ageDays) || ageDays <= 0) return entry.weight;
  return entry.weight * Math.pow(2, -ageDays / halfLife);
}

const TRUST_ORDER: Record<FactSource, number> = {
  principal: 3,
  self: 2,
  other: 1,
  unverified: 0,
};

function higherTrust(a: FactSource, b: FactSource): FactSource {
  return TRUST_ORDER[a] >= TRUST_ORDER[b] ? a : b;
}

/** True for the `UNIQUE (persona, kind, content_norm)` collision. */
function isUniqueViolation(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return msg.includes("UNIQUE constraint failed");
}

export interface FileOutcome {
  entry: DrawerEntry;
  /** True when this call created the row; false when it reaffirmed one. */
  inserted: boolean;
}

export class DrawerStore {
  /** Runs a closure inside one write transaction (see `file()`). */
  private readonly inWriteTx: <T>(fn: () => T) => T;

  constructor(private db: Database) {
    ensureDrawerSchema(db);
    const tx = db.transaction((fn: () => unknown) => fn());
    this.inWriteTx = ((fn: () => unknown) => tx.immediate(fn)) as <T>(
      fn: () => T,
    ) => T;
  }

  /**
   * File an entry, or REAFFIRM the one already there.
   *
   * The re-file path is the whole point: it never appends a duplicate and
   * never rewrites the original assertion date. It bumps `last_reaffirmed_at`
   * (which is what resets decay) and revives a `dormant` entry — a belief that
   * was just restated is live again by definition.
   *
   * A reaffirmation is evidence the entry is still LIVE, not evidence it is
   * more trusted or more important than when it was filed. So an omitted
   * `weight` or `source` falls back to THE ROW's current value, never to the
   * defaults: a re-file that names neither cannot promote an `unverified`,
   * weight-0 entry to `principal`, weight 1. Only an explicit, higher value
   * raises either.
   *
   * A `superseded` entry is NOT revived this way. Undoing a supersession has
   * to be an explicit act, otherwise a stale tool re-filing its old norm on
   * every startup would silently resurrect what replaced it.
   *
   * Concurrency: `get()`-then-`INSERT` is a TOCTOU under the concurrent turns
   * this runtime already allows (#391), so the whole read-modify-write runs in
   * one IMMEDIATE transaction — and a UNIQUE collision from another connection
   * is retried onto the reaffirm path rather than thrown at the caller. Filing
   * the same entry twice is idempotent from ANY caller; that is the contract
   * third-party tools are told to rely on.
   */
  file(input: FileDrawerEntryInput): DrawerEntry {
    return this.fileEntry(input).entry;
  }

  /** `file()`, but reporting whether the row was inserted or reaffirmed. */
  fileEntry(input: FileDrawerEntryInput): FileOutcome {
    const assertedAt = input.assertedAt ?? new Date();
    const id = drawerEntryId(input.persona, input.kind, input.content);
    if (input.supersedes === id) {
      // Reachable by accident: a tool files a correction and computes the old
      // id from text that normalizes to the same string. Left unguarded the
      // entry marks ITSELF superseded and, by the revive asymmetry above, no
      // later re-file brings it back — the write silently erases itself.
      throw new Error(
        `drawer entry cannot supersede itself (id ${id}, ` +
          `persona ${input.persona}, kind ${input.kind})`,
      );
    }
    try {
      return this.inWriteTx(() => this.fileNow(id, input, assertedAt));
    } catch (err) {
      if (!isUniqueViolation(err)) throw err;
      // Another connection inserted between our read and our write; the row
      // exists now, so the same call reaffirms it.
      return this.inWriteTx(() => this.fileNow(id, input, assertedAt));
    }
  }

  private fileNow(
    id: string,
    input: FileDrawerEntryInput,
    assertedAt: Date,
  ): FileOutcome {
    const existing = this.get(id);
    if (existing) {
      const weight = Math.max(existing.weight, input.weight ?? existing.weight);
      const source = higherTrust(
        existing.source,
        input.source ?? existing.source,
      );
      const status: DrawerStatus =
        existing.status === "dormant" ? "active" : existing.status;
      // last_reaffirmed_at only ever moves FORWARD: ingesting an old markdown
      // file must not make a live entry look stale.
      const reaffirmed =
        assertedAt > existing.lastReaffirmedAt
          ? assertedAt
          : existing.lastReaffirmedAt;
      this.db
        .query(
          `UPDATE drawer_entries
              SET weight = ?, source = ?, status = ?, last_reaffirmed_at = ?,
                  supersedes = COALESCE(?, supersedes)
            WHERE id = ?`,
        )
        .run(
          weight,
          source,
          status,
          reaffirmed.toISOString(),
          input.supersedes ?? null,
          id,
        );
      if (input.supersedes) {
        this.markSuperseded(input.persona, input.kind, input.supersedes);
      }
      return { entry: this.get(id)!, inserted: false };
    }
    this.db
      .query(
        `INSERT INTO drawer_entries
           (id, persona, kind, content, content_norm, weight, status, supersedes,
            source, origin, asserted_at, last_reaffirmed_at)
         VALUES (?, ?, ?, ?, ?, ?, 'active', ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        input.persona,
        input.kind,
        input.content,
        normalizeFact(input.content),
        input.weight ?? DEFAULT_WEIGHT,
        input.supersedes ?? null,
        input.source ?? DEFAULT_SOURCE,
        input.origin ?? null,
        assertedAt.toISOString(),
        assertedAt.toISOString(),
      );
    if (input.supersedes) {
      this.markSuperseded(input.persona, input.kind, input.supersedes);
    }
    return { entry: this.get(id)!, inserted: true };
  }

  get(id: string): DrawerEntry | undefined {
    const row = this.db
      .query("SELECT * FROM drawer_entries WHERE id = ?")
      .get(id) as RawDrawerRow | null;
    return row ? mapRow(row) : undefined;
  }

  /**
   * Mark an entry superseded WITHIN ITS OWN KIND. Scoping on `kind` as well as
   * `persona` is what stops a `people` entry retiring a `decisions` one: an id
   * is opaque to the caller that computed it, so a wrong-kind id must miss
   * rather than retire an unrelated drawer's row.
   *
   * Silently no-ops on an unknown id: a tool naming an entry that was never
   * filed (fresh persona, reordered ingest) must not fail the write of the
   * entry that replaces it.
   */
  markSuperseded(persona: string, kind: DrawerKind, id: string): void {
    this.db
      .query(
        "UPDATE drawer_entries SET status = 'superseded' " +
          "WHERE persona = ? AND kind = ? AND id = ?",
      )
      .run(persona, kind, id);
  }

  /** Move an entry's lifecycle state. Rejects a status the kind cannot hold. */
  setStatus(id: string, status: DrawerStatus): DrawerEntry | undefined {
    const entry = this.get(id);
    if (!entry) return undefined;
    if (!statusAllowed(entry.kind, status)) {
      throw new Error(
        `drawer ${entry.kind} cannot be '${status}' ` +
          `(allowed: ${ALLOWED_STATUSES[entry.kind].join(", ")})`,
      );
    }
    this.db
      .query("UPDATE drawer_entries SET status = ? WHERE id = ?")
      .run(status, id);
    return this.get(id);
  }

  list(persona: string, kind?: DrawerKind): DrawerEntry[] {
    const rows = kind
      ? (this.db
          .query(
            "SELECT * FROM drawer_entries WHERE persona = ? AND kind = ? " +
              "ORDER BY asserted_at",
          )
          .all(persona, kind) as RawDrawerRow[])
      : (this.db
          .query(
            "SELECT * FROM drawer_entries WHERE persona = ? ORDER BY kind, asserted_at",
          )
          .all(persona) as RawDrawerRow[]);
    return rows.map(mapRow);
  }

  /**
   * Ranked, injectable entries: `active` only, scored, highest first.
   *
   * Beliefs are scored off `last_reaffirmed_at` and dropped under
   * DORMANT_FLOOR. Commitments and people are scored on weight alone — no
   * clock — for the reason in the header. `now` is injectable so tests do not
   * have to sleep.
   */
  ranked(
    persona: string,
    kind: DrawerKind,
    opts: { limit?: number; now?: Date } = {},
  ): Array<DrawerEntry & { score: number }> {
    const now = opts.now ?? new Date();
    // `status = 'active'` and the ordering are pushed into SQL so
    // idx_drawer_entries_rank (persona, kind, status, last_reaffirmed_at DESC)
    // actually serves this query — on a drawer the size #410 describes (~1400
    // entries) a full scan per call is the difference that matters. The final
    // ordering is still by decayed score in JS, since weight is part of it.
    const scored = this.listActive(persona, kind)
      .map((e) => ({ ...e, score: scoreEntry(e, now) }))
      .filter((e) => !decays(kind) || e.score >= DORMANT_FLOOR)
      .sort((a, b) => b.score - a.score);
    return opts.limit === undefined ? scored : scored.slice(0, opts.limit);
  }

  /** `active` rows for one drawer, freshest reaffirmation first. Index-served. */
  private listActive(persona: string, kind: DrawerKind): DrawerEntry[] {
    const rows = this.db
      .query(
        "SELECT * FROM drawer_entries " +
          "WHERE persona = ? AND kind = ? AND status = 'active' " +
          "ORDER BY last_reaffirmed_at DESC",
      )
      .all(persona, kind) as RawDrawerRow[];
    return rows.map(mapRow);
  }

  /**
   * Flip decayed-out beliefs to `dormant`. Idempotent, and never touches a
   * non-belief kind — running this over commitments would retire live
   * obligations, which is the exact failure the split exists to prevent.
   */
  sweepDormant(persona: string, now: Date = new Date()): DrawerEntry[] {
    const moved: DrawerEntry[] = [];
    for (const kind of BELIEF_KINDS) {
      for (const e of this.listActive(persona, kind)) {
        if (scoreEntry(e, now) >= DORMANT_FLOOR) continue;
        this.setStatus(e.id, "dormant");
        moved.push({ ...e, status: "dormant" });
      }
    }
    return moved;
  }
}
