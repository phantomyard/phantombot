/**
 * Tests for launchd plist generation + install/uninstall logic. Uses a
 * fake LaunchctlRunner that records every invocation, so we don't need
 * actual launchctl on the test host (and so these tests pass on Linux CI).
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  ensureLaunchdHeartbeatInstances,
  generateHeartbeatPlist,
  generatePhantombotPlist,
  generateTickPlist,
  installPhantombotPlists,
  type LaunchctlResult,
  type LaunchctlRunner,
  listHeartbeatInstancePlists,
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

describe("per-persona heartbeat plists (#491)", () => {
  test("generateHeartbeatPlist with a persona gets its own label and --persona args", () => {
    const plist = generateHeartbeatPlist("/usr/local/bin/phantombot", "kai");
    expect(plist).toContain(
      `<string>${HEARTBEAT_PLIST_LABEL}.kai</string>`,
    );
    expect(plist).toContain("<string>--persona</string>");
    expect(plist).toContain("<string>kai</string>");
    expect(plist).toContain("<integer>1800</integer>");
  });

  test("listHeartbeatInstancePlists discovers persona names from disk", async () => {
    const dir = await mkdtemp(join(tmpdir(), "phantombot-agents-"));
    try {
      await writeFile(join(dir, "dev.phantombot.heartbeat.kai.plist"), "x");
      await writeFile(join(dir, "dev.phantombot.heartbeat.lena.plist"), "x");
      // Legacy label and unrelated plists are not instances.
      await writeFile(join(dir, "dev.phantombot.heartbeat.plist"), "x");
      await writeFile(join(dir, "dev.phantombot.tick.plist"), "x");
      expect(listHeartbeatInstancePlists(dir)).toEqual(["kai", "lena"]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
    expect(listHeartbeatInstancePlists(join(dir, "gone"))).toEqual([]);
  });

  test("install with personas writes one plist per persona and retires the legacy plist", async () => {
    const out = new CaptureStream();
    const err = new CaptureStream();
    const lc = new FakeLaunchctl();
    // A legacy heartbeat plist from an older install is present.
    await writeFile(hbPath, generateHeartbeatPlist("/old/bin/phantombot"));
    const result = await installPhantombotPlists({
      binPath: "/usr/local/bin/phantombot",
      personas: ["lena", "kai"],
      plistPath: mainPath,
      heartbeatPlistPath: hbPath,
      nightlyPlistPath: ngPath,
      tickPlistPath: tkPath,
      agentsDir: workdir,
      domain: "gui/501",
      launchctl: lc,
      out,
      err,
    });
    expect(result.installed).toBe(true);
    const lenaPath = join(workdir, "dev.phantombot.heartbeat.lena.plist");
    const kaiPath = join(workdir, "dev.phantombot.heartbeat.kai.plist");
    expect(existsSync(lenaPath)).toBe(true);
    expect(existsSync(kaiPath)).toBe(true);
    const kaiBody = await readFile(kaiPath, "utf8");
    expect(kaiBody).toContain("--persona");
    // Legacy plist retired once the default persona's replacement loaded.
    expect(existsSync(hbPath)).toBe(false);
    expect(out.text).toContain("removed retired plist");
    const bootstraps = lc.calls.filter((c) => c[0] === "bootstrap");
    expect(bootstraps.map((c) => c[2])).toContain(lenaPath);
    expect(bootstraps.map((c) => c[2])).toContain(kaiPath);
    expect(
      lc.calls.some(
        (c) =>
          c[0] === "bootout" && c[1] === `gui/501/${HEARTBEAT_PLIST_LABEL}`,
      ),
    ).toBe(true);
  });

  test("install keeps the legacy plist when the default persona's bootstrap fails", async () => {
    const out = new CaptureStream();
    const err = new CaptureStream();
    const lc = new FakeLaunchctl();
    await writeFile(hbPath, generateHeartbeatPlist("/old/bin/phantombot"));
    lc.responses = [
      // bootout ×4 (main, lena, kai, tick)
      { exitCode: 1, stdout: "", stderr: "" },
      { exitCode: 1, stdout: "", stderr: "" },
      { exitCode: 1, stdout: "", stderr: "" },
      { exitCode: 1, stdout: "", stderr: "" },
      // bootstrap main ok, bootstrap lena FAILS
      { exitCode: 0, stdout: "", stderr: "" },
      { exitCode: 5, stdout: "", stderr: "bootstrap failed" },
    ];
    const result = await installPhantombotPlists({
      binPath: "/usr/local/bin/phantombot",
      personas: ["lena", "kai"],
      plistPath: mainPath,
      heartbeatPlistPath: hbPath,
      nightlyPlistPath: ngPath,
      tickPlistPath: tkPath,
      agentsDir: workdir,
      domain: "gui/501",
      launchctl: lc,
      out,
      err,
    });
    expect(result.installed).toBe(false);
    expect(err.text).toContain("bootstrap failed");
    // Legacy heartbeat survives: the host keeps A heartbeat.
    expect(existsSync(hbPath)).toBe(true);
  });
});

describe("ensureLaunchdHeartbeatInstances (#491)", () => {
  const opts = (
    lc: FakeLaunchctl,
    personas: string[],
  ): Parameters<typeof ensureLaunchdHeartbeatInstances>[0] => ({
    binPath: "/usr/local/bin/phantombot",
    personas,
    domain: "gui/501",
    launchctl: lc,
    agentsDir: workdir,
    legacyHeartbeatPath: hbPath,
  });

  test("writes + bootstraps missing per-persona plists, retires legacy", async () => {
    await writeFile(hbPath, generateHeartbeatPlist("/usr/local/bin/phantombot"));
    const lc = new FakeLaunchctl();
    lc.responses = [
      // print lena → not loaded (no bootout needed); bootstrap ok
      { exitCode: 5, stdout: "", stderr: "" },
      { exitCode: 0, stdout: "", stderr: "" },
      // print kai → not loaded; bootstrap ok
      { exitCode: 5, stdout: "", stderr: "" },
      { exitCode: 0, stdout: "", stderr: "" },
      // legacy retire bootout (confirmed unload)
      { exitCode: 0, stdout: "", stderr: "" },
    ];
    const r = await ensureLaunchdHeartbeatInstances(opts(lc, ["lena", "kai"]));
    expect(r.rewrote).toEqual([
      "dev.phantombot.heartbeat.lena",
      "dev.phantombot.heartbeat.kai",
    ]);
    expect(r.bootstrapped).toEqual(r.rewrote);
    expect(r.retiredLegacy).toBe(true);
    expect(existsSync(hbPath)).toBe(false);
    expect(
      existsSync(join(workdir, "dev.phantombot.heartbeat.lena.plist")),
    ).toBe(true);
  });

  test("healthy loaded plists are left alone (idempotent)", async () => {
    await writeFile(hbPath, "legacy");
    const lenaPath = join(workdir, "dev.phantombot.heartbeat.lena.plist");
    await writeFile(
      lenaPath,
      generateHeartbeatPlist("/usr/local/bin/phantombot", "lena"),
    );
    const lc = new FakeLaunchctl();
    lc.responses = [
      // print lena → loaded
      { exitCode: 0, stdout: "", stderr: "" },
      // legacy retire bootout
      { exitCode: 0, stdout: "", stderr: "" },
    ];
    const r = await ensureLaunchdHeartbeatInstances(opts(lc, ["lena"]));
    expect(r.rewrote).toEqual([]);
    expect(r.bootstrapped).toEqual([]);
    expect(r.retiredLegacy).toBe(true);
    // No bootstrap call at all.
    expect(lc.calls.some((c) => c[0] === "bootstrap")).toBe(false);
  });

  test("stale plist is backed up, rewritten and reloaded", async () => {
    const lenaPath = join(workdir, "dev.phantombot.heartbeat.lena.plist");
    await writeFile(lenaPath, generateHeartbeatPlist("/old/bin/phantombot", "lena"));
    const lc = new FakeLaunchctl();
    lc.responses = [
      // print lena → loaded (but content stale → reload anyway)
      { exitCode: 0, stdout: "", stderr: "" },
      // bootout, bootstrap
      { exitCode: 0, stdout: "", stderr: "" },
      { exitCode: 0, stdout: "", stderr: "" },
    ];
    const r = await ensureLaunchdHeartbeatInstances(opts(lc, ["lena"]));
    expect(r.rewrote).toEqual(["dev.phantombot.heartbeat.lena"]);
    expect(r.backups).toEqual([`${lenaPath}.bak`]);
    expect(await readFile(`${lenaPath}.bak`, "utf8")).toContain("/old/bin");
    expect(await readFile(lenaPath, "utf8")).toContain("/usr/local/bin");
    expect(r.bootstrapped).toEqual(["dev.phantombot.heartbeat.lena"]);
  });

  test("bootout failure during stale reload leaves the old plist; next heal retries", async () => {
    const lenaPath = join(workdir, "dev.phantombot.heartbeat.lena.plist");
    const stale = generateHeartbeatPlist("/old/bin/phantombot", "lena");
    await writeFile(lenaPath, stale);
    const lc = new FakeLaunchctl();
    lc.responses = [
      // print lena → loaded, but content stale → bootout FAILS
      { exitCode: 0, stdout: "", stderr: "" },
      { exitCode: 1, stdout: "", stderr: "bootout failed" },
    ];
    const r = await ensureLaunchdHeartbeatInstances(opts(lc, ["lena"]));
    expect(r.reloadFailed).toEqual(["dev.phantombot.heartbeat.lena"]);
    expect(r.bootstrapped).toEqual([]);
    // The on-disk body still matches the loaded (stale) job — no rewrite,
    // no backup, nothing the next heal can mistake for a healthy reload.
    expect(await readFile(lenaPath, "utf8")).toBe(stale);
    expect(existsSync(`${lenaPath}.bak`)).toBe(false);
    // Next heal: bootout succeeds this time → reload proceeds.
    const lc2 = new FakeLaunchctl();
    lc2.responses = [
      { exitCode: 0, stdout: "", stderr: "" }, // print → loaded, stale
      { exitCode: 0, stdout: "", stderr: "" }, // bootout ok
      { exitCode: 0, stdout: "", stderr: "" }, // bootstrap ok
    ];
    const r2 = await ensureLaunchdHeartbeatInstances(opts(lc2, ["lena"]));
    expect(r2.rewrote).toEqual(["dev.phantombot.heartbeat.lena"]);
    expect(r2.bootstrapped).toEqual(["dev.phantombot.heartbeat.lena"]);
    expect(await readFile(lenaPath, "utf8")).toContain("/usr/local/bin");
  });

  test("unserved persona's plist is kept when bootout fails and the job is still loaded", async () => {
    const robbiePath = join(workdir, "dev.phantombot.heartbeat.robbie.plist");
    await writeFile(robbiePath, "x");
    await writeFile(
      join(workdir, "dev.phantombot.heartbeat.lena.plist"),
      generateHeartbeatPlist("/usr/local/bin/phantombot", "lena"),
    );
    const lc = new FakeLaunchctl();
    lc.responses = [
      { exitCode: 0, stdout: "", stderr: "" }, // print lena → loaded
      { exitCode: 1, stdout: "", stderr: "" }, // robbie bootout FAILS
      { exitCode: 0, stdout: "", stderr: "" }, // probe print → still loaded
    ];
    const r = await ensureLaunchdHeartbeatInstances(opts(lc, ["lena"]));
    expect(r.removed).toEqual([]);
    expect(r.removeFailed).toEqual(["dev.phantombot.heartbeat.robbie"]);
    // The plist stays — it's the only handle a later heal has.
    expect(existsSync(robbiePath)).toBe(true);
  });

  test("unserved persona's plist is removed when bootout fails but the job is confirmed absent", async () => {
    const robbiePath = join(workdir, "dev.phantombot.heartbeat.robbie.plist");
    await writeFile(robbiePath, "x");
    await writeFile(
      join(workdir, "dev.phantombot.heartbeat.lena.plist"),
      generateHeartbeatPlist("/usr/local/bin/phantombot", "lena"),
    );
    const lc = new FakeLaunchctl();
    lc.responses = [
      { exitCode: 0, stdout: "", stderr: "" }, // print lena → loaded
      { exitCode: 1, stdout: "", stderr: "" }, // robbie bootout fails
      { exitCode: 5, stdout: "", stderr: "" }, // probe print → not loaded
    ];
    const r = await ensureLaunchdHeartbeatInstances(opts(lc, ["lena"]));
    expect(r.removed).toEqual(["dev.phantombot.heartbeat.robbie"]);
    expect(existsSync(robbiePath)).toBe(false);
  });

  test("legacy plist is kept when its bootout fails during retirement", async () => {
    await writeFile(hbPath, "legacy");
    await writeFile(
      join(workdir, "dev.phantombot.heartbeat.lena.plist"),
      generateHeartbeatPlist("/usr/local/bin/phantombot", "lena"),
    );
    const lc = new FakeLaunchctl();
    lc.responses = [
      { exitCode: 0, stdout: "", stderr: "" }, // print lena → loaded
      { exitCode: 1, stdout: "", stderr: "" }, // legacy bootout FAILS
      { exitCode: 0, stdout: "", stderr: "" }, // probe print → still loaded
    ];
    const r = await ensureLaunchdHeartbeatInstances(opts(lc, ["lena"]));
    expect(r.retiredLegacy).toBe(false);
    expect(existsSync(hbPath)).toBe(true);
  });

  test("unserved personas are booted out and deleted", async () => {
    await writeFile(
      join(workdir, "dev.phantombot.heartbeat.robbie.plist"),
      "x",
    );
    const lc = new FakeLaunchctl();
    lc.responses = [
      // print lena → loaded
      { exitCode: 0, stdout: "", stderr: "" },
      // robbie bootout
      { exitCode: 0, stdout: "", stderr: "" },
    ];
    // Pre-write lena's plist so it's not dirty.
    await writeFile(
      join(workdir, "dev.phantombot.heartbeat.lena.plist"),
      generateHeartbeatPlist("/usr/local/bin/phantombot", "lena"),
    );
    const r = await ensureLaunchdHeartbeatInstances(opts(lc, ["lena"]));
    expect(r.removed).toEqual(["dev.phantombot.heartbeat.robbie"]);
    expect(
      existsSync(join(workdir, "dev.phantombot.heartbeat.robbie.plist")),
    ).toBe(false);
    expect(
      lc.calls.some(
        (c) =>
          c[0] === "bootout" &&
          c[1] === "gui/501/dev.phantombot.heartbeat.robbie",
      ),
    ).toBe(true);
  });

  test("legacy plist survives when the default persona fails to bootstrap", async () => {
    await writeFile(hbPath, "legacy");
    const lc = new FakeLaunchctl();
    lc.responses = [
      // print lena → not loaded (no bootout needed); bootstrap FAILS
      { exitCode: 5, stdout: "", stderr: "" },
      { exitCode: 5, stdout: "", stderr: "nope" },
    ];
    const r = await ensureLaunchdHeartbeatInstances(opts(lc, ["lena"]));
    expect(r.bootstrapped).toEqual([]);
    expect(r.retiredLegacy).toBe(false);
    expect(existsSync(hbPath)).toBe(true);
  });
});

describe("uninstallPhantombotPlists removes per-persona plists (#491)", () => {
  test("boots out and deletes every per-persona heartbeat plist", async () => {
    const out = new CaptureStream();
    const err = new CaptureStream();
    const lc = new FakeLaunchctl();
    const kaiPath = join(workdir, "dev.phantombot.heartbeat.kai.plist");
    await writeFile(mainPath, "x");
    await writeFile(kaiPath, "x");
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
    expect(existsSync(kaiPath)).toBe(false);
    expect(out.text).toContain(`removed ${kaiPath}`);
    expect(
      lc.calls.some(
        (c) =>
          c[0] === "bootout" &&
          c[1] === "gui/501/dev.phantombot.heartbeat.kai",
      ),
    ).toBe(true);
  });

  test("install keeps the legacy + nightly plists when their bootouts fail", async () => {
    const out = new CaptureStream();
    const err = new CaptureStream();
    const lc = new FakeLaunchctl();
    await writeFile(hbPath, "legacy");
    await writeFile(ngPath, "nightly");
    // Install's own bootouts/bootstraps default to ok; then the legacy
    // and nightly retirements each get a FAILING bootout whose probe
    // confirms the job is still loaded.
    lc.responses = [
      { exitCode: 0, stdout: "", stderr: "" }, // bootout main
      { exitCode: 0, stdout: "", stderr: "" }, // bootout hb lena
      { exitCode: 0, stdout: "", stderr: "" }, // bootout tick
      { exitCode: 0, stdout: "", stderr: "" }, // bootstrap main
      { exitCode: 0, stdout: "", stderr: "" }, // bootstrap hb lena
      { exitCode: 0, stdout: "", stderr: "" }, // bootstrap tick
      { exitCode: 1, stdout: "", stderr: "" }, // legacy bootout FAILS
      { exitCode: 0, stdout: "", stderr: "" }, // probe print → still loaded
      { exitCode: 1, stdout: "", stderr: "" }, // nightly bootout FAILS
      { exitCode: 0, stdout: "", stderr: "" }, // probe print → still loaded
    ];
    const result = await installPhantombotPlists({
      binPath: "/usr/local/bin/phantombot",
      personas: ["lena"],
      plistPath: mainPath,
      heartbeatPlistPath: hbPath,
      nightlyPlistPath: ngPath,
      tickPlistPath: tkPath,
      agentsDir: workdir,
      domain: "gui/501",
      launchctl: lc,
      out,
      err,
    });
    // Install itself succeeded (bootout ×3 best-effort, bootstrap ×3 ok).
    expect(result.installed).toBe(true);
    // But retirement is deferred: bootout failed and the probe confirms
    // the jobs are still loaded, so the plists stay for a later retry.
    expect(existsSync(hbPath)).toBe(true);
    expect(existsSync(ngPath)).toBe(true);
    expect(out.text).not.toContain(`removed retired plist: ${hbPath}`);
  });
});
