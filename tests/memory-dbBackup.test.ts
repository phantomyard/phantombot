/**
 * #417 — restore points for the memory database.
 *
 * These assertions are about the two orderings that make a backup system
 * either a safety net or an accelerant: integrity is checked BEFORE a snapshot
 * is taken, and a restore moves the live file aside rather than over-writing
 * it.
 */

import { describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";

import {
  backupDir,
  backupMemoryDb,
  checkIntegrity,
  listRestorePoints,
  restoreMemoryDb,
} from "../src/memory/dbBackup.ts";

async function workdir(): Promise<string> {
  return mkdtemp(join(tmpdir(), "db-backup-"));
}

/** A small, valid database with one identifiable row. */
function seed(path: string, marker: string): void {
  const db = new Database(path, { create: true });
  db.exec("CREATE TABLE IF NOT EXISTS t (v TEXT)");
  db.query("INSERT INTO t (v) VALUES (?)").run(marker);
  db.close();
}

function markers(path: string): string[] {
  const db = new Database(path, { readonly: true, create: false });
  try {
    return (db.query("SELECT v FROM t").all() as Array<{ v: string }>).map(
      (r) => r.v,
    );
  } finally {
    db.close();
  }
}

describe("checkIntegrity", () => {
  test("a healthy database reports ok", async () => {
    const dir = await workdir();
    const db = join(dir, "memory.sqlite");
    seed(db, "one");
    expect(checkIntegrity(db)).toEqual({ ok: true, detail: "ok" });
    await rm(dir, { recursive: true, force: true });
  });

  test("a missing file is a fault, not an empty database", async () => {
    // `new Database(path, { create: true })` on a missing path would create an
    // empty file and pass its integrity check — a green doctor on a box whose
    // memory had been deleted.
    const dir = await workdir();
    const db = join(dir, "gone.sqlite");
    expect(checkIntegrity(db).ok).toBe(false);
    expect(existsSync(db)).toBe(false);
    await rm(dir, { recursive: true, force: true });
  });

  test("a corrupt file fails", async () => {
    const dir = await workdir();
    const db = join(dir, "memory.sqlite");
    await writeFile(db, "this is not a database");
    expect(checkIntegrity(db).ok).toBe(false);
    await rm(dir, { recursive: true, force: true });
  });
});

describe("backupMemoryDb", () => {
  test("takes a snapshot that is itself a valid database", async () => {
    const dir = await workdir();
    const db = join(dir, "memory.sqlite");
    seed(db, "one");
    const r = await backupMemoryDb({ dbPath: db });
    expect(r.status).toBe("taken");
    expect(checkIntegrity(r.path!).ok).toBe(true);
    expect(markers(r.path!)).toEqual(["one"]);
    expect(backupDir(db)).toBe(join(dir, "backups"));
    await rm(dir, { recursive: true, force: true });
  });

  test("REFUSES to snapshot a corrupt database, keeping the good points", async () => {
    // The failure this ordering exists to prevent: N nights of faithfully
    // rotating corruption into every restore point until the last good one is
    // gone — a backup system that destroys what it exists to protect.
    const dir = await workdir();
    const db = join(dir, "memory.sqlite");
    seed(db, "good");
    const first = await backupMemoryDb({ dbPath: db });
    expect(first.status).toBe("taken");

    await writeFile(db, "corrupted now");
    const second = await backupMemoryDb({ dbPath: db });
    expect(second.status).toBe("refused");
    expect(second.integrity.ok).toBe(false);

    const points = await listRestorePoints(db);
    expect(points).toHaveLength(1);
    expect(markers(points[0]!.path)).toEqual(["good"]);
    await rm(dir, { recursive: true, force: true });
  });

  test("rotates to `keep`, newest first", async () => {
    const dir = await workdir();
    const db = join(dir, "memory.sqlite");
    seed(db, "one");
    for (let i = 0; i < 4; i++) {
      await backupMemoryDb({
        dbPath: db,
        keep: 2,
        now: new Date(Date.UTC(2026, 7, 21, 0, 0, i)),
      });
    }
    const points = await listRestorePoints(db);
    expect(points).toHaveLength(2);
    expect(points[0]!.takenAt.getTime()).toBeGreaterThan(
      points[1]!.takenAt.getTime(),
    );
    await rm(dir, { recursive: true, force: true });
  });
});

describe("restoreMemoryDb", () => {
  test("moves the live database aside instead of overwriting it", async () => {
    const dir = await workdir();
    const db = join(dir, "memory.sqlite");
    seed(db, "old");
    const point = await backupMemoryDb({ dbPath: db });

    seed(db, "newer");
    expect(markers(db)).toEqual(["old", "newer"]);

    const r = await restoreMemoryDb({ dbPath: db, from: point.path! });
    expect(markers(db)).toEqual(["old"]);
    // A restore from the wrong point is itself reversible.
    expect(existsSync(r.previousAt!)).toBe(true);
    expect(markers(r.previousAt!)).toEqual(["old", "newer"]);
    await rm(dir, { recursive: true, force: true });
  });

  test("removes the stale WAL sidecars", async () => {
    // A `-wal` belonging to the database we just moved aside would be replayed
    // over the restored file: recovery turning into corruption.
    const dir = await workdir();
    const db = join(dir, "memory.sqlite");
    seed(db, "old");
    const point = await backupMemoryDb({ dbPath: db });
    await writeFile(`${db}-wal`, "stale wal");
    await writeFile(`${db}-shm`, "stale shm");

    await restoreMemoryDb({ dbPath: db, from: point.path! });
    expect(existsSync(`${db}-wal`)).toBe(false);
    expect(existsSync(`${db}-shm`)).toBe(false);
    await rm(dir, { recursive: true, force: true });
  });

  test("refuses a corrupt restore point rather than destroying the live file", async () => {
    const dir = await workdir();
    const db = join(dir, "memory.sqlite");
    seed(db, "live");
    const bad = join(dir, "memory.20260821T000000Z.sqlite");
    await writeFile(bad, "not a database");

    await expect(restoreMemoryDb({ dbPath: db, from: bad })).rejects.toThrow(
      /integrity check/,
    );
    expect(markers(db)).toEqual(["live"]);
    await rm(dir, { recursive: true, force: true });
  });

  test("a missing restore point is an error, not a silent no-op", async () => {
    const dir = await workdir();
    const db = join(dir, "memory.sqlite");
    seed(db, "live");
    await expect(
      restoreMemoryDb({ dbPath: db, from: join(dir, "nope.sqlite") }),
    ).rejects.toThrow(/not found/);
    await rm(dir, { recursive: true, force: true });
  });
});
