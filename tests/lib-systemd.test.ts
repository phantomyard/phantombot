/**
 * Tests for systemd unit generation + install/uninstall logic.
 *
 * Uses a fake SystemctlRunner that records every invocation, so we don't
 * need actual systemctl on the test host.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildSystemctlEnv,
  driftedUnitNames,
  ensureSystemdUnitsCurrent,
  ensureUnitCurrent,
  ensureUserSystemdEnv,
  generateSystemdUnit,
  installPhantombotUnit,
  phantombotUnitTargets,
  SELF_RESTART_ARGS,
  uninstallPhantombotUnit,
  type SystemctlResult,
  type SystemctlRunner,
} from "../src/lib/systemd.ts";

class FakeSystemctl implements SystemctlRunner {
  calls: string[][] = [];
  /** Return code per call. Defaults to 0. */
  responses: SystemctlResult[] = [];
  async run(args: readonly string[]): Promise<SystemctlResult> {
    this.calls.push([...args]);
    return (
      this.responses.shift() ?? { exitCode: 0, stdout: "", stderr: "" }
    );
  }
}

class CaptureStream {
  chunks: string[] = [];
  write(s: string | Uint8Array): boolean {
    this.chunks.push(typeof s === "string" ? s : new TextDecoder().decode(s));
    return true;
  }
  get text(): string {
    return this.chunks.join("");
  }
}

let workdir: string;
let unitPath: string;
let hbServicePath: string;
let hbTimerPath: string;
let ngServicePath: string;
let ngTimerPath: string;
let tickServicePath: string;
let tickTimerPath: string;

/**
 * Build the heartbeat/nightly/tick path overrides every install test
 * needs. Without these, installPhantombotUnit would write to the real
 * ~/.config/systemd/user/ on the test runner — the bug fixed in #44.
 */
function tmpInstallPaths() {
  return {
    heartbeatServicePath: hbServicePath,
    heartbeatTimerPath: hbTimerPath,
    nightlyServicePath: ngServicePath,
    nightlyTimerPath: ngTimerPath,
    tickServicePath: tickServicePath,
    tickTimerPath: tickTimerPath,
  };
}

beforeEach(async () => {
  workdir = await mkdtemp(join(tmpdir(), "phantombot-systemd-"));
  unitPath = join(workdir, "phantombot.service");
  hbServicePath = join(workdir, "phantombot-heartbeat.service");
  hbTimerPath = join(workdir, "phantombot-heartbeat.timer");
  ngServicePath = join(workdir, "phantombot-nightly.service");
  ngTimerPath = join(workdir, "phantombot-nightly.timer");
  tickServicePath = join(workdir, "phantombot-tick.service");
  tickTimerPath = join(workdir, "phantombot-tick.timer");
});

afterEach(async () => {
  await rm(workdir, { recursive: true, force: true });
});

describe("generateSystemdUnit", () => {
  test("renders the canonical unit body", () => {
    const u = generateSystemdUnit({
      binPath: "/home/kai/.local/bin/phantombot",
      args: ["run"],
    });
    expect(u).toContain("Description=Phantombot");
    expect(u).toContain(
      "ExecStart=/home/kai/.local/bin/phantombot run",
    );
    expect(u).toContain("Restart=on-failure");
    expect(u).toContain("WantedBy=default.target");
  });

  test("quotes bin paths with spaces", () => {
    const u = generateSystemdUnit({
      binPath: "/path with space/phantombot",
      args: ["run"],
    });
    expect(u).toContain('ExecStart="/path with space/phantombot" run');
  });

  test("SELF_RESTART_ARGS passes --no-block so the systemctl child can exit cleanly before the cgroup kill", () => {
    // The /restart and /update flows call svc.restart() from INSIDE the
    // running service. Without --no-block, systemctl blocks awaiting
    // unit start-up — but the same restart sends SIGTERM through the
    // whole cgroup, taking out the systemctl child too, which we then
    // observed as exit 143 and (mis-)logged as "/restart failed".
    expect(SELF_RESTART_ARGS).toContain("--no-block");
    expect(SELF_RESTART_ARGS).toContain("--user");
    expect(SELF_RESTART_ARGS).toContain("restart");
    expect(SELF_RESTART_ARGS).toContain("phantombot.service");
  });

  test("declares SuccessExitStatus=143 so SIGTERM-on-self-restart isn't a failure", () => {
    // /restart and /update terminate the running process via
    // systemctl restart, which sends SIGTERM. If the in-process handler
    // doesn't translate that to a clean exit 0 in time, the runtime
    // exits with 143 (128+SIGTERM). Without this declaration, systemd
    // logs the unit as failed and Restart=on-failure kicks in on top of
    // the legitimate restart — visible noise + a redundant cycle.
    const u = generateSystemdUnit({
      binPath: "/home/kai/.local/bin/phantombot",
      args: ["run"],
    });
    expect(u).toContain("SuccessExitStatus=143");
  });
});

