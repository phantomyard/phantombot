import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import {
  chmod,
  mkdtemp,
  open,
  readdir,
  readFile,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { rmrf } from "./fixtures/rmrf.ts";
import {
  acquireLock,
  configuredKeep,
  configuredMaxBytes,
  DEFAULT_KEEP,
  DEFAULT_MAX_BYTES,
  inspectLogDir,
  LOCK_STALE_MS,
  releaseLock,
  rotateLogDir,
  rotateServiceLogs,
} from "../src/lib/logRotate.ts";

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "phantombot-logrot-"));
});

afterEach(async () => {
  delete process.env.PHANTOMBOT_LOG_MAX_BYTES;
  delete process.env.PHANTOMBOT_LOG_KEEP;
  await rmrf(dir);
});

async function writeLog(name: string, bytes: number): Promise<string> {
  const path = join(dir, name);
  await writeFile(path, "x".repeat(bytes));
  return path;
}

describe("rotateLogDir", () => {
  test("rotates a log over the cap and leaves one under it alone", async () => {
    await writeLog("big.log", 200);
    await writeLog("small.log", 10);

    const r = await rotateLogDir({ dir, maxBytes: 100 });

    expect(r.rotated.map((f) => f.file)).toEqual(["big.log"]);
    expect(r.rotated[0]?.bytes).toBe(200);
    expect(r.skipped).toEqual([]);
    expect(r.lockedOut).toBe(false);
    expect((await stat(join(dir, "big.log"))).size).toBe(0);
    expect((await readFile(join(dir, "big.log.1"), "utf8")).length).toBe(200);
    expect((await stat(join(dir, "small.log"))).size).toBe(10);
    expect(existsSync(join(dir, "small.log.1"))).toBe(false);
  });

  /**
   * The regression test for the whole design. launchd holds an O_APPEND
   * descriptor on the live file, and a descriptor follows the INODE: a
   * rename-based rotation leaves the writer appending to the renamed file, so
   * everything logged after the first rotation disappears from the live log.
   * Model that writer with a real appending file handle held ACROSS the
   * rotation.
   */
  test("a writer holding the live file keeps writing to the live path", async () => {
    const path = await writeLog("held.log", 200);
    const fh = await open(path, "a");
    try {
      await rotateLogDir({ dir, maxBytes: 100 });
      await fh.write("after-rotation\n");
    } finally {
      await fh.close();
    }

    // The post-rotation line must be in the LIVE file, and the file must not
    // have been left with a 200-byte sparse hole in front of it.
    expect(await readFile(path, "utf8")).toBe("after-rotation\n");
    expect((await readFile(join(dir, "held.log.1"), "utf8")).length).toBe(200);
  });

  test("shifts generations and drops the oldest beyond keep", async () => {
    await writeFile(join(dir, "a.log.1"), "gen1");
    await writeFile(join(dir, "a.log.2"), "gen2");
    await writeFile(join(dir, "a.log.3"), "gen3");
    await writeLog("a.log", 200);

    await rotateLogDir({ dir, maxBytes: 100, keep: 3 });

    expect((await readFile(join(dir, "a.log.1"), "utf8")).length).toBe(200);
    expect(await readFile(join(dir, "a.log.2"), "utf8")).toBe("gen1");
    expect(await readFile(join(dir, "a.log.3"), "utf8")).toBe("gen2");
    // gen3 fell off the end rather than becoming a fourth generation.
    expect(existsSync(join(dir, "a.log.4"))).toBe(false);
  });

  test("prunes generations stranded beyond a lowered keep", async () => {
    await writeFile(join(dir, "a.log.4"), "old4");
    await writeFile(join(dir, "a.log.5"), "old5");
    await writeLog("a.log", 200);

    await rotateLogDir({ dir, maxBytes: 100, keep: 3 });

    // Nothing rotates `.4`/`.5` any more, so leaving them would be exactly the
    // unbounded-growth bug, one directory deeper.
    expect(existsSync(join(dir, "a.log.4"))).toBe(false);
    expect(existsSync(join(dir, "a.log.5"))).toBe(false);
    expect((await readFile(join(dir, "a.log.1"), "utf8")).length).toBe(200);
  });

  test("keep 0 truncates and discards every existing generation", async () => {
    await writeLog("a.log", 200);
    // Lowering keep to 0 must DISCARD retained history, not freeze it on disk
    // forever: nothing would ever rotate or delete these again.
    await writeFile(join(dir, "a.log.1"), "gen1");
    await writeFile(join(dir, "a.log.2"), "gen2");
    await writeFile(join(dir, "a.log.3"), "gen3");

    await rotateLogDir({ dir, maxBytes: 100, keep: 0 });

    expect((await stat(join(dir, "a.log"))).size).toBe(0);
    expect(existsSync(join(dir, "a.log.1"))).toBe(false);
    expect(existsSync(join(dir, "a.log.2"))).toBe(false);
    expect(existsSync(join(dir, "a.log.3"))).toBe(false);
  });

  test("an already-rotated generation is never itself a candidate", async () => {
    await writeFile(join(dir, "a.log.1"), "y".repeat(500));
    await writeLog("a.log", 10);

    const r = await rotateLogDir({ dir, maxBytes: 100 });

    expect(r.rotated).toEqual([]);
    expect(existsSync(join(dir, "a.log.1.1"))).toBe(false);
    expect((await readFile(join(dir, "a.log.1"), "utf8")).length).toBe(500);
  });

  test("a fresh lock held by another pass rotates nothing", async () => {
    await writeLog("a.log", 200);
    await writeFile(
      join(dir, ".rotate.lock"),
      `999999 ${new Date().toISOString()}\n`,
    );

    const r = await rotateLogDir({ dir, maxBytes: 100 });

    expect(r.lockedOut).toBe(true);
    expect(r.rotated).toEqual([]);
    expect((await stat(join(dir, "a.log"))).size).toBe(200);
  });

  test("a stale lock is stolen so a crash cannot wedge rotation", async () => {
    await writeLog("a.log", 200);
    const stale = new Date(Date.now() - LOCK_STALE_MS - 1_000).toISOString();
    await writeFile(join(dir, ".rotate.lock"), `999999 ${stale}\n`);

    const r = await rotateLogDir({ dir, maxBytes: 100 });

    expect(r.lockedOut).toBe(false);
    expect(r.rotated.map((f) => f.file)).toEqual(["a.log"]);
    // Released on the way out, not left behind for the next pass to trip on.
    expect(existsSync(join(dir, ".rotate.lock"))).toBe(false);
  });

  /**
   * The stale-takeover race. Every contender reads the SAME stale timestamp,
   * so a plain overwrite lets all of them conclude they own the directory and
   * rotate at once — the exact interleaved generation shift the lock exists to
   * prevent. Exactly one may enter; the rest must report `lockedOut`.
   */
  test("only one of many concurrent passes steals a stale lock", async () => {
    await writeLog("a.log", 200);
    const stale = new Date(Date.now() - LOCK_STALE_MS - 1_000).toISOString();
    await writeFile(join(dir, ".rotate.lock"), `999999 ${stale}\n`);

    const results = await Promise.all(
      Array.from({ length: 20 }, () => rotateLogDir({ dir, maxBytes: 100 })),
    );

    expect(results.filter((r) => !r.lockedOut).length).toBe(1);
    // …and the one that entered did the rotation, exactly once.
    expect(results.flatMap((r) => r.rotated).map((f) => f.file)).toEqual([
      "a.log",
    ]);
    expect(existsSync(join(dir, "a.log.2"))).toBe(false);
  });

  test("a pass whose lock was stolen cannot release its successor's", async () => {
    const stale = new Date(Date.now() - LOCK_STALE_MS - 1_000).toISOString();
    await writeFile(join(dir, ".rotate.lock"), `999999 ${stale}\n`);

    const successor = await acquireLock(dir, new Date());
    expect(successor).toBeString();

    // The crashed/stale owner finally reaches its own release.
    await releaseLock(dir, "the-stale-owners-token");
    expect(existsSync(join(dir, ".rotate.lock"))).toBe(true);
    const held = await readFile(join(dir, ".rotate.lock"), "utf8");
    expect(held).toContain(successor as string);

    // The real owner still can.
    await releaseLock(dir, successor as string);
    expect(existsSync(join(dir, ".rotate.lock"))).toBe(false);
  });

  /**
   * The release race Kai flagged: the token check and the unlink are two
   * syscalls, so a pass that overran LOCK_STALE_MS can have its lock stolen
   * BETWEEN them and then delete the successor's fresh lock. The hook fires at
   * exactly that point; a contender must not be able to install a successor
   * there, and the resumed release must leave whatever lock is present alone
   * unless it is still ours.
   */
  test("release cannot delete a successor installed mid-release", async () => {
    // Our own lock, taken long enough ago that any contender sees it as stale.
    const staleNow = new Date(Date.now() - LOCK_STALE_MS - 1_000);
    const token = await acquireLock(dir, staleNow);
    expect(token).toBeString();

    let takeover: string | null = "not-attempted";
    await releaseLock(dir, token as string, {
      afterOwnershipRead: async () => {
        // A contender tries to steal our (now stale) lock at the worst moment.
        takeover = await acquireLock(dir, new Date());
      },
    });

    // Takeover is serialised against release, so it cannot land in the window.
    expect(takeover).toBeNull();
    // Our own lock is gone, so the contender's next pass gets in cleanly.
    expect(existsSync(join(dir, ".rotate.lock"))).toBe(false);
    const next = await acquireLock(dir, new Date());
    expect(next).toBeString();
    await releaseLock(dir, next as string);
    expect(existsSync(join(dir, ".rotate.lock"))).toBe(false);
  });

  test("release leaves no steal lock behind", async () => {
    const token = await acquireLock(dir, new Date());
    await releaseLock(dir, token as string);
    expect(existsSync(join(dir, ".rotate.lock.steal"))).toBe(false);
  });

  /**
   * A steal lock we cannot take means a takeover may be in flight, and its
   * holder can be paused just before it mutates the real lock. Release must
   * therefore return WITHOUT deleting — deleting would open exactly the window
   * the steal holder is about to install its successor into. Stale or fresh,
   * the real lock is left alone; only a STALE steal lock is cleared, so later
   * passes are not wedged.
   */
  test("release never deletes the real lock while a steal lock is held", async () => {
    const token = await acquireLock(dir, new Date());
    // A contender that is mid-steal (its steal lock is fresh).
    await writeFile(
      join(dir, ".rotate.lock.steal"),
      `999999 ${new Date().toISOString()} contender\n`,
    );

    await releaseLock(dir, token as string);

    // Ours survives: the paused steal holder is still entitled to replace it.
    expect(existsSync(join(dir, ".rotate.lock"))).toBe(true);
    // A fresh steal lock belongs to the contender — we must not clear it.
    expect(existsSync(join(dir, ".rotate.lock.steal"))).toBe(true);
  });

  test("release clears a stale steal lock but still leaves the real lock", async () => {
    const token = await acquireLock(dir, new Date());
    const stale = new Date(Date.now() - LOCK_STALE_MS - 1_000).toISOString();
    await writeFile(join(dir, ".rotate.lock.steal"), `999999 ${stale} old\n`);

    await releaseLock(dir, token as string);

    // Not deleted: clearing the steal lock and taking it in the same pass is
    // the race — the old steal holder may resume and install a successor.
    expect(existsSync(join(dir, ".rotate.lock"))).toBe(true);
    // But the stale steal lock is gone, so nothing is wedged...
    expect(existsSync(join(dir, ".rotate.lock.steal"))).toBe(false);
    // ...and the leftover real lock is recoverable by the next pass once stale.
    const later = new Date(Date.now() + LOCK_STALE_MS + 1_000);
    expect(await acquireLock(dir, later)).toBeString();
  });

  test("the lock file itself is never rotated", async () => {
    await writeFile(join(dir, ".rotate.lock"), "x".repeat(500));
    const r = await rotateLogDir({ dir, maxBytes: 100 });
    expect(r.rotated).toEqual([]);
  });

  test("a missing directory is a no-op, not a throw", async () => {
    const r = await rotateLogDir({ dir: join(dir, "nope"), maxBytes: 100 });
    expect(r.rotated).toEqual([]);
    expect(r.lockedOut).toBe(false);
  });

  test.skipIf(process.platform === "win32" || process.getuid?.() === 0)(
    "an unrotatable file is reported and the pass continues",
    async () => {
      await writeLog("a-locked.log", 200);
      await writeLog("b-ok.log", 200);
      // Deny writes to the directory AFTER the lock is taken is impossible
      // from outside, so instead make the live file unreadable: copyFile then
      // fails and the live bytes must survive.
      await chmod(join(dir, "a-locked.log"), 0o000);

      const r = await rotateLogDir({ dir, maxBytes: 100 });

      expect(r.skipped.map((f) => f.file)).toEqual(["a-locked.log"]);
      expect(r.rotated.map((f) => f.file)).toEqual(["b-ok.log"]);
      // Failed rotation must not have destroyed the original.
      await chmod(join(dir, "a-locked.log"), 0o600);
      expect((await stat(join(dir, "a-locked.log"))).size).toBe(200);
    },
  );

  /**
   * The copy is the step most likely to fail (Windows EBUSY/EACCES on a live
   * log held by the writing `cmd`). If generations were pruned and shifted
   * first, every heartbeat would age them one more step without ever writing a
   * new snapshot, so a permanently unrotatable file quietly erases ALL of its
   * retained history. Nothing may move until the bytes are safely copied.
   */
  test.skipIf(process.platform === "win32" || process.getuid?.() === 0)(
    "a failed live copy leaves every retained generation untouched",
    async () => {
      await writeLog("a.log", 200);
      await writeFile(join(dir, "a.log.1"), "gen1");
      await writeFile(join(dir, "a.log.2"), "gen2");
      await writeFile(join(dir, "a.log.3"), "gen3");
      await chmod(join(dir, "a.log"), 0o000);

      const r = await rotateLogDir({ dir, maxBytes: 100, keep: 3 });

      expect(r.rotated).toEqual([]);
      expect(r.skipped.map((f) => f.file)).toEqual(["a.log"]);
      expect(await readFile(join(dir, "a.log.1"), "utf8")).toBe("gen1");
      expect(await readFile(join(dir, "a.log.2"), "utf8")).toBe("gen2");
      expect(await readFile(join(dir, "a.log.3"), "utf8")).toBe("gen3");
      await chmod(join(dir, "a.log"), 0o600);
      expect((await stat(join(dir, "a.log"))).size).toBe(200);
      // No half-written snapshot left behind for the next pass to trip on.
      expect(
        (await readdir(dir)).filter((n) => n.includes(".rotating-")),
      ).toEqual([]);
    },
  );
});

