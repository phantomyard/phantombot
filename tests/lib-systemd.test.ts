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
  ensureUserSystemdEnv,
  generateSystemdUnit,
  installPhantombotUnit,
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

beforeEach(async () => {
  workdir = await mkdtemp(join(tmpdir(), "phantombot-systemd-"));
  unitPath = join(workdir, "phantombot.service");
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
});

describe("installPhantombotUnit", () => {
  test("writes the unit file and runs daemon-reload, enable, start", async () => {
    const sys = new FakeSystemctl();
    const out = new CaptureStream();
    const err = new CaptureStream();
    const result = await installPhantombotUnit({
      binPath: "/usr/local/bin/phantombot",
      unitPath,
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
