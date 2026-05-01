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
  SystemctlResult,
  SystemctlRunner,
} from "../src/lib/systemd.ts";

class FakeSystemctl implements SystemctlRunner {
  calls: string[][] = [];
  async run(args: readonly string[]): Promise<SystemctlResult> {
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
let savedXdg: string | undefined;

beforeEach(async () => {
  workdir = await mkdtemp(join(tmpdir(), "phantombot-install-"));
  unitPath = join(workdir, "phantombot.service");
  savedXdg = process.env.XDG_RUNTIME_DIR;
  process.env.XDG_RUNTIME_DIR = "/run/user/1000";
});

afterEach(async () => {
  if (savedXdg === undefined) delete process.env.XDG_RUNTIME_DIR;
  else process.env.XDG_RUNTIME_DIR = savedXdg;
  await rm(workdir, { recursive: true, force: true });
});

describe("runInstall", () => {
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
    });
    expect(code).toBe(2);
    expect(err.text).toContain("compiled binary");
    expect(sys.calls).toEqual([]);
  });

  test("rejects when XDG_RUNTIME_DIR is unset (no user systemd bus)", async () => {
    delete process.env.XDG_RUNTIME_DIR;
    const out = new CaptureStream();
    const err = new CaptureStream();
    const sys = new FakeSystemctl();
    const code = await runInstall({
      binPath: "/usr/local/bin/phantombot",
      unitPath,
      systemctl: sys,
      out,
      err,
    });
    expect(code).toBe(2);
    expect(err.text).toContain("loginctl enable-linger");
  });

  test("happy path writes unit + runs reload/enable/start, returns 0", async () => {
    const out = new CaptureStream();
    const err = new CaptureStream();
    const sys = new FakeSystemctl();
    const code = await runInstall({
      binPath: "/usr/local/bin/phantombot",
      unitPath,
      systemctl: sys,
      out,
      err,
    });
    expect(code).toBe(0);
    expect(sys.calls.map((a) => a.join(" "))).toEqual([
      "--user daemon-reload",
      "--user enable phantombot.service",
      "--user start phantombot.service",
    ]);
    expect(out.text).toContain("journalctl --user -u phantombot");
  });
});

describe("runUninstall", () => {
  test("issues stop/disable/daemon-reload regardless of unit existing", async () => {
    const out = new CaptureStream();
    const err = new CaptureStream();
    const sys = new FakeSystemctl();
    const code = await runUninstall({
      unitPath,
      systemctl: sys,
      out,
      err,
    });
    expect(code).toBe(0);
    expect(sys.calls.map((a) => a.join(" "))).toEqual([
      "--user stop phantombot.service",
      "--user disable phantombot.service",
      "--user daemon-reload",
    ]);
    expect(out.text).toContain("uninstall complete");
  });
});
