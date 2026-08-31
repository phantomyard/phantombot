/**
 * Restore points for the memory database — issue #417.
 *
 * Retiring the markdown drawers moves the persona's decisions, lessons,
 * people, commitments and norms into `memory.sqlite`, alongside turn history
 * and tasks. That is the right shape, but it concentrates the blast radius:
 * before this module the only copy of that data lived in one file that nothing
 * ever backed up, and `doctor` had no opinion about whether it was even
 * readable. A single corrupt page would have been silent, permanent data loss.
 *
 * So: a rotating set of verified snapshots, and a recovery path an operator
 * can run from the message `doctor` prints.
 *
 * Three decisions worth knowing about.
 *
 * SNAPSHOTS ARE TAKEN WITH `VACUUM INTO`, not `cp`. A live SQLite database in
 * WAL mode is three files (`-wal`, `-shm`) and copying the main one while a
 * writer is mid-transaction yields a snapshot that is torn in a way
 * `integrity_check` will happily call clean. `VACUUM INTO` runs inside a read
 * transaction and writes a fully-checkpointed, self-contained database — the
 * only supported way to snapshot a hot database without stopping writers.
 *
 * A CORRUPT SOURCE IS NEVER SNAPSHOTTED. Integrity is checked BEFORE the
 * snapshot is taken and the run aborts if it fails. Without that ordering, the
 * nightly would faithfully rotate corruption into every restore point over N
 * nights and delete the last good one — a backup system that destroys exactly
 * what it exists to protect. Rotation is the reason this matters: a snapshot
 * set that only ever grows would be safe by accident, and it also fills a
 * 40 GB VPS with copies of a 300 MB database.
 *
 * A SNAPSHOT IS A HOST CONCERN, NOT A PERSONA ONE (issue #495). Several
 * personas can share one `memory.sqlite`, and since the per-persona nightly
 * instances landed they roll over within milliseconds of each other. The
 * snapshot name is stamped to the SECOND, so two sweeps in the same second
 * resolve to the SAME destination — and the second one deletes the file the
 * first is still writing, which surfaces as `disk I/O error` on an otherwise
 * healthy database. Snapshots are therefore serialised on a lock file beside
 * the restore points, and a caller may pass `coalesceMs` to say "a snapshot
 * this recent already covers me": the loser of the race reports `fresh` and
 * takes nothing, instead of failing.
 *
 * RESTORE NEVER OVERWRITES THE LIVE FILE IN PLACE. The current database is
 * moved aside to `<name>.pre-restore-<stamp>` first, so a restore from a
 * snapshot that turns out to be older than the operator thought is itself
 * reversible. The stale `-wal`/`-shm` sidecars are removed as part of the
 * swap: leaving them beside a restored file lets SQLite replay a log belonging
 * to a different database, which is how a recovery turns into a corruption.
 */

import { existsSync } from "node:fs";
import {
  copyFile,
  mkdir,
  open as openFile,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  unlink,
} from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { basename, dirname, join } from "node:path";
import { Database } from "bun:sqlite";

import { log } from "../lib/logger.ts";

/**
 * How many restore points to keep.
 *
 * Not one: a corruption discovered on Tuesday is often present in Monday's
 * snapshot too, and a single slot means the only copy is already poisoned.
 * Five nightly snapshots is far enough back to step over a bad night without
 * the disk cost becoming interesting.
 */
export const DEFAULT_KEEP = 5;

/** Sidecars SQLite leaves beside a WAL-mode database. */
const SIDECARS = ["-wal", "-shm"] as const;

const STAMP_RE = /\.(\d{8}T\d{6}Z)\.sqlite$/;

/**
 * How recent a restore point has to be for a `coalesceMs` caller to accept it
 * instead of taking its own.
 *
 * Sized for the thing it exists to absorb: sibling nightly sweeps fire within
 * milliseconds of a shared day rollover, so anything above a few seconds
 * closes the race. Five minutes leaves room for a slow sweep without ever
 * being long enough to swallow a genuine daily snapshot.
 */
export const SNAPSHOT_COALESCE_MS = 5 * 60_000;

/** How long to wait for the lock before deciding a sibling has this covered. */
const LOCK_WAIT_MS = 15_000;

/**
 * When a lock file is old enough to be treated as abandoned.
 *
 * A holder that died mid-`VACUUM INTO` leaves the file behind, and a lock that
 * outlives its process would stop every future snapshot — the failure mode
 * where the safety measure becomes the outage. Far longer than any real
 * snapshot, far shorter than a day.
 */
const LOCK_STALE_MS = 10 * 60_000;

export function backupDir(dbPath: string): string {
  return join(dirname(dbPath), "backups");
}

function lockPath(dbPath: string): string {
  return join(backupDir(dbPath), ".snapshot.lock");
}