describe("installPhantombotUnit", () => {
  test("writes the unit file and runs daemon-reload, enable, start", async () => {
    const sys = new FakeSystemctl();
    const out = new CaptureStream();
    const err = new CaptureStream();
    const result = await installPhantombotUnit({
      binPath: "/usr/local/bin/phantombot",
      unitPath,
      ...tmpInstallPaths(),
      systemctl: sys,
      out,
      err,
    });
    expect(result.installed).toBe(true);

    const unit = await readFile(unitPath, "utf8");
    expect(unit).toContain("ExecStart=/usr/local/bin/phantombot run");

    expect(sys.calls).toEqual([
      ["--user", "daemon-reload"],
      ["--user", "enable", "phantombot.service"],
      ["--user", "start", "phantombot.service"],
      ["--user", "enable", "phantombot-heartbeat.timer"],
      ["--user", "start", "phantombot-heartbeat.timer"],
      ["--user", "enable", "phantombot-nightly.timer"],
      ["--user", "start", "phantombot-nightly.timer"],
      ["--user", "enable", "phantombot-tick.timer"],
      ["--user", "start", "phantombot-tick.timer"],
    ]);
    expect(out.text).toContain("wrote phantombot.service");
    expect(out.text).toContain("wrote phantombot-tick.timer");
    expect(out.text).toContain("enabled and started");
  });

  test("aborts on systemctl failure", async () => {
    const sys = new FakeSystemctl();
    sys.responses = [
      { exitCode: 1, stdout: "", stderr: "no bus" },
    ];
    const out = new CaptureStream();
    const err = new CaptureStream();
    const result = await installPhantombotUnit({
      binPath: "/usr/local/bin/phantombot",
      unitPath,
      ...tmpInstallPaths(),
      systemctl: sys,
      out,
      err,
    });
    expect(result.installed).toBe(false);
    expect(err.text).toContain("systemctl --user daemon-reload failed");
    // Did NOT proceed to enable / start.
    expect(sys.calls).toHaveLength(1);
  });
});

