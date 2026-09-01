/**
 * Single-flight lock for lifecycle commands (phantombot#519).
 *
 * The lock replaces the `default_persona` ownership guard, so these tests are
 * the ones standing between "any persona may update" and "two personas race
 * the same binary swap".
 */

import { beforeEach, describe, expect, test } from "bun:test";
import {
  acquireLifecycleLock,
  lifecycleBusyReply,
  lifecycleLockHolder,
  LIFECYCLE_LOCK_TTL_MS,
  resetLifecycleLock,
} from "../src/lib/lifecycleLock.ts";

beforeEach(() => {
  resetLifecycleLock();
});

describe("acquireLifecycleLock", () => {
  test("the first caller gets it, the second is told who holds it", () => {
    const a = acquireLifecycleLock(
      { command: "/update", persona: "lena" },
      1000,
    );
    expect(a.ok).toBe(true);

    const b = acquireLifecycleLock(
      { command: "/restart", persona: "kai" },
      2000,
    );
    expect(b.ok).toBe(false);
    if (b.ok) throw new Error("unreachable");
    expect(b.holder.persona).toBe("lena");
    expect(b.holder.command).toBe("/update");
  });

  test("release frees it for the next caller", () => {
    const a = acquireLifecycleLock(
      { command: "/update", persona: "lena" },
      1000,
    );
    if (!a.ok) throw new Error("expected the lock");
    a.release();
    expect(lifecycleLockHolder(1001)).toBeUndefined();
    const b = acquireLifecycleLock(
      { command: "/update", persona: "kai" },
      1001,
    );
    expect(b.ok).toBe(true);
  });

  test("release is idempotent", () => {
    const a = acquireLifecycleLock({ command: "/update", persona: "lena" }, 0);
    if (!a.ok) throw new Error("expected the lock");
    a.release();
    a.release();
    expect(lifecycleLockHolder(1)).toBeUndefined();
  });

  test("a stale release cannot free somebody ELSE's lock", () => {
    // Abandoned run: takes the lock, never releases, TTL expires.
    const stale = acquireLifecycleLock(
      { command: "/update", persona: "lena" },
      0,
    );
    if (!stale.ok) throw new Error("expected the lock");

    const fresh = acquireLifecycleLock(
      { command: "/update", persona: "kai" },
      LIFECYCLE_LOCK_TTL_MS + 1,
    );
    expect(fresh.ok).toBe(true);

    // The zombie finally releases — it must not unlock kai's run.
    stale.release();
    expect(lifecycleLockHolder(LIFECYCLE_LOCK_TTL_MS + 2)?.persona).toBe("kai");
  });

  test("a holder older than the TTL is abandoned, not honoured forever", () => {
    acquireLifecycleLock({ command: "/update", persona: "lena" }, 0);
    expect(lifecycleLockHolder(LIFECYCLE_LOCK_TTL_MS - 1)?.persona).toBe(
      "lena",
    );
    expect(lifecycleLockHolder(LIFECYCLE_LOCK_TTL_MS)).toBeUndefined();
    const b = acquireLifecycleLock(
      { command: "/update", persona: "kai" },
      LIFECYCLE_LOCK_TTL_MS,
    );
    expect(b.ok).toBe(true);
  });
});

describe("lifecycleBusyReply", () => {
  test("names the holder, its command and how long ago — never a persona to ask", () => {
    const reply = lifecycleBusyReply(
      "/update",
      { command: "/update", persona: "lena", startedAt: 0 },
      12_000,
    );
    expect(reply).toContain("already in progress");
    expect(reply).toContain("lena");
    expect(reply).toContain("12s");
    // The whole point of #519: no "ask X to run it" dead end.
    expect(reply).not.toContain("default persona");
  });
});