/**
 * Serialise snapshots of one database across processes.
 *
 * `open(..., "wx")` is the atomic primitive: exactly one caller can create the
 * file, so there is no window where two processes both believe they hold it.
 * Returns a release function, or `null` if the lock stayed held for
 * `waitMs` — the caller decides whether that means skip or proceed, because
 * "someone else is snapshotting this exact database right now" is good news
 * for the nightly and merely informational for an operator who typed the
 * command.
 *
 * Exported for tests: the takeover case (a slow holder's lock cleared as
 * stale, then re-taken by a sibling) cannot be provoked deterministically
 * through `backupMemoryDb` alone.
 */
export async function acquireSnapshotLock(
  dbPath: string,
  waitMs: number,
): Promise<(() => Promise<void>) | null> {
  const path = lockPath(dbPath);
  const deadline = Date.now() + waitMs;
  for (;;) {
    try {
      const token = `${process.pid}:${randomUUID()}`;
      const handle = await openFile(path, "wx");
      await handle.writeFile(`${token} ${new Date().toISOString()}\n`);
      await handle.close();
      return async () => {
        // Only remove the lock if it is still OURS. A holder whose snapshot
        // ran past LOCK_STALE_MS has had its lock cleared and re-taken by a
        // sibling; an unconditional `rm` here would delete the SIBLING's lock
        // and let a third caller in while it was mid-`VACUUM INTO` — exactly
        // the race this lock exists to close.
        try {
          const held = await readFile(path, "utf8");
          if (!held.startsWith(`${token} `)) {
            log.warn("dbBackup: snapshot lock was taken over; not releasing", {
              path,
            });
            return;
          }
        } catch {
          return; // Already gone — nothing to release.
        }
        await rm(path, { force: true });
      };
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
      // Abandoned by a dead holder? Clear it and try once more this pass.
      try {
        const age = Date.now() - (await stat(path)).mtimeMs;
        if (age > LOCK_STALE_MS) {
          log.warn("dbBackup: clearing a stale snapshot lock", { path, age });
          await rm(path, { force: true });
          continue;
        }
      } catch {
        // The holder released it between our open and our stat — retry.
        continue;
      }
      if (Date.now() >= deadline) return null;
      await new Promise((r) => setTimeout(r, 50));
    }
  }
}

function stampNow(now: Date): string {
  return now.toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z");
}

function snapshotPath(dbPath: string, now: Date): string {
  return join(backupDir(dbPath), `${basename(dbPath, ".sqlite")}.${stampNow(now)}.sqlite`);
}

export interface IntegrityResult {
  ok: boolean;
  /** SQLite's own words. `ok` on a healthy database. */
  detail: string;
}

/**
 * `PRAGMA integrity_check` on a database file, without disturbing it.
 *
 * Opened read-only and with `create: false` so checking a path that does not
 * exist reports a fault instead of quietly creating an empty database and
 * pronouncing it healthy — the failure mode that would make `doctor` green on
 * a box whose memory file had been deleted.
 */
export function checkIntegrity(dbPath: string): IntegrityResult {
  if (!existsSync(dbPath)) return { ok: false, detail: "missing" };
  let db: Database | undefined;
  try {
    db = new Database(dbPath, { readonly: true, create: false });
    const rows = db.query("PRAGMA integrity_check").all() as Array<
      Record<string, string>
    >;
    const detail = rows
      .map((r) => Object.values(r)[0] ?? "")
      .join("; ")
      .trim();
    return { ok: detail === "ok", detail: detail || "empty result" };
  } catch (e) {
    return { ok: false, detail: (e as Error).message };
  } finally {
    db?.close();
  }
}

export interface RestorePoint {
  path: string;
  takenAt: Date;
  bytes: number;
}

/** Restore points on disk, newest first. */
export async function listRestorePoints(
  dbPath: string,
): Promise<RestorePoint[]> {
  const dir = backupDir(dbPath);
  if (!existsSync(dir)) return [];
  const out: RestorePoint[] = [];
  for (const name of await readdir(dir)) {
    const m = STAMP_RE.exec(name);
    if (!m) continue;
    const iso = m[1]!.replace(
      /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/,
      "$1-$2-$3T$4:$5:$6Z",
    );
    const takenAt = new Date(iso);
    if (Number.isNaN(takenAt.getTime())) continue;
    const full = join(dir, name);
    out.push({ path: full, takenAt, bytes: (await stat(full)).size });
  }
  return out.sort((a, b) => b.takenAt.getTime() - a.takenAt.getTime());
}

export interface BackupResult {
  /**
   * `taken` | `skipped` (source missing) | `refused` (source unhealthy) |
   * `fresh` (a recent-enough restore point already covers this run — #495).
   */
  status: "taken" | "skipped" | "refused" | "fresh";
  path?: string;
  bytes?: number;
  /** Snapshots rotated out by this run. */
  pruned: string[];
  integrity: IntegrityResult;
}

/**
 * Take a verified snapshot and rotate the old ones out.
 *
 * Returns rather than throws on an unhealthy source: the nightly calls this,
 * and a database that fails its integrity check is a thing to REPORT loudly,
 * not a reason to fail the sweep that would have reported it.
 */
