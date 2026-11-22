/** Which Chrome-family executable a browser worker launches (issue #810).
 *
 * Bun.WebView takes the first executable it finds and never checks that it
 * starts. On Ubuntu that is often the Snap Chromium wrapper, whose confinement
 * cannot open a profile under a hidden `$HOME` directory such as
 * `~/.local/share/phantombot/...`, so every launch dies with "Chrome process
 * closed the pipe". Bun also refuses a second launch in the same process after
 * a failed one, so a fallback must be decided BEFORE the worker starts.
 *
 * Order of precedence:
 *   1. the persona's own choice (`phantombot browser use <browser|path>`)
 *   2. `BUN_CHROME_PATH` from the host environment (operator override)
 *   3. the last executable that launched for this persona (cached)
 *   4. a launch-tested cascade over installed browsers, Snap wrappers last
 *   5. Bun's own discovery, only when no known install exists at all
 */
import { spawn } from "node:child_process";
import { closeSync, existsSync, openSync, readSync, readdirSync, realpathSync, statSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { isAbsolute, join, posix, resolve, win32 } from "node:path";
import { isCompiledBinary } from "../lib/embeddedPi.ts";

export const BROWSER_PROBE_SUBCOMMAND = "__browser_probe";
export const BROWSER_IDS = ["chrome", "chromium", "brave", "edge"] as const;
export type BrowserId = typeof BROWSER_IDS[number];
export const BROWSER_NAMES: Record<BrowserId, string> = { chrome: "Google Chrome", chromium: "Chromium", brave: "Brave", edge: "Microsoft Edge" };
const PREFERENCE_FILE = "preference.json";
const DETECTED_FILE = "detected.json";
const PROBE_TIMEOUT_MS = 20_000;

export interface Candidate { id: BrowserId; path: string; snap: boolean }
export interface DiscoveryHost {
  platform: NodeJS.Platform;
  env: NodeJS.ProcessEnv;
  isFile(path: string): boolean;
  which(name: string): string | null;
  directories(path: string): string[];
  realpath(path: string): string;
  /** First bytes of a file (Snap wrapper detection); "" when unreadable. */
  head(path: string): string;
}
export type ProbeResult = { ok: true } | { ok: false; error: string };
export type ProbeFn = (executable: string, root: string) => Promise<ProbeResult>;
export type BrowserSource = "preference" | "env" | "detected" | "probed" | "bun";
export interface Resolution { path?: string; source: BrowserSource; choice?: string }
export interface DiscoveryOptions { host?: DiscoveryHost; probe?: ProbeFn }

export function systemHost(env: NodeJS.ProcessEnv = process.env): DiscoveryHost {
  return {
    platform: process.platform,
    env,
    isFile: path => { try { return statSync(path).isFile(); } catch { return false; } },
    which: name => Bun.which(name, { PATH: env.PATH ?? env.Path ?? "" }),
    directories: path => {
      try { return readdirSync(path, { withFileTypes: true }).filter(e => e.isDirectory()).map(e => e.name); } catch { return []; }
    },
    realpath: path => { try { return realpathSync(path); } catch { return path; } },
    head: path => {
      let fd: number | undefined;
      try {
        fd = openSync(path, "r");
        const buffer = Buffer.alloc(4096);
        return buffer.subarray(0, readSync(fd, buffer, 0, buffer.length, 0)).toString("latin1");
      } catch { return ""; } finally { if (fd !== undefined) closeSync(fd); }
    },
  };
}

function platformCandidates(host: DiscoveryHost): { id: BrowserId; path: string }[] {
  const { env } = host;
  if (host.platform === "darwin") {
    const apps: [BrowserId, string][] = [
      ["chrome", "Google Chrome.app/Contents/MacOS/Google Chrome"],
      ["chromium", "Chromium.app/Contents/MacOS/Chromium"],
      ["brave", "Brave Browser.app/Contents/MacOS/Brave Browser"],
      ["edge", "Microsoft Edge.app/Contents/MacOS/Microsoft Edge"],
    ];
    const roots = ["/Applications", ...(env.HOME ? [posix.join(env.HOME, "Applications")] : [])];
    return apps.flatMap(([id, app]) => roots.map(root => ({ id, path: posix.join(root, app) })));
  }
  if (host.platform === "win32") {
    const roots = [env.PROGRAMFILES ?? env.ProgramFiles, env["ProgramFiles(x86)"], env.LOCALAPPDATA].filter((r): r is string => !!r);
    const apps: [BrowserId, string][] = [
      ["chrome", "Google\\Chrome\\Application\\chrome.exe"],
      ["chromium", "Chromium\\Application\\chrome.exe"],
      ["brave", "BraveSoftware\\Brave-Browser\\Application\\brave.exe"],
      ["edge", "Microsoft\\Edge\\Application\\msedge.exe"],
    ];
    return apps.flatMap(([id, app]) => roots.map(root => ({ id, path: `${root.replace(/[\\/]+$/, "")}\\${app}` })));
  }
  const onPath = (id: BrowserId, names: string[]) => names.flatMap(name => {
    const found = host.which(name);
    return found ? [{ id, path: found }] : [];
  });
  return [
    ...onPath("chrome", ["google-chrome-stable", "google-chrome"]),
    { id: "chrome", path: "/opt/google/chrome/chrome" },
    ...onPath("chromium", ["chromium", "chromium-browser"]),
    { id: "chromium", path: "/usr/lib/chromium/chromium" },
    { id: "chromium", path: "/snap/bin/chromium" },
    ...onPath("brave", ["brave-browser", "brave"]),
    { id: "brave", path: "/opt/brave.com/brave/brave-browser" },
    { id: "brave", path: "/snap/bin/brave" },
    ...onPath("edge", ["microsoft-edge-stable", "microsoft-edge"]),
    { id: "edge", path: "/opt/microsoft/msedge/msedge" },
  ];
}

/** Only the user's known Playwright cache, never a recursive/cwd search.
 * Full Chromium builds only: headless-shell is not a WebView browser. Layouts
 * cover both the older Chromium archives and newer Chrome for Testing archives. */
function cachedCandidates(host: DiscoveryHost): { id: BrowserId; path: string }[] {
  const { env, platform } = host;
  const paths = platform === "win32" ? win32 : posix;
  let root: string | undefined;
  if (env.PLAYWRIGHT_BROWSERS_PATH) {
    // Playwright's "0" means project-local storage; relative paths likewise
    // depend on cwd and must never become implicit host executable choices.
    if (!paths.isAbsolute(env.PLAYWRIGHT_BROWSERS_PATH)) return [];
    root = env.PLAYWRIGHT_BROWSERS_PATH;
  } else if (platform === "win32") {
    if (env.LOCALAPPDATA && paths.isAbsolute(env.LOCALAPPDATA)) root = paths.join(env.LOCALAPPDATA, "ms-playwright");
  } else if (platform === "darwin") {
    if (env.HOME && paths.isAbsolute(env.HOME)) root = paths.join(env.HOME, "Library", "Caches", "ms-playwright");
  } else if (platform === "linux") {
    const cache = env.XDG_CACHE_HOME && paths.isAbsolute(env.XDG_CACHE_HOME) ? env.XDG_CACHE_HOME
      : env.HOME && paths.isAbsolute(env.HOME) ? paths.join(env.HOME, ".cache") : undefined;
    if (cache) root = paths.join(cache, "ms-playwright");
  }
  if (!root) return [];
  const layouts = platform === "win32" ? [["chrome-win64", "chrome.exe"], ["chrome-win", "chrome.exe"]]
    : platform === "darwin" ? [
      ["chrome-mac-arm64", "Google Chrome for Testing.app", "Contents", "MacOS", "Google Chrome for Testing"],
      ["chrome-mac-x64", "Google Chrome for Testing.app", "Contents", "MacOS", "Google Chrome for Testing"],
      ["chrome-mac", "Chromium.app", "Contents", "MacOS", "Chromium"],
    ] : [["chrome-linux64", "chrome"], ["chrome-linux-arm64", "chrome"], ["chrome-linux", "chrome"]];
  return host.directories(root)
    .filter(name => /^chromium-\d+$/.test(name))
    .sort((a, b) => Number(b.slice(9)) - Number(a.slice(9)))
    .flatMap(name => layouts.map(parts => ({ id: "chromium" as const, path: paths.join(root, name, ...parts) })));
}

function isSnapLauncher(real: string): boolean { return /\/s?bin\/snap$/.test(real); }

/** A Snap, or Ubuntu's `chromium-browser` shell wrapper that execs one. */
export function isSnap(host: DiscoveryHost, path: string): boolean {
  if (host.platform !== "linux") return false;
  // /snap/bin/<app> is a symlink to the shared `snap` launcher (/usr/bin/snap).
  const real = host.realpath(path);
  if (path.startsWith("/snap/") || real.startsWith("/snap/") || isSnapLauncher(real)) return true;
  const head = host.head(path);
  return head.startsWith("#!") && head.includes("/snap/");
}

/** Installed Chrome-family executables in launch-preference order: Chrome,
 * Chromium, Brave, Edge, then cached Chromium; every Snap last. Deduplicated by
 * real path so a symlink and its target are probed once. */
export function browserCandidates(host: DiscoveryHost = systemHost()): Candidate[] {
  const seen = new Set<string>();
  const found: Candidate[] = [];
  for (const c of [...platformCandidates(host), ...cachedCandidates(host)]) {
    if (!host.isFile(c.path)) continue;
    const real = host.realpath(c.path);
    // Every Snap app resolves to the one launcher; keep those apart by name.
    const key = isSnapLauncher(real) ? c.path : real;
    if (seen.has(key)) continue;
    seen.add(key);
    found.push({ ...c, snap: isSnap(host, c.path) });
  }
  return [...found.filter(c => !c.snap), ...found.filter(c => c.snap)];
}

/** Launch argv shared by the worker and the probe: a probe that launched
 * differently would vouch for a browser the worker cannot start. */
export function chromeArgv(platform: NodeJS.Platform = process.platform): string[] {
  return platform === "darwin" ? ["--use-mock-keychain"] : [];
}

/** Browser children need OS environment, not the persona's decrypted vault. */
export function browserChildEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const names = ["PATH", "Path", "HOME", "USERPROFILE", "LOCALAPPDATA", "APPDATA", "PROGRAMFILES", "ProgramFiles", "ProgramFiles(x86)", "SYSTEMROOT", "SystemRoot", "WINDIR", "TEMP", "TMP", "TMPDIR", "LANG", "LC_ALL", "DISPLAY", "WAYLAND_DISPLAY", "XDG_RUNTIME_DIR", "XDG_CACHE_HOME", "BUN_CHROME_PATH", "SSL_CERT_FILE", "SSL_CERT_DIR", "HTTP_PROXY", "HTTPS_PROXY", "NO_PROXY", "http_proxy", "https_proxy", "no_proxy"];
  return Object.fromEntries(names.filter(n => env[n] !== undefined).map(n => [n, env[n]]));
}

