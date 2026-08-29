/**
 * #495 — concurrent snapshots of one shared memory database.
 *
 * Since the per-persona nightly instances landed (#490), every persona on a
 * host sweeps at the same day rollover against the SAME `memory.sqlite`. The
 * snapshot name is stamped to the second, so siblings that fire milliseconds
 * apart resolve to one destination path and the loser deletes the file the
 * winner is still writing — reported as `disk I/O error` and then pinned in
 * the persona's nightly ledger, so `doctor` stays red on a healthy host.
 *
 * These tests are about that exact shape: same database, same second.
 */

import { describe, expect, test } from "bun:test";
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  utimes,
  writeFile,
} from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";

import {
  acquireSnapshotLock,
  backupDir,
  backupMemoryDb,
  listRestorePoints,
  SNAPSHOT_COALESCE_MS,
} from "../src/memory/dbBackup.ts";

async function workdir(): Promise<string> {
  return mkdtemp(join(tmpdir(), "db-backup-race-"));
}

/** A database big enough that `VACUUM INTO` is not instantaneous. */
function seed(path: string, rows = 4000): void {
  const db = new Database(path, { create: true });
  db.exec("CREATE TABLE IF NOT EXISTS t (v TEXT)");
  const ins = db.query("INSERT INTO t (v) VALUES (?)");
  db.transaction(() => {
    for (let i = 0; i < rows; i++) ins.run(`row-${i}-${"x".repeat(200)}`);
  })();
  db.close();
}

function rowCount(path: string): number {
  const db = new Database(path, { readonly: true, create: false });
  try {
    return (db.query("SELECT count(*) AS n FROM t").get() as { n: number }).n;
  } finally {
    db.close();
  }
}

