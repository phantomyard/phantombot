/**
 * Tests for the single-instance run lock.
 *
 * The lock is an OS ADVISORY lock (flock on POSIX, LockFileEx on Windows) held
 * for the process lifetime. Correctness comes from the kernel, not from a PID
 * heuristic, so these tests exercise the kernel invariant directly: exactly one
 * holder at a time, and automatic release when the holder dies — including a
 * hard kill, which is how the daemon exits on every Windows stop/self-update.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import {
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

const RUNLOCK_MODULE = join(import.meta.dir, "../src/lib/runLock.ts");

/** Spawn a child that acquires the lock, signals readiness, then lingers. */
function spawnHolder(path: string, readyPath: string, lingerMs: number) {
  return Bun.spawn([
    "bun",
    "-e",
    [
      `const { acquireRunLock, isLockHandle } = require(${JSON.stringify(RUNLOCK_MODULE)});`,
      `const r = acquireRunLock(${JSON.stringify(path)});`,
      `if (!isLockHandle(r)) process.exit(3);`,
      `require("fs").writeFileSync(${JSON.stringify(readyPath)}, String(process.pid));`,
      `setTimeout(() => process.exit(0), ${lingerMs});`,
    ].join("\n"),
  ]);
}

async function waitForFile(path: string, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (existsSync(path)) return;
    await Bun.sleep(25);
  }
  throw new Error(`timed out waiting for ${path}`);
}

describe("acquireRunLock", () => {
  test("acquires a fresh lock and records our pid", () => {
    const path = join(workdir, "run.lock");
    const r = acquireRunLock(path);
    if (!isLockHandle(r)) throw new Error("expected lock handle");
    expect(existsSync(path)).toBe(true);
    r.release();
  });

  // Two independent acquisitions in the SAME process use two different open
  // file descriptions / handles, which flock and LockFileEx both treat as
  // distinct — so the second must conflict. This is the cheap, portable proof
  // that the OS enforces exclusivity.
  test("a second acquire conflicts while the first is held", () => {
    const path = join(workdir, "run.lock");
    const first = acquireRunLock(path);
    if (!isLockHandle(first)) throw new Error("expected first handle");
    try {
      const second = acquireRunLock(path);
      expect(isLockHandle(second)).toBe(false);
      if (!isLockHandle(second)) expect(second.pid).toBe(process.pid);
    } finally {
      first.release();
    }
  });

  test("re-acquire succeeds after release", () => {
    const path = join(workdir, "run.lock");
    const first = acquireRunLock(path);
    if (!isLockHandle(first)) throw new Error("expected first handle");
    first.release();
    const second = acquireRunLock(path);
    if (!isLockHandle(second)) throw new Error("expected re-acquire");
    second.release();
  });

  test("release is idempotent", () => {
    const path = join(workdir, "run.lock");
    const r = acquireRunLock(path);
    if (!isLockHandle(r)) throw new Error("expected lock handle");
    r.release();
    r.release(); // must not throw
  });

  // A pre-existing lock FILE with no live holder is NOT a conflict: there is no
  // OS lock on it, so the next starter simply re-locks the same inode. This is
  // the state left after a hard kill (release() never ran) and it must not wedge
  // startup — the whole failure mode the old PID-heuristic kept reintroducing.
  test("a leftover file with no live holder is freely re-acquired", () => {
    const path = join(workdir, "run.lock");
    writeFileSync(path, "999999\n"); // stale pid text, but nobody holds the lock
    const r = acquireRunLock(path);
    if (!isLockHandle(r)) throw new Error("expected acquire over stale file");
    r.release();
  });

  test("conflicts with a live holder and reports its pid", async () => {
    const path = join(workdir, "run.lock");
    const ready = join(workdir, "holder.ready");
    const holder = spawnHolder(path, ready, 4000);
    try {
      await waitForFile(ready);
      const r = acquireRunLock(path);
      expect(isLockHandle(r)).toBe(false);
      if (!isLockHandle(r)) expect(r.pid).toBe(holder.pid);
    } finally {
      holder.kill();
      await holder.exited;
    }
  }, 15_000);

  // The headline invariant of the whole redesign: when a holder dies WITHOUT a
  // clean release (SIGKILL / taskkill /F / crash), the kernel drops the lock, so
  // the next starter acquires it. The old design leaked a stale lock here and
  // either wedged startup or (worse, under a recycled PID) let two daemons run.
  test("lock is auto-released when the holder is hard-killed", async () => {
    const path = join(workdir, "run.lock");
    const ready = join(workdir, "holder.ready");
    const holder = spawnHolder(path, ready, 60_000);
    await waitForFile(ready);

    // While the holder lives, we must conflict.
    const during = acquireRunLock(path);
    expect(isLockHandle(during)).toBe(false);

    // Hard kill — no release() runs.
    holder.kill(9);
    await holder.exited;

    // Kernel released the lock on process death → we can now acquire.
    const after = acquireRunLock(path);
    if (!isLockHandle(after)) throw new Error("expected acquire after kill");
    after.release();
  }, 15_000);

  // Core exclusivity under contention: N starters race for the same fresh lock
  // and EXACTLY one may hold it. Winners linger so every loser sees a genuinely
  // live holder and conflicts — an instant-exit winner would free the lock in
  // turn and let each starter acquire sequentially, which is not exclusivity.
  test("exactly one of N starters wins the lock", async () => {
    const N = 8;
    const path = join(workdir, "run.lock");
    const codes = await Promise.all(
      Array.from({ length: N }, () =>
        Bun.spawn([
          "bun",
          "-e",
          [
            `const { acquireRunLock, isLockHandle } = require(${JSON.stringify(RUNLOCK_MODULE)});`,
            `const r = acquireRunLock(${JSON.stringify(path)});`,
            `if (isLockHandle(r)) { setTimeout(() => process.exit(0), 1500); }`,
            `else { process.exit(1); }`,
          ].join("\n"),
        ]).exited,
      ),
    );
    const winners = codes.filter((c) => c === 0).length;
    const losers = codes.filter((c) => c === 1).length;
    expect(winners).toBe(1);
    expect(losers).toBe(N - 1);
  }, 30_000);
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

  test("falls back to a per-user $HOME/.cache path when XDG_RUNTIME_DIR is unset (issue #365)", () => {
    const saved = process.env.XDG_RUNTIME_DIR;
    delete process.env.XDG_RUNTIME_DIR;
    try {
      if (process.platform === "win32") {
        // Windows has no uid and no /tmp — the lock lives in per-user %TEMP%.
        expect(defaultLockPath()).toBe(join(tmpdir(), "phantombot.run.lock"));
      } else {
        // POSIX fallback is now under $HOME/.cache (never /tmp) so a full tmpfs
        // can't block the lock. Still per-user (keyed on uid).
        const uid = process.getuid?.() ?? 0;
        expect(defaultLockPath()).toBe(
          join(homedir(), ".cache", "phantombot", "run", `phantombot-${uid}.run.lock`),
        );
      }
    } finally {
      if (saved !== undefined) process.env.XDG_RUNTIME_DIR = saved;
    }
  });
});