/** Test-launch one executable in a child process, exactly as the worker would:
 * same argv, same OS-only environment, and a throwaway profile INSIDE the real
 * browser root (Snap confinement fails on the location, not the binary). */
export const probeBrowser: ProbeFn = async (executable, root) => {
  await mkdir(root, { recursive: true, mode: 0o700 });
  const dir = await mkdtemp(join(root, "probe-"));
  try {
    const args = isCompiledBinary() ? [] : [resolve(import.meta.dir, "..", "index.ts")];
    // Own process group (POSIX): launchers are often shell wrappers, so Chrome
    // is a grandchild that must be reaped with the probe, not left running.
    const group = process.platform !== "win32";
    const child = spawn(process.execPath, [...args, BROWSER_PROBE_SUBCOMMAND, executable, dir], {
      stdio: ["ignore", "pipe", "pipe"], env: browserChildEnv(process.env), windowsHide: true, detached: group,
    });
    let out = "";
    child.stdout!.on("data", chunk => { out += chunk; });
    child.stderr!.on("data", chunk => { out += chunk; });
    const code = await new Promise<number | null>(done => {
      const timer = setTimeout(() => { child.kill("SIGKILL"); done(null); }, PROBE_TIMEOUT_MS);
      child.once("error", error => { clearTimeout(timer); out += error.message; done(-1); });
      child.once("exit", value => { clearTimeout(timer); done(value); });
    });
    if (group && child.pid) { try { process.kill(-child.pid, "SIGKILL"); } catch { /* group already gone */ } }
    if (code === 0 && out.includes("phantombot-browser-probe-ok")) return { ok: true };
    const reason = code === null ? `did not start within ${PROBE_TIMEOUT_MS / 1000}s` : (out.split("\n").map(l => l.trim()).filter(l => l && !l.startsWith("[")).pop() ?? `exit ${code}`);
    return { ok: false, error: reason.slice(0, 300) };
  } finally {
    // A wrapper-launched Chrome can still flush its profile after the probe
    // exits; remove the directory until it stays gone (bounded).
    for (let attempt = 0; attempt < 12; attempt++) {
      await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }).catch(() => {});
      await Bun.sleep(250);
      if (!existsSync(dir)) break;
    }
  }
};