describe("concurrent snapshots (#495)", () => {
  test("two sweeps in the same second produce one good snapshot, no error", async () => {
    const dir = await workdir();
    const dbPath = join(dir, "memory.sqlite");
    seed(dbPath);
    // The reproduction condition: one clock value for both callers, so both
    // compute the identical stamped destination.
    const now = new Date("2026-08-29T14:43:18.000Z");

    const [a, b] = await Promise.all([
      backupMemoryDb({ dbPath, now, coalesceMs: SNAPSHOT_COALESCE_MS }),
      backupMemoryDb({ dbPath, now, coalesceMs: SNAPSHOT_COALESCE_MS }),
    ]);

    const statuses = [a.status, b.status].sort();
    expect(statuses).toEqual(["fresh", "taken"]);

    // Exactly one restore point, and it is a complete database — not the torn
    // remains of a file that was deleted mid-write.
    const points = await listRestorePoints(dbPath);
    expect(points).toHaveLength(1);
    expect(rowCount(points[0]!.path)).toBe(4000);

    await rm(dir, { recursive: true, force: true });
  });

  test("the loser reports the winner's snapshot rather than nothing", async () => {
    const dir = await workdir();
    const dbPath = join(dir, "memory.sqlite");
    seed(dbPath, 50);
    const now = new Date("2026-08-29T14:43:18.000Z");

    const first = await backupMemoryDb({ dbPath, now, coalesceMs: 60_000 });
    expect(first.status).toBe("taken");

    // A sibling arriving a second later: nothing to do, and it should say
    // WHICH restore point covers it so the caller can log something true.
    const second = await backupMemoryDb({
      dbPath,
      now: new Date(now.getTime() + 1_000),
      coalesceMs: 60_000,
    });
    expect(second.status).toBe("fresh");
    expect(second.path).toBe(first.path!);
    expect(await listRestorePoints(dbPath)).toHaveLength(1);

    await rm(dir, { recursive: true, force: true });
  });

  test("a snapshot older than the window is not coalesced away", async () => {
    const dir = await workdir();
    const dbPath = join(dir, "memory.sqlite");
    seed(dbPath, 50);
    const first = await backupMemoryDb({
      dbPath,
      now: new Date("2026-08-28T03:00:00Z"),
      coalesceMs: 60_000,
    });
    expect(first.status).toBe("taken");

    // Tomorrow's rollover is a different night and must get its own point —
    // the window closes a race, it does not thin the daily schedule.
    const next = await backupMemoryDb({
      dbPath,
      now: new Date("2026-08-29T03:00:00Z"),
      coalesceMs: 60_000,
    });
    expect(next.status).toBe("taken");
    expect(await listRestorePoints(dbPath)).toHaveLength(2);

    await rm(dir, { recursive: true, force: true });
  });

  test("an explicit `memory backup` never coalesces", async () => {
    const dir = await workdir();
    const dbPath = join(dir, "memory.sqlite");
    seed(dbPath, 50);
    const now = new Date("2026-08-29T14:43:18.000Z");
    expect((await backupMemoryDb({ dbPath, now })).status).toBe("taken");
    // An operator who typed the command wants a snapshot, not a report that
    // one already exists. Same second, so it lands on the same path.
    const again = await backupMemoryDb({ dbPath, now });
    expect(again.status).toBe("taken");
    expect(rowCount(again.path!)).toBe(50);

    await rm(dir, { recursive: true, force: true });
  });

  test("a lock held by a live process is waited out, not barged through", async () => {
    const dir = await workdir();
    const dbPath = join(dir, "memory.sqlite");
    seed(dbPath, 50);
    const lock = join(backupDir(dbPath), ".snapshot.lock");
    await Bun.write(lock, `${process.pid} ${new Date().toISOString()}\n`);

    const r = await backupMemoryDb({ dbPath, coalesceMs: 60_000, lockWaitMs: 100 });
    expect(r.status).toBe("fresh");
    expect(await listRestorePoints(dbPath)).toHaveLength(0);
    // And it left the holder's lock alone.
    expect(existsSync(lock)).toBe(true);

    await rm(dir, { recursive: true, force: true });
  });

  test("a stale lock from a dead holder is cleared rather than blocking forever", async () => {
    const dir = await workdir();
    const dbPath = join(dir, "memory.sqlite");
    seed(dbPath, 50);
    const lock = join(backupDir(dbPath), ".snapshot.lock");
    await mkdir(backupDir(dbPath), { recursive: true });
    await writeFile(lock, "999999 old\n");
    // Backdate it past the stale threshold — a holder that died mid-VACUUM.
    // Backdated with `utimes`, not `touch -d`: coreutils is not on a stock
    // Windows dev box and this repo supports Windows development.
    const old = new Date(Date.now() - 30 * 60_000);
    await utimes(lock, old, old);

    const r = await backupMemoryDb({ dbPath, coalesceMs: 60_000, lockWaitMs: 100 });
    expect(r.status).toBe("taken");
    expect(await listRestorePoints(dbPath)).toHaveLength(1);

    await rm(dir, { recursive: true, force: true });
  });

  test("a holder whose lock went stale does not delete its successor's lock", async () => {
    const dir = await workdir();
    const dbPath = join(dir, "memory.sqlite");
    seed(dbPath, 50);
    const lock = join(backupDir(dbPath), ".snapshot.lock");
    await mkdir(backupDir(dbPath), { recursive: true });

    // A: acquires, then runs long enough that its lock reads as abandoned.
    const releaseA = await acquireSnapshotLock(dbPath, 100);
    expect(releaseA).not.toBeNull();
    const stale = new Date(Date.now() - 30 * 60_000);
    await utimes(lock, stale, stale);

    // B: clears the stale lock and takes it for itself.
    const releaseB = await acquireSnapshotLock(dbPath, 100);
    expect(releaseB).not.toBeNull();
    const heldByB = await readFile(lock, "utf8");

    // A finally finishes. Releasing must not touch B's lock — an
    // unconditional rm here would let a third caller in mid-snapshot.
    await releaseA?.();
    expect(existsSync(lock)).toBe(true);
    expect(await readFile(lock, "utf8")).toBe(heldByB);

    // B still owns it, and its own release does clear it.
    await releaseB?.();
    expect(existsSync(lock)).toBe(false);

    await rm(dir, { recursive: true, force: true });
  });

  test("the lock file is released, and never counted as a restore point", async () => {
    const dir = await workdir();
    const dbPath = join(dir, "memory.sqlite");
    seed(dbPath, 50);
    await backupMemoryDb({ dbPath, coalesceMs: 60_000 });
    expect(existsSync(join(backupDir(dbPath), ".snapshot.lock"))).toBe(false);
    const names = await readdir(backupDir(dbPath));
    expect(names).toHaveLength(1);
    expect(await listRestorePoints(dbPath)).toHaveLength(1);

    await rm(dir, { recursive: true, force: true });
  });
});
