/**
 * Markdown → `journal_entries` — the ABSORB half of #461.
 *
 * The direction of travel changed in review. Rows are now the WRITE path and
 * markdown is a DERIVED ARTEFACT the nightly produces once a day is closed
 * (see journalRender.ts), so there is no bulk migration to run and no
 * open-day mirror to keep honest: the table only ever holds days that have
 * not been rendered yet, which on a healthy box is today plus at most one.
 *
 * What survives here is the parser, for two narrow jobs:
 *
 *   1. A persona upgrading mid-day already has a `memory/<today>.md` written
 *      by the OLD code. Absorbing it once is what stops the morning
 *      disappearing from the prompt at the moment of upgrade.
 *   2. A human (or a tool that has not moved to rows) may append to a daily
 *      file by hand. Absorbing before rendering means that line is ADOPTED
 *      rather than clobbered — sync-then-write, never write-over.
 *
 * Absorption is one-way and idempotent: ids are content-derived, so a second
 * pass over the same file is a no-op, and the per-tag duplication the old
 * writer produced collapses on the way in because two lines differing only in
 * their `[tag]` marker normalize to the same `content_norm`.
 */

import { Database } from "bun:sqlite";
import { existsSync } from "node:fs";
import { mkdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import { log } from "../lib/logger.js";
import { enableWalMode } from "./store.ts";
import { indexOpenDay } from "./journalRender.ts";
import {
  JournalStore,
  type AppendJournalInput,
  type JournalSource,
} from "./journal.ts";

/** `# 2026-08-27` — the header a daily file opens with. Never an entry. */
const DAY_HEADER = /^#\s*\d{4}-\d{2}-\d{2}\s*$/;

/** Leading list bullet: `- ` or `* `. Decoration, not content. */
const BULLET = /^[-*]\s+/;

/**
 * A leading tag marker: `[decision]`, or the comma SET `[decision,lesson]`
 * that `renderEntry` writes.
 *
 * Both forms have to parse, and the comma form is not cosmetic — the mirror
 * renders one line per ROW, so a two-tag row renders as `[decision,lesson]`.
 * A parser that only understood the single form would read that back as an
 * entry whose content literally began "[decision,lesson] …", which is a
 * different `content_norm`, which is a NEW row — and every heartbeat would
 * mint another one. Markers may also be stacked (`[a] [b] text`), which is how
 * a hand-written line can carry two.
 */
const TAG_MARKER = /^\[([a-z][a-z0-9_-]*(?:\s*,\s*[a-z][a-z0-9_-]*)*)\]\s*/i;

/** Trailing ` · 07:18Z` stamp written by `memory capture`. */
const STAMP = /\s*·\s*(\d{2}):(\d{2})Z\s*$/;

/** A machine-written scheduler line: `[commitment] task 577: … fires …`. */
const TASK_LINE = /^task\s+\d+:\s/i;

export interface ParsedJournalLine {
  content: string;
  tags: string[];
  /** Minutes past midnight UTC, from the trailing stamp. Undefined if absent. */
  minutes?: number;
  source: JournalSource;
}

/**
 * Parse one daily-file line into an entry, or `undefined` for a line that is
 * not one (the date header, a blank, a bare separator).
 *
 * Tags are stripped from the CONTENT and returned separately. That is what
 * makes the two copies of a two-tag capture collapse: `- [decision] X · 07:18Z`
 * and `- [lesson] X · 07:18Z` both parse to content `X`, and `content_norm`
 * does the rest.
 */
export function parseJournalLine(raw: string): ParsedJournalLine | undefined {
  let line = raw.trim();
  if (line.length === 0) return undefined;
  if (DAY_HEADER.test(line)) return undefined;
  if (/^-{3,}$/.test(line)) return undefined;
  line = line.replace(BULLET, "");

  const tags: string[] = [];
  for (;;) {
    const m = TAG_MARKER.exec(line);
    if (!m) break;
    for (const t of m[1]!.split(",")) tags.push(t.trim().toLowerCase());
    line = line.slice(m[0].length);
  }

  let minutes: number | undefined;
  const stamp = STAMP.exec(line);
  if (stamp) {
    minutes = Number(stamp[1]) * 60 + Number(stamp[2]);
    line = line.slice(0, stamp.index);
  }

  const content = line.trim();
  if (content.length === 0) return undefined;
  return {
    content,
    tags,
    minutes,
    source: TASK_LINE.test(content) ? "task" : "self",
  };
}

export interface JournalIngestResult {
  date: string;
  /** Lines that parsed to an entry. */
  parsed: number;
  /** Rows created. */
  inserted: number;
  /** Lines that collapsed onto an existing row (the duplication being undone). */
  merged: number;
}

/** Ingest one day's markdown text as rows. Idempotent. */
export function ingestJournalMarkdown(
  store: JournalStore,
  persona: string,
  date: string,
  text: string,
): JournalIngestResult {
  let parsed = 0;
  let inserted = 0;
  let merged = 0;
  for (const raw of text.split("\n")) {
    const line = parseJournalLine(raw);
    if (!line) continue;
    parsed++;
    const input: AppendJournalInput = {
      persona,
      date,
      content: line.content,
      tags: line.tags,
      source: line.source,
      // A stamped line is placed at ITS time on ITS day, so ingesting an old
      // file cannot reorder a day or backdate today's entries to midnight.
      createdAt: dayTime(date, line.minutes),
    };
    if (store.append(input).inserted) inserted++;
    else merged++;
  }
  return { date, parsed, inserted, merged };
}

/** Midnight UTC for `YYYY-MM-DD`, plus optional minutes. */
function dayTime(date: string, minutes?: number): Date {
  const base = new Date(`${date}T00:00:00.000Z`);
  if (Number.isNaN(base.getTime())) return new Date();
  return minutes === undefined
    ? base
    : new Date(base.getTime() + minutes * 60_000);
}

/**
 * Absorb one day's markdown file into rows, if it exists.
 *
 * Called before a day is rendered and on the write path for the open day, so
 * anything a human or a legacy writer put in the file becomes a row rather
 * than being overwritten by the render. Returns undefined when there is no
 * file — the normal case for a day that was born as rows.
 *
 * Never throws: an unreadable daily file must not stop a capture or a
 * nightly. The cost of skipping is that a hand-edited line stays only in the
 * file; the cost of throwing is losing the write that is in flight.
 */
export async function absorbDay(
  store: JournalStore,
  personaDir: string,
  persona: string,
  date: string,
): Promise<JournalIngestResult | undefined> {
  const path = join(personaDir, "memory", `${date}.md`);
  if (!existsSync(path)) return undefined;
  try {
    return ingestJournalMarkdown(store, persona, date, await readFile(path, "utf8"));
  } catch (e) {
    log.warn("journal: could not absorb daily file", {
      persona,
      date,
      error: (e as Error).message,
    });
    return undefined;
  }
}

/**
 * Open the journal table on its own connection.
 *
 * Mirrors `openDrawerStore` — same file, same WAL mode, same busy timeout, so
 * a capture racing a heartbeat waits instead of failing.
 */
export async function openJournalStore(
  dbPath: string,
): Promise<{ store: JournalStore; db: Database; close: () => void }> {
  // Create the parent dir the way openMemoryStore does: a caller may name a
  // database in a persona tree that has not been scaffolded yet, and bun's
  // `create: true` creates the FILE, not the directory above it.
  if (dbPath !== ":memory:") await mkdir(dirname(dbPath), { recursive: true });
  const db = new Database(dbPath, { create: true });
  db.exec("PRAGMA busy_timeout = 5000");
  await enableWalMode(db);
  const store = new JournalStore(db);
  return { store, db, close: () => db.close() };
}

/**
 * The single journal WRITE path: append a row, and index it immediately.
 *
 * Every writer goes through here — `memory capture`, the scheduler's
 * commitment line, the drawer-import log. One writer is the whole reason the
 * duplication is fixable: a second one appending markdown directly would put
 * the file and the table back into disagreement, which is exactly how the
 * drawers ended up with two copies of everything before #417.
 *
 * No markdown is written. The open day exists as rows and as an INDEX entry
 * (see `indexOpenDay`); its file appears when the nightly renders it. That
 * ordering is what makes the day durable in two independent places at every
 * moment: before the render it is rows + index, after it is rows + index +
 * file, and only once a LATER nightly re-confirms the file do the rows go.
 *
 * Best-effort by contract: returns `false` rather than throwing, because a
 * SQLite hiccup must not fail the command whose side effect already happened.
 */
export async function writeJournalEntry(
  dbPath: string,
  personaDir: string,
  input: AppendJournalInput,
  opts: { indexPath?: string; skipIndex?: boolean } = {},
): Promise<boolean> {
  try {
    const { store, close } = await openJournalStore(dbPath);
    try {
      // Absorb first: on a box upgrading mid-day the old code left a file
      // behind, and its contents have to become rows before this entry lands
      // or the render at midnight would publish a day missing its morning.
      await absorbDay(store, personaDir, input.persona, input.date);
      store.append(input);
      if (!opts.skipIndex) {
        await indexOpenDay(store, input.persona, input.date, opts.indexPath);
      }
      return true;
    } finally {
      close();
    }
  } catch (e) {
    log.warn("journal: entry write failed", {
      persona: input.persona,
      date: input.date,
      error: (e as Error).message,
    });
    return false;
  }
}