/** Child side of the probe (internal subcommand; no config or vault). */
export async function runBrowserProbe(executable: string, dir: string): Promise<void> {
  type View = { navigate(url: string): Promise<unknown>; evaluate(s: string): Promise<unknown>; cdp(method: string): Promise<unknown> };
  const runtime = (Bun as unknown as { WebView?: { new(options: unknown): View; closeAll(): void } }).WebView;
  if (!runtime) throw new Error("This Bun runtime has no Bun.WebView");
  let view: View | undefined;
  try {
    view = new runtime({ backend: { type: "chrome", url: false, path: executable, argv: chromeArgv() }, dataStore: { directory: dir }, width: 320, height: 240 });
    await view.navigate("about:blank");
    if (await view.evaluate("1 + 1") !== 2) throw new Error("Chrome did not evaluate a script");
    process.stdout.write("phantombot-browser-probe-ok\n");
  } finally {
    // Ask Chrome to exit itself (a wrapper script would survive closeAll's
    // kill of its direct child), bounded, then force-clean.
    if (view) {
      const closing = (async () => { try { await view!.cdp("Browser.close"); } catch { /* never started, or already gone */ } })();
      await Promise.race([closing, Bun.sleep(3000)]);
    }
    runtime.closeAll();
  }
}

interface Preference { browser: string; path: string }
interface Detected { path: string; checkedAt: string }

