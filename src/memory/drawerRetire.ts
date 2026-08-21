/**
 * Retiring the markdown drawers — the last step of issue #417.
 *
 * The five drawer files stop being memory and become an archived artefact.
 * After this runs, `drawer_entries` is the source of truth: the heartbeat
 * files rows, the threat judge is briefed from rows, and `--export` is how a
 * human gets markdown back.
 *
 * This is the only destructive step in the whole feature, so it is gated on
 * EVIDENCE rather than on a flag:
 *
 *   GATE 1 — COVERAGE. Re-ingest the live file, then parse it independently
 *     and assert every entry it contains is present as a row. This is the
 *     ingest's own homework being marked: a parser bug that silently drops an
 *     entry shape fails here, before anything is removed.
 *   GATE 2 — RECOVERABILITY. Round-trip the rows back out to markdown and
 *     assert the export re-parses to the same id set (`drawerExport.ts`). A
 *     drawer that cannot be regenerated is a drawer that must keep its file.
 *
 * A drawer that fails either gate is LEFT ALONE — file intact, no archive, a
 * warning returned. Retirement is per-drawer for exactly this reason: one
 * unparseable `lessons.md` must not hold `norms` hostage, and equally must not
 * be swept along with the four that passed.
 *
 * And the file is never deleted before it is copied. `memory/archive/<date>/`
 * gets the original bytes AND the regenerated export, so the pre-image and the
 * artefact sit side by side — same archive-before-rewrite rule the compaction
 * stage runs on. `rm` is not a step here; `copy, verify, unlink` is.
 */

