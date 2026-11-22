/** Issue #810: launch-tested browser discovery and the persona's browser choice. */
import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { browserCandidates, browserStatus, chooseBrowser, forgetDetected, resolveBrowserExecutable, type DiscoveryHost, type ProbeFn } from "../src/browser/discovery.ts";
import { browserCall } from "../src/browser/daemon.ts";
import { CHROME_START_FAILED } from "../src/browser/session.ts";
import { runBrowserChoice } from "../src/cli/browser.ts";
import type { Config } from "../src/config.ts";

const roots: string[] = [];
afterEach(async () => { for (const p of roots.splice(0)) await rm(p, { recursive: true, force: true }); });
async function temp() { const p = await mkdtemp(join(tmpdir(), "pb-browser-discovery-")); roots.push(p); return p; }

const SNAP_WRAPPER = "#!/bin/sh\nif ! [ -x /snap/bin/chromium ]; then exit 1; fi\nexec /snap/bin/chromium \"$@\"\n";

/** Ubuntu like the VPS in #810: the chromium-browser Snap wrapper plus Brave. */
function linuxHost(files: Record<string, string> = {}, env: NodeJS.ProcessEnv = {}, links: Record<string, string> = {}): DiscoveryHost {
  const all: Record<string, string> = {
    "/usr/bin/chromium-browser": SNAP_WRAPPER,
    "/snap/bin/chromium": "ELF",
    "/usr/bin/brave-browser": "",
    "/opt/brave.com/brave/brave-browser": "#!/bin/bash\nexec /opt/brave.com/brave/brave \"$@\"\n",
    ...files,
  };
  const allLinks: Record<string, string> = { "/usr/bin/brave-browser": "/opt/brave.com/brave/brave-browser", "/snap/bin/chromium": "/usr/bin/snap", ...links };
  return {
    platform: "linux", env, directories: () => [],
    isFile: p => p in all,
    which: name => (`/usr/bin/${name}` in all ? `/usr/bin/${name}` : null),
    realpath: p => allLinks[p] ?? p,
    head: p => all[p] ?? "",
  };
}

function recordingProbe(failing: string[] = []): { probe: ProbeFn; probed: string[] } {
  const probed: string[] = [];
  return { probed, probe: async path => { probed.push(path); return failing.includes(path) ? { ok: false, error: "Chrome process closed the pipe" } : { ok: true }; } };
}

test("Linux candidates: Snap wrappers come last and symlinks are probed once", () => {
  const host = linuxHost({ "/usr/bin/google-chrome-stable": "ELF", "/opt/google/chrome/chrome": "ELF" }, {}, { "/usr/bin/google-chrome-stable": "/opt/google/chrome/chrome" });
  expect(browserCandidates(host)).toEqual([
    { id: "chrome", path: "/usr/bin/google-chrome-stable", snap: false },
    { id: "brave", path: "/usr/bin/brave-browser", snap: false },
    { id: "chromium", path: "/usr/bin/chromium-browser", snap: true },
    { id: "chromium", path: "/snap/bin/chromium", snap: true },
  ]);
});

test("Snap apps are links to the one snap launcher: flagged Snap, and never merged with each other", () => {
  const host = linuxHost({ "/snap/bin/brave": "ELF" }, {}, { "/snap/bin/brave": "/usr/bin/snap" });
  expect(browserCandidates(host).map(c => [c.path, c.snap])).toEqual([
    ["/usr/bin/brave-browser", false],
    ["/usr/bin/chromium-browser", true],
    ["/snap/bin/chromium", true],
    ["/snap/bin/brave", true],
  ]);
});