describe("configured limits", () => {
  test("defaults apply when the env vars are unset", () => {
    expect(configuredMaxBytes()).toBe(DEFAULT_MAX_BYTES);
    expect(configuredKeep()).toBe(DEFAULT_KEEP);
  });

  test("valid overrides are honoured", () => {
    process.env.PHANTOMBOT_LOG_MAX_BYTES = "4096";
    process.env.PHANTOMBOT_LOG_KEEP = "1";
    expect(configuredMaxBytes()).toBe(4096);
    expect(configuredKeep()).toBe(1);
  });

  test("junk and negative overrides fall back to the defaults", () => {
    process.env.PHANTOMBOT_LOG_MAX_BYTES = "sixteen megs";
    process.env.PHANTOMBOT_LOG_KEEP = "-3";
    expect(configuredMaxBytes()).toBe(DEFAULT_MAX_BYTES);
    expect(configuredKeep()).toBe(DEFAULT_KEEP);
  });

  test("a zero cap falls back rather than rotating on every pass", () => {
    process.env.PHANTOMBOT_LOG_MAX_BYTES = "0";
    expect(configuredMaxBytes()).toBe(DEFAULT_MAX_BYTES);
  });
});

describe("inspectLogDir", () => {
  test("counts every generation but flags only live logs over the cap", async () => {
    await writeLog("a.log", 200);
    await writeFile(join(dir, "a.log.1"), "y".repeat(300));
    await writeLog("b.log", 10);

    const s = await inspectLogDir(dir, 100);

    expect(s.bytes).toBe(510);
    expect(s.overCap).toEqual(["a.log"]);
  });

  test("a missing directory reports zero", async () => {
    expect(await inspectLogDir(join(dir, "nope"), 100)).toEqual({
      bytes: 0,
      overCap: [],
    });
  });
});

describe("rotateServiceLogs", () => {
  test("a non-installed (dev) run never touches the logs", async () => {
    await writeLog("a.log", 200);
    process.env.PHANTOMBOT_LOG_MAX_BYTES = "8";

    expect(await rotateServiceLogs({ dir, installed: false })).toBeNull();

    expect((await stat(join(dir, "a.log"))).size).toBe(200);
    expect(existsSync(join(dir, "a.log.1"))).toBe(false);
  });

  test("a platform with no file logs (Linux/journald) is a no-op", async () => {
    expect(await rotateServiceLogs({ dir: null, installed: true })).toBeNull();
  });

  test("an installed run rotates the directory", async () => {
    await writeLog("a.log", 200);
    process.env.PHANTOMBOT_LOG_MAX_BYTES = "100";

    const r = await rotateServiceLogs({ dir, installed: true });

    expect(r?.rotated.map((f) => f.file)).toEqual(["a.log"]);
    expect((await stat(join(dir, "a.log"))).size).toBe(0);
  });
});
