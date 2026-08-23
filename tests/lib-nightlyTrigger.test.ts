/**
 * Tests for day-rollover detection — the trigger that replaced the 02:00
 * nightly timer.
 */

import { describe, expect, test } from "bun:test";
import {
  buildNightlyLaunch,
  dailyFileDate,
  dayRolledOver,
  type NightlyHostEnv,
  nightlyUnitName,
} from "../src/lib/nightlyTrigger.ts";
import { PHANTOMBOT_SERVICE_PATH } from "../src/lib/systemd.ts";

describe("dailyFileDate", () => {
  test("uses the same basis the daily-file writer uses (UTC)", () => {
    // `memory capture` names files from toISOString(), so rollover detection
    // has to agree with that boundary or it would fire while the day it is
    // about to process is still being appended to.
    const at = new Date("2026-06-01T23:30:00Z");
    expect(dailyFileDate(at)).toBe("2026-06-01");
    expect(dailyFileDate(new Date("2026-06-02T00:00:00Z"))).toBe("2026-06-02");
  });
});

describe("dayRolledOver", () => {
  test("true when the previous fire was on an earlier day", () => {
    expect(
      dayRolledOver("2026-06-01T23:45:00Z", new Date("2026-06-02T00:15:00Z")),
    ).toBe(true);
  });

  test("false within the same day, even 23 hours apart", () => {
    expect(
      dayRolledOver("2026-06-01T00:30:00Z", new Date("2026-06-01T23:30:00Z")),
    ).toBe(false);
  });

  test("false with no marker — startup already swept, don't double up", () => {
    expect(dayRolledOver(undefined, new Date("2026-06-02T00:15:00Z"))).toBe(
      false,
    );
  });

  test("false on an unparseable marker rather than firing blind", () => {
    expect(dayRolledOver("not-a-date", new Date("2026-06-02T00:15:00Z"))).toBe(
      false,
    );
  });

  test("false when the clock stepped backwards (NTP fix, restored snapshot)", () => {
    // Previous fire recorded in the future: nothing has closed, so nothing to
    // distil. Firing here would process a day that is still open.
    expect(
      dayRolledOver("2026-06-03T10:00:00Z", new Date("2026-06-02T09:00:00Z")),
    ).toBe(false);
  });

  test("true across a multi-day gap (box was powered off for a week)", () => {
    expect(
      dayRolledOver("2026-05-26T09:00:00Z", new Date("2026-06-02T09:00:00Z")),
    ).toBe(true);
  });
});