test("macOS and Windows candidates use the standard install locations in browser order", () => {
  const mac = new Set(["/Applications/Brave Browser.app/Contents/MacOS/Brave Browser", "/Users/a/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"]);
  const host = (platform: NodeJS.Platform, files: Set<string>, env: NodeJS.ProcessEnv): DiscoveryHost => ({ platform, env, directories: () => [], isFile: p => files.has(p), which: () => null, realpath: p => p, head: () => "" });
  expect(browserCandidates(host("darwin", mac, { HOME: "/Users/a" })).map(c => c.id)).toEqual(["chrome", "brave"]);
  const win = new Set(["C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe", "C:\\Users\\a\\AppData\\Local\\Google\\Chrome\\Application\\chrome.exe"]);
  const found = browserCandidates(host("win32", win, { PROGRAMFILES: "C:\\Program Files", "ProgramFiles(x86)": "C:\\Program Files (x86)", LOCALAPPDATA: "C:\\Users\\a\\AppData\\Local" }));
  expect(found.map(c => [c.id, c.snap])).toEqual([["chrome", false], ["edge", false]]);
});

test("cascade skips a browser that cannot start, caches the winner, and re-detects once it is forgotten", async () => {
  const settings = await temp();
  const { probe, probed } = recordingProbe(["/usr/bin/brave-browser"]);
  const host = linuxHost();
  // Brave fails here, so the cascade must move on to the Snap Chromium.
  expect(await resolveBrowserExecutable(settings, settings, { host, probe })).toEqual({ path: "/usr/bin/chromium-browser", source: "probed" });
  expect(probed).toEqual(["/usr/bin/brave-browser", "/usr/bin/chromium-browser"]);
  // Cached: the next worker start launches nothing extra.
  expect(await resolveBrowserExecutable(settings, settings, { host, probe })).toEqual({ path: "/usr/bin/chromium-browser", source: "detected" });
  expect(probed).toHaveLength(2);
  await forgetDetected(settings);
  await resolveBrowserExecutable(settings, settings, { host, probe });
  expect(probed).toHaveLength(4);
});

test("the issue #810 host: the Snap Chromium fails, so Brave is chosen", async () => {
  const settings = await temp();
  const { probe } = recordingProbe(["/usr/bin/chromium-browser", "/snap/bin/chromium"]);
  expect((await resolveBrowserExecutable(settings, settings, { host: linuxHost(), probe })).path).toBe("/usr/bin/brave-browser");
});

test("a cached executable that was uninstalled is detected again", async () => {
  const settings = await temp();
  await writeFile(join(settings, "detected.json"), JSON.stringify({ path: "/gone/chrome", checkedAt: "x" }));
  const { probe } = recordingProbe();
  expect(await resolveBrowserExecutable(settings, settings, { host: linuxHost(), probe })).toEqual({ path: "/usr/bin/brave-browser", source: "probed" });
});

test("BUN_CHROME_PATH is used as-is, and the persona's choice beats it", async () => {
  const settings = await temp();
  const { probe, probed } = recordingProbe();
  const host = linuxHost({}, { BUN_CHROME_PATH: "/custom/chrome" });
  expect(await resolveBrowserExecutable(settings, settings, { host, probe })).toEqual({ path: "/custom/chrome", source: "env" });
  expect(probed).toEqual([]);
  await chooseBrowser(settings, "brave", { host, probe });
  expect(await resolveBrowserExecutable(settings, settings, { host, probe })).toEqual({ path: "/usr/bin/brave-browser", source: "preference", choice: "brave" });
});

test("no known install falls back to Bun's own discovery; nothing that starts is an explicit error", async () => {
  const settings = await temp();
  const empty: DiscoveryHost = { platform: "linux", env: {}, directories: () => [], isFile: () => false, which: () => null, realpath: p => p, head: () => "" };
  expect(await resolveBrowserExecutable(settings, settings, { host: empty, probe: recordingProbe().probe })).toEqual({ source: "bun" });
  const all = ["/usr/bin/brave-browser", "/usr/bin/chromium-browser", "/snap/bin/chromium"];
  const failure = resolveBrowserExecutable(settings, settings, { host: linuxHost(), probe: recordingProbe(all).probe });
  await expect(failure).rejects.toThrow("No installed browser could start");
  await expect(resolveBrowserExecutable(settings, settings, { host: linuxHost(), probe: recordingProbe(all).probe })).rejects.toThrow("/usr/bin/chromium-browser (Snap): Chrome process closed the pipe");
  await expect(readFile(join(settings, "detected.json"))).rejects.toThrow();
});

