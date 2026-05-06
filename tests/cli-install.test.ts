/**
 * Tests for runInstall + runUninstall — checks the bin-path validation,
 * XDG_RUNTIME_DIR check, and end-to-end systemctl call sequence with a
 * mocked runner.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runInstall } from "../src/cli/install.ts";
import { runUninstall } from "../src/cli/uninstall.ts";
import type {
  LaunchctlResult,
  LaunchctlRunner,
} from "../src/lib/launchd.ts";
import type {
  SystemctlResult,
  SystemctlRunner,
  UserSystemdEnv,
} from "../src/lib/systemd.ts";

class FakeSystemctl implements SystemctlRunner {
  calls: string[][] = [];
  async run(args: readonly string[]): Promise<SystemctlResult> {
    this.calls.push([...args]);
    return { exitCode: 0, stdout: "", stderr: "" };
  }
}

class FakeLaunchctl implements LaunchctlRunner {
  calls: string[][] = [];
  async run(args: readonly string[]): Promise<LaunchctlResult> {
    this.calls.push([...args]);
    return { exitCode: 0, stdout: "", stderr: "" };
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
let installPaths: {
  heartbeatServicePath: string;
  heartbeatTimerPath: string;
  nightlyServicePath: string;
  nightlyTimerPath: string;
  tickServicePath: string;
  tickTimerPath: string;
};

beforeEach(async () => {
  workdir = await mkdtemp(join(tmpdir(), "phantombot-install-"));
  unitPath = join(workdir, "phantombot.service");
  // Without these, runInstall would write companion units into the real
  // ~/.config/systemd/user/ on the test runner — see #44.
  installPaths = {
    heartbeatServicePath: join(workdir, "phantombot-heartbeat.service"),
    heartbeatTimerPath: join(workdir, "phantombot-heartbeat.timer"),
    nightlyServicePath: join(workdir, "phantombot-nightly.service"),
    nightlyTimerPath: join(workdir, "phantombot-nightly.timer"),
    tickServicePath: join(workdir, "phantombot-tick.service"),
    tickTimerPath: join(workdir, "phantombot-tick.timer"),
  };
});

afterEach(async () => {
  await rm(workdir, { recursive: true, force: true });
});

const sysEnvReady = (): UserSystemdEnv => ({
  ready: true,
  autoSet: false,
  runtimeDir: "/run/user/1000",
});
const sysEnvAutoSet = (): UserSystemdEnv => ({
  ready: true,
  autoSet: true,
  runtimeDir: "/run/user/1003",
});
const sysEnvMissing = (): UserSystemdEnv => ({
  ready: false,
  autoSet: false,
  reason: "/run/user/1003 does not exist — enable linger first: sudo loginctl enable-linger kai",
});

describe("runInstall (linux/systemd)", () => {
  test("rejects when bin name isn't 'phantombot'", async () => {
    const out = new CaptureStream();
    const err = new CaptureStream();
    const sys = new FakeSystemctl();
    const code = await runInstall({
      binPath: "/usr/bin/bun",
      unitPath,
      systemctl: sys,
      out,
      err,
      ensureSystemdEnv: sysEnvReady,
      platform: "linux",
    });
    expect(code).toBe(2);
    expect(err.text).toContain("compiled binary");
    expect(sys.calls).toEqual([]);
  });

  test("rejects when systemd env detection fails (linger disabled)", async () => {
    const out = new CaptureStream();
    const err = new CaptureStream();
    const sys = new FakeSystemctl();
    const code = await runInstall({
      binPath: "/usr/local/bin/phantombot",
      unitPath,
      systemctl: sys,
      out,
      err,
      ensureSystemdEnv: sysEnvMissing,
      platform: "linux",
    });
    expect(code).toBe(2);
    expect(err.text).toContain("no user-level systemd bus available");
    expect(err.text).toContain("loginctl enable-linger");
  });

  test("auto-set message printed when systemd env is auto-detected", async () => {
    const out = new CaptureStream();
    const err = new CaptureStream();
    const sys = new FakeSystemctl();
    const code = await runInstall({
      binPath: "/usr/local/bin/phantombot",
      unitPath,
      ...installPaths,
      systemctl: sys,
      out,
      err,
      ensureSystemdEnv: sysEnvAutoSet,
      platform: "linux",
    });
    expect(code).toBe(0);
    expect(out.text).toContain(
      "auto-detected XDG_RUNTIME_DIR=/run/user/1003",
    );
  });

  test("happy path writes unit + runs reload/enable/start, returns 0", async () => {
    const out = new CaptureStream();
    const err = new CaptureStream();
    const sys = new FakeSystemctl();
    const code = await runInstall({
      binPath: "/usr/local/bin/phantombot",
      unitPath,
      ...installPaths,
      systemctl: sys,
      out,
      err,
      ensureSystemdEnv: sysEnvReady,
      platform: "linux",
    });
    expect(code).toBe(0);
    expect(sys.calls.map((a) => a.join(" "))).toEqual([
      "--user daemon-reload",
      "--user enable phantombot.service",
      "--user start phantombot.service",
      "--user enable phantombot-heartbeat.timer",
      "--user start phantombot-heartbeat.timer",
      "--user enable phantombot-nightly.timer",
      "--user start phantombot-nightly.timer",
      "--user enable phantombot-tick.timer",
      "--user start phantombot-tick.timer",
    ]);
    // The hint text uses the host's restartCommand/logsCommand, so it'll
    // be journalctl on linux CI; match loosely.
    expect(out.text).toContain("view logs:");
    expect(out.text).toContain("restart:");
    // No auto-set message when env was already set.
    expect(out.text).not.toContain("auto-detected");
  });
});

describe("runInstall (darwin/launchd)", () => {
  test("happy path writes plists + bootstraps each into the gui domain", async () => {
    const out = new CaptureStream();
    const err = new CaptureStream();
    const lc = new FakeLaunchctl();
    const code = await runInstall({
      binPath: "/Users/andrew/.local/bin/phantombot",
      plistPath: join(workdir, "dev.phantombot.phantombot.plist"),
      heartbeatPlistPath: join(workdir, "dev.phantombot.heartbeat.plist"),
      nightlyPlistPath: join(workdir, "dev.phantombot.nightly.plist"),
      tickPlistPath: join(workdir, "dev.phantombot.tick.plist"),
      domain: "gui/501",
      launchctl: lc,
      out,
      err,
      platform: "darwin",
    });
    expect(code).toBe(0);
    // bootouts of nothing × 4, then bootstrap each plist × 4. We check the
    // verb sequence rather than full strings so test stays readable.
    const verbs = lc.calls.map((c) => c[0]);
    expect(verbs).toEqual([
      "bootout",
      "bootout",
      "bootout",
      "bootout",
      "bootstrap",
      "bootstrap",
      "bootstrap",
      "bootstrap",
    ]);
    // bootstraps target the correct domain.
    for (const c of lc.calls.filter((c) => c[0] === "bootstrap")) {
      expect(c[1]).toBe("gui/501");
    }
  });

  test("doesn't fall through to systemctl on darwin (the bug Andrew hit on his Mac)", async () => {
    const out = new CaptureStream();
    const err = new CaptureStream();
    const sys = new FakeSystemctl();
    const lc = new FakeLaunchctl();
    const code = await runInstall({
      binPath: "/Users/andrew/.local/bin/phantombot",
      plistPath: join(workdir, "dev.phantombot.phantombot.plist"),
      heartbeatPlistPath: join(workdir, "dev.phantombot.heartbeat.plist"),
      nightlyPlistPath: join(workdir, "dev.phantombot.nightly.plist"),
      tickPlistPath: join(workdir, "dev.phantombot.tick.plist"),
      domain: "gui/501",
      systemctl: sys,
      launchctl: lc,
      out,
      err,
      platform: "darwin",
    });
    expect(code).toBe(0);
    // No systemctl calls — the regression test for the original Mac bug.
    expect(sys.calls).toEqual([]);
    // No "loginctl" appears anywhere.
    expect(err.text).not.toContain("loginctl");
    expect(out.text).not.toContain("loginctl");
  });

  test("rejects when bin name isn't 'phantombot' regardless of platform", async () => {
    const err = new CaptureStream();
    const lc = new FakeLaunchctl();
    const code = await runInstall({
      binPath: "/Users/andrew/.local/bin/bun",
      domain: "gui/501",
      launchctl: lc,
      out: new CaptureStream(),
      err,
      platform: "darwin",
    });
    expect(code).toBe(2);
    expect(err.text).toContain("compiled binary");
    expect(lc.calls).toEqual([]);
  });
});

describe("runUninstall (linux/systemd)", () => {
  test("issues stop/disable/daemon-reload regardless of unit existing", async () => {
    const out = new CaptureStream();
    const err = new CaptureStream();
    const sys = new FakeSystemctl();
    const code = await runUninstall({
      unitPath,
      systemctl: sys,
      out,
      err,
      ensureSystemdEnv: sysEnvReady,
      platform: "linux",
    });
    expect(code).toBe(0);
    expect(sys.calls.map((a) => a.join(" "))).toEqual([
      "--user stop phantombot-tick.timer",
      "--user disable phantombot-tick.timer",
      "--user stop phantombot-nightly.timer",
      "--user disable phantombot-nightly.timer",
      "--user stop phantombot-heartbeat.timer",
      "--user disable phantombot-heartbeat.timer",
      "--user stop phantombot.service",
      "--user disable phantombot.service",
      "--user daemon-reload",
    ]);
    expect(out.text).toContain("uninstall complete");
  });

  test("warns and continues with file removal when systemd env is missing", async () => {
    const out = new CaptureStream();
    const err = new CaptureStream();
    const sys = new FakeSystemctl();
    const code = await runUninstall({
      unitPath,
      systemctl: sys,
      out,
      err,
      ensureSystemdEnv: sysEnvMissing,
      platform: "linux",
    });
    expect(code).toBe(0);
    expect(err.text).toContain("no user-level systemd bus available");
  });
});

describe("runUninstall (darwin/launchd)", () => {
  test("boots out each label without touching systemctl", async () => {
    const out = new CaptureStream();
    const err = new CaptureStream();
    const sys = new FakeSystemctl();
    const lc = new FakeLaunchctl();
    const code = await runUninstall({
      plistPath: join(workdir, "dev.phantombot.phantombot.plist"),
      heartbeatPlistPath: join(workdir, "dev.phantombot.heartbeat.plist"),
      nightlyPlistPath: join(workdir, "dev.phantombot.nightly.plist"),
      tickPlistPath: join(workdir, "dev.phantombot.tick.plist"),
      domain: "gui/501",
      systemctl: sys,
      launchctl: lc,
      out,
      err,
      platform: "darwin",
    });
    expect(code).toBe(0);
    expect(sys.calls).toEqual([]);
    expect(lc.calls.length).toBe(4);
    expect(lc.calls.every((c) => c[0] === "bootout")).toBe(true);
    expect(out.text).toContain("uninstall complete");
  });
});
