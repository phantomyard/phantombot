import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";

import {
  MAX_LOCK_AGE_MS,
  acquireWorkspace,
  listWorkspaceLocks,
  locksEnabled,
  normalizeWorkspace,
  releaseWorkspace,
  workspaceHolder,
  workspaceLockNotice,
  type WorkspaceLockRecord,
} from "../src/lib/workspaceLock.ts";

let dir: string;
const prevEnabled = process.env.PHANTOMBOT_WORKSPACE_LOCKS;
const prevDir = process.env.PHANTOMBOT_WORKSPACE_LOCK_DIR;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "phantombot-ws-"));
  process.env.PHANTOMBOT_WORKSPACE_LOCKS = "1";
  process.env.PHANTOMBOT_WORKSPACE_LOCK_DIR = dir;
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
  if (prevEnabled === undefined) delete process.env.PHANTOMBOT_WORKSPACE_LOCKS;
  else process.env.PHANTOMBOT_WORKSPACE_LOCKS = prevEnabled;
  if (prevDir === undefined) delete process.env.PHANTOMBOT_WORKSPACE_LOCK_DIR;
  else process.env.PHANTOMBOT_WORKSPACE_LOCK_DIR = prevDir;
});

const NOW = new Date("2026-08-19T12:00:00.000Z");
const WS = "/tmp/phantombot-inspect";

/** Probes describing a foreign process that is alive and unchanged. */
const alive = { isAlive: () => true, startToken: () => "token-a" };
/** ...and one whose owner is gone. */
const dead = { isAlive: () => false, startToken: () => null };

function fileFor(workspace: string): string {
  return `${createHash("sha256")
    .update(normalizeWorkspace(workspace))
    .digest("hex")
    .slice(0, 32)}.json`;
}

async function put(over: Partial<WorkspaceLockRecord> = {}): Promise<void> {
  const record: WorkspaceLockRecord = {
    workspace: normalizeWorkspace(WS),
    persona: "robbie",
    conversation: "task:42",
    pid: 424242,
    pid_start: "token-a",
    acquired_at: NOW.toISOString(),
    ...over,
  };
  await writeFile(join(dir, fileFor(record.workspace)), JSON.stringify(record));
}

describe("normalizeWorkspace", () => {
  test("collapses equivalent spellings onto one lock", () => {
    expect(normalizeWorkspace("/tmp/x/")).toBe(normalizeWorkspace("/tmp/x"));
    expect(normalizeWorkspace("/tmp/./x")).toBe(normalizeWorkspace("/tmp/x"));
  });
});

describe("acquireWorkspace", () => {
  test("claims a free workspace", () => {
    const result = acquireWorkspace(
      {
        workspace: WS,
        persona: "robbie",
        conversation: "telegram:1",
        turnId: "t1",
      },
      { now: NOW },
    );
    expect(result.ok).toBe(true);
    expect(workspaceHolder(WS, { now: NOW })?.turn_id).toBe("t1");
  });

  test("refuses a workspace a live turn holds", async () => {
    await put({ turn_id: "other" });
    const result = acquireWorkspace(
      {
        workspace: WS,
        persona: "robbie",
        conversation: "telegram:1",
        turnId: "t1",
      },
      { now: NOW, ...alive },
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.heldBy.turn_id).toBe("other");
  });

  test("is re-entrant for the turn that already holds it", async () => {
    await put({ turn_id: "t1" });
    const result = acquireWorkspace(
      {
        workspace: WS,
        persona: "robbie",
        conversation: "telegram:1",
        turnId: "t1",
      },
      { now: NOW, ...alive },
    );
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.tookOver).toBe(false);
  });

  test("takes over from a holder whose process died", async () => {
    await put({ turn_id: "corpse" });
    const result = acquireWorkspace(
      {
        workspace: WS,
        persona: "robbie",
        conversation: "telegram:1",
        turnId: "t1",
      },
      { now: NOW, ...dead },
    );
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.tookOver).toBe(true);
  });

  test("a recycled pid is a dead holder, not a live one", async () => {
    // Same pid, different start token: the original process is gone and an
    // unrelated one inherited the number. Without the start-time half of the
    // check this reads as "still held" and wedges the tree for an hour.
    await put({ turn_id: "corpse", pid_start: "token-a" });
    const result = acquireWorkspace(
      {
        workspace: WS,
        persona: "robbie",
        conversation: "telegram:1",
        turnId: "t1",
      },
      { now: NOW, isAlive: () => true, startToken: () => "token-B-different" },
    );
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.tookOver).toBe(true);
  });

  test("expires a lock older than the ceiling even if its owner lives", async () => {
    await put({
      turn_id: "leaked",
      acquired_at: new Date(
        NOW.getTime() - MAX_LOCK_AGE_MS - 1000,
      ).toISOString(),
    });
    const result = acquireWorkspace(
      {
        workspace: WS,
        persona: "robbie",
        conversation: "telegram:1",
        turnId: "t1",
      },
      { now: NOW, ...alive },
    );
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.tookOver).toBe(true);
  });

  test("two different paths never collide onto one lock", () => {
    acquireWorkspace(
      {
        workspace: "/tmp/a",
        persona: "robbie",
        conversation: "c",
        turnId: "t1",
      },
      { now: NOW },
    );
    const second = acquireWorkspace(
      {
        workspace: "/tmp/b",
        persona: "robbie",
        conversation: "c",
        turnId: "t2",
      },
      { now: NOW, ...alive },
    );
    expect(second.ok).toBe(true);
  });

  test("succeeds when locking is switched off", () => {
    process.env.PHANTOMBOT_WORKSPACE_LOCKS = "off";
    expect(locksEnabled()).toBe(false);
    const result = acquireWorkspace(
      { workspace: WS, persona: "robbie", conversation: "c", turnId: "t1" },
      { now: NOW },
    );
    expect(result.ok).toBe(true);
    expect(workspaceHolder(WS, { now: NOW })).toBeUndefined();
  });
});