test("use: launch-tests before saving, refuses what is missing or broken, and auto clears the choice", async () => {
  const settings = await temp();
  const host = linuxHost({ "/opt/custom/chrome": "ELF" });
  await expect(chooseBrowser(settings, "edge", { host, probe: recordingProbe().probe })).rejects.toThrow("not installed");
  await expect(chooseBrowser(settings, "brave", { host, probe: recordingProbe(["/usr/bin/brave-browser"]).probe })).rejects.toThrow("Not saved");
  await expect(readFile(join(settings, "preference.json"))).rejects.toThrow();
  await expect(chooseBrowser(settings, "relative/chrome", { host, probe: recordingProbe().probe })).rejects.toThrow("absolute path");
  await expect(chooseBrowser(settings, "/nope/chrome", { host, probe: recordingProbe().probe })).rejects.toThrow("No executable");
  // An id tries each install of that browser in order (non-Snap first).
  expect(await chooseBrowser(settings, "Chromium", { host, probe: recordingProbe(["/usr/bin/chromium-browser"]).probe })).toEqual({ browser: "chromium", path: "/snap/bin/chromium" });
  expect(await chooseBrowser(settings, "/opt/custom/chrome", { host, probe: recordingProbe().probe })).toEqual({ browser: "/opt/custom/chrome", path: "/opt/custom/chrome" });
  expect(await browserStatus(settings, { host })).toMatchObject({ using: { source: "preference", browser: "/opt/custom/chrome" } });
  expect(await chooseBrowser(settings, "auto", { host })).toEqual({ browser: "auto" });
  expect(await browserStatus(settings, { host })).toMatchObject({ using: { source: "auto" } });
});

test("a chosen browser that moved is found again, but never silently swapped for another", async () => {
  const settings = await temp();
  await writeFile(join(settings, "preference.json"), JSON.stringify({ browser: "brave", path: "/old/brave" }));
  const { probe } = recordingProbe();
  expect(await resolveBrowserExecutable(settings, settings, { host: linuxHost(), probe })).toEqual({ path: "/usr/bin/brave-browser", source: "preference", choice: "brave" });
  expect(JSON.parse(await readFile(join(settings, "preference.json"), "utf8")).path).toBe("/usr/bin/brave-browser");
  await writeFile(join(settings, "preference.json"), JSON.stringify({ browser: "edge", path: "/old/edge" }));
  await expect(resolveBrowserExecutable(settings, settings, { host: linuxHost(), probe })).rejects.toThrow("The chosen browser 'edge' cannot start");
  await writeFile(join(settings, "preference.json"), JSON.stringify({ browser: "/old/custom", path: "/old/custom" }));
  await expect(resolveBrowserExecutable(settings, settings, { host: linuxHost(), probe })).rejects.toThrow("no longer exists");
});

