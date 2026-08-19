/**
 * Tests for advisory workspace locks (#405).
 *
 * The invariant under test is that the holder of a lock is a TURN, not a
 * process. The first cut of this module judged liveness from the pid that wrote
 * the record, which made every lock a no-op: the only writer is a CLI that
 * exits immediately, so the pid was always dead and the next query pruned the
 * lock. Several tests below exist specifically to keep that from coming back.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, readdir, rm, utimes, writeFile } from "node:fs/promises";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
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
import { registerTurn } from "../src/lib/turnRegistry.ts";

let dir: string;
let registryDir: string;
const prevEnabled = process.env.PHANTOMBOT_WORKSPACE_LOCKS;
const prevDir = process.env.PHANTOMBOT_WORKSPACE_LOCK_DIR;
const prevRegistry = process.env.PHANTOMBOT_TURN_REGISTRY;
const prevRegistryDir = process.env.PHANTOMBOT_TURN_REGISTRY_DIR;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "phantombot-ws-"));
  registryDir = await mkdtemp(join(tmpdir(), "phantombot-ws-reg-"));
  process.env.PHANTOMBOT_WORKSPACE_LOCKS = "1";
  process.env.PHANTOMBOT_WORKSPACE_LOCK_DIR = dir;
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
  await rm(registryDir, { recursive: true, force: true });
  for (const [name, prev] of [
    ["PHANTOMBOT_WORKSPACE_LOCKS", prevEnabled],
    ["PHANTOMBOT_WORKSPACE_LOCK_DIR", prevDir],
    ["PHANTOMBOT_TURN_REGISTRY", prevRegistry],
    ["PHANTOMBOT_TURN_REGISTRY_DIR", prevRegistryDir],
  ] as const) {
    if (prev === undefined) delete process.env[name];
    else process.env[name] = prev;
  }
});

const NOW = new Date("2026-08-19T12:00:00.000Z");
const WS = "/tmp/phantombot-inspect";

/** The turn holding the lock is still running. */
const running = { turnRunning: () => true };
/** ...it finished (or its owning process died — the registry covers both). */
const finished = { turnRunning: () => false };
/** ...the registry cannot say: switched off, or an id it has never seen. */
const unknown = { turnRunning: () => undefined };

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
    // A pid that is long gone — every lock the CLI writes looks like this by
    // the time anyone reads it.
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