export async function backupMemoryDb(input: {
  dbPath: string;
  keep?: number;
  now?: Date;
  /**
   * Accept an existing restore point younger than this instead of taking one
   * (#495). Callers that share a database with sibling processes — the
   * nightly — pass it; an operator running `phantombot memory backup` does
   * not, because an explicit request should always produce a snapshot.
   */
  coalesceMs?: number;
  /** Override the lock wait. Tests use it; nothing else should need to. */
  lockWaitMs?: number;
}): Promise<BackupResult> {
  const now = input.now ?? new Date();
  const keep = input.keep ?? DEFAULT_KEEP;
  if (!existsSync(input.dbPath)) {
    return {
      status: "skipped",
      pruned: [],
      integrity: { ok: false, detail: "missing" },
    };
  }
  const integrity = checkIntegrity(input.dbPath);
  if (!integrity.ok) {
    log.warn("dbBackup: refusing to snapshot an unhealthy database", {
      db: input.dbPath,
      detail: integrity.detail,
    });
    return { status: "refused", pruned: [], integrity };
  }

  const dir = backupDir(input.dbPath);
  await mkdir(dir, { recursive: true });

  // Everything from here to the release touches shared paths — the stamped
  // destination and the rotation set — so it happens under the lock.
  const release = await acquireSnapshotLock(
    input.dbPath,
    input.lockWaitMs ?? LOCK_WAIT_MS,
  );
  if (!release) {
    // Another process has been snapshotting this database for longer than the
    // wait. For a coalescing caller that is the answer it wanted; for an
    // operator it is still the honest one, because barging in would delete the
    // in-flight file out from under the holder.
    log.info("dbBackup: another snapshot is in flight — skipping", {
      db: input.dbPath,
    });
    return { status: "fresh", pruned: [], integrity };
  }

  try {
    if (input.coalesceMs !== undefined) {
      const [newest] = await listRestorePoints(input.dbPath);
      const age = newest ? now.getTime() - newest.takenAt.getTime() : Infinity;
      if (newest && age >= 0 && age < input.coalesceMs) {
        log.info("dbBackup: recent restore point already covers this run", {
          path: newest.path,
          ageMs: age,
        });
        return {
          status: "fresh",
          path: newest.path,
          bytes: newest.bytes,
          pruned: [],
          integrity,
        };
      }
    }

    const dest = snapshotPath(input.dbPath, now);
    // A same-second re-run would otherwise fail the VACUUM INTO, which refuses
    // an existing target. Overwriting is safe under the lock: no other process
    // can be writing that file, so the only thing here is our own leftover.
    if (existsSync(dest)) await rm(dest, { force: true });

    const db = new Database(input.dbPath, { readonly: true, create: false });
    try {
      db.query("VACUUM INTO ?").run(dest);
    } finally {
      db.close();
    }

    const pruned: string[] = [];
    const points = await listRestorePoints(input.dbPath);
    for (const old of points.slice(keep)) {
      await rm(old.path, { force: true });
      pruned.push(old.path);
    }

    const bytes = (await stat(dest)).size;
    log.info("dbBackup: snapshot taken", { path: dest, bytes, pruned: pruned.length });
    return { status: "taken", path: dest, bytes, pruned, integrity };
  } finally {
    await release();
  }
}

export interface RestoreResult {
  restoredFrom: string;
  /** Where the previous live database was moved. */
  previousAt?: string;
  bytes: number;
}

/**
 * Put a restore point back over the live database.
 *
 * The snapshot's OWN integrity is checked first: restoring from a corrupt
 * snapshot over a corrupt live file leaves nothing to try next, and the whole
 * point of keeping five is that the operator can walk back until one passes.
 *
 * The caller must not have the database open. Phantombot holds a connection
 * for its whole life, so the CLI path stops the service first — this function
 * deliberately does not, because deciding to stop a running daemon belongs to
 * the command the operator typed, not to a file operation.
 */
export async function restoreMemoryDb(input: {
  dbPath: string;
  from: string;
  now?: Date;
}): Promise<RestoreResult> {
  const now = input.now ?? new Date();
  if (!existsSync(input.from)) {
    throw new Error(`restore point not found: ${input.from}`);
  }
  const health = checkIntegrity(input.from);
  if (!health.ok) {
    throw new Error(
      `restore point ${basename(input.from)} fails its integrity check ` +
        `(${health.detail}) — try an older one: phantombot memory restore --list`,
    );
  }

  let previousAt: string | undefined;
  if (existsSync(input.dbPath)) {
    previousAt = `${input.dbPath}.pre-restore-${stampNow(now)}`;
    await rename(input.dbPath, previousAt);
  }
  // Sidecars belong to the database we just moved aside. Left in place, SQLite
  // would replay that WAL over the restored file.
  for (const suffix of SIDECARS) {
    const side = `${input.dbPath}${suffix}`;
    if (existsSync(side)) await unlink(side);
  }
  await copyFile(input.from, input.dbPath);
  const bytes = (await stat(input.dbPath)).size;
  log.info("dbBackup: restored", { from: input.from, previousAt, bytes });
  return { restoredFrom: input.from, previousAt, bytes };
}
