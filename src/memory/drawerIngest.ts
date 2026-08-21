/**
 * One-way ingest of the markdown drawers into `drawer_entries` (issue #410).
 *
 * The five drawers were written by hand and by four years of nightly sweeps, so
 * the shape is not uniform. Two entry forms exist in the wild and both are
 * supported:
 *
 *   ### A heading                    <- an entry whose body runs to the next
 *   body line                           `###` or `##`
 *   - detail bullet
 *
 *   - - [norm] one-line capture      <- the flat bullets the heartbeat appends
 *
 * `## 2026-06-04` section headers date everything under them; a non-date
 * section header (`## Family`) carries no date, so those entries fall back to
 * the file's mtime. Blockquote preamble and `---` rules are skipped.
 *
 * THE INGEST NEVER DELETES OR REWRITES THE MARKDOWN. It reads, files rows, and
 * stops. Retiring the file is a separate, later step gated on a re-verify —
 * the same "archive, never rm" rule stage one runs on. Because every id is
 * derived from normalized content, re-running the ingest is a no-op that
 * reaffirms rather than duplicates, so it is safe to run on every startup while
 * the two representations live side by side.
 */

import { readFile, stat } from "node:fs/promises";
import { basename, join } from "node:path";
import { existsSync } from "node:fs";
import { DRAWER_KINDS, type DrawerKind, type DrawerStore } from "./drawers.ts";

export interface ParsedDrawerEntry {
  content: string;
  /** Section date if the enclosing `## ` header was a date, else undefined. */
  date?: string;
}

export interface IngestResult {
  kind: DrawerKind;
  path: string;
  /** Entries parsed out of the file. */
  parsed: number;
  /** Rows newly inserted (first ever sighting). */
  inserted: number;
  /** Rows that already existed and were reaffirmed instead of duplicated. */
  reaffirmed: number;
}

const DATE_HEADER = /^##\s+(\d{4}-\d{2}-\d{2})\s*$/;
const SECTION_HEADER = /^##\s+(?!#)/;
const ENTRY_HEADER = /^###\s+(.*)$/;
const FLAT_BULLET = /^-\s+(.*)$/;

/**
 * Split one drawer file into entries.
 *
 * Pure and exported so the parser can be tested against real drawer text
 * without a database — the risky half of this migration is the parse, not the
 * insert.
 */
export function parseDrawer(text: string): ParsedDrawerEntry[] {
  const out: ParsedDrawerEntry[] = [];
  let date: string | undefined;
  /** The entry being accumulated, if any, and which shape it came from. */
  let open: { lines: string[]; date?: string; block: boolean } | undefined;

  const flush = () => {
    if (!open) return;
    const content = open.lines.join("\n").trim();
    if (content) out.push({ content, date: open.date });
    open = undefined;
  };

  let prevBlank = true;
  for (const raw of text.split("\n")) {
    const line = raw.trimEnd();
    const blank = line.trim() === "";
    const wasBlank = prevBlank;
    prevBlank = blank;
    const dateHeader = DATE_HEADER.exec(line);
    if (dateHeader) {
      flush();
      date = dateHeader[1];
      continue;
    }
    if (SECTION_HEADER.test(line)) {
      flush();
      // A non-date section (`## Family`) groups entries but dates nothing.
      date = undefined;
      continue;
    }
    const entryHeader = ENTRY_HEADER.exec(line);
    if (entryHeader) {
      flush();
      open = { lines: [entryHeader[1]!.trim()], date, block: true };
      continue;
    }
    // A bullet at COLUMN 0 starts an entry of its own. Matching on the
    // untrimmed line is what keeps an indented sub-bullet attached to the
    // bullet it qualifies, instead of promoting it to a standalone entry with
    // its own id and decay clock.
    //
    // Inside a `###` block it takes a BLANK LINE first to break out: a bullet
    // running straight on from the block body is one of that entry's detail
    // bullets (the dominant shape in the drawers), while a bullet after a
    // blank line is the flat capture shape and would otherwise be swallowed
    // into whatever block happened to precede it.
    const bullet = FLAT_BULLET.exec(line);
    if (bullet && (!open?.block || wasBlank)) {
      flush();
      // The heartbeat writes `- - [norm] …`, so strip the doubled dash.
      const content = bullet[1]!.replace(/^-\s+/, "").trim();
      if (content) open = { lines: [content], date, block: false };
      continue;
    }
    if (open?.block) {
      // Inside a `###` block: everything up to the next header or column-0
      // bullet is body.
      open.lines.push(line);
      continue;
    }
    if (open) {
      // Continuation of a flat bullet: indented lines belong to it, a blank
      // line or column-0 prose ends it.
      if (blank) flush();
      else if (/^\s/.test(raw)) open.lines.push(line);
      else flush();
      continue;
    }
    // Anything else at top level (preamble blockquote, `---`, `# Title`,
    // blank) is not an entry.
  }
  flush();
  return out;
}

