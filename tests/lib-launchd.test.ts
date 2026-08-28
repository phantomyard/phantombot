/**
 * Tests for launchd plist generation + install/uninstall logic. Uses a
 * fake LaunchctlRunner that records every invocation, so we don't need
 * actual launchctl on the test host (and so these tests pass on Linux CI).
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, readlink, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  ensureExecAlias,
  execAliasPath,
  generateHeartbeatPlist,
  generatePhantombotPlist,
  generateTickPlist,
  installPhantombotPlists,
  type LaunchctlResult,
  type LaunchctlRunner,
  removeExecAliases,
  uninstallPhantombotPlists,
  HEARTBEAT_EXEC_ALIAS,
  TICK_EXEC_ALIAS,
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

  test("tick fires every 60 seconds", () => {
    const plist = generateTickPlist("/usr/local/bin/phantombot");
    expect(plist).toContain(`<string>${TICK_PLIST_LABEL}</string>`);
    expect(plist).toContain("<string>tick</string>");
    expect(plist).toContain("<key>StartInterval</key>");
    expect(plist).toContain("<integer>60</integer>");
  });
});

describe("installPhantombotPlists", () => {
  test("writes the three live plists then bootstraps each into the gui domain", async () => {
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

    // The retired nightly plist is never written.
    expect(existsSync(ngPath)).toBe(false);
    // Every live plist exists on disk with a sane body.
    for (const path of [mainPath, hbPath, tkPath]) {
      const body = await readFile(path, "utf8");
      expect(body).toContain('<?xml version="1.0"');
      expect(body).toContain("<key>Label</key>");
    }

    // The launchctl call sequence is: bootout(label) × 3 (idempotent
    // pre-cleanup), then bootstrap(plist) × 3. Nothing for the retired
    // nightly agent, because its plist isn't on disk.
    const sequence = lc.calls.map((c) => c.join(" "));
    expect(sequence).toEqual([
      `bootout gui/501/${PHANTOMBOT_PLIST_LABEL}`,
      `bootout gui/501/${HEARTBEAT_PLIST_LABEL}`,
      `bootout gui/501/${TICK_PLIST_LABEL}`,
      `bootstrap gui/501 ${mainPath}`,
      `bootstrap gui/501 ${hbPath}`,
      `bootstrap gui/501 ${tkPath}`,
    ]);
    expect(out.text).toContain("bootstrapped");
  });

  test("boots out and deletes a nightly plist left by an older install", async () => {
    // Upgrade path: the retired 02:00 agent is still loaded and on disk.
    // Install must unload and delete it, or macOS keeps firing a duplicate
    // sweep every night.
    await Bun.write(ngPath, "<plist>old nightly</plist>");
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
    expect(existsSync(ngPath)).toBe(false);
    expect(lc.calls.map((c) => c.join(" "))).toContain(
      `bootout gui/501/${NIGHTLY_PLIST_LABEL}`,
    );
    expect(out.text).toContain("removed retired plist");
  });

  test("fails install (and reports) when bootstrap returns non-zero", async () => {
    const out = new CaptureStream();
    const err = new CaptureStream();
    const lc = new FakeLaunchctl();
    // 3 bootouts succeed; first bootstrap fails.
    lc.responses = [
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

describe("exec aliases", () => {
  test("execAliasPath resolves next to the binary", () => {
    expect(execAliasPath("/opt/bin/phantombot", TICK_EXEC_ALIAS)).toBe(
      "/opt/bin/phantombot-tick",
    );
  });

  test("ensureExecAlias creates a symlink to the binary and is idempotent", async () => {
    const bin = join(workdir, "phantombot");
    await writeFile(bin, "#!/bin/sh\n", "utf8");

    const first = await ensureExecAlias(bin, TICK_EXEC_ALIAS);
    expect(first).toBe(join(workdir, TICK_EXEC_ALIAS));
    expect(await readlink(first)).toBe(bin);

    // Re-running install must not throw on the existing link.
    const second = await ensureExecAlias(bin, TICK_EXEC_ALIAS);
    expect(second).toBe(first);
    expect(await readlink(second)).toBe(bin);
  });

  test("ensureExecAlias repoints a stale alias at the new binary path", async () => {
    const oldBin = join(workdir, "phantombot.old");
    const newBin = join(workdir, "phantombot");
    await writeFile(oldBin, "", "utf8");
    await writeFile(newBin, "", "utf8");
    await ensureExecAlias(oldBin, TICK_EXEC_ALIAS);
    const path = await ensureExecAlias(newBin, TICK_EXEC_ALIAS);
    expect(await readlink(path)).toBe(newBin);
  });

  test("ensureExecAlias falls back to the binary when the alias name is a real file", async () => {
    const bin = join(workdir, "phantombot");
    await writeFile(bin, "", "utf8");
    await writeFile(join(workdir, TICK_EXEC_ALIAS), "not ours", "utf8");
    expect(await ensureExecAlias(bin, TICK_EXEC_ALIAS)).toBe(bin);
    // The intruding file survives untouched.
    expect(await readFile(join(workdir, TICK_EXEC_ALIAS), "utf8")).toBe(
      "not ours",
    );
  });

  test("ensureExecAlias falls back when the directory does not exist", async () => {
    const bin = "/definitely/not/here/phantombot";
    expect(await ensureExecAlias(bin, TICK_EXEC_ALIAS)).toBe(bin);
  });

  test("removeExecAliases deletes only symlinks", async () => {
    const bin = join(workdir, "phantombot");
    await writeFile(bin, "", "utf8");
    await ensureExecAlias(bin, TICK_EXEC_ALIAS);
    await writeFile(join(workdir, HEARTBEAT_EXEC_ALIAS), "real file", "utf8");

    const removed = await removeExecAliases(bin);
    expect(removed).toEqual([join(workdir, TICK_EXEC_ALIAS)]);
    expect(existsSync(join(workdir, TICK_EXEC_ALIAS))).toBe(false);
    expect(existsSync(join(workdir, HEARTBEAT_EXEC_ALIAS))).toBe(true);
  });

  test("install points the periodic plists at the aliases, not the binary", async () => {
    const bin = join(workdir, "phantombot");
    await writeFile(bin, "", "utf8");
    const out = new CaptureStream();
    const err = new CaptureStream();
    const lc = new FakeLaunchctl();
    const result = await installPhantombotPlists({
      binPath: bin,
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

    const hb = await readFile(hbPath, "utf8");
    expect(hb).toContain(`<string>${join(workdir, HEARTBEAT_EXEC_ALIAS)}</string>`);
    expect(hb).toContain("<string>heartbeat</string>");

    const tk = await readFile(tkPath, "utf8");
    expect(tk).toContain(`<string>${join(workdir, TICK_EXEC_ALIAS)}</string>`);
    expect(tk).toContain("<string>tick</string>");

    // The daemon keeps the real binary name — it SHOULD read "phantombot".
    const main = await readFile(mainPath, "utf8");
    expect(main).toContain(`<string>${bin}</string>`);
  });

  test("install still succeeds when the alias cannot be created", async () => {
    // Binary in a directory that doesn't exist: no symlink is possible, and
    // the heartbeat plist falls back to the binary path itself.
    const bin = "/definitely/not/here/phantombot";
    const out = new CaptureStream();
    const err = new CaptureStream();
    const result = await installPhantombotPlists({
      binPath: bin,
      plistPath: mainPath,
      heartbeatPlistPath: hbPath,
      nightlyPlistPath: ngPath,
      tickPlistPath: tkPath,
      domain: "gui/501",
      launchctl: new FakeLaunchctl(),
      out,
      err,
    });
    expect(result.installed).toBe(true);
    expect(await readFile(hbPath, "utf8")).toContain(`<string>${bin}</string>`);
  });

  test("uninstall removes the aliases it installed", async () => {
    const bin = join(workdir, "phantombot");
    await writeFile(bin, "", "utf8");
    await installPhantombotPlists({
      binPath: bin,
      plistPath: mainPath,
      heartbeatPlistPath: hbPath,
      nightlyPlistPath: ngPath,
      tickPlistPath: tkPath,
      domain: "gui/501",
      launchctl: new FakeLaunchctl(),
      out: new CaptureStream(),
      err: new CaptureStream(),
    });
    expect(existsSync(join(workdir, TICK_EXEC_ALIAS))).toBe(true);

    const out = new CaptureStream();
    await uninstallPhantombotPlists({
      plistPath: mainPath,
      heartbeatPlistPath: hbPath,
      nightlyPlistPath: ngPath,
      tickPlistPath: tkPath,
      domain: "gui/501",
      binPath: bin,
      launchctl: new FakeLaunchctl(),
      out,
      err: new CaptureStream(),
    });
    expect(existsSync(join(workdir, TICK_EXEC_ALIAS))).toBe(false);
    expect(existsSync(join(workdir, HEARTBEAT_EXEC_ALIAS))).toBe(false);
    expect(out.text).toContain(TICK_EXEC_ALIAS);
  });
});