async function readJson<T>(path: string): Promise<T | undefined> {
  try { return JSON.parse(await readFile(path, "utf8")) as T; } catch { return undefined; }
}
async function writeJson(dir: string, name: string, value: unknown): Promise<void> {
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const temporary = join(dir, `${name}.${process.pid}.${crypto.randomUUID()}.tmp`);
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  await rename(temporary, join(dir, name));
}

/** Forget the cached auto-detected executable (it failed to start). */
export async function forgetDetected(settings: string): Promise<void> {
  await rm(join(settings, DETECTED_FILE), { force: true });
}

function describe(c: Candidate): string { return `${c.path}${c.snap ? " (Snap)" : ""}`; }

async function firstThatStarts(candidates: Candidate[], root: string, probe: ProbeFn): Promise<{ found?: Candidate; tried: string[] }> {
  const tried: string[] = [];
  for (const c of candidates) {
    const result = await probe(c.path, root);
    if (result.ok) return { found: c, tried };
    tried.push(`${describe(c)}: ${result.error}`);
  }
  return { tried };
}

/** Which executable the next worker launches. `settings` holds the persona's
 * choice and cache (`<persona-dir>/browser`); `root` is where the worker's own
 * profile lives, so probes run next to it. Throws when nothing can start. */
export async function resolveBrowserExecutable(settings: string, root: string, options: DiscoveryOptions = {}): Promise<Resolution> {
  const host = options.host ?? systemHost();
  const probe = options.probe ?? probeBrowser;
  const preference = await readJson<Preference>(join(settings, PREFERENCE_FILE));
  if (preference?.browser) {
    if (preference.path && host.isFile(preference.path)) return { path: preference.path, source: "preference", choice: preference.browser };
    // The chosen browser moved (update, reinstall): find it again, but never
    // silently swap in a different browser than the one that was chosen.
    if ((BROWSER_IDS as readonly string[]).includes(preference.browser)) {
      const { found, tried } = await firstThatStarts(browserCandidates(host).filter(c => c.id === preference.browser), root, probe);
      if (found) {
        await writeJson(settings, PREFERENCE_FILE, { browser: preference.browser, path: found.path } satisfies Preference);
        return { path: found.path, source: "preference", choice: preference.browser };
      }
      throw new Error(`The chosen browser '${preference.browser}' cannot start${tried.length ? `: ${tried.join("; ")}` : " (not installed)"}. Run 'phantombot browser use auto' or choose another with 'phantombot browser use <browser>'.`);
    }
    throw new Error(`The chosen browser '${preference.browser}' no longer exists. Run 'phantombot browser use auto' or choose another with 'phantombot browser use <browser>'.`);
  }
  if (host.env.BUN_CHROME_PATH) return { path: host.env.BUN_CHROME_PATH, source: "env" };
  const detected = await readJson<Detected>(join(settings, DETECTED_FILE));
  if (detected?.path && host.isFile(detected.path)) return { path: detected.path, source: "detected" };
  const candidates = browserCandidates(host);
  // Unknown layout (Flatpak, NixOS, a custom prefix): keep Bun's own search.
  if (!candidates.length) return { source: "bun" };
  const { found, tried } = await firstThatStarts(candidates, root, probe);
  if (!found) {
    const cachePaths = new Set(cachedCandidates(host).map(c => c.path));
    const hint = host.platform === "linux" && candidates.every(c => cachePaths.has(c.path))
      ? " Cached Chromium on Linux needs a working sandbox; if the adjacent chrome-sandbox helper is not configured, an operator must set its owner to root:root and mode to 4755 (see docs/reference/browser.md)."
      : "";
    throw new Error(`No installed browser could start: ${tried.join("; ")}.${hint} Install Chrome, Chromium, Brave or Edge, or choose an executable with 'phantombot browser use <path>'.`);
  }
  await writeJson(settings, DETECTED_FILE, { path: found.path, checkedAt: new Date().toISOString() } satisfies Detected);
  return { path: found.path, source: "probed" };
}

