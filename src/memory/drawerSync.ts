/**
 * The wiring that makes `drawer_entries` a LIVE representation — issue #410,
 * final stage.
 *
 * Stages two and three of #410 landed the row schema (`drawers.ts`) and the
 * markdown parser (`drawerIngest.ts`) and then stopped: nothing in `src/`
 * imported either module, so the table was never created on a real box, never
 * filled, and never read. A schema no caller reaches is not half a feature, it
 * is dead code that reads like a finished one — which is exactly how it got
 * signed off. This module is the missing half, and the rule it exists to
 * enforce is: no drawer code merges without a caller.
 *
 * Two jobs:
 *
 *   1. SYNC (`syncDrawers`). Parse the five markdown drawers into rows on the
 *      heartbeat's cadence. Idempotent by construction — ids are content
 *      derived, so a re-run reaffirms rather than duplicates — and skipped
 *      entirely when the file's content hash is unchanged since the last
 *      sync, so the steady-state cost is five hashes rather than ~4500 upserts
 *      every 30 minutes.
 *
 *   2. RENDER (`renderDrawer`). Produce the drawer text the threat judge is
 *      briefed from, out of RANKED rows instead of raw file bytes. This is the
 *      part the rows were always for: the file path can only offer "the first
 *      16 KB of a 663 KB file", which is entries from 2024 that happen to sit
 *      at the top, while ranked rows offer the entries with the highest
 *      decayed score — and drop superseded and dormant ones entirely.
 *
 * MARKDOWN REMAINS THE SOURCE OF TRUTH. The files are still what the nightly
 * writes, what the heartbeat appends to, what the owner edits, and what a
 * third-party tool merges into (phantomtools' `<!-- ORG:BEGIN norms -->`
 * block). Rows are a derived, rebuildable projection: delete the table and the
 * next heartbeat reconstructs it. That direction is deliberate and this module
 * must not invert it — nothing here ever writes markdown.
 *
 * Consequently every read has a FILE FALLBACK. A persona whose heartbeat has
 * not run yet, a fresh install, a wiped database: the briefing degrades to the
 * old verbatim-file behaviour rather than silently briefing the judge on an
 * empty drawer. Failing open to "no norms at all" would make the judge cry
 * wolf on routine operations, which is the precise failure norms exist to
 * prevent.
 */

import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { Database } from "bun:sqlite";

import { log } from "../lib/logger.ts";
import {
  DRAWER_KINDS,
  DrawerStore,
  type DrawerEntry,
  type DrawerKind,
} from "./drawers.ts";
import {
  drawerPath,
  ingestDrawerFile,
  type IngestResult,
} from "./drawerIngest.ts";
import { enableWalMode } from "./store.ts";

/**
 * Content hashes of the markdown files last ingested, so an unchanged drawer
 * costs one read and one hash instead of a full parse-and-upsert pass.
 *
 * Deliberately hashes CONTENT rather than trusting mtime+size: the drawers are
 * appended to by the heartbeat and rewritten wholesale by the nightly
 * compaction stage, and a rewrite that lands in the same millisecond at the
 * same length is exactly the case where a skipped sync would strand the rows
 * on stale text with nothing to signal it.
 */
const SYNC_STATE_SCHEMA = `
CREATE TABLE IF NOT EXISTS drawer_sync_state (
  persona     TEXT NOT NULL,
  path        TEXT NOT NULL,
  content_sha TEXT NOT NULL,
  synced_at   TEXT NOT NULL,
  PRIMARY KEY (persona, path)
);
`;

export interface DrawerSyncResult {
  /** Per-drawer ingest counts. Absent for drawers skipped as unchanged. */
  ingested: IngestResult[];
  /** Drawers whose content hash matched the last sync. */
  unchanged: DrawerKind[];
  /** Drawers with no markdown file on disk yet. */
  missing: DrawerKind[];
}

/**
 * Open the drawer tables on the shared memory database.
 *
 * Same file as `turns` and `tasks` — the drawers are memory, and a second
 * database file would mean a second WAL, a second busy_timeout and a second
 * thing to back up. Pragmas mirror `openMemoryStore` exactly (busy_timeout
 * FIRST, then the retrying WAL switch) because this connection may be the one
 * that creates the file on a fresh install.
 */
export async function openDrawerStore(
  dbPath: string,
): Promise<{ store: DrawerStore; db: Database; close: () => void }> {
  const db = new Database(dbPath, { create: true });
  db.exec("PRAGMA busy_timeout = 5000");
  await enableWalMode(db);
  db.exec(SYNC_STATE_SCHEMA);
  const store = new DrawerStore(db);
  return { store, db, close: () => db.close() };
}