describe("releaseWorkspace", () => {
  test("the holder can release", async () => {
    await put({ turn_id: "t1" });
    expect(releaseWorkspace(WS, { turnId: "t1" }, { now: NOW })).toBe(true);
    expect(workspaceHolder(WS, { now: NOW, ...alive })).toBeUndefined();
  });

  test("a different turn cannot drop a lock it never took", async () => {
    await put({ turn_id: "t1" });
    expect(releaseWorkspace(WS, { turnId: "t2" }, { now: NOW })).toBe(false);
    expect(workspaceHolder(WS, { now: NOW, ...alive })?.turn_id).toBe("t1");
  });

  test("--force overrides for hand-clearing", async () => {
    await put({ turn_id: "t1" });
    expect(
      releaseWorkspace(WS, { turnId: "t2", force: true }, { now: NOW }),
    ).toBe(true);
    expect(workspaceHolder(WS, { now: NOW, ...alive })).toBeUndefined();
  });

  test("releasing an unheld workspace is a no-op, not a failure", () => {
    expect(releaseWorkspace(WS, { turnId: "t1" }, { now: NOW })).toBe(true);
  });
});

describe("workspaceHolder / listWorkspaceLocks", () => {
  test("a stale lock is pruned on inspection", async () => {
    await put({ turn_id: "corpse" });
    expect(workspaceHolder(WS, { now: NOW, ...dead })).toBeUndefined();
    expect(await readdir(dir)).toHaveLength(0);
  });

  test("lists live locks oldest first", async () => {
    await put({
      workspace: normalizeWorkspace("/tmp/b"),
      acquired_at: "2026-08-19T11:50:00.000Z",
    });
    await put({
      workspace: normalizeWorkspace("/tmp/a"),
      acquired_at: "2026-08-19T11:40:00.000Z",
    });
    const locks = listWorkspaceLocks({ now: NOW, ...alive });
    expect(locks.map((l) => l.workspace)).toEqual([
      normalizeWorkspace("/tmp/a"),
      normalizeWorkspace("/tmp/b"),
    ]);
  });

  test("a corrupt lock file is discarded, not fatal", async () => {
    await writeFile(join(dir, "garbage.json"), "{oh no");
    expect(listWorkspaceLocks({ now: NOW, ...alive })).toHaveLength(0);
  });
});

describe("workspaceLockNotice", () => {
  test("is absent when nothing is claimed", () => {
    expect(workspaceLockNotice([])).toBeUndefined();
  });

  test("names the path, the holder and the honest limits", () => {
    const notice =
      workspaceLockNotice([
        {
          workspace: "/tmp/phantombot-inspect",
          persona: "robbie",
          conversation: "task:42",
          pid: 1,
          acquired_at: NOW.toISOString(),
          purpose: "reviewing PR #405",
        },
      ]) ?? "";
    expect(notice).toContain("/tmp/phantombot-inspect");
    expect(notice).toContain("task:42");
    expect(notice).toContain("reviewing PR #405");
    expect(notice).toContain("advisory");
    expect(notice).toContain("Reading is fine");
  });
});