describe("ensureSystemdUnitsCurrent", () => {
  // Drive every test through the tmpdir paths so we never touch the real
  // ~/.config/systemd/user/ on the test runner. Same pattern as the
  // installPhantombotUnit tests above.
  function paths() {
    return {
      unitPath,
      heartbeatServicePath: hbServicePath,
      heartbeatTimerPath: hbTimerPath,
      nightlyServicePath: ngServicePath,
      nightlyTimerPath: ngTimerPath,
      tickServicePath,
      tickTimerPath,
    };
  }

  function isEnabledActive(): SystemctlResult {
    return { exitCode: 0, stdout: "enabled\n", stderr: "" };
  }
  function isActiveActive(): SystemctlResult {
    return { exitCode: 0, stdout: "active\n", stderr: "" };
  }

  test("nothing to do when all units already match and timers are active", async () => {
    // Pre-populate every unit file with the canonical template.
    const bin = "/usr/local/bin/phantombot";
    await writeFile(
      unitPath,
      generateSystemdUnit({ binPath: bin, args: ["run"] }),
      "utf8",
    );
    const sys = new FakeSystemctl();
    // Need the heartbeat/nightly/tick canonical contents too. Easier:
    // ask the helper to write them first, then run again and assert it
    // does nothing the second time.
    await ensureSystemdUnitsCurrent({ binPath: bin, ...paths(), systemctl: sys });
    sys.calls = [];
    // Second call: everything already current, timers report enabled+active.
    sys.responses = [
      isEnabledActive(),
      isActiveActive(),
      isEnabledActive(),
      isActiveActive(),
      isEnabledActive(),
      isActiveActive(),
    ];
    const r = await ensureSystemdUnitsCurrent({
      binPath: bin,
      ...paths(),
      systemctl: sys,
    });
    expect(r.rewrote).toEqual([]);
    expect(r.backups).toEqual([]);
    expect(r.repairedTimers).toEqual([]);
    // No daemon-reload, no enable, no start — only the 6 inspect calls
    // (is-enabled + is-active for each of the 3 timers).
    expect(sys.calls).toEqual([
      ["--user", "is-enabled", "phantombot-heartbeat.timer"],
      ["--user", "is-active", "phantombot-heartbeat.timer"],
      ["--user", "is-enabled", "phantombot-nightly.timer"],
      ["--user", "is-active", "phantombot-nightly.timer"],
      ["--user", "is-enabled", "phantombot-tick.timer"],
      ["--user", "is-active", "phantombot-tick.timer"],
    ]);
  });

  test("rewrites every missing unit file, runs daemon-reload once, enables timers", async () => {
    const sys = new FakeSystemctl();
    // Workdir is empty; every target file is missing. After running:
    // daemon-reload + for each of 3 timers we'll see is-enabled
    // returning "disabled" (exit 1) + enable --now.
    sys.responses = [
      // daemon-reload after rewrite
      { exitCode: 0, stdout: "", stderr: "" },
      // heartbeat: is-enabled, is-active, enable --now
      { exitCode: 1, stdout: "disabled\n", stderr: "" },
      { exitCode: 3, stdout: "inactive\n", stderr: "" },
      { exitCode: 0, stdout: "", stderr: "" },
      // nightly
      { exitCode: 1, stdout: "disabled\n", stderr: "" },
      { exitCode: 3, stdout: "inactive\n", stderr: "" },
      { exitCode: 0, stdout: "", stderr: "" },
      // tick
      { exitCode: 1, stdout: "disabled\n", stderr: "" },
      { exitCode: 3, stdout: "inactive\n", stderr: "" },
      { exitCode: 0, stdout: "", stderr: "" },
    ];
    const r = await ensureSystemdUnitsCurrent({
      binPath: "/usr/local/bin/phantombot",
      ...paths(),
      systemctl: sys,
    });
    expect(r.rewrote.sort()).toEqual(
      [
        "phantombot-heartbeat.service",
        "phantombot-heartbeat.timer",
        "phantombot-nightly.service",
        "phantombot-nightly.timer",
        "phantombot-tick.service",
        "phantombot-tick.timer",
        "phantombot.service",
      ].sort(),
    );
    expect(r.backups).toEqual([]); // nothing pre-existing to back up
    expect(r.repairedTimers).toEqual([
      "phantombot-heartbeat.timer",
      "phantombot-nightly.timer",
      "phantombot-tick.timer",
    ]);
    // Verify each canonical body landed on disk.
    expect(await readFile(unitPath, "utf8")).toContain(
      "ExecStart=/usr/local/bin/phantombot run",
    );
    expect(await readFile(hbTimerPath, "utf8")).toContain(
      "Phantombot heartbeat timer",
    );
    // daemon-reload runs exactly once (not 7 times) when content changed.
    const reloadCount = sys.calls.filter(
      (c) => c[0] === "--user" && c[1] === "daemon-reload",
    ).length;
    expect(reloadCount).toBe(1);
  });

  test("backs up a hand-edited unit file before overwriting", async () => {
    const sys = new FakeSystemctl();
    await writeFile(unitPath, "HAND_EDITED_CONTENT_DO_NOT_LOSE", "utf8");
    sys.responses = [
      { exitCode: 0, stdout: "", stderr: "" }, // daemon-reload
      isEnabledActive(),
      isActiveActive(),
      isEnabledActive(),
      isActiveActive(),
      isEnabledActive(),
      isActiveActive(),
    ];
    const r = await ensureSystemdUnitsCurrent({
      binPath: "/usr/local/bin/phantombot",
      ...paths(),
      systemctl: sys,
    });
    // phantombot.service was rewritten; others (missing) also rewritten;
    // but only the existing-and-different one produces a backup.
    expect(r.rewrote).toContain("phantombot.service");
    expect(r.backups).toEqual([`${unitPath}.bak`]);
    expect(await readFile(`${unitPath}.bak`, "utf8")).toBe(
      "HAND_EDITED_CONTENT_DO_NOT_LOSE",
    );
  });

  test("re-arms a timer whose is-active reports inactive", async () => {
    // All unit files in place and current, but the heartbeat timer
    // claims active=no — simulates a rotted timers.target.wants/ symlink.
    const bin = "/usr/local/bin/phantombot";
    await ensureSystemdUnitsCurrent({
      binPath: bin,
      ...paths(),
      systemctl: new FakeSystemctl(),
    });
    const sys = new FakeSystemctl();
    sys.responses = [
      // heartbeat: enabled but inactive → enable --now
      isEnabledActive(),
      { exitCode: 3, stdout: "inactive\n", stderr: "" },
      { exitCode: 0, stdout: "", stderr: "" },
      // nightly OK
      isEnabledActive(),
      isActiveActive(),
      // tick OK
      isEnabledActive(),
      isActiveActive(),
    ];
    const r = await ensureSystemdUnitsCurrent({
      binPath: bin,
      ...paths(),
      systemctl: sys,
    });
    expect(r.rewrote).toEqual([]);
    expect(r.repairedTimers).toEqual(["phantombot-heartbeat.timer"]);
    // Verify the repair call was enable --now (not just start), which
    // both arms the symlink and starts the timer in one shot.
    expect(sys.calls).toContainEqual([
      "--user",
      "enable",
      "--now",
      "phantombot-heartbeat.timer",
    ]);
  });

  test("force-re-arms a stale-but-active timer via restart", async () => {
    // All unit files in place and current; the heartbeat timer reports
    // enabled AND active so systemd thinks it's fine — but the caller has
    // detected (via the last-fired marker) that it stopped firing: the
    // `active (elapsed)` zombie. The healer must `restart` it to force a
    // reschedule; `enable --now` is a no-op on an active timer and would
    // silently fail to recover this state.
    const bin = "/usr/local/bin/phantombot";
    await ensureSystemdUnitsCurrent({
      binPath: bin,
      ...paths(),
      systemctl: new FakeSystemctl(),
    });
    const sys = new FakeSystemctl();
    sys.responses = [
      // heartbeat: enabled + active, but in the force set → restart
      isEnabledActive(),
      isActiveActive(),
      { exitCode: 0, stdout: "", stderr: "" }, // restart
      // nightly OK, not in the force set → left alone
      isEnabledActive(),
      isActiveActive(),
      // tick OK, not in the force set → left alone
      isEnabledActive(),
      isActiveActive(),
    ];
    const r = await ensureSystemdUnitsCurrent({
      binPath: bin,
      ...paths(),
      systemctl: sys,
      forceRearmTimers: ["phantombot-heartbeat.timer"],
    });
    expect(r.rewrote).toEqual([]);
    // Only the listed zombie is touched; the other healthy timers aren't.
    expect(r.repairedTimers).toEqual(["phantombot-heartbeat.timer"]);
    expect(sys.calls).toContainEqual([
      "--user",
      "restart",
      "phantombot-heartbeat.timer",
    ]);
    // It must NOT have used enable --now, which can't recover an
    // already-active timer.
    expect(sys.calls).not.toContainEqual([
      "--user",
      "enable",
      "--now",
      "phantombot-heartbeat.timer",
    ]);
  });

  test("rewriting a timer's content also restarts it to arm the new schedule", async () => {
    // The drifted-timer cure: a timer file whose body changed (e.g.
    // OnUnitActiveSec → OnCalendar) needs more than a daemon-reload — an
    // `active (elapsed)` timer stays wedged until restarted. So when we
    // rewrite a timer's content, we restart it even though systemd still
    // reports it enabled + active. Without this, doctor would rewrite the
    // unit but the box would stay on the dead schedule until a manual kick.
    const bin = "/usr/local/bin/phantombot";
    // Populate every unit with canonical content first.
    await ensureSystemdUnitsCurrent({
      binPath: bin,
      ...paths(),
      systemctl: new FakeSystemctl(),
    });
    // Now corrupt only the heartbeat *timer* so its content drifts.
    await writeFile(hbTimerPath, "OnUnitActiveSec=30min\n", "utf8");
    const sys = new FakeSystemctl();
    sys.responses = [
      { exitCode: 0, stdout: "", stderr: "" }, // daemon-reload (content changed)
      // heartbeat: enabled + active, but its content was just rewritten → restart
      isEnabledActive(),
      isActiveActive(),
      { exitCode: 0, stdout: "", stderr: "" }, // restart
      // nightly: unchanged, enabled + active → left alone
      isEnabledActive(),
      isActiveActive(),
      // tick: unchanged, enabled + active → left alone
      isEnabledActive(),
      isActiveActive(),
    ];
    const r = await ensureSystemdUnitsCurrent({
      binPath: bin,
      ...paths(),
      systemctl: sys,
    });
    expect(r.rewrote).toEqual(["phantombot-heartbeat.timer"]);
    expect(r.backups).toEqual([`${hbTimerPath}.bak`]);
    // The rewritten timer was restarted; the untouched ones were not.
    expect(r.repairedTimers).toEqual(["phantombot-heartbeat.timer"]);
    expect(sys.calls).toContainEqual([
      "--user",
      "restart",
      "phantombot-heartbeat.timer",
    ]);
    expect(sys.calls).not.toContainEqual([
      "--user",
      "restart",
      "phantombot-nightly.timer",
    ]);
    expect(sys.calls).not.toContainEqual([
      "--user",
      "restart",
      "phantombot-tick.timer",
    ]);
  });

  test("a force-rearm timer that is also inactive uses enable --now, not restart", async () => {
    // Precedence check: when a timer is in the force set AND systemd
    // already reports it inactive, the normal enable --now path arms +
    // starts it. A restart would be redundant, so we don't issue one.
    const bin = "/usr/local/bin/phantombot";
    await ensureSystemdUnitsCurrent({
      binPath: bin,
      ...paths(),
      systemctl: new FakeSystemctl(),
    });
    const sys = new FakeSystemctl();
    sys.responses = [
      // heartbeat: enabled but inactive → enable --now (force set is moot)
      isEnabledActive(),
      { exitCode: 3, stdout: "inactive\n", stderr: "" },
      { exitCode: 0, stdout: "", stderr: "" }, // enable --now
      // nightly OK
      isEnabledActive(),
      isActiveActive(),
      // tick OK
      isEnabledActive(),
      isActiveActive(),
    ];
    const r = await ensureSystemdUnitsCurrent({
      binPath: bin,
      ...paths(),
      systemctl: sys,
      forceRearmTimers: ["phantombot-heartbeat.timer"],
    });
    expect(r.repairedTimers).toEqual(["phantombot-heartbeat.timer"]);
    expect(sys.calls).toContainEqual([
      "--user",
      "enable",
      "--now",
      "phantombot-heartbeat.timer",
    ]);
    expect(sys.calls).not.toContainEqual([
      "--user",
      "restart",
      "phantombot-heartbeat.timer",
    ]);
  });
});

