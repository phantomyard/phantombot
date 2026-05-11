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
  ensureUnitCurrent,
  ensureUserSystemdEnv,
  generateSystemdUnit,
  installPhantombotUnit,
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
    expect(out.text).toContain("wrote unit file");
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