test("CLI list/use: trusted only, and use restarts the persona worker", async () => {
  const root = await temp(); await mkdir(join(root, "alice"));
  const config = { personasDir: root, defaultPersona: "alice" } as Config;
  const discovery = { host: linuxHost(), probe: recordingProbe().probe };
  const calls: unknown[][] = []; let out = ""; let err = "";
  const base = { config, discovery, call: async (...args: unknown[]) => { calls.push(args); return {}; }, out: (s: string) => { out += s; }, err: (s: string) => { err += s; } };
  expect(await runBrowserChoice({ ...base, action: "use", value: "brave", env: { PHANTOMBOT_TURN_ID: "t", PHANTOMBOT_PERSONA: "alice" } })).toBe(1);
  expect(err).toContain("trusted turn");
  expect(await runBrowserChoice({ ...base, action: "list", env: { PHANTOMBOT_SECURITY_SESSION: "{}" } })).toBe(1);
  expect(await runBrowserChoice({ ...base, action: "use", value: "brave", env: {} })).toBe(0);
  expect(JSON.parse(out)).toMatchObject({ browser: "brave", path: "/usr/bin/brave-browser", restarted: true });
  expect(calls).toEqual([[join(root, "alice", "browser"), { action: "stop" }]]);
  out = "";
  expect(await runBrowserChoice({ ...base, action: "list", env: { PHANTOMBOT_CONVERSATION: "c", PHANTOMBOT_TRUSTED: "1" } })).toBe(0);
  expect(JSON.parse(out)).toMatchObject({ using: { source: "preference", browser: "brave" }, installed: [{ browser: "brave" }, { browser: "chromium", snap: true }, { browser: "chromium", snap: true }] });
  expect(await runBrowserChoice({ ...base, action: "use", env: {} })).toBe(1);
});

test("a cached browser that fails to start is forgotten; a persona's choice is not", async () => {
  const root = await temp();
  const token = "b".repeat(64);
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch(req) {
    if (new URL(req.url).pathname === "/health") return new Response("phantombot-browser");
    return Response.json({ error: `${CHROME_START_FAILED}: Chrome process closed the pipe` }, { status: 400 });
  } });
  try {
    await writeFile(join(root, "endpoint.json"), JSON.stringify({ port: server.port, token }));
    await writeFile(join(root, "detected.json"), JSON.stringify({ path: "/usr/bin/chromium-browser", checkedAt: "x" }));
    await writeFile(join(root, "preference.json"), JSON.stringify({ browser: "brave", path: "/usr/bin/brave-browser" }));
    await expect(browserCall(root, { action: "open", url: "https://example.com" })).rejects.toThrow(CHROME_START_FAILED);
    await expect(readFile(join(root, "detected.json"))).rejects.toThrow();
    expect(JSON.parse(await readFile(join(root, "preference.json"), "utf8")).browser).toBe("brave");
  } finally { await server.stop(true); }
});

function cacheHost(platform: NodeJS.Platform, env: NodeJS.ProcessEnv, root: string, files: string[], revisions = ["chromium-9", "chromium-100"]): DiscoveryHost {
  return { platform, env, isFile: p => files.includes(p), which: () => null, realpath: p => p, head: () => "", directories: p => p === root ? revisions : [] };
}

test("Playwright caches cover Linux, macOS and Windows, old and new full-browser layouts", () => {
  const cases: [NodeJS.Platform, NodeJS.ProcessEnv, string, string[]][] = [
    ["linux", { HOME: "/home/a" }, "/home/a/.cache/ms-playwright", ["chrome-linux64/chrome", "chrome-linux-arm64/chrome", "chrome-linux/chrome"]],
    ["darwin", { HOME: "/Users/a" }, "/Users/a/Library/Caches/ms-playwright", ["chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing", "chrome-mac-x64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing", "chrome-mac/Chromium.app/Contents/MacOS/Chromium"]],
    ["win32", { LOCALAPPDATA: "C:\\Users\\a\\AppData\\Local" }, "C:\\Users\\a\\AppData\\Local\\ms-playwright", ["chrome-win64\\chrome.exe", "chrome-win\\chrome.exe"]],
  ];
  for (const [platform, env, root, layouts] of cases) {
    const separator = platform === "win32" ? "\\" : "/";
    const files = ["chromium-100", "chromium-9"].flatMap(v => layouts.map(layout => [root, v, layout].join(separator)));
    const host = cacheHost(platform, env, root, files);
    expect(browserCandidates(host).map(c => c.path)).toEqual(files);
    expect(browserCandidates(host).every(c => c.id === "chromium" && !c.snap)).toBe(true);
  }
});