/**
 * `memory/<kind>.md` for a drawer kind.
 *
 * POSIX separator on every platform, deliberately: this string is compared
 * against the persona-scaffold paths and the threat judge's BRIEFING_DRAWERS,
 * both of which are written with forward slashes, and `join()` on Windows
 * would return `memory\\decisions.md` and quietly break that equality. Every
 * consumer either joins it onto the persona dir (which normalizes) or displays
 * it, so a forward slash is correct in both.
 */
export function drawerPath(kind: DrawerKind): string {
  return `memory/${kind}.md`;
}

/**
 * Ingest one drawer file into rows. Returns counts; writes nothing to disk.
 *
 * `now` bounds a section date from the future (a typo'd header must not park
 * an entry's decay clock in 2027) and stands in for an undated entry only when
 * the file has no usable mtime.
 */
export async function ingestDrawerFile(
  store: DrawerStore,
  personaDir: string,
  persona: string,
  kind: DrawerKind,
  now: Date = new Date(),
): Promise<IngestResult> {
  const rel = drawerPath(kind);
  const abs = join(personaDir, rel);
  const result: IngestResult = {
    kind,
    path: rel,
    parsed: 0,
    inserted: 0,
    reaffirmed: 0,
  };
  if (!existsSync(abs)) return result;

  const text = await readFile(abs, "utf8");
  const fallback = await fileDate(abs, now);
  const entries = parseDrawer(text);
  result.parsed = entries.length;

  for (const entry of entries) {
    const assertedAt = entryDate(entry.date, fallback, now);
    // `self`, not `principal`: these lines are the persona's own filed beliefs,
    // and the nightly promoted a good number of them out of `origin: "task"`
    // turns that the fact pool deliberately holds at `unverified`. Defaulting
    // them to the top trust tier would flatten that distinction in one pass,
    // with nothing left on disk to recover it from.
    //
    // `fileEntry` reports insert-vs-reaffirm, so the counts cost no extra read
    // — a pre-`get()` per entry would double the queries across ~4500 rows.
    const { inserted } = store.fileEntry({
      persona,
      kind,
      content: entry.content,
      source: "self",
      origin: rel,
      assertedAt,
    });
    if (inserted) result.inserted += 1;
    else result.reaffirmed += 1;
  }
  return result;
}

/** Ingest all five drawers. */
export async function ingestDrawers(
  store: DrawerStore,
  personaDir: string,
  persona: string,
  now: Date = new Date(),
): Promise<IngestResult[]> {
  const out: IngestResult[] = [];
  for (const kind of DRAWER_KINDS) {
    out.push(await ingestDrawerFile(store, personaDir, persona, kind, now));
  }
  return out;
}

function entryDate(date: string | undefined, fallback: Date, now: Date): Date {
  if (!date) return fallback;
  const parsed = new Date(`${date}T00:00:00Z`);
  if (Number.isNaN(parsed.getTime())) return fallback;
  return parsed > now ? now : parsed;
}

async function fileDate(abs: string, now: Date): Promise<Date> {
  try {
    const s = await stat(abs);
    return s.mtime > now ? now : s.mtime;
  } catch {
    return now;
  }
}

/** Human label for a result line, e.g. `decisions.md: 1411 parsed, 1347 new`. */
export function describeIngest(r: IngestResult): string {
  return (
    `${basename(r.path)}: ${r.parsed} parsed, ${r.inserted} new, ` +
    `${r.reaffirmed} already filed`
  );
}