describe("driftedUnitNames", () => {
  const bin = "/usr/local/bin/phantombot";

  test("returns [] when every on-disk unit matches its template", () => {
    const targets = phantombotUnitTargets(bin);
    const byPath = new Map(targets.map((t) => [t.path, t.content]));
    const drifted = driftedUnitNames(targets, (p) => byPath.get(p));
    expect(drifted).toEqual([]);
  });

  test("flags only the unit whose on-disk content differs", () => {
    const targets = phantombotUnitTargets(bin);
    const byPath = new Map(targets.map((t) => [t.path, t.content]));
    const heartbeat = targets.find(
      (t) => t.unit === "phantombot-heartbeat.timer",
    );
    if (!heartbeat) throw new Error("heartbeat timer target missing");
    // Simulate the pre-OnCalendar body left behind by an in-place update.
    byPath.set(heartbeat.path, "OnUnitActiveSec=30min\n");
    const drifted = driftedUnitNames(targets, (p) => byPath.get(p));
    expect(drifted).toEqual(["phantombot-heartbeat.timer"]);
  });

  test("a missing file (reader returns undefined) is not counted as drift", () => {
    const targets = phantombotUnitTargets(bin);
    const byPath = new Map(targets.map((t) => [t.path, t.content]));
    const tick = targets.find((t) => t.unit === "phantombot-tick.timer");
    if (!tick) throw new Error("tick timer target missing");
    byPath.delete(tick.path); // absent on disk
    const drifted = driftedUnitNames(targets, (p) => byPath.get(p));
    // Missing ≠ drift — doctor reports absent files via missing_unit_files.
    expect(drifted).toEqual([]);
  });
});

