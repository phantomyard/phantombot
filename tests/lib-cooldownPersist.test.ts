/**
 * File-backed cooldown persistence.
 *
 * The behaviour that matters: a window the PROVIDER set outlives our process,
 * and `phantombot update` restarts the service. Without persistence a restart
 * inside a quota window re-probes a harness we have been told is closed, and
 * the user pays a guaranteed-failed round-trip for it.
 *
 * The second behaviour that matters: none of this may ever break a turn. An
 * unreadable, torn or unwritable file degrades to "no cooldown", which is
 * exactly today's behaviour.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile, chmod } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { CooldownStore } from "../src/lib/cooldown.ts";
import {
  cooldownPath,
  fileCooldownPersistence,
  loadCooldownState,
} from "../src/lib/cooldownPersist.ts";

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "phantombot-cooldown-"));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("cooldownPath", () => {
  test("is overridable for tests and never touches state.json", () => {
    const prev = process.env.PHANTOMBOT_COOLDOWN_STATE;
    process.env.PHANTOMBOT_COOLDOWN_STATE = "/tmp/x.json";
    try {
      expect(cooldownPath()).toBe("/tmp/x.json");
    } finally {
      if (prev === undefined) delete process.env.PHANTOMBOT_COOLDOWN_STATE;
      else process.env.PHANTOMBOT_COOLDOWN_STATE = prev;
    }
    expect(cooldownPath()).not.toContain("state.json");
  });
});

describe("loadCooldownState", () => {
  test("a missing file is simply no cooldown", async () => {
    expect(await loadCooldownState(join(dir, "nope.json"))).toEqual({});
  });

  test("a TORN file is no cooldown, not a crash", async () => {
    const p = join(dir, "c.json");
    await writeFile(p, '{"codex": {"cooldownUn');
    expect(await loadCooldownState(p)).toEqual({});
  });

  test("entries with no usable deadline are dropped, good ones kept", async () => {
    const p = join(dir, "c.json");
    await writeFile(
      p,
      JSON.stringify({
        codex: { consecutiveFailures: 2, cooldownUntilMs: 123 },
        broken: { consecutiveFailures: 2 },
        alsoBroken: "nonsense",
      }),
    );
    expect(await loadCooldownState(p)).toEqual({
      codex: { consecutiveFailures: 2, cooldownUntilMs: 123 },
    });
  });

  test("a missing failure count defaults to 1 rather than 0", async () => {
    // 0 would mean "no failures", which reads as healthy and would let the
    // next failure restart the ladder at its 150s base.
    const p = join(dir, "c.json");
    await writeFile(p, JSON.stringify({ codex: { cooldownUntilMs: 123 } }));
    expect((await loadCooldownState(p)).codex!.consecutiveFailures).toBe(1);
  });
});

describe("round trip", () => {
  test("a window survives a 'restart' — store → file → new store", async () => {
    const p = join(dir, "c.json");
    let now = 1_000_000;
    const before = new CooldownStore(() => 0.5, () => now);
    const sink = fileCooldownPersistence(p);
    before.hydrate({}, sink);
    before.markFailure("codex", { retryAfterMs: 4 * 3_600_000 });

    // The sink is fire-and-forget by contract; wait for the queued write to
    // settle rather than sleeping — a fixed 20 ms lost the race on a loaded
    // CI runner (PR #608 run 35917775889) and read the file before it existed.
    await sink.settled?.();
    expect(JSON.parse(await readFile(p, "utf8")).codex.cooldownUntilMs).toBe(
      now + 4 * 3_600_000,
    );

    const after = new CooldownStore(() => 0.5, () => now);
    after.hydrate(await loadCooldownState(p));
    expect(after.isCooledDown("codex").cooled).toBe(true);
  });

  test("an unwritable path is swallowed — the store still works", async () => {
    const readOnly = join(dir, "ro");
    await Bun.write(join(readOnly, "keep"), "x");
    await chmod(readOnly, 0o500);
    const s = new CooldownStore(() => 0.5, () => 0);
    const sink = fileCooldownPersistence(join(readOnly, "c.json"));
    s.hydrate({}, sink);
    expect(() => s.markFailure("codex")).not.toThrow();
    // Same wait as above: the failed write must have run (and been swallowed)
    // before we assert the store is unaffected by it.
    await sink.settled?.();
    expect(s.isCooledDown("codex").cooled).toBe(true);
    await chmod(readOnly, 0o700);
  });
});

/**
 * Write ORDERING. `writeFileAtomic` is write-temp-then-rename, so two saves
 * in flight race to rename over the same path and the winner is not
 * necessarily the newer snapshot. A chain fall-through issues one markFailure
 * per harness back-to-back, so the burst is routine, not exotic.
 */
