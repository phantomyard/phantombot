/**
 * The nightly's housekeeping on the memory DATABASE — issue #417.
 *
 * Compaction (stage three) keeps the prompt FILES inside their budgets. This
 * is its counterpart for the rows: now that the drawers are the database
 * rather than five markdown files, the two things the files used to give us
 * for free have to be done explicitly.
 *
 *   RETIREMENT. `decisions.md` grew to 684 KB because nothing ever pruned it —
 *     every superseded decision sat in the file forever, and compaction
 *     deliberately would not rewrite a drawer. Rows retire instead of being
 *     deleted: `sweepDormant` moves beliefs whose decayed score fell under the
 *     floor to `dormant`, so they stop being injected and stay queryable. That
 *     is the same "never delete, stop ranking" rule, made mechanical.
 *
 *   DURABILITY. A markdown drawer was recoverable from any backup, any git
 *     checkout, or a text editor's undo. A row is recoverable from a snapshot
 *     or not at all — so the sweep takes one, verified, and keeps a handful of
 *     restore points (`memory/dbBackup.ts`).
 *
 * The snapshot is taken LAST, after distillation, compaction and the dormancy
 * sweep have finished. A restore point should represent a settled night, not
 * a database mid-rewrite — and if a stage corrupted something, the integrity
 * check in front of the snapshot is what refuses to rotate that corruption
 * into the restore points.
 */

import type { WriteSink } from "./io.ts";
import { log } from "./logger.ts";
import {
  backupMemoryDb,
  type BackupResult,
} from "../memory/dbBackup.ts";
import { openDrawerStore } from "../memory/drawerSync.ts";

export interface MaintenanceResult {
  /** Beliefs moved to `dormant` this run. */
  dormant: number;
  backup?: BackupResult;
  /** Anything that failed. Reported, never thrown — see below. */
  errors: string[];
}

/**
 * Run the database housekeeping for one persona.
 *
 * Never throws — it runs at the tail of a sweep that has already done the
 * expensive cognitive work, and a failed snapshot must not abort the sweep
 * that produced the data worth snapshotting. Failures are RETURNED, and the
 * caller decides what they mean; the nightly driver folds them into the
 * sweep's errors, because a memory database that cannot be verified or backed
 * up is exactly the condition `doctor` and the ledger exist to make visible.
 */
export async function runMemoryMaintenance(input: {
  dbPath: string;
  persona: string;
  keep?: number;
  now?: Date;
  out?: WriteSink;
}): Promise<MaintenanceResult> {
  const now = input.now ?? new Date();
  const write = (t: string) => input.out?.write(t);
  const result: MaintenanceResult = { dormant: 0, errors: [] };

  try {
    const { store, close } = await openDrawerStore(input.dbPath);
    try {
      const moved = store.sweepDormant(input.persona, now);
      result.dormant = moved.length;
      if (moved.length > 0) {
        write(
          `nightly: ${moved.length} drawer entr${moved.length === 1 ? "y" : "ies"} ` +
            `went dormant (queryable, no longer injected)\n`,
        );
      }
    } finally {
      close();
    }
  } catch (e) {
    const msg = `dormancy sweep: ${(e as Error).message}`;
    result.errors.push(msg);
    log.warn("nightly: dormancy sweep failed", { error: (e as Error).message });
  }

  try {
    const backup = await backupMemoryDb({
      dbPath: input.dbPath,
      keep: input.keep,
      now,
    });
    result.backup = backup;
    if (backup.status === "taken") {
      write(
        `nightly: memory snapshot ${backup.path} ` +
          `(${Math.round((backup.bytes ?? 0) / 1024)} KB)` +
          (backup.pruned.length > 0
            ? `, ${backup.pruned.length} older point(s) rotated out`
            : "") +
          `\n`,
      );
    } else if (backup.status === "refused") {
      // Loud on purpose: an unhealthy memory database is the one condition
      // where doing nothing is right AND the operator has to know tonight.
      const msg = `memory database failed its integrity check: ${backup.integrity.detail}`;
      result.errors.push(msg);
      write(
        `nightly: ${msg}\n` +
          `nightly: no snapshot taken — existing restore points are intact.\n` +
          `nightly: recover with 'phantombot memory restore --list' then ` +
          `'phantombot memory restore --from <point>'\n`,
      );
    }
  } catch (e) {
    const msg = `snapshot: ${(e as Error).message}`;
    result.errors.push(msg);
    log.warn("nightly: snapshot failed", { error: (e as Error).message });
  }

  return result;
}
