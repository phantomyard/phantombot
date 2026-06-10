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
  test("creates a fresh lock with our pid", () => {
    const path = join(workdir, "run.lock");
    const r = acquireRunLock(path);
    if (!isLockHandle(r)) throw new Error("expected lock handle");
    expect(existsSync(path)).toBe(true);
    expect(Number(readFileSync(path, "utf8").split("\n")[0])).toBe(process.pid);
    r.release();
    expect(existsSync(path)).toBe(false);
  });

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
});

describe("defaultLockPath", () => {
  test("uses XDG_RUNTIME_DIR when set", () => {
    const saved = process.env.XDG_RUNTIME_DIR;
    process.env.XDG_RUNTIME_DIR = "/run/user/1003";
    try {
      expect(defaultLockPath()).toBe("/run/user/1003/phantombot.run.lock");
    } finally {
      if (saved === undefined) delete process.env.XDG_RUNTIME_DIR;
      else process.env.XDG_RUNTIME_DIR = saved;
    }
  });

  test("falls back to /tmp/phantombot-<uid>.run.lock when XDG_RUNTIME_DIR is unset", () => {
    const saved = process.env.XDG_RUNTIME_DIR;
    delete process.env.XDG_RUNTIME_DIR;
    try {
      const uid = process.getuid?.() ?? 0;
      expect(defaultLockPath()).toBe(`/tmp/phantombot-${uid}.run.lock`);
    } finally {
      if (saved !== undefined) process.env.XDG_RUNTIME_DIR = saved;
    }
  });
});
