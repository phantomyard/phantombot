/**
 * Markdown → `journal_entries`, and back out again — the migration half of #461.
 *
 * Shaped after the drawer retirement (#417/#418, `drawerRetire.ts`): ingest is
 * ONE-WAY and IDEMPOTENT, ids are content-derived so re-running costs nothing,
 * and no markdown is ever deleted. A closed day's file stays on disk exactly as
 * it was written — the rows are the read path, the file is the artefact.
 *
 * The one file that IS rewritten is TODAY'S, by `mirrorDay`, and only after its
 * current contents have been ingested. That order is load-bearing: it is what
 * makes a line appended to the file by hand (or by a tool that has not moved to
 * rows yet) get absorbed rather than clobbered. Sync-then-write, never
 * write-over — the same rule that keeps the drawers from ending up with two
 * disagreeing copies.
 *
 * Ingest also DEDUPLICATES on the way in, which is where the headline number
 * comes from. `memory capture --tag decision --tag lesson` wrote the same
 * paragraph twice, once under each tag; both lines parse to the same body, so
 * they collide on `content_norm` and land as ONE row carrying both tags.
 */

import { Database } from "bun:sqlite";
import { existsSync } from "node:fs";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import { log } from "../lib/logger.js";
import { enableWalMode } from "./store.ts";
import {
  JournalStore,
  renderDay,
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

/** `YYYY-MM-DD.md` — a daily file, as opposed to a drawer or a note. */
const DAILY_FILE = /^(\d{4}-\d{2}-\d{2})\.md$/;

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
 * Ingest every `memory/YYYY-MM-DD.md` for a persona.
 *
 * Runs on the heartbeat, so a box that has not migrated yet converges within
 * 30 minutes of the upgrade with no operator step, and a persona whose owner
 * hand-edited a daily file gets that content into the table. Costs nothing on
 * a converged box: every id already exists, so every append is a merge.
 */
export async function ingestJournalDir(
  store: JournalStore,
  personaDir: string,
  persona: string,
): Promise<JournalIngestResult[]> {
  const memDir = join(personaDir, "memory");
  if (!existsSync(memDir)) return [];
  const names = (await readdir(memDir)).filter((n) => DAILY_FILE.test(n)).sort();
  const out: JournalIngestResult[] = [];
  for (const name of names) {
    const date = DAILY_FILE.exec(name)![1]!;
    let text: string;
    try {
      text = await readFile(join(memDir, name), "utf8");
    } catch {
      // An unreadable day must not cost the other days their ingest.
      continue;
    }
    out.push(ingestJournalMarkdown(store, persona, date, text));
  }
  return out;
}

/**
 * Re-render ONE day's markdown from its rows, after absorbing whatever the
 * file currently holds.
 *
 * Only the OPEN day is mirrored. Rewriting closed days would churn the mtime +
 * size fingerprint the nightly sweep uses to decide what it has already
 * distilled, re-queueing weeks of finished work for no gain — and the whole
 * point of rows is that nothing needs to read those files again anyway.
 *
 * The file survives as the human-readable artefact and as the unit the
 * FTS/vector indexer walks; the PROMPT path no longer reads it.
 */
export async function mirrorDay(
  store: JournalStore,
  personaDir: string,
  persona: string,
  date: string,
): Promise<void> {
  const path = join(personaDir, "memory", `${date}.md`);
  if (existsSync(path)) {
    try {
      ingestJournalMarkdown(store, persona, date, await readFile(path, "utf8"));
    } catch {
      // Unreadable: fall through and write what the rows hold. Refusing to
      // mirror would leave the capture invisible to search entirely.
    }
  }
  const entries = store.listDay(persona, date);
  if (entries.length === 0) return;
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, renderDay(date, entries), "utf8");
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
 * The single journal WRITE path: append a row, then re-render today's mirror.
 *
 * Every writer goes through here — `memory capture`, the scheduler's
 * commitment line, the drawer-import log. One writer is the whole reason the
 * duplication is fixable: a second one that appends markdown directly would
 * put the file and the table back into disagreement, which is exactly how the
 * drawers ended up with two copies of everything before #417.
 *
 * Best-effort by contract: it returns `false` rather than throwing, because a
 * SQLite hiccup must not fail the command whose side effect already happened.
 */
export async function writeJournalEntry(
  dbPath: string,
  personaDir: string,
  input: AppendJournalInput,
): Promise<boolean> {
  try {
    const { store, close } = await openJournalStore(dbPath);
    try {
      store.append(input);
      await mirrorDay(store, personaDir, input.persona, input.date);
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
