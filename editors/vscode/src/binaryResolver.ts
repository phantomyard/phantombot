/**
 * phantombot binary discovery for the VS Code extension.
 *
 * Resolution order (first hit wins):
 *   1. Explicit override — the `phantombot.binaryPath` setting.
 *   2. PATH — a `phantombot` (or `phantombot.exe` on win32) entry on $PATH.
 *   3. Common install locations — the user-prefix + system paths phantombot's
 *      own install.sh writes to, per platform.
 *
 * On total failure we return `undefined` and the caller surfaces a clear,
 * actionable error into the chat panel — never a silent hang.
 *
 * This module is pure (it only touches the filesystem + env via injected
 * seams), so it runs under `bun test` with zero `vscode` dependency. The
 * platform switch is driven by an injected `platform`/`env`/`exists` so a
 * single test can exercise linux, darwin AND the win32 branch — the win32
 * branch is therefore implemented but, on this box, only unit-tested (no real
 * Windows host available).
 */

import { posix, win32 } from "node:path";
import { existsSync } from "node:fs";

export type Platform = "linux" | "darwin" | "win32" | string;

export interface ResolveDeps {
  /** process.platform. */
  platform: Platform;
  /** process.env (we read PATH, HOME, USERPROFILE, LOCALAPPDATA). */
  env: Record<string, string | undefined>;
  /** Existence probe — injectable for tests. Default node:fs existsSync. */
  exists?: (p: string) => boolean;
  /** Explicit `phantombot.binaryPath` setting, if the user set one. */
  configuredPath?: string;
}

export interface ResolveResult {
  /** Absolute path (or PATH-relative command) to spawn. */
  path: string;
  /** How it was found — surfaced in diagnostics. */
  source: "setting" | "path" | "install-location";
}

/** The canonical executable name for the platform (used in diagnostics). */
export function binaryName(platform: Platform): string {
  return platform === "win32" ? "phantombot.exe" : "phantombot";
}

/**
 * All executable-name variants to probe, in priority order.
 *
 * On Windows phantombot may be installed as a native `phantombot.exe` (compiled
 * release) OR as an npm/shim `phantombot.cmd`/`phantombot.bat` (e.g. a global
 * npm install). The old resolver only looked for `.exe`, so a perfectly good
 * `.cmd` install surfaced as "binary not found". We probe `.exe` first (the
 * released artifact), then the shims. POSIX has a single extensionless name.
 */
export function binaryNames(platform: Platform): string[] {
  return platform === "win32"
    ? ["phantombot.exe", "phantombot.cmd", "phantombot.bat"]
    : ["phantombot"];
}

/**
 * Join path segments using the TARGET platform's rules — not the host's. This
 * matters because the resolver may run on linux/darwin while reasoning about a
 * win32 layout (and vice-versa in tests): `node:path`'s default `join` uses the
 * HOST separator, which would mangle a Windows path on a POSIX box.
 */
function joinFor(platform: Platform, ...segments: string[]): string {
  return platform === "win32"
    ? win32.join(...segments)
    : posix.join(...segments);
}

/** The PATH entry separator for the platform. */
function pathSeparator(platform: Platform): string {
  return platform === "win32" ? ";" : ":";
}

/**
 * Candidate well-known install locations, in priority order, per platform.
 * These mirror where phantombot's install.sh + `phantombot update` place the
 * binary. Kept conservative — we only probe paths we actually write to.
 */
export function installLocationCandidates(
  platform: Platform,
  env: Record<string, string | undefined>,
): string[] {
  const names = binaryNames(platform);
  if (platform === "win32") {
    // Implemented, UNTESTED on a real Windows host (no Windows box here).
    // For each install dir we probe every name variant (.exe/.cmd/.bat).
    const dirs: string[][] = [];
    const localAppData = env.LOCALAPPDATA;
    if (localAppData) {
      dirs.push([localAppData, "phantombot", "bin"]);
      dirs.push([localAppData, "Programs", "phantombot"]);
    }
    const userProfile = env.USERPROFILE;
    if (userProfile) {
      dirs.push([userProfile, ".local", "bin"]);
      dirs.push([userProfile, "bin"]);
    }
    // npm global shims (phantombot.cmd) land here.
    const appData = env.APPDATA;
    if (appData) dirs.push([appData, "npm"]);
    dirs.push(["C:\\", "Program Files", "phantombot"]);
    const candidates: string[] = [];
    for (const dir of dirs) {
      for (const name of names) {
        candidates.push(joinFor(platform, ...dir, name));
      }
    }
    return candidates;
  }

  // linux + darwin share the POSIX layout.
  const name = names[0]!;
  const home = env.HOME;
  const candidates: string[] = [];
  if (home) {
    candidates.push(joinFor(platform, home, ".local", "bin", name));
    candidates.push(joinFor(platform, home, "bin", name));
  }
  candidates.push(joinFor(platform, "/usr", "local", "bin", name));
  candidates.push(joinFor(platform, "/usr", "bin", name));
  if (platform === "darwin") {
    // Homebrew on Apple Silicon.
    candidates.push(joinFor(platform, "/opt", "homebrew", "bin", name));
  }
  return candidates;
}

/** Probe every directory on $PATH for the binary. Returns the first hit. */
export function findOnPath(
  platform: Platform,
  env: Record<string, string | undefined>,
  exists: (p: string) => boolean,
): string | undefined {
  const rawPath = env.PATH ?? env.Path ?? "";
  if (!rawPath) return undefined;
  const names = binaryNames(platform);
  const sep = pathSeparator(platform);
  for (const dir of rawPath.split(sep)) {
    if (!dir) continue;
    for (const name of names) {
      const candidate = joinFor(platform, dir, name);
      if (exists(candidate)) return candidate;
    }
  }
  return undefined;
}

/**
 * Resolve the phantombot binary. Returns `undefined` if nothing is found, so
 * the caller can render a precise error rather than spawning a bad path.
 */
export function resolvePhantombotBinary(
  deps: ResolveDeps,
): ResolveResult | undefined {
  const exists = deps.exists ?? existsSync;

  // 1. Explicit setting wins — but only if it actually exists, so a stale
  //    setting falls through to discovery rather than dead-ending.
  const configured = deps.configuredPath?.trim();
  if (configured && exists(configured)) {
    return { path: configured, source: "setting" };
  }

  // 2. PATH.
  const onPath = findOnPath(deps.platform, deps.env, exists);
  if (onPath) return { path: onPath, source: "path" };

  // 3. Common install locations.
  for (const candidate of installLocationCandidates(deps.platform, deps.env)) {
    if (exists(candidate)) {
      return { path: candidate, source: "install-location" };
    }
  }

  return undefined;
}

/** Human-readable guidance shown in the panel when resolution fails. */
export function notFoundMessage(platform: Platform): string {
  const setting =
    "Set the `phantombot.binaryPath` setting to its absolute path, " +
    "or add it to your PATH.";
  const name = binaryName(platform);
  return (
    `Could not find the \`${name}\` binary. ${setting}\n\n` +
    "Install it from https://github.com/phantomyard/phantombot, then reload " +
    "the window."
  );
}