describe("BunSystemctlRunner constructor env", () => {
  test("defaults to a spread of process.env", () => {
    // Smoke-test only: we just want to verify the constructor accepts
    // no argument and doesn't throw. The actual spawn behavior is verified
    // indirectly by the install/uninstall integration tests with a fake
    // SystemctlRunner.
    const { BunSystemctlRunner } = require("../src/lib/systemd.ts");
    const r = new BunSystemctlRunner();
    expect(r).toBeDefined();
  });

  test("accepts an explicit env object", () => {
    const { BunSystemctlRunner } = require("../src/lib/systemd.ts");
    const r = new BunSystemctlRunner({ XDG_RUNTIME_DIR: "/run/user/1003" });
    expect(r).toBeDefined();
  });
});

describe("buildSystemctlEnv", () => {
  test("spreads process.env and overlays XDG/DBUS from sysEnv.runtimeDir", () => {
    // Clear any inherited DBUS so we can verify the auto-set path.
    const savedDbus = process.env.DBUS_SESSION_BUS_ADDRESS;
    delete process.env.DBUS_SESSION_BUS_ADDRESS;
    try {
      const env = buildSystemctlEnv({
        ready: true,
        autoSet: true,
        runtimeDir: "/run/user/1003",
      });
      expect(env.XDG_RUNTIME_DIR).toBe("/run/user/1003");
      expect(env.DBUS_SESSION_BUS_ADDRESS).toBe(
        "unix:path=/run/user/1003/bus",
      );
      // Sanity: non-XDG keys from process.env are preserved.
      expect(typeof env.PATH).toBe("string");
    } finally {
      if (savedDbus === undefined)
        delete process.env.DBUS_SESSION_BUS_ADDRESS;
      else process.env.DBUS_SESSION_BUS_ADDRESS = savedDbus;
    }
  });

  test("does not overwrite an inherited DBUS_SESSION_BUS_ADDRESS", () => {
    const saved = process.env.DBUS_SESSION_BUS_ADDRESS;
    process.env.DBUS_SESSION_BUS_ADDRESS = "unix:path=/custom/bus";
    try {
      const env = buildSystemctlEnv({
        ready: true,
        autoSet: true,
        runtimeDir: "/run/user/1003",
      });
      expect(env.DBUS_SESSION_BUS_ADDRESS).toBe("unix:path=/custom/bus");
    } finally {
      if (saved === undefined) delete process.env.DBUS_SESSION_BUS_ADDRESS;
      else process.env.DBUS_SESSION_BUS_ADDRESS = saved;
    }
  });

  test("leaves XDG/DBUS unset when sysEnv has no runtimeDir", () => {
    const saved = process.env.XDG_RUNTIME_DIR;
    delete process.env.XDG_RUNTIME_DIR;
    try {
      const env = buildSystemctlEnv({ ready: false, autoSet: false });
      expect(env.XDG_RUNTIME_DIR).toBeUndefined();
    } finally {
      if (saved !== undefined) process.env.XDG_RUNTIME_DIR = saved;
    }
  });
});

