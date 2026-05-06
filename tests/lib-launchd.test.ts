/**
 * Tests for launchd plist generation + install/uninstall logic. Uses a
 * fake LaunchctlRunner that records every invocation, so we don't need
 * actual launchctl on the test host (and so these tests pass on Linux CI).
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  generateHeartbeatPlist,
  generateNightlyPlist,
  generatePhantombotPlist,
  generateTickPlist,
  installPhantombotPlists,
  type LaunchctlResult,
  type LaunchctlRunner,
  uninstallPhantombotPlists,
  PHANTOMBOT_PLIST_LABEL,
  HEARTBEAT_PLIST_LABEL,
  NIGHTLY_PLIST_LABEL,
  TICK_PLIST_LABEL,
} from "../src/lib/launchd.ts";

class FakeLaunchctl implements LaunchctlRunner {
  calls: string[][] = [];
  responses: LaunchctlResult[] = [];
  async run(args: readonly string[]): Promise<LaunchctlResult> {
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
let mainPath: string;
let hbPath: string;
let ngPath: string;
let tkPath: string;

beforeEach(async () => {
  workdir = await mkdtemp(join(tmpdir(), "phantombot-launchd-"));
  mainPath = join(workdir, `${PHANTOMBOT_PLIST_LABEL}.plist`);
  hbPath = join(workdir, `${HEARTBEAT_PLIST_LABEL}.plist`);
  ngPath = join(workdir, `${NIGHTLY_PLIST_LABEL}.plist`);
  tkPath = join(workdir, `${TICK_PLIST_LABEL}.plist`);
});

afterEach(async () => {
  await rm(workdir, { recursive: true, force: true });
});

describe("generatePhantombotPlist", () => {
  test("renders a launch-on-boot, keep-alive plist with the bin path as ProgramArguments", () => {
    const plist = generatePhantombotPlist({
      binPath: "/Users/andrew/.local/bin/phantombot",
      args: ["run"],
    });
    expect(plist).toContain(`<string>${PHANTOMBOT_PLIST_LABEL}</string>`);
    expect(plist).toContain(
      "<string>/Users/andrew/.local/bin/phantombot</string>",
    );
    expect(plist).toContain("<string>run</string>");
    expect(plist).toContain("<key>RunAtLoad</key>");
    expect(plist).toContain("<key>KeepAlive</key>");
    expect(plist).toContain("<key>ThrottleInterval</key>");
    // Always-on units don't get a fire schedule.
    expect(plist).not.toContain("<key>StartInterval</key>");
    expect(plist).not.toContain("<key>StartCalendarInterval</key>");
  });

  test("XML-escapes ampersands and angle brackets in bin path", () => {
    const plist = generatePhantombotPlist({
      binPath: "/usr/local/odd&path/<phantombot>",
      args: ["run"],
    });
    expect(plist).toContain(
      "<string>/usr/local/odd&amp;path/&lt;phantombot&gt;</string>",
    );
  });

  test("includes a usable PATH so subprocess agents can find pi/phantombot", () => {
    const plist = generatePhantombotPlist({
      binPath: "/Users/andrew/.local/bin/phantombot",
      args: ["run"],
    });
    expect(plist).toContain("<key>PATH</key>");
    // /opt/homebrew/bin matters on Apple Silicon — that's where bun lives if
    // installed via brew.
    expect(plist).toContain("/.local/bin");
    expect(plist).toContain("/opt/homebrew/bin");
  });

  test("logs go to ~/Library/Logs/phantombot/<label>.{out,err}.log", () => {
    const plist = generatePhantombotPlist({
      binPath: "/Users/andrew/.local/bin/phantombot",
      args: ["run"],
    });
    expect(plist).toContain(
      `${PHANTOMBOT_PLIST_LABEL}.out.log`,
    );
    expect(plist).toContain(
      `${PHANTOMBOT_PLIST_LABEL}.err.log`,
    );
  });
});

describe("companion plists carry the right schedule", () => {
  test("heartbeat fires every 30 minutes", () => {
    const plist = generateHeartbeatPlist("/usr/local/bin/phantombot");
    expect(plist).toContain(`<string>${HEARTBEAT_PLIST_LABEL}</string>`);
    expect(plist).toContain("<string>heartbeat</string>");
    expect(plist).toContain("<key>StartInterval</key>");
    expect(plist).toContain("<integer>1800</integer>");
    // No KeepAlive on a periodic oneshot.
    expect(plist).not.toContain("<key>KeepAlive</key>");
  });

  test("nightly fires daily at 02:00 (calendar-based)", () => {
    const plist = generateNightlyPlist("/usr/local/bin/phantombot");
    expect(plist).toContain(`<string>${NIGHTLY_PLIST_LABEL}</string>`);
    expect(plist).toContain("<string>nightly</string>");
    expect(plist).toContain("<key>StartCalendarInterval</key>");
    expect(plist).toContain("<key>Hour</key>");
    expect(plist).toContain("<integer>2</integer>");
    expect(plist).toContain("<key>Minute</key>");
    expect(plist).toContain("<integer>0</integer>");
  });

  test("tick fires every 60 seconds", () => {
    const plist = generateTickPlist("/usr/local/bin/phantombot");
    expect(plist).toContain(`<string>${TICK_PLIST_LABEL}</string>`);
    expect(plist).toContain("<string>tick</string>");
    expect(plist).toContain("<key>StartInterval</key>");
    expect(plist).toContain("<integer>60</integer>");
  });
});

describe("installPhantombotPlists", () => {
  test("writes all four plists then bootstraps each into the gui domain", async () => {
    const out = new CaptureStream();
    const err = new CaptureStream();
    const lc = new FakeLaunchctl();
    const result = await installPhantombotPlists({
      binPath: "/Users/andrew/.local/bin/phantombot",
      plistPath: mainPath,
      heartbeatPlistPath: hbPath,
      nightlyPlistPath: ngPath,
      tickPlistPath: tkPath,
      domain: "gui/501",
      launchctl: lc,
      out,
      err,
    });
    expect(result.installed).toBe(true);

    // All four files exist on disk with sane bodies.
    for (const path of [mainPath, hbPath, ngPath, tkPath]) {
      const body = await readFile(path, "utf8");
      expect(body).toContain('<?xml version="1.0"');
      expect(body).toContain("<key>Label</key>");
    }

    // The launchctl call sequence is: bootout(label) × 4 (idempotent
    // pre-cleanup), then bootstrap(plist) × 4.
    const sequence = lc.calls.map((c) => c.join(" "));
    expect(sequence).toEqual([
      `bootout gui/501/${PHANTOMBOT_PLIST_LABEL}`,
      `bootout gui/501/${HEARTBEAT_PLIST_LABEL}`,
      `bootout gui/501/${NIGHTLY_PLIST_LABEL}`,
      `bootout gui/501/${TICK_PLIST_LABEL}`,
      `bootstrap gui/501 ${mainPath}`,
      `bootstrap gui/501 ${hbPath}`,
      `bootstrap gui/501 ${ngPath}`,
      `bootstrap gui/501 ${tkPath}`,
    ]);
    expect(out.text).toContain("bootstrapped");
  });

  test("fails install (and reports) when bootstrap returns non-zero", async () => {
    const out = new CaptureStream();
    const err = new CaptureStream();
    const lc = new FakeLaunchctl();
    // 4 bootouts succeed; first bootstrap fails.
    lc.responses = [
      { exitCode: 0, stdout: "", stderr: "" },
      { exitCode: 0, stdout: "", stderr: "" },
      { exitCode: 0, stdout: "", stderr: "" },
      { exitCode: 0, stdout: "", stderr: "" },
      { exitCode: 5, stdout: "", stderr: "Input/output error" },
    ];
    const result = await installPhantombotPlists({
      binPath: "/Users/andrew/.local/bin/phantombot",
      plistPath: mainPath,
      heartbeatPlistPath: hbPath,
      nightlyPlistPath: ngPath,
      tickPlistPath: tkPath,
      domain: "gui/501",
      launchctl: lc,
      out,
      err,
    });
    expect(result.installed).toBe(false);
    expect(err.text).toContain("launchctl bootstrap");
    expect(err.text).toContain("Input/output error");
  });
});

describe("uninstallPhantombotPlists", () => {
  test("boots out each label then removes the plists from disk", async () => {
    // Pre-create plists so the uninstall has files to remove.
    await Bun.write(mainPath, "<plist></plist>");
    await Bun.write(hbPath, "<plist></plist>");
    await Bun.write(ngPath, "<plist></plist>");
    await Bun.write(tkPath, "<plist></plist>");

    const out = new CaptureStream();
    const err = new CaptureStream();
    const lc = new FakeLaunchctl();
    const result = await uninstallPhantombotPlists({
      plistPath: mainPath,
      heartbeatPlistPath: hbPath,
      nightlyPlistPath: ngPath,
      tickPlistPath: tkPath,
      domain: "gui/501",
      launchctl: lc,
      out,
      err,
    });
    expect(result.removed).toBe(true);

    expect(lc.calls.map((c) => c.join(" "))).toEqual([
      `bootout gui/501/${TICK_PLIST_LABEL}`,
      `bootout gui/501/${NIGHTLY_PLIST_LABEL}`,
      `bootout gui/501/${HEARTBEAT_PLIST_LABEL}`,
      `bootout gui/501/${PHANTOMBOT_PLIST_LABEL}`,
    ]);
    // All plists removed.
    const { existsSync } = await import("node:fs");
    expect(existsSync(mainPath)).toBe(false);
    expect(existsSync(hbPath)).toBe(false);
    expect(existsSync(ngPath)).toBe(false);
    expect(existsSync(tkPath)).toBe(false);
    expect(out.text).toContain("removed");
  });

  test("logs '(no plist at …)' for the main plist when nothing was installed", async () => {
    const out = new CaptureStream();
    const err = new CaptureStream();
    const lc = new FakeLaunchctl();
    // Even bootouts of nothing return non-zero — make sure we don't fail.
    lc.responses = [
      { exitCode: 1, stdout: "", stderr: "Could not find target" },
      { exitCode: 1, stdout: "", stderr: "Could not find target" },
      { exitCode: 1, stdout: "", stderr: "Could not find target" },
      { exitCode: 1, stdout: "", stderr: "Could not find target" },
    ];
    const result = await uninstallPhantombotPlists({
      plistPath: mainPath,
      heartbeatPlistPath: hbPath,
      nightlyPlistPath: ngPath,
      tickPlistPath: tkPath,
      domain: "gui/501",
      launchctl: lc,
      out,
      err,
    });
    expect(result.removed).toBe(true);
    expect(out.text).toContain("(no plist at");
    // bootout failures are logged but don't fail the uninstall.
    expect(out.text).toContain("returned 1 (continuing)");
  });
});