describe("buildNightlyLaunch", () => {
  const bare = { command: "/usr/local/bin/phantombot", args: ["nightly", "--persona", "robbie"] };
  const systemd: NightlyHostEnv = {
    platform: "linux",
    systemdRunPath: "/usr/bin/systemd-run",
    systemdBooted: true,
    userSessionRuntimeDir: "/run/user/1000",
    home: "/home/robbie",
  };

  test("systemd hosts launch a TRANSIENT unit, not a bare child", () => {
    // The whole bug: a detached child stays in the heartbeat's Type=oneshot
    // cgroup and is SIGKILLed when `phantombot heartbeat` exits ~1s later.
    // Only a separate unit has a lifecycle of its own.
    const l = buildNightlyLaunch(bare, "robbie", systemd, "phantombot-nightly-robbie-x");
    expect(l.transient).toBe(true);
    expect(l.command).toBe("/usr/bin/systemd-run");
    expect(l.args).toContain("--user");
    expect(l.args).toContain("--collect");
    expect(l.args).toContain("--unit=phantombot-nightly-robbie-x");
    // The real command still runs, after the `--` separator.
    const sep = l.args.indexOf("--");
    expect(sep).toBeGreaterThan(0);
    expect(l.args.slice(sep + 1)).toEqual([bare.command, ...bare.args]);
  });

  test("the transient unit re-sources the env files and pins PATH", () => {
    // A --user transient unit inherits the user MANAGER's environment, not the
    // caller's, so without this the sweep would run with neither phantombot's
    // own .env nor the agent's ~/.env, and with whatever PATH the manager has.
    const l = buildNightlyLaunch(bare, "robbie", systemd);
    expect(l.args).toContain("--property=EnvironmentFile=-/home/robbie/.env");
    expect(l.args).toContain(
      "--property=EnvironmentFile=-/home/robbie/.config/phantombot/.env",
    );
    const path = l.args.find((a) => a.startsWith("--property=Environment=PATH="));
    // `%h` is a unit-FILE specifier; transient properties travel over D-Bus
    // where nothing expands it, so home must already be resolved here.
    expect(path).toBeDefined();
    expect(path).not.toContain("%h");
    expect(path).toContain("/home/robbie/.local/bin");
  });

  test("the pinned PATH stays in lockstep with the installed units", () => {
    // Derived, not restated: if the service PATH gains an entry, the transient
    // nightly unit has to gain it too, or the sweep resolves binaries against
    // a different lookup path than every other phantombot unit.
    const l = buildNightlyLaunch(bare, "robbie", systemd);
    const path = l.args.find((a) => a.startsWith("--property=Environment=PATH="));
    expect(path).toBe(
      `--property=Environment=PATH=${PHANTOMBOT_SERVICE_PATH.replaceAll("%h", "/home/robbie")}`,
    );
  });

  test("no secrets are passed on the command line", () => {
    // --setenv would put the value in `systemctl show` and the journal.
    const l = buildNightlyLaunch(bare, "robbie", systemd);
    expect(l.args.some((a) => a.startsWith("--setenv"))).toBe(false);
  });

  test("macOS stays a bare detached child — launchd does not kill it", () => {
    const l = buildNightlyLaunch(bare, "robbie", {
      platform: "darwin",
      systemdBooted: false,
      home: "/Users/matt",
    });
    expect(l.transient).toBe(false);
    expect(l.command).toBe(bare.command);
    expect(l.args).toEqual(bare.args);
  });

  test("Windows stays a bare detached child", () => {
    const l = buildNightlyLaunch(bare, "megan", {
      platform: "win32",
      systemdBooted: false,
      home: "C:\\Users\\megan",
    });
    expect(l.transient).toBe(false);
  });

  test("linux WITHOUT systemd-run installed falls back to the bare child", () => {
    const l = buildNightlyLaunch(bare, "robbie", { ...systemd, systemdRunPath: undefined });
    expect(l.transient).toBe(false);
  });

  test("linux with no user session (no XDG_RUNTIME_DIR) falls back", () => {
    // `systemd-run --user` has no bus to talk to here; a bare child at least
    // runs, and on a non-unit caller nothing tears its cgroup down.
    const l = buildNightlyLaunch(bare, "robbie", { ...systemd, userSessionRuntimeDir: undefined });
    expect(l.transient).toBe(false);
  });

  test("a container that has systemd-run but is not systemd-booted falls back", () => {
    const l = buildNightlyLaunch(bare, "robbie", { ...systemd, systemdBooted: false });
    expect(l.transient).toBe(false);
  });
});

describe("nightlyUnitName", () => {
  test("folds characters systemd rejects in a unit name", () => {
    // Persona names are user-supplied; `/` or a space would make systemd-run
    // fail and silently drop us onto the fallback path forever.
    const name = nightlyUnitName("dev/persona name!", new Date("2026-08-21T00:00:40Z"), 42);
    expect(name).toMatch(/^[A-Za-z0-9:_.-]+$/);
    expect(name).toContain("dev-persona-name-");
  });

  test("two launches in the same second do not collide on a name", () => {
    const at = new Date("2026-08-21T00:00:40Z");
    expect(nightlyUnitName("robbie", at, 10)).not.toBe(nightlyUnitName("robbie", at, 11));
  });

  test("a very long persona name stays inside systemd's name limit", () => {
    const name = nightlyUnitName("x".repeat(300));
    expect(name.length).toBeLessThan(120);
  });
});