describe("fileCooldownPersistence serialisation", () => {
  test("the LAST snapshot wins after a rapid burst of saves", async () => {
    const path = join(dir, "burst.json");
    const sink = fileCooldownPersistence(path);
    const now = Date.now();
    for (let i = 1; i <= 20; i++) {
      sink.save({ codex: { cooldownUntilMs: now + i * 1000, consecutiveFailures: i } });
    }
    await sink.settled?.();
    const onDisk = await loadCooldownState(path);
    expect(onDisk.codex?.consecutiveFailures).toBe(20);
    expect(onDisk.codex?.cooldownUntilMs).toBe(now + 20_000);
  });

  test("a save during an in-flight write is not lost", async () => {
    const path = join(dir, "inflight.json");
    const sink = fileCooldownPersistence(path);
    const now = Date.now();
    sink.save({ codex: { cooldownUntilMs: now + 1000, consecutiveFailures: 1 } });
    // Yield once so the first write is genuinely in flight, then save again —
    // the second must still reach disk rather than being dropped or
    // overtaken by the first.
    await Promise.resolve();
    sink.save({ codex: { cooldownUntilMs: now + 9000, consecutiveFailures: 9 } });
    await sink.settled?.();
    const onDisk = await loadCooldownState(path);
    expect(onDisk.codex?.consecutiveFailures).toBe(9);
  });

  test("a failed write does not poison later ones", async () => {
    const path = join(dir, "nested", "later.json");
    const sink = fileCooldownPersistence(path);
    // Parent dir missing → first write fails. It must be swallowed (the
    // contract is "never throw") and must not wedge the chain.
    sink.save({ codex: { cooldownUntilMs: Date.now() + 1000, consecutiveFailures: 1 } });
    await sink.settled?.();
    const ok = fileCooldownPersistence(join(dir, "ok.json"));
    ok.save({ codex: { cooldownUntilMs: Date.now() + 2000, consecutiveFailures: 3 } });
    await ok.settled?.();
    expect((await loadCooldownState(join(dir, "ok.json"))).codex?.consecutiveFailures).toBe(3);
  });
});

/**
 * clear() used to drop the persistence sink, turning "reset the cooldowns"
 * into a silent one-way disable of persistence for the rest of the process.
 */
describe("CooldownStore.clear", () => {
  test("persists the cleared state instead of dropping the sink", async () => {
    const path = join(dir, "cleared.json");
    const sink = fileCooldownPersistence(path);
    const store = new CooldownStore();
    store.hydrate({}, sink);
    store.markFailure("codex");
    await sink.settled?.();
    expect(Object.keys(await loadCooldownState(path))).toEqual(["codex"]);

    store.clear();
    await sink.settled?.();
    // The clear itself reached disk: a restart must not re-adopt the window.
    expect(await loadCooldownState(path)).toEqual({});
  });

  test("the sink survives clear(), so later failures still persist", async () => {
    const path = join(dir, "after-clear.json");
    const sink = fileCooldownPersistence(path);
    const store = new CooldownStore();
    store.hydrate({}, sink);
    store.clear();
    store.markFailure("codex");
    await sink.settled?.();
    // This is the regression: with the sink nulled out, this file stays empty
    // and the process silently stops persisting until restart.
    expect(Object.keys(await loadCooldownState(path))).toEqual(["codex"]);
  });
});
