/**
 * PATH parity for the `phantombot acp` subprocess: prepend the well-known
 * harness install directories the DAEMON already searches via
 * `src/lib/harnessAvailability.ts:harnessSearchPath()`, so a harness that's
 * pinned by absolute path in `state.json` (e.g. `claude.EXE` at
 * `~/.local/bin/claude.EXE`) still has what ITS OWN launch needs on the PATH
 * the extension hands the child process.
 *
 * THE GAP THIS CLOSES: `resolveHarnessBinary()` on the daemon side finds a
 * harness binary either on PATH or by walking `harnessSearchPath()` and
 * pins the resolved ABSOLUTE path into `state.json`. Absolute-path resolution
 * means the extension's spawn of `phantombot acp` finds claude/pi/etc fine
 * regardless of PATH. But once phantombot decides to run that harness, IT
 * spawns claude/pi/codex as ITS OWN child \u2014 and those binaries are
 * frequently Node scripts (`#!/usr/bin/env node`) or wrapper shims that shell
 * out to other tools on PATH (see the shebang-needs-interpreter-on-path
 * lesson, phantombot#240 / withCommandDirOnPath). The daemon (systemd/
 * scheduled task) has a narrow PATH but phantombot's OWN spawn helpers already
 * compensate for that per-harness. VS Code hands the ACP child a PATH that is
 * *editor-inherited*, which on Windows in particular routinely excludes
 * `~/.local/bin` (where nvm/fnm/volta-installed CLIs and their `node`
 * interpreter live side by side) \u2014 collapsing an otherwise-healthy
 * claude-then-pi chain down to pi-only the moment claude's OWN spawn fails
 * silently inside phantombot's harness code.
 *
 * This module mirrors (does not replace) `harnessSearchPath()` server-side \u2014
 * pure, no fs access beyond what's handed in, so it's unit-testable without
 * touching a real home directory. It only ADDS directories; it never removes
 * or reorders what's already on PATH.
 */

import { posix, win32 } from "node:path";

export type EnvMap = Record<string, string | undefined>;

/**
 * The well-known harness/tool install directories under `home`, same set as
 * the daemon's `harnessSearchPath()` static list (minus the dynamic
 * nvm/fnm-version-directory walk, which needs real fs access the extension
 * doesn't have at spawn time \u2014 the static list already covers the common
 * "tool lives in one fixed dir" installers: pi's own installer, bun global
 * installs, volta, and npm both global and per-user).
 */
export function harnessInstallDirs(
  home: string,
  platform: NodeJS.Platform,
  env: EnvMap,
): string[] {
  const path = platform === "win32" ? win32 : posix;
  const dirs = [
    path.join(home, ".local", "bin"),
    path.join(home, ".npm-global", "bin"),
    path.join(home, ".npm", "bin"),
    path.join(home, ".bun", "bin"),
    path.join(home, ".volta", "bin"),
    path.join(home, ".pi", "agent", "bin"),
    path.join(home, ".local", "share", "pi-node", "bin"),
    path.join(home, ".local", "share", "pi-node", "current", "bin"),
  ];
  if (platform === "win32" && env.APPDATA && env.APPDATA.trim()) {
    dirs.push(path.join(env.APPDATA, "npm"));
  }
  return dirs;
}

/**
 * Return a NEW env with `harnessInstallDirs()` prepended to PATH (never
 * mutates the input, which may be the shared `process.env` reference).
 * Directories already present anywhere on PATH are not duplicated. Uses
 * `HOME` (POSIX) or `USERPROFILE` (Windows, falling back to `HOMEDRIVE` +
 * `HOMEPATH`) from the env being built, so this stays pure \u2014 no
 * `os.homedir()` call \u2014 and is fully unit-testable with a synthetic env.
 */
export function withHarnessInstallDirsOnPath(
  env: EnvMap,
  platform: NodeJS.Platform = process.platform,
): EnvMap {
  const home = homeFromEnv(env, platform);
  if (!home) return env;

  const delimiter = platform === "win32" ? ";" : ":";
  const currentPath = env.PATH ?? env.Path ?? "";
  const existing = new Set(
    currentPath.split(delimiter).filter((entry) => entry.length > 0),
  );

  const toAdd = harnessInstallDirs(home, platform, env).filter(
    (dir) => !existing.has(dir),
  );
  if (toAdd.length === 0) return env;

  const pathKey = platform === "win32" && env.Path !== undefined && env.PATH === undefined
    ? "Path"
    : "PATH";
  const next: EnvMap = { ...env };
  next[pathKey] = currentPath
    ? `${toAdd.join(delimiter)}${delimiter}${currentPath}`
    : toAdd.join(delimiter);
  return next;
}

function homeFromEnv(env: EnvMap, platform: NodeJS.Platform): string | undefined {
  if (platform === "win32") {
    const userProfile = env.USERPROFILE?.trim();
    if (userProfile) return userProfile;
    const drive = env.HOMEDRIVE?.trim();
    const path = env.HOMEPATH?.trim();
    if (drive && path) return `${drive}${path}`;
    return env.HOME?.trim() || undefined;
  }
  return env.HOME?.trim() || undefined;
}
