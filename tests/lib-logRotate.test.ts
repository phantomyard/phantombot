import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { chmod, mkdtemp, open, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { rmrf } from "./fixtures/rmrf.ts";
import {
  configuredKeep,
  configuredMaxBytes,
  DEFAULT_KEEP,
  DEFAULT_MAX_BYTES,
  inspectLogDir,
  LOCK_STALE_MS,
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

  test("keep 0 truncates without keeping a copy", async () => {
    await writeLog("a.log", 200);

    await rotateLogDir({ dir, maxBytes: 100, keep: 0 });

    expect((await stat(join(dir, "a.log"))).size).toBe(0);
    expect(existsSync(join(dir, "a.log.1"))).toBe(false);
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