describe("ensureUserSystemdEnv", () => {
  test("returns ready+autoSet=false when XDG_RUNTIME_DIR is already set", () => {
    const env = { XDG_RUNTIME_DIR: "/run/user/1000" } as NodeJS.ProcessEnv;
    const r = ensureUserSystemdEnv({ env });
    expect(r).toEqual({
      ready: true,
      autoSet: false,
      runtimeDir: "/run/user/1000",
    });
    // Did not modify env (no DBUS_SESSION_BUS_ADDRESS injected).
    expect(env.DBUS_SESSION_BUS_ADDRESS).toBeUndefined();
  });

  test("auto-sets env vars when /run/user/<uid> exists and XDG isn't set", () => {
    const env: NodeJS.ProcessEnv = { USER: "kai" };
    const r = ensureUserSystemdEnv({
      env,
      uid: 1003,
      exists: (p) => p === "/run/user/1003",
    });
    expect(r).toMatchObject({
      ready: true,
      autoSet: true,
      runtimeDir: "/run/user/1003",
    });
    expect(env.XDG_RUNTIME_DIR).toBe("/run/user/1003");
    expect(env.DBUS_SESSION_BUS_ADDRESS).toBe(
      "unix:path=/run/user/1003/bus",
    );
  });

  test("does not overwrite an existing DBUS_SESSION_BUS_ADDRESS", () => {
    const env: NodeJS.ProcessEnv = {
      USER: "kai",
      DBUS_SESSION_BUS_ADDRESS: "unix:path=/custom/bus",
    };
    ensureUserSystemdEnv({
      env,
      uid: 1003,
      exists: () => true,
    });
    expect(env.DBUS_SESSION_BUS_ADDRESS).toBe("unix:path=/custom/bus");
  });

  test("returns ready=false with linger hint when /run/user/<uid> doesn't exist", () => {
    const env: NodeJS.ProcessEnv = { USER: "kai" };
    const r = ensureUserSystemdEnv({
      env,
      uid: 1003,
      exists: () => false,
    });
    expect(r.ready).toBe(false);
    expect(r.autoSet).toBe(false);
    expect(r.reason).toContain("/run/user/1003 does not exist");
    expect(r.reason).toContain("enable-linger kai");
    // Env unchanged.
    expect(env.XDG_RUNTIME_DIR).toBeUndefined();
  });

  test("uses runtimeDir override when provided", () => {
    const env: NodeJS.ProcessEnv = {};
    const r = ensureUserSystemdEnv({
      env,
      uid: 1003,
      runtimeDir: "/tmp/fake-runtime",
      exists: (p) => p === "/tmp/fake-runtime",
    });
    expect(r.ready).toBe(true);
    expect(r.runtimeDir).toBe("/tmp/fake-runtime");
    expect(env.XDG_RUNTIME_DIR).toBe("/tmp/fake-runtime");
  });
});

