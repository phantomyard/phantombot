/**
 * Tests for the stale-maintenance detection + tick throttle that make the
 * per-persona maintenance heal reachable from a job the heartbeat does not
 * own (#510).
 *
 * The heal dispatch itself (`healMaintenanceUnits`) is exercised through the
 * per-backend suites — lib-launchd / lib-systemd / lib-taskScheduler — and is
 * inert here anyway: it returns early unless the running process IS the
 * installed `phantombot` binary.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  TICK_HEAL_MIN_INTERVAL_MINUTES,
  healStaleMaintenanceFromTick,
  shouldAttemptTickHeal,
  staleMaintenancePersonas,
} from "../src/lib/maintenanceHeal.ts";
import { recordHeartbeatFired } from "../src/lib/timerHealth.ts";
import type { Config } from "../src/config.ts";

let workdir: string;
let prevState: string | undefined;

const cfg = (defaultPersona: string, autostart: string[] = []) =>
  ({ defaultPersona, autostartPersonas: autostart }) as unknown as Config;

beforeEach(async () => {
  workdir = await mkdtemp(join(tmpdir(), "phantombot-maintheal-"));
  prevState = process.env.XDG_STATE_HOME;
  process.env.XDG_STATE_HOME = workdir;
});

afterEach(async () => {
  if (prevState === undefined) delete process.env.XDG_STATE_HOME;
  else process.env.XDG_STATE_HOME = prevState;
  await rm(workdir, { recursive: true, force: true });
});

describe("staleMaintenancePersonas", () => {
  test("a fresh marker is not stale", async () => {
    await recordHeartbeatFired("max");
    expect(staleMaintenancePersonas(cfg("max"))).toEqual([]);
  });

  test("a marker older than the bar is stale (the matt case)", async () => {
    await recordHeartbeatFired("matt");
    // matt's launchd job went 41h without firing while the daemon was healthy.
    const later = new Date(Date.now() + 41 * 60 * 60_000);
    expect(staleMaintenancePersonas(cfg("matt"), later)).toEqual(["matt"]);
  });

  test("a missing marker counts as stale — the never-bootstrapped instance", () => {
    expect(staleMaintenancePersonas(cfg("max"))).toEqual(["max"]);
  });

  test("only the stale personas are named, not the whole roster", async () => {
    // max's instance is firing; kai's never bootstrapped, so it has no marker
    // at all — exactly the per-persona blind spot doctor only saw host-locally.
    await recordHeartbeatFired("max");
    const stale = staleMaintenancePersonas(cfg("max", ["kai"]));
    expect(stale).toEqual(["kai"]);
  });
});

describe("shouldAttemptTickHeal", () => {
  const marker = () => join(workdir, "attempt");

  test("healthy host: no heal, and no attempt marker written", async () => {
    await recordHeartbeatFired("max");
    const r = await shouldAttemptTickHeal(cfg("max"), { markerPath: marker() });
    expect(r.heal).toBe(false);
    expect(existsSync(marker())).toBe(false);
  });

  test("stale host: heals and records the attempt", async () => {
    const now = new Date();
    const r = await shouldAttemptTickHeal(cfg("max"), {
      now,
      markerPath: marker(),
    });
    expect(r.heal).toBe(true);
    expect(r.stale).toEqual(["max"]);
    expect(readFileSync(marker(), "utf8").trim()).toBe(now.toISOString());
  });

  test("second attempt inside the interval is throttled", async () => {
    const now = new Date();
    await shouldAttemptTickHeal(cfg("max"), { now, markerPath: marker() });
    // Tick fires every minute; the next minute must not heal again.
    const soon = new Date(now.getTime() + 60_000);
    const r = await shouldAttemptTickHeal(cfg("max"), {
      now: soon,
      markerPath: marker(),
    });
    expect(r.heal).toBe(false);
    // Still stale — the throttle suppresses the attempt, not the diagnosis.
    expect(r.stale).toEqual(["max"]);
  });

  test("attempt is allowed again once the interval has passed", async () => {
    const now = new Date();
    await shouldAttemptTickHeal(cfg("max"), { now, markerPath: marker() });
    const later = new Date(
      now.getTime() + (TICK_HEAL_MIN_INTERVAL_MINUTES + 1) * 60_000,
    );
    const r = await shouldAttemptTickHeal(cfg("max"), {
      now: later,
      markerPath: marker(),
    });
    expect(r.heal).toBe(true);
  });

  test("a clock step backwards does not unlock a heal every minute", async () => {
    const now = new Date();
    await shouldAttemptTickHeal(cfg("max"), { now, markerPath: marker() });
    const earlier = new Date(now.getTime() - 60 * 60_000);
    const r = await shouldAttemptTickHeal(cfg("max"), {
      now: earlier,
      markerPath: marker(),
    });
    expect(r.heal).toBe(false);
  });

  test("an unparseable attempt marker fails open rather than wedging the heal", async () => {
    await writeFile(marker(), "not-a-date\n", "utf8");
    const r = await shouldAttemptTickHeal(cfg("max"), { markerPath: marker() });
    expect(r.heal).toBe(true);
  });
});

describe("healStaleMaintenanceFromTick (the tick call site)", () => {
  const marker = () => join(workdir, "attempt");

  test("does nothing when this process is not the installed binary", async () => {
    let calls = 0;
    const r = await healStaleMaintenanceFromTick(cfg("max"), {
      markerPath: marker(),
      isInstalled: () => false,
      heal: async () => {
        calls++;
      },
    });
    expect(r.healed).toBe(false);
    expect(calls).toBe(0);
    // No attempt recorded either: a dev run must leave no trace.
    expect(existsSync(marker())).toBe(false);
  });

  test("heals a stale host and names the stale personas", async () => {
    const seen: string[][] = [];
    const r = await healStaleMaintenanceFromTick(cfg("matt"), {
      markerPath: marker(),
      isInstalled: () => true,
      heal: async (p) => {
        seen.push([...p]);
      },
    });
    expect(r.healed).toBe(true);
    expect(seen).toEqual([["matt"]]);
  });

  test("a healthy host costs no service-manager call", async () => {
    await recordHeartbeatFired("max");
    let calls = 0;
    const r = await healStaleMaintenanceFromTick(cfg("max"), {
      markerPath: marker(),
      isInstalled: () => true,
      heal: async () => {
        calls++;
      },
    });
    expect(r.healed).toBe(false);
    expect(calls).toBe(0);
  });

  test("the minute after a heal does not heal again", async () => {
    const now = new Date();
    let calls = 0;
    const opts = {
      markerPath: marker(),
      isInstalled: () => true,
      heal: async () => {
        calls++;
      },
    };
    await healStaleMaintenanceFromTick(cfg("max"), { ...opts, now });
    await healStaleMaintenanceFromTick(cfg("max"), {
      ...opts,
      now: new Date(now.getTime() + 60_000),
    });
    expect(calls).toBe(1);
  });
});