function sha256(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

function lastSyncedSha(
  db: Database,
  persona: string,
  path: string,
): string | undefined {
  const row = db
    .query(
      "SELECT content_sha FROM drawer_sync_state WHERE persona = ? AND path = ?",
    )
    .get(persona, path) as { content_sha: string } | null;
  return row?.content_sha;
}

function recordSync(
  db: Database,
  persona: string,
  path: string,
  sha: string,
  now: Date,
): void {
  db.query(
    `INSERT INTO drawer_sync_state (persona, path, content_sha, synced_at)
     VALUES (?, ?, ?, ?)
     ON CONFLICT (persona, path) DO UPDATE
       SET content_sha = excluded.content_sha, synced_at = excluded.synced_at`,
  ).run(persona, path, sha, now.toISOString());
}

/**
 * Project the five markdown drawers into rows.
 *
 * Never throws for one bad drawer: a parse failure on `lessons.md` must not
 * cost the judge its `norms`. Each drawer is independent and errors are logged
 * and skipped, which is the same posture the briefing reader takes.
 *
 * The sync marker is written only AFTER a successful ingest, so a crash
 * mid-drawer re-runs that drawer next heartbeat instead of marking stale text
 * as done.
 */
export async function syncDrawers(input: {
  store: DrawerStore;
  db: Database;
  personaDir: string;
  persona: string;
  /** Re-ingest even when the content hash is unchanged. */
  force?: boolean;
  now?: Date;
}): Promise<DrawerSyncResult> {
  const now = input.now ?? new Date();
  const out: DrawerSyncResult = { ingested: [], unchanged: [], missing: [] };

  for (const kind of DRAWER_KINDS) {
    const rel = drawerPath(kind);
    const abs = join(input.personaDir, rel);
    if (!existsSync(abs)) {
      out.missing.push(kind);
      continue;
    }
    try {
      const sha = sha256(await readFile(abs, "utf8"));
      if (!input.force && lastSyncedSha(input.db, input.persona, rel) === sha) {
        out.unchanged.push(kind);
        continue;
      }
      const result = await ingestDrawerFile(
        input.store,
        input.personaDir,
        input.persona,
        kind,
        now,
      );
      recordSync(input.db, input.persona, rel, sha, now);
      out.ingested.push(result);
    } catch (e) {
      log.warn("drawerSync: drawer ingest failed", {
        persona: input.persona,
        drawer: rel,
        error: (e as Error).message,
      });
    }
  }
  return out;
}

/**
 * Ranked entries for one drawer, rendered as the bullet list the briefing and
 * the CLI both print.
 *
 * Returns undefined when the drawer has no injectable rows, which is the
 * caller's signal to fall back to the markdown file rather than brief on
 * nothing.
 */
export function renderDrawer(
  store: DrawerStore,
  persona: string,
  kind: DrawerKind,
  opts: { limit?: number; now?: Date } = {},
): string | undefined {
  const entries = store.ranked(persona, kind, opts);
  if (entries.length === 0) return undefined;
  return entries.map(renderEntry).join("\n");
}

/**
 * One entry as a single markdown bullet.
 *
 * Newlines inside a multi-line `###` block entry are folded to spaces on
 * purpose: the briefing is a flat list the judge skims, and a bullet whose
 * body spans lines is indistinguishable from the start of the next entry once
 * the byte cap cuts through it.
 */
function renderEntry(entry: DrawerEntry): string {
  const oneLine = entry.content.replace(/\s*\n\s*/g, " ").trim();
  return `- ${oneLine}`;
}

export interface DrawerBriefingSection {
  kind: DrawerKind;
  text: string;
  /** `rows` when rendered from drawer_entries, `file` when the fallback ran. */
  from: "rows" | "file";
}

/**
 * Briefing text for one drawer: ranked rows if there are any, else the raw
 * markdown file, else nothing.
 *
 * The fallback is per-DRAWER, not per-briefing: a persona part-way through its
 * first sync can legitimately have rows for `decisions` and none for `norms`,
 * and "all or nothing" would there throw away the drawer that had been done.
 */
export async function drawerSection(
  store: DrawerStore,
  personaDir: string,
  persona: string,
  kind: DrawerKind,
  opts: { limit?: number; now?: Date } = {},
): Promise<DrawerBriefingSection | undefined> {
  let rows: string | undefined;
  try {
    rows = renderDrawer(store, persona, kind, opts);
  } catch (e) {
    // The store opened but this drawer's query did not survive it (corrupt
    // page, schema older than the code). Every other failure here degrades to
    // the markdown file, and so does this one — a broken row query must not be
    // the one path that briefs the judge on nothing.
    log.warn("drawerSection: row query failed, falling back to the file", {
      kind,
      persona,
      error: (e as Error).message,
    });
  }
  if (rows) return { kind, text: rows, from: "rows" };
  try {
    const text = (
      await readFile(join(personaDir, drawerPath(kind)), "utf8")
    ).trim();
    if (text.length > 0) return { kind, text, from: "file" };
  } catch {
    // Missing/unreadable drawer — the caller briefs on what exists.
  }
  return undefined;
}
