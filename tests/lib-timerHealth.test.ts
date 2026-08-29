import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  HEARTBEAT_STALE_MINUTES,
  TICK_STALE_MINUTES,
  heartbeatMarkerPath,
  loadHeartbeatLastFired,
  loadPersonaHeartbeatLastFired,
  loadTickLastFired,
  recordHeartbeatFired,
  recordTickFired,
  tickMarkerPath,
} from "../src/lib/timerHealth.ts";

let workdir: string;
let prevState: string | undefined;

beforeEach(async () => {
  workdir = await mkdtemp(join(tmpdir(), "phantombot-timerhealth-"));
  prevState = process.env.XDG_STATE_HOME;
  process.env.XDG_STATE_HOME = workdir;
});

afterEach(async () => {
  if (prevState === undefined) {
    delete process.env.XDG_STATE_HOME;
  } else {
    process.env.XDG_STATE_HOME = prevState;
  }
  await rm(workdir, { recursive: true, force: true });
});

describe("timerHealth", () => {
  test("recordHeartbeatFired writes a marker with ISO + runs counter", async () => {
    await recordHeartbeatFired();
    const path = heartbeatMarkerPath();
    expect(existsSync(path)).toBe(true);
    const text = readFileSync(path, "utf8");
    expect(text).toMatch(/^ISO=\S+ runs=1\n$/);
  });

  test("repeat fires bump the runs counter", async () => {
    await recordHeartbeatFired();
    await recordHeartbeatFired();
    await recordHeartbeatFired();
    const text = readFileSync(heartbeatMarkerPath(), "utf8");
    expect(text).toMatch(/runs=3/);
  });

  test("loadHeartbeatLastFired returns {} when no marker exists", () => {
    const r = loadHeartbeatLastFired();
    expect(r).toEqual({});
  });

  test("loadHeartbeatLastFired returns iso + ageMinutes after a fire", async () => {
    await recordHeartbeatFired();
    const now = new Date(Date.now() + 5 * 60_000); // simulate 5m later
    const r = loadHeartbeatLastFired(now);
    expect(r.iso).toBeDefined();
    expect(r.ageMinutes).toBe(5);
    expect(r.runs).toBe(1);
  });

  test("recordTickFired and loadTickLastFired share the tick marker", async () => {
    await recordTickFired();
    expect(existsSync(tickMarkerPath())).toBe(true);
    const r = loadTickLastFired();
    expect(r.iso).toBeDefined();
    expect(r.ageMinutes).toBeLessThanOrEqual(1);
  });

  test("heartbeat and tick markers are separate files", async () => {
    await recordHeartbeatFired();
    await recordTickFired();
    expect(heartbeatMarkerPath()).not.toBe(tickMarkerPath());
    expect(existsSync(heartbeatMarkerPath())).toBe(true);
    expect(existsSync(tickMarkerPath())).toBe(true);
  });

  test("corrupt marker falls back to mtime, doesn't throw", async () => {
    const p = heartbeatMarkerPath();
    // Pre-create XDG state dir by firing once, then overwrite with garbage.
    await recordHeartbeatFired();
    await writeFile(p, "garbage with no ISO\n", "utf8");
    const r = loadHeartbeatLastFired();
    // Falls back to mtime-derived iso, age should be small.
    expect(r.iso).toBeDefined();
    expect(r.ageMinutes).toBeLessThanOrEqual(1);
  });

  test("per-persona markers are separate files (#486)", async () => {
    await recordHeartbeatFired("lena");
    await recordHeartbeatFired("kai");
    expect(heartbeatMarkerPath("lena")).not.toBe(heartbeatMarkerPath("kai"));
    expect(existsSync(heartbeatMarkerPath("lena"))).toBe(true);
    expect(existsSync(heartbeatMarkerPath("kai"))).toBe(true);
    // And distinct from the legacy timer-scoped marker.
    expect(heartbeatMarkerPath("lena")).not.toBe(heartbeatMarkerPath());
  });

  test("loadPersonaHeartbeatLastFired reads only the persona's own marker", async () => {
    await recordHeartbeatFired("kai");
    const own = loadPersonaHeartbeatLastFired("kai");
    expect(own.iso).toBeDefined();
    // Another persona with no marker sees nothing — not kai's fire.
    expect(loadPersonaHeartbeatLastFired("lena").iso).toBeUndefined();
  });

  test("the default persona falls back to the legacy marker; a non-default does not (#486)", async () => {
    // Pre-#486 upgrade state: only the timer-scoped marker exists.
    await recordHeartbeatFired();
    expect(
      loadPersonaHeartbeatLastFired("lena", { isDefault: true }).iso,
    ).toBeDefined();
    expect(loadPersonaHeartbeatLastFired("kai").iso).toBeUndefined();
    // Once the default has its own per-persona marker, it wins over legacy.
    await recordHeartbeatFired("lena");
    const r = loadPersonaHeartbeatLastFired("lena", { isDefault: true });
    expect(r.iso).toBeDefined();
    expect(r.runs).toBe(1); // the persona file's own counter, not legacy's
  });

  test("default thresholds are sane (heartbeat > tick)", () => {
    expect(HEARTBEAT_STALE_MINUTES).toBeGreaterThan(TICK_STALE_MINUTES);
    // 2× the 30m cadence + slack: tight enough to flag a wedged timer
    // within ~an hour, loose enough to ignore a single late fire.
    expect(HEARTBEAT_STALE_MINUTES).toBeGreaterThanOrEqual(60);
    expect(HEARTBEAT_STALE_MINUTES).toBeLessThanOrEqual(90);
    expect(TICK_STALE_MINUTES).toBeLessThanOrEqual(15);
  });
});
