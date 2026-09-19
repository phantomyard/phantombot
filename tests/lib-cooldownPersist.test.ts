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
    before.hydrate({}, fileCooldownPersistence(p));
    before.markFailure("codex", { retryAfterMs: 4 * 3_600_000 });

    // The sink is fire-and-forget by contract; let the write land.
    await Bun.sleep(20);
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
    s.hydrate({}, fileCooldownPersistence(join(readOnly, "c.json")));
    expect(() => s.markFailure("codex")).not.toThrow();
    await Bun.sleep(20);
    expect(s.isCooledDown("codex").cooled).toBe(true);
    await chmod(readOnly, 0o700);
  });
});