describe("ensureUnitCurrent", () => {
  const BIN = "/home/kai/.local/bin/phantombot";

  test("identical on-disk unit → no rerender, no systemctl call", async () => {
    const sys = new FakeSystemctl();
    const expected = generateSystemdUnit({ binPath: BIN, args: ["run"] });
    await writeFile(unitPath, expected, "utf8");
    const r = await ensureUnitCurrent({ unitPath, binPath: BIN, systemctl: sys });
    expect(r.rerendered).toBe(false);
    expect(sys.calls).toEqual([]);
    // File untouched.
    expect(await readFile(unitPath, "utf8")).toBe(expected);
  });

  test("missing unit → rerender + daemon-reload", async () => {
    const sys = new FakeSystemctl();
    const r = await ensureUnitCurrent({ unitPath, binPath: BIN, systemctl: sys });
    expect(r.rerendered).toBe(true);
    expect(sys.calls).toEqual([["--user", "daemon-reload"]]);
    const written = await readFile(unitPath, "utf8");
    expect(written).toBe(generateSystemdUnit({ binPath: BIN, args: ["run"] }));
  });

  test("one-byte diff → rerender + daemon-reload", async () => {
    const sys = new FakeSystemctl();
    const expected = generateSystemdUnit({ binPath: BIN, args: ["run"] });
    // Append one stray newline to make the file differ by exactly one byte.
    await writeFile(unitPath, `${expected}\n`, "utf8");
    const r = await ensureUnitCurrent({ unitPath, binPath: BIN, systemctl: sys });
    expect(r.rerendered).toBe(true);
    expect(sys.calls).toEqual([["--user", "daemon-reload"]]);
    expect(await readFile(unitPath, "utf8")).toBe(expected);
  });

  test("pre-Phase-29 unit lacking EnvironmentFile= → rerender adds it", async () => {
    const sys = new FakeSystemctl();
    const stale = `[Unit]
Description=Phantombot — personality-first chat agent
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
ExecStart=${BIN} run
Restart=on-failure
RestartSec=5
StandardOutput=journal
StandardError=journal

[Install]
WantedBy=default.target
`;
    expect(stale).not.toContain("EnvironmentFile=");
    await writeFile(unitPath, stale, "utf8");
    const r = await ensureUnitCurrent({ unitPath, binPath: BIN, systemctl: sys });
    expect(r.rerendered).toBe(true);
    expect(sys.calls).toEqual([["--user", "daemon-reload"]]);
    const rewritten = await readFile(unitPath, "utf8");
    expect(rewritten).toContain("EnvironmentFile=-%h/.config/phantombot/.env");
    expect(rewritten).toContain(`ExecStart=${BIN} run`);
  });
});

