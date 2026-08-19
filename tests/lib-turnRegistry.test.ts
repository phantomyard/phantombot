import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  INTERACTIVE_COOLDOWN_MS,
  MAX_DEFERRAL_MS,
  MAX_TURN_LIFETIME_MS,
  interactiveActivity,
  isRunning,
  readRegistry,
  registerTurn,
  registryEnabled,
  shouldDeferWake,
  siblingNotice,
  siblingTurns,
  type TurnRecord,
} from "../src/lib/turnRegistry.ts";

let dir: string;
const prevEnabled = process.env.PHANTOMBOT_TURN_REGISTRY;
const prevDir = process.env.PHANTOMBOT_TURN_REGISTRY_DIR;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "phantombot-turns-"));
  process.env.PHANTOMBOT_TURN_REGISTRY = "1";
  process.env.PHANTOMBOT_TURN_REGISTRY_DIR = dir;
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
  if (prevEnabled === undefined) delete process.env.PHANTOMBOT_TURN_REGISTRY;
  else process.env.PHANTOMBOT_TURN_REGISTRY = prevEnabled;
  if (prevDir === undefined) delete process.env.PHANTOMBOT_TURN_REGISTRY_DIR;
  else process.env.PHANTOMBOT_TURN_REGISTRY_DIR = prevDir;
});

const NOW = new Date("2026-08-19T12:00:00.000Z");

/** A record owned by a process that is definitely not us. */
function record(over: Partial<TurnRecord> = {}): TurnRecord {
  return {
    id: over.id ?? "aaaa",
    persona: "robbie",
    conversation: "telegram:7995070089",
    origin: "channel",
    pid: 424242,
    started_at: NOW.toISOString(),
    ...over,
  };
}

async function seed(rec: TurnRecord): Promise<void> {
  await writeFile(join(dir, `${rec.id}.json`), JSON.stringify(rec), "utf8");
}

const alive = () => true;
const dead = () => false;

describe("turn registry — register / release round trip", () => {
  test("a registered turn is visible to another reader as running", () => {
    const handle = registerTurn({
      persona: "robbie",
      conversation: "telegram:1",
      origin: "channel",
    });
    const snap = readRegistry({ now: NOW });
    expect(snap.running.map((r) => r.id)).toEqual([handle.id]);
    expect(snap.recent).toHaveLength(0);
  });

  test("release moves the entry out of running but keeps it as recent", () => {
    const handle = registerTurn({
      persona: "robbie",
      conversation: "telegram:1",
      origin: "channel",
    });
    handle.release();
    const snap = readRegistry({ now: new Date() });
    expect(snap.running).toHaveLength(0);
    expect(snap.recent.map((r) => r.id)).toEqual([handle.id]);
    // Retaining it is the point: a just-finished turn is still evidence the
    // principal is mid-conversation.
    expect(snap.recent[0]?.finished_at).toBeTruthy();
  });

  test("release is idempotent", () => {
    const handle = registerTurn({
      persona: "robbie",
      conversation: "telegram:1",
      origin: "channel",
    });
    handle.release();
    const first = readRegistry({ now: new Date() }).recent[0]?.finished_at;
    handle.release();
    const second = readRegistry({ now: new Date() }).recent[0]?.finished_at;
    expect(second).toBe(first!);
  });

  test("the kill switch makes registration and reads inert", () => {
    process.env.PHANTOMBOT_TURN_REGISTRY = "0";
    expect(registryEnabled()).toBe(false);
    registerTurn({
      persona: "robbie",
      conversation: "telegram:1",
      origin: "channel",
    });
    expect(readRegistry({ now: NOW }).running).toHaveLength(0);
  });

  test("registration is off under NODE_ENV=test unless explicitly enabled", () => {
    delete process.env.PHANTOMBOT_TURN_REGISTRY;
    expect(process.env.NODE_ENV).toBe("test");
    expect(registryEnabled()).toBe(false);
  });
});

describe("turn registry — liveness (issue #391 crash safety)", () => {
  test("an entry whose owner died is NOT running, however fresh it looks", () => {
    // The whole failure mode: release() never ran, so the file still says
    // in-flight one second after the process was SIGKILLed.
    const rec = record({ started_at: new Date(NOW.getTime() - 1000).toISOString() });
    expect(isRunning(rec, NOW, dead)).toBe(false);
    expect(isRunning(rec, NOW, alive)).toBe(true);
  });

  test("a recycled pid is dead, not running", () => {
    const rec = record({ pid_start: "111" });
    expect(isRunning(rec, NOW, alive, () => "222")).toBe(false);
    expect(isRunning(rec, NOW, alive, () => "111")).toBe(true);
  });

  test("an unreadable start token falls back to the pid check, never to 'different'", () => {
    const rec = record({ pid_start: "111" });
    expect(isRunning(rec, NOW, alive, () => null)).toBe(true);
  });

  test("a live-pid entry older than MAX_TURN_LIFETIME_MS stops counting as running", () => {
    // Backstop for an abandoned generator: the owner is genuinely alive, so
    // the pid check can never retire this entry on its own.
    const stale = record({
      started_at: new Date(NOW.getTime() - MAX_TURN_LIFETIME_MS - 1).toISOString(),
    });
    expect(isRunning(stale, NOW, alive)).toBe(false);
    const fresh = record({
      started_at: new Date(NOW.getTime() - MAX_TURN_LIFETIME_MS + 1000).toISOString(),
    });
    expect(isRunning(fresh, NOW, alive)).toBe(true);
  });

  test("expired and unparseable entries are pruned from disk on read", async () => {
    await seed(record({ id: "old", finished_at: "2026-01-01T00:00:00.000Z" }));
    await writeFile(join(dir, "garbage.json"), "{not json", "utf8");
    await seed(record({ id: "keep" }));
    const snap = readRegistry({ now: NOW, isAlive: alive });
    expect(snap.running.map((r) => r.id)).toEqual(["keep"]);
    expect((await readdir(dir)).sort()).toEqual(["keep.json"]);
  });
});

