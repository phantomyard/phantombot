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