describe("uninstallPhantombotUnit", () => {
  test("stops, disables, removes the file, daemon-reloads", async () => {
    await writeFile(unitPath, "stub", "utf8");
    const sys = new FakeSystemctl();
    const out = new CaptureStream();
    const err = new CaptureStream();
    const result = await uninstallPhantombotUnit({
      unitPath,
      systemctl: sys,
      out,
      err,
    });
    expect(result.removed).toBe(true);
    expect(sys.calls).toEqual([
      ["--user", "stop", "phantombot-tick.timer"],
      ["--user", "disable", "phantombot-tick.timer"],
      ["--user", "stop", "phantombot-nightly.timer"],
      ["--user", "disable", "phantombot-nightly.timer"],
      ["--user", "stop", "phantombot-heartbeat.timer"],
      ["--user", "disable", "phantombot-heartbeat.timer"],
      ["--user", "stop", "phantombot.service"],
      ["--user", "disable", "phantombot.service"],
      ["--user", "daemon-reload"],
    ]);
    await expect(readFile(unitPath, "utf8")).rejects.toThrow();
  });

  test("does not fail when there's no unit file to remove", async () => {
    const sys = new FakeSystemctl();
    const out = new CaptureStream();
    const err = new CaptureStream();
    const result = await uninstallPhantombotUnit({
      unitPath, // file doesn't exist
      systemctl: sys,
      out,
      err,
    });
    expect(result.removed).toBe(true);
    expect(out.text).toContain("(no unit file at");
  });
});
