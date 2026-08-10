/**
 * Tests for the single-instance run lock.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  existsSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  _windowsInstanceToken,
  acquireRunLock,
  defaultLockPath,
  isLockHandle,
} from "../src/lib/runLock.ts";

let workdir: string;

beforeEach(async () => {
  workdir = await mkdtemp(join(tmpdir(), "phantombot-lock-"));
});

afterEach(async () => {
  await rm(workdir, { recursive: true, force: true });
});

describe("acquireRunLock", () => {
  // Windows-appropriate timeout: the fresh-create path calls lockPayload(),
  // which on Windows spawns PowerShell to read the process creation time. A
  // cold PowerShell start legitimately approaches the 5s default and was
  // flaking test-windows at ~5.2s — give it generous headroom.
  test("creates a fresh lock with our pid", () => {
    const path = join(workdir, "run.lock");
    const r = acquireRunLock(path);
    if (!isLockHandle(r)) throw new Error("expected lock handle");
    expect(existsSync(path)).toBe(true);
    expect(Number(readFileSync(path, "utf8").split("\n")[0])).toBe(process.pid);
    r.release();
    expect(existsSync(path)).toBe(false);
  }, 20_000);

  test("conflicts when another live PID holds it", () => {
    const path = join(workdir, "run.lock");
    // Use process.pid (we are alive) — this is "another live process" from the lock's POV.
    writeFileSync(path, String(process.pid));
    const r = acquireRunLock(path);
    if (isLockHandle(r)) throw new Error("expected conflict");
    expect(r.pid).toBe(process.pid);
  });

  test("reclaims a stale lock with a dead PID", () => {
    const path = join(workdir, "run.lock");
    // PID 999999 is essentially guaranteed not to exist on a normal system.
    writeFileSync(path, "999999");
    const r = acquireRunLock(path);
    if (!isLockHandle(r)) throw new Error("expected reclaim");
    expect(Number(readFileSync(path, "utf8").split("\n")[0])).toBe(process.pid);
    r.release();
  });

  test("reclaims a malformed lock", () => {
    const path = join(workdir, "run.lock");
    writeFileSync(path, "not-a-pid");
    const r = acquireRunLock(path);
    if (!isLockHandle(r)) throw new Error("expected reclaim");
    expect(Number(readFileSync(path, "utf8").split("\n")[0])).toBe(process.pid);
    r.release();
  });

  test("release is idempotent", () => {
    const path = join(workdir, "run.lock");
    const r = acquireRunLock(path);
    if (!isLockHandle(r)) throw new Error("expected lock handle");
    r.release();
    r.release(); // should not throw even though file is gone
    expect(existsSync(path)).toBe(false);
  });

  test("release does NOT remove a successor's lock", () => {
    const path = join(workdir, "run.lock");
    const r = acquireRunLock(path);
    if (!isLockHandle(r)) throw new Error("expected lock handle");
    // Simulate a stale-reclaim by another process: write a different pid in.
    writeFileSync(path, "12345");
    r.release();
    // The file should NOT have been removed since the pid inside isn't ours.
    expect(existsSync(path)).toBe(true);
    expect(Number(readFileSync(path, "utf8").split("\n")[0])).toBe(12345);
  });

  // ── PID-reuse guard (item d) ──
  // On Linux the lock records boot-id + start-time. A lock that names our live
  // PID but carries a DIFFERENT instance token represents a recycled PID — the
  // original holder is gone — and must be reclaimed, not treated as a conflict.
  test("reclaims a lock whose PID is live but instance token mismatches (recycled PID)", () => {
    const onLinux = existsSync("/proc/sys/kernel/random/boot_id");
    if (!onLinux) return; // token guard is /proc-specific; nothing to assert off Linux
    const path = join(workdir, "run.lock");
    // Our real, live PID but a bogus token → looks like a recycled PID.
    writeFileSync(path, `${process.pid}\nbogus-boot:0`);
    const r = acquireRunLock(path);
    if (!isLockHandle(r)) throw new Error("expected reclaim of recycled-PID lock");
    expect(Number(readFileSync(path, "utf8").split("\n")[0])).toBe(process.pid);
    r.release();
  });

  // ── Empty-file (mid-write) race ──
  // The O_EXCL winner creates the file empty, then writes its PID a moment
  // later (on Windows that gap is a whole PowerShell spawn). A second starter
  // that reads the file in that window must NOT treat the empty file as stale
  // and unlink the live holder — that's what spawned two daemons on one bot
  // token. It must wait for the PID to appear and then back off as a conflict.
  test("waits for a concurrent starter mid-write instead of stealing its lock", async () => {
    const path = join(workdir, "run.lock");
    // Simulate the O_EXCL winner: the file exists but is momentarily EMPTY.
    writeFileSync(path, "");
    // A real, live, separate process writes its PID shortly after — while our
    // acquire is inside the retry window — then stays alive.
    const child = Bun.spawn([
      "bun",
      "-e",
      `await Bun.sleep(120);` +
        `require("fs").writeFileSync(${JSON.stringify(path)}, String(process.pid)+"\\n");` +
        `await Bun.sleep(3000);`,
    ]);
    try {
      // Give the child a beat to start before we begin the (synchronous) wait.
      await Bun.sleep(20);
      const r = acquireRunLock(path);
      // Must be a conflict naming the child's PID — not a stolen handle.
      expect(isLockHandle(r)).toBe(false);
      if (!isLockHandle(r)) expect(r.pid).toBe(child.pid);
    } finally {
      child.kill();
    }
  });

  // A process that crashed BETWEEN create and write leaves the file empty
  // forever. After the retry window elapses we must still reclaim it, not hang.
  test("reclaims a lock that stays empty past the retry window (crashed mid-write)", () => {
    const path = join(workdir, "run.lock");
    writeFileSync(path, ""); // empty and it never gets filled
    const started = Date.now();
    const r = acquireRunLock(path);
    const elapsed = Date.now() - started;
    if (!isLockHandle(r)) throw new Error("expected reclaim of empty orphan lock");
    // We should have waited out the retry window before reclaiming — proof the
    // retry ran rather than instantly declaring the empty file stale.
    expect(elapsed).toBeGreaterThanOrEqual(800);
    expect(Number(readFileSync(path, "utf8").split("\n")[0])).toBe(process.pid);
    r.release();
  });

  // pid=0 is what `Number("")`/a zeroed payload parses to; it must be treated
  // as "not yet written", i.e. retried, never as a live holder.
  test("treats a pid=0 payload as mid-write, not a live holder", () => {
    const path = join(workdir, "run.lock");
    writeFileSync(path, "0\n");
    const r = acquireRunLock(path);
    if (!isLockHandle(r)) throw new Error("expected reclaim of pid=0 lock");
    expect(Number(readFileSync(path, "utf8").split("\n")[0])).toBe(process.pid);
    r.release();
  });

  test("still conflicts when PID is live and token matches (genuine holder)", () => {
    const path = join(workdir, "run.lock");
    // First acquire writes our real pid + our real token, then a second
    // acquire on the same path must see a genuine live holder and conflict.
    const first = acquireRunLock(path);
    if (!isLockHandle(first)) throw new Error("expected initial lock");
    const second = acquireRunLock(path);
    expect(isLockHandle(second)).toBe(false);
    if (!isLockHandle(second)) expect(second.pid).toBe(process.pid);
    first.release();
  });

  // ── Atomic reclaim (rename over stale) ──
  // N aligned starters racing against a stale lock must result in exactly
  // one acquiring the handle; the rest see a conflict. This is the core
  // invariant that the rename-reclaim path must preserve.
  test("exactly one of N starters wins against a stale lock (rename-reclaim)", async () => {
    const N = 8;
    const path = join(workdir, "run.lock");
    // Write a stale lock (dead PID, no token) — every starter will try to reclaim.
    writeFileSync(path, "999999\n");
    const results = await Promise.all(
      Array.from({ length: N }, () =>
        Bun.spawn([
          "bun",
          "-e",
          [
            `const { acquireRunLock, isLockHandle } = require(${JSON.stringify(join(__dirname, "../src/lib/runLock.ts"))});`,
            `const r = acquireRunLock(${JSON.stringify(path)});`,
            // A winner must LINGER holding the lock (as a real daemon does) so
            // every loser sees a genuinely LIVE holder and conflicts. Winners
            // that exit instantly would each free the lock in turn, letting the
            // next starter legitimately reclaim it — that's sequential reclaim,
            // not exclusivity, and it's exactly how the old `>= 1` assertion hid
            // the two-daemon bug. Lingering makes `=== 1` provable.
            `if (isLockHandle(r)) { setTimeout(() => process.exit(0), 1500); }`,
            `else { process.exit(1); }`,
          ].join("\n"),
        ]).exited
      ),
    );
    const winners = results.filter((code) => code === 0).length;
    const losers = results.filter((code) => code === 1).length;
    // The core invariant: EXACTLY one daemon may hold the lock at a time.
    expect(winners).toBe(1);
    expect(losers).toBe(N - 1);
  });
});

describe("defaultLockPath", () => {
  test("uses XDG_RUNTIME_DIR when set", () => {
    const saved = process.env.XDG_RUNTIME_DIR;
    process.env.XDG_RUNTIME_DIR = "/run/user/1003";
    try {
      // Build the expectation with the host's path.join so the separator is
      // correct on Windows too (XDG_RUNTIME_DIR still wins if it's set there).
      expect(defaultLockPath()).toBe(join("/run/user/1003", "phantombot.run.lock"));
    } finally {
      if (saved === undefined) delete process.env.XDG_RUNTIME_DIR;
      else process.env.XDG_RUNTIME_DIR = saved;
    }
  });

  test("falls back to a per-user temp path when XDG_RUNTIME_DIR is unset", () => {
    const saved = process.env.XDG_RUNTIME_DIR;
    delete process.env.XDG_RUNTIME_DIR;
    try {
      if (process.platform === "win32") {
        // Windows has no uid and no /tmp — the lock lives in per-user %TEMP%.
        expect(defaultLockPath()).toBe(join(tmpdir(), "phantombot.run.lock"));
      } else {
        const uid = process.getuid?.() ?? 0;
        expect(defaultLockPath()).toBe(`/tmp/phantombot-${uid}.run.lock`);
      }
    } finally {
      if (saved !== undefined) process.env.XDG_RUNTIME_DIR = saved;
    }
  });
});

describe("_windowsInstanceToken", () => {
  // The PID is read back out of an on-disk lock file and interpolated into a
  // PowerShell CIM filter, so it must be proven to be a plain positive integer
  // before it ever reaches a command line.
  test("rejects non-integer, negative, and zero PIDs before spawning", () => {
    for (const bad of [NaN, 0, -1, 1.5, Infinity]) {
      expect(_windowsInstanceToken(bad)).toBeUndefined();
    }
  });

  test("degrades to undefined when PowerShell is unavailable", () => {
    if (process.platform === "win32") return; // real PowerShell would answer
    expect(_windowsInstanceToken(process.pid)).toBeUndefined();
  });
});