describe("liveness follows the TURN, not the writing process", () => {
  test("a lock written by a dead process is still held while its turn runs", async () => {
    // The regression that made the whole feature a no-op. `phantombot workspace
    // lock` exits milliseconds after writing, so the recorded pid is always
    // dead — if that pid decided liveness, this lock would already be gone.
    process.env.PHANTOMBOT_TURN_REGISTRY = "1";
    process.env.PHANTOMBOT_TURN_REGISTRY_DIR = registryDir;
    const handle = registerTurn(
      { persona: "robbie", conversation: "telegram:1", origin: "channel" },
      { dir: registryDir },
    );
    await put({ turn_id: handle.id, pid: 424242, pid_start: "gone" });

    expect(workspaceHolder(WS, { now: NOW, registryDir })?.turn_id).toBe(
      handle.id,
    );

    handle.release();
    expect(workspaceHolder(WS, { now: NOW, registryDir })).toBeUndefined();
  });

  test("a live writing process does not keep a finished turn's lock alive", async () => {
    // The mirror image: the daemon that ran the turn is still up (and hosting
    // other turns), but this turn is over, so its claim must not survive.
    process.env.PHANTOMBOT_TURN_REGISTRY = "1";
    process.env.PHANTOMBOT_TURN_REGISTRY_DIR = registryDir;
    const handle = registerTurn(
      { persona: "robbie", conversation: "telegram:1", origin: "channel" },
      { dir: registryDir },
    );
    handle.release();
    await put({ turn_id: handle.id, pid: process.pid });
    expect(workspaceHolder(WS, { now: NOW, registryDir })).toBeUndefined();
  });

  test("an unverifiable turn keeps its lock until the age ceiling", async () => {
    // Registry off, or an id it has never seen. Guessing "free" here is how the
    // collision this module prevents gets reintroduced, so we hold — bounded by
    // MAX_LOCK_AGE_MS, `unlock`, and `--force`.
    await put({ turn_id: "ghost" });
    expect(workspaceHolder(WS, { now: NOW, ...unknown })?.turn_id).toBe(
      "ghost",
    );
    expect(
      workspaceHolder(WS, {
        now: new Date(NOW.getTime() + MAX_LOCK_AGE_MS + 1000),
        ...unknown,
      }),
    ).toBeUndefined();
  });

  test("a hand-taken lock with no turn id is held until released", async () => {
    await put({ turn_id: undefined });
    expect(workspaceHolder(WS, { now: NOW, ...finished })).toBeDefined();
    expect(releaseWorkspace(WS, {}, { now: NOW })).toBe(true);
    expect(workspaceHolder(WS, { now: NOW })).toBeUndefined();
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
    expect(workspaceHolder(WS, { now: NOW, ...unknown })?.turn_id).toBe("t1");
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
      { now: NOW, ...running },
    );
    expect(result.ok).toBe(false);
    if (!result.ok && result.reason === "held") {
      expect(result.heldBy.turn_id).toBe("other");
    } else {
      throw new Error("expected a held result");
    }
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
      { now: NOW, ...running },
    );
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.tookOver).toBe(false);
  });

  test("takes over from a turn that is gone", async () => {
    await put({ turn_id: "corpse" });
    const result = acquireWorkspace(
      {
        workspace: WS,
        persona: "robbie",
        conversation: "telegram:1",
        turnId: "t1",
      },
      { now: NOW, ...finished },
    );
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.tookOver).toBe(true);
  });

  test("expires a lock older than the ceiling even if its turn lives", async () => {
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
      { now: NOW, ...running },
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
      { now: NOW, ...running },
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

describe("acquire is serialised by a guard", () => {
  const guardPath = () => join(dir, `${fileFor(WS)}.guard`);

  test("reports contention instead of racing an in-flight acquire", () => {
    // Read-check-write without this guard lets two acquires both read "free",
    // both write, and both believe they won.
    writeFileSync(guardPath(), "999999");
    const result = acquireWorkspace(
      { workspace: WS, persona: "robbie", conversation: "c", turnId: "t1" },
      { now: NOW },
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("contended");
    // Nothing was written: a contended acquire must not leave a claim behind.
    expect(existsSync(join(dir, fileFor(WS)))).toBe(false);
  });

  test("breaks a guard abandoned by a process that died mid-acquire", async () => {
    writeFileSync(guardPath(), "999999");
    const old = new Date(Date.now() - 60_000);
    await utimes(guardPath(), old, old);
    const result = acquireWorkspace(
      { workspace: WS, persona: "robbie", conversation: "c", turnId: "t1" },
      { now: NOW },
    );
    expect(result.ok).toBe(true);
    expect(workspaceHolder(WS, { now: NOW, ...unknown })?.turn_id).toBe("t1");
  });

  test("releases the guard on the way out, including on refusal", async () => {
    await put({ turn_id: "other" });
    acquireWorkspace(
      { workspace: WS, persona: "robbie", conversation: "c", turnId: "t1" },
      { now: NOW, ...running },
    );
    expect(existsSync(guardPath())).toBe(false);
  });

  test("only one of many concurrent processes wins the workspace", async () => {
    // The real thing: separate processes, released together off a barrier
    // file, so the read-check-write windows genuinely overlap.
    const MODULE = join(import.meta.dir, "../src/lib/workspaceLock.ts");
    const barrier = join(dir, "go");
    const children = Array.from({ length: 8 }, (_, i) =>
      Bun.spawn(
        [
          "bun",
          "-e",
          [
            `const fs = require("fs");`,
            `while (!fs.existsSync(${JSON.stringify(barrier)})) Bun.sleepSync(1);`,
            `const { acquireWorkspace } = require(${JSON.stringify(MODULE)});`,
            `const r = acquireWorkspace({ workspace: ${JSON.stringify(WS)}, persona: "robbie", conversation: "c", turnId: "t${i}" });`,
            `process.stdout.write(JSON.stringify({ turn: "t${i}", ok: r.ok }));`,
          ].join("\n"),
        ],
        {
          env: {
            ...process.env,
            PHANTOMBOT_WORKSPACE_LOCKS: "1",
            PHANTOMBOT_WORKSPACE_LOCK_DIR: dir,
            // No registry: every claim is unverifiable, so the first writer's
            // lock reads as held and everyone else must lose.
            PHANTOMBOT_TURN_REGISTRY: "0",
            NODE_ENV: "production",
          },
          stdout: "pipe",
          stderr: "pipe",
        },
      ),
    );
    await Bun.sleep(300);
    writeFileSync(barrier, "go");

    const results = await Promise.all(
      children.map(async (child) => {
        const out = await new Response(child.stdout).text();
        await child.exited;
        return out ? (JSON.parse(out) as { turn: string; ok: boolean }) : null;
      }),
    );

    const winners = results.filter((r) => r?.ok);
    expect(winners).toHaveLength(1);
    // ...and the lock on disk belongs to that winner, not to a straggler that
    // overwrote it.
    const onDisk = JSON.parse(
      readFileSync(join(dir, fileFor(WS)), "utf8"),
    ) as WorkspaceLockRecord;
    expect(onDisk.turn_id).toBe(winners[0]!.turn);
  }, 60_000);
});

describe("releaseWorkspace", () => {
  test("the holder can release", async () => {
    await put({ turn_id: "t1" });
    expect(releaseWorkspace(WS, { turnId: "t1" }, { now: NOW })).toBe(true);
    expect(workspaceHolder(WS, { now: NOW, ...running })).toBeUndefined();
  });

  test("a different turn cannot drop a lock it never took", async () => {
    await put({ turn_id: "t1" });
    expect(releaseWorkspace(WS, { turnId: "t2" }, { now: NOW })).toBe(false);
    expect(workspaceHolder(WS, { now: NOW, ...running })?.turn_id).toBe("t1");
  });

  test("a caller with NO turn id cannot drop a turn's lock either", async () => {
    // The hole this closes: any plain shell — a stray script, a maintenance
    // one-liner, a harness with the registry off — could silently release a
    // live claim just by not having a turn id. Dropping a lock you never took
    // is how a cooperative protocol turns into corruption.
    await put({ turn_id: "t1" });
    expect(releaseWorkspace(WS, {}, { now: NOW })).toBe(false);
    expect(workspaceHolder(WS, { now: NOW, ...running })?.turn_id).toBe("t1");
  });

  test("--force overrides for hand-clearing", async () => {
    await put({ turn_id: "t1" });
    expect(releaseWorkspace(WS, { force: true }, { now: NOW })).toBe(true);
    expect(workspaceHolder(WS, { now: NOW, ...running })).toBeUndefined();
  });

  test("releasing an unheld workspace is a no-op, not a failure", () => {
    expect(releaseWorkspace(WS, { turnId: "t1" }, { now: NOW })).toBe(true);
  });
});

describe("workspaceHolder / listWorkspaceLocks", () => {
  test("a stale lock is pruned on inspection", async () => {
    await put({ turn_id: "corpse" });
    expect(workspaceHolder(WS, { now: NOW, ...finished })).toBeUndefined();
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
    const locks = listWorkspaceLocks({ now: NOW, ...running });
    expect(locks.map((l) => l.workspace)).toEqual([
      normalizeWorkspace("/tmp/a"),
      normalizeWorkspace("/tmp/b"),
    ]);
  });

  test("a corrupt lock file is discarded, not fatal", async () => {
    await writeFile(join(dir, "garbage.json"), "{oh no");
    expect(listWorkspaceLocks({ now: NOW, ...running })).toHaveLength(0);
  });

  test("a guard file is never mistaken for a lock", async () => {
    await put({ turn_id: "t1" });
    writeFileSync(join(dir, `${fileFor(WS)}.guard`), "1");
    expect(listWorkspaceLocks({ now: NOW, ...running })).toHaveLength(1);
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