test("cache roots honor XDG and absolute Playwright overrides without searching cwd or headless shells", () => {
  const file = "/custom/cache/chromium-100/chrome-linux64/chrome";
  const host = cacheHost("linux", { HOME: "/home/a", PLAYWRIGHT_BROWSERS_PATH: "/custom/cache" }, "/custom/cache", [file], ["chromium-100", "chromium_headless_shell-101", "firefox-102", "chromium-100/../../escape", "chromium-100-extra"]);
  expect(browserCandidates(host).map(c => c.path)).toEqual([file]);
  for (const value of ["0", "relative-cache"]) {
    expect(browserCandidates({ ...host, env: { ...host.env, PLAYWRIGHT_BROWSERS_PATH: value } })).toEqual([]);
  }
  const xdg = "/xdg/ms-playwright/chromium-100/chrome-linux/chrome";
  expect(browserCandidates(cacheHost("linux", { HOME: "/home/a", XDG_CACHE_HOME: "/xdg" }, "/xdg/ms-playwright", [xdg])).map(c => c.path)).toEqual([xdg]);
  expect(browserCandidates(cacheHost("linux", { HOME: "/home/a", XDG_CACHE_HOME: "relative" }, "/home/a/.cache/ms-playwright", ["/home/a/.cache/ms-playwright/chromium-100/chrome-linux/chrome"]))).toHaveLength(1);
});

test("cache follows native browsers, precedes Snaps, and deduplicates executable aliases", () => {
  const cached = "/cache/chromium-100/chrome-linux64/chrome";
  const host = linuxHost({ [cached]: "ELF" }, { PLAYWRIGHT_BROWSERS_PATH: "/cache" });
  host.directories = () => ["chromium-100"];
  expect(browserCandidates(host).map(c => c.path)).toEqual(["/usr/bin/brave-browser", cached, "/usr/bin/chromium-browser", "/snap/bin/chromium"]);
  host.realpath = p => p === cached ? "/opt/brave.com/brave/brave-browser" : p === "/usr/bin/brave-browser" ? "/opt/brave.com/brave/brave-browser" : p;
  expect(browserCandidates(host).filter(c => c.path === cached)).toEqual([]);
});

test("a broken newest cache falls through, only the proven winner is cached; overrides still win", async () => {
  const root = await temp();
  const newest = "/cache/chromium-100/chrome-linux64/chrome";
  const older = "/cache/chromium-9/chrome-linux/chrome";
  const host = cacheHost("linux", { PLAYWRIGHT_BROWSERS_PATH: "/cache" }, "/cache", [newest, older]);
  const { probe, probed } = recordingProbe([newest]);
  expect(await resolveBrowserExecutable(root, root, { host, probe })).toEqual({ path: older, source: "probed" });
  expect(probed).toEqual([newest, older]);
  expect(JSON.parse(await readFile(join(root, "detected.json"), "utf8")).path).toBe(older);
  expect(await resolveBrowserExecutable(root, root, { host, probe })).toEqual({ path: older, source: "detected" });
  expect(probed).toHaveLength(2);
  await forgetDetected(root);
  await expect(resolveBrowserExecutable(root, root, { host, probe: recordingProbe([newest, older]).probe })).rejects.toThrow("No installed browser could start");
  await expect(readFile(join(root, "detected.json"))).rejects.toThrow();
  host.env.BUN_CHROME_PATH = "/operator/chrome";
  expect(await resolveBrowserExecutable(root, root, { host, probe })).toEqual({ path: "/operator/chrome", source: "env" });
  await chooseBrowser(root, "chromium", { host, probe });
  expect(await resolveBrowserExecutable(root, root, { host, probe })).toEqual({ path: older, source: "preference", choice: "chromium" });
});