/** `phantombot browser use <choice>`: a browser id, an absolute executable
 * path, or `auto`. The choice is test-launched before it is saved, so a
 * persona never pins a browser that cannot start. */
export async function chooseBrowser(settings: string, choice: string, options: DiscoveryOptions = {}): Promise<{ browser: string; path?: string }> {
  const host = options.host ?? systemHost();
  const probe = options.probe ?? probeBrowser;
  const value = choice.trim();
  if (value.toLowerCase() === "auto") {
    await rm(join(settings, PREFERENCE_FILE), { force: true });
    await forgetDetected(settings);
    return { browser: "auto" };
  }
  let candidates: Candidate[];
  if ((BROWSER_IDS as readonly string[]).includes(value.toLowerCase())) {
    const id = value.toLowerCase() as BrowserId;
    candidates = browserCandidates(host).filter(c => c.id === id);
    if (!candidates.length) throw new Error(`${BROWSER_NAMES[id]} is not installed here. Installed: ${browserCandidates(host).map(c => c.id).join(", ") || "none"}.`);
  } else if (isAbsolute(value)) {
    if (!host.isFile(value)) throw new Error(`No executable file at ${value}`);
    candidates = [{ id: "chrome", path: value, snap: isSnap(host, value) }];
  } else {
    throw new Error(`Choose one of ${BROWSER_IDS.join(", ")}, auto, or an absolute path to a Chrome-family executable`);
  }
  const { found, tried } = await firstThatStarts(candidates, settings, probe);
  if (!found) throw new Error(`Not saved: it cannot start (${tried.join("; ")}).`);
  const browser = isAbsolute(value) ? value : value.toLowerCase();
  await writeJson(settings, PREFERENCE_FILE, { browser, path: found.path } satisfies Preference);
  return { browser, path: found.path };
}

/** `phantombot browser list`: installed browsers and what the next launch uses,
 * without launching anything. */
export async function browserStatus(settings: string, options: DiscoveryOptions = {}): Promise<unknown> {
  const host = options.host ?? systemHost();
  const preference = await readJson<Preference>(join(settings, PREFERENCE_FILE));
  const detected = await readJson<Detected>(join(settings, DETECTED_FILE));
  const using = preference?.browser ? { source: "preference", browser: preference.browser, path: preference.path }
    : host.env.BUN_CHROME_PATH ? { source: "env", path: host.env.BUN_CHROME_PATH }
    : detected?.path && host.isFile(detected.path) ? { source: "detected", path: detected.path }
    : { source: "auto", path: null, note: "detected on the next open" };
  return {
    using,
    installed: browserCandidates(host).map(c => ({ browser: c.id, name: BROWSER_NAMES[c.id], path: c.path, snap: c.snap })),
    choose: "phantombot browser use <chrome|chromium|brave|edge|/path/to/executable|auto>",
  };
}