import { existsSync } from "node:fs";
import { copyFile, mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";

import type { Database } from "bun:sqlite";

import { log } from "../lib/logger.ts";
import { archiveDirPath } from "../lib/nightlyCompact.ts";
import {
  DRAWER_KINDS,
  drawerEntryId,
  type DrawerKind,
  type DrawerStore,
} from "./drawers.ts";
import { drawerPath, ingestDrawerFile, parseDrawer } from "./drawerIngest.ts";
import { verifyDrawerRoundTrip } from "./drawerExport.ts";
import { clearDrawerHold, noteDrawerHold } from "./drawerSync.ts";

export interface DrawerRetirement {
  kind: DrawerKind;
  path: string;
  /** `retired` | `absent` (already gone) | `held` (a gate failed). */
  status: "retired" | "absent" | "held";
  /** Entries parsed out of the file on its final ingest. */
  entries?: number;
  /** Where the original bytes went. Set only on `retired`. */
  archivedTo?: string;
  /** Why the drawer was held back. Set only on `held`. */
  reason?: string;
  /**
   * Whether this hold is new — first time held, or held for a NEW reason.
   * Only set when a `db` was supplied; that is what remembers across fires.
   * Callers that log on a schedule use this to warn on the transition and
   * stay quiet on the repeat.
   */
  firstHold?: boolean;
  /** When this hold started, ISO. Set alongside `firstHold`. */
  heldSince?: string;
}

/**
 * Retire whichever drawer files are still on disk.
 *
 * Idempotent: a persona whose drawers are already retired reports `absent` for
 * all five and touches nothing, which is what makes it safe to call from the
 * heartbeat on every fire.
 */
export async function retireDrawers(input: {
  store: DrawerStore;
  /**
   * The same connection the store was opened on. Optional: without it
   * retirement still works, it just cannot tell a first hold from the four
   * hundredth, so every outcome reports as new.
   */
  db?: Database;
  personaDir: string;
  persona: string;
  kinds?: readonly DrawerKind[];
  now?: Date;
}): Promise<DrawerRetirement[]> {
  const now = input.now ?? new Date();
  const stamp = now.toISOString().slice(0, 10);
  const out: DrawerRetirement[] = [];

  for (const kind of input.kinds ?? DRAWER_KINDS) {
    const rel = drawerPath(kind);
    const abs = join(input.personaDir, rel);
    if (!existsSync(abs)) {
      out.push(track(input, { kind, path: rel, status: "absent" }, now));
      continue;
    }
    try {
      out.push(track(input, await retireOne(input, kind, rel, abs, stamp, now), now));
    } catch (e) {
      // A drawer that throws keeps its file. Every failure mode here — a
      // read error, a locked database, a full disk mid-archive — resolves to
      // "the markdown stays", because the file is still the only copy the
      // moment we cannot prove otherwise.
      const reason = (e as Error).message;
      const held = track(
        input,
        { kind, path: rel, status: "held", reason },
        now,
      );
      // Same rule as the heartbeat's aggregate line: the transition is a
      // warning, the standing condition is not. `doctor` is where a drawer
      // that has been stuck for a week gets reported.
      if (held.firstHold === false) {
        log.info("drawerRetire: still held back", { kind, error: reason });
      } else {
        log.warn("drawerRetire: held back", { kind, error: reason });
      }
      out.push(held);
    }
  }
  return out;
}

/**
 * Persist the hold/clear side of an outcome and stamp it with `firstHold`.
 *
 * A no-op without a `db` — the outcome is returned untouched, which keeps
 * every existing caller (and the tests) working on a store alone.
 */
function track(
  input: { db?: Database; persona: string },
  r: DrawerRetirement,
  now: Date,
): DrawerRetirement {
  if (!input.db) return r;
  if (r.status !== "held") {
    clearDrawerHold(input.db, input.persona, r.path);
    return r;
  }
  const { firstHold, heldSince } = noteDrawerHold(
    input.db,
    input.persona,
    r.path,
    r.reason ?? "",
    now,
  );
  return { ...r, firstHold, heldSince };
}

async function retireOne(
  input: {
    store: DrawerStore;
    personaDir: string;
    persona: string;
    now?: Date;
  },
  kind: DrawerKind,
  rel: string,
  abs: string,
  stamp: string,
  now: Date,
): Promise<DrawerRetirement> {
  const { store, personaDir, persona } = input;

  // Final ingest: whatever was appended since the last heartbeat lands as rows
  // before we start reasoning about whether the file is redundant.
  const ingested = await ingestDrawerFile(store, personaDir, persona, kind, now);

  // GATE 1 — coverage, checked against the file's own text rather than the
  // ingest's return value. The counts come from the same code path that would
  // be at fault; an independent parse is what makes this a check.
  const text = await readFile(abs, "utf8");
  const fileIds = parseDrawer(text).map((e) =>
    drawerEntryId(persona, kind, e.content),
  );
  const rowIds = new Set(store.list(persona, kind).map((e) => e.id));
  const uncovered = [...new Set(fileIds)].filter((id) => !rowIds.has(id));
  if (uncovered.length > 0) {
    return {
      kind,
      path: rel,
      status: "held",
      entries: ingested.parsed,
      reason:
        `${uncovered.length} entr${uncovered.length === 1 ? "y" : "ies"} in ` +
        `${rel} are not in the table — file kept`,
    };
  }

  // GATE 2 — recoverability.
  const trip = verifyDrawerRoundTrip(store, persona, kind);
  if (!trip.ok) {
    return {
      kind,
      path: rel,
      status: "held",
      entries: ingested.parsed,
      reason:
        `export round-trip lost ${trip.missing.length} and invented ` +
        `${trip.extra.length} entries — file kept`,
    };
  }

  const dir = archiveDirPath(personaDir, stamp);
  await mkdir(dir, { recursive: true });
  const base = rel.replace(/[\\/]/g, "__");
  let dest = join(dir, base);
  for (let n = 2; existsSync(dest) && n < 1000; n++) {
    dest = join(dir, base.replace(/(\.md)?$/, `.${n}$1`));
  }
  await copyFile(abs, dest);
  // The regenerated export goes in beside the pre-image, so the archive shows
  // BOTH what was on disk and what the table renders back — the diff between
  // the two is the whole audit trail of this migration.
  await writeFile(`${dest}.exported`, trip.markdown, "utf8");
  await unlink(abs);

  log.info("drawerRetire: retired drawer", {
    persona,
    kind,
    entries: rowIds.size,
    archivedTo: dest,
  });
  return {
    kind,
    path: rel,
    status: "retired",
    entries: rowIds.size,
    archivedTo: dest,
  };
}

/** Human line for one retirement outcome. */
export function describeRetirement(r: DrawerRetirement): string {
  switch (r.status) {
    case "retired":
      return `${r.path}: retired (${r.entries} rows), archived to ${r.archivedTo}`;
    case "absent":
      return `${r.path}: already retired`;
    case "held":
      return `${r.path}: HELD — ${r.reason}`;
  }
}