describe("turn registry — siblings", () => {
  test("a turn never reports itself as its own sibling", () => {
    const handle = registerTurn({
      persona: "robbie",
      conversation: "telegram:1",
      origin: "channel",
    });
    expect(siblingTurns("robbie", handle.id, { now: NOW })).toHaveLength(0);
    expect(siblingTurns("robbie", undefined, { now: NOW })).toHaveLength(1);
  });

  test("siblings are scoped to one persona", async () => {
    await seed(record({ id: "other-persona", persona: "lena" }));
    await seed(record({ id: "mine" }));
    const found = siblingTurns("robbie", undefined, { now: NOW, isAlive: alive });
    expect(found.map((r) => r.id)).toEqual(["mine"]);
  });

  test("the notice names the sibling and forbids blind shared-state writes", () => {
    const notice = siblingNotice([record({ conversation: "tick:42" })])!;
    expect(notice).toContain("tick:42");
    expect(notice).toContain("CHANGES SHARED STATE");
    expect(notice).toContain("Read-only work needs no such care");
  });

  test("no siblings means no notice at all — the common case stays free", () => {
    expect(siblingNotice([])).toBeUndefined();
  });
});

describe("wake deferral (issue #391)", () => {
  const due = new Date(NOW.getTime() - 30_000);

  test("a wake is deferred while an interactive turn is in flight", async () => {
    await seed(record({ id: "live", origin: "channel" }));
    const verdict = shouldDeferWake("robbie", due, { now: NOW, isAlive: alive });
    expect(verdict.defer).toBe(true);
    expect(verdict.reason).toBe("interactive turn in flight");
  });

  test("a wake is deferred just after an interactive turn ends — the 63-second gap", async () => {
    // The actual incident: the interactive turn had already finished when the
    // task fired 63s later, so an in-flight-only check would have missed it.
    await seed(
      record({
        id: "just-finished",
        finished_at: new Date(NOW.getTime() - 63_000).toISOString(),
      }),
    );
    const verdict = shouldDeferWake("robbie", due, { now: NOW, isAlive: dead });
    expect(verdict.defer).toBe(true);
    expect(verdict.reason).toBe("interactive turn within cooldown");
  });

  test("past the cooldown the wake fires", async () => {
    await seed(
      record({
        id: "long-done",
        finished_at: new Date(
          NOW.getTime() - INTERACTIVE_COOLDOWN_MS - 1000,
        ).toISOString(),
      }),
    );
    expect(shouldDeferWake("robbie", due, { now: NOW, isAlive: dead }).defer).toBe(
      false,
    );
  });

  test("a dead interactive turn does not defer anything", async () => {
    // A crashed daemon must not park every scheduled task until retention
    // expires. This is the case the pid probe exists for.
    await seed(record({ id: "crashed" }));
    expect(shouldDeferWake("robbie", due, { now: NOW, isAlive: dead }).defer).toBe(
      false,
    );
  });

  test("background turns never defer a wake — only conversations do", async () => {
    await seed(record({ id: "nightly", origin: "internal" }));
    await seed(record({ id: "task", origin: "task" }));
    expect(shouldDeferWake("robbie", due, { now: NOW, isAlive: alive }).defer).toBe(
      false,
    );
  });

  test("another persona's conversation never defers this persona's wake", async () => {
    await seed(record({ id: "lena-chat", persona: "lena" }));
    expect(shouldDeferWake("robbie", due, { now: NOW, isAlive: alive }).defer).toBe(
      false,
    );
  });

  test("deferral is bounded — a task overdue past the ceiling fires anyway", async () => {
    // Starvation is the worse failure: it is silent.
    await seed(record({ id: "live" }));
    const starved = new Date(NOW.getTime() - MAX_DEFERRAL_MS - 1);
    expect(
      shouldDeferWake("robbie", starved, { now: NOW, isAlive: alive }).defer,
    ).toBe(false);
    const notYet = new Date(NOW.getTime() - MAX_DEFERRAL_MS + 1000);
    expect(
      shouldDeferWake("robbie", notYet, { now: NOW, isAlive: alive }).defer,
    ).toBe(true);
  });

  test("interactiveActivity reports quiet when nothing has ever run", () => {
    expect(interactiveActivity("robbie", { now: NOW })).toEqual({
      inFlight: false,
      recent: false,
    });
  });
});
