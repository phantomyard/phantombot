/**
 * Windows PATH handling for harness children (issue #647).
 *
 * Two facts about Windows that the POSIX-shaped PATH helpers in
 * processGroup.ts got wrong, and that together left a fresh install with no
 * usable shell:
 *
 * 1. THE VARIABLE IS CALLED `Path`. `process.env` is case-insensitive on
 *    Windows, but the moment it is spread into a plain object (every harness
 *    does this to build the child env) the key keeps its original case —
 *    `Path` — and lookups become case-SENSITIVE. A helper that reads
 *    `env.PATH` therefore sees `undefined`, concludes PATH is empty, and
 *    writes a brand-new `PATH` key holding only the dirs it wanted to prepend.
 *    The child's environment block then carries BOTH `Path=<the real one>` and
 *    `PATH=<three phantombot dirs>`, and the child resolves the short one.
 *    `C:\Windows\System32` is gone: pi's `where powershell.exe` fails with
 *    ENOENT on `where` itself, and the seeded PowerShell tool (#615) reports
 *    "No PowerShell executable found". Bash survived only because pi probes
 *    Git Bash's install dir directly.
 *
 * 2. A DAEMON'S PATH IS A SNAPSHOT. The Scheduled Task's environment is fixed
 *    when the daemon starts. Anything installed afterwards (Git, pwsh, winget
 *    packages) updates the registry PATH that a NEW interactive login would
 *    get, but not the running daemon — so "I installed it and the agent still
 *    can't find it" until a restart.
 *
 * Policy: a persona on Windows gets the PATH a regular user is handed at an
 * interactive PowerShell login or SSH session — the full machine PATH plus the
 * full user PATH, read fresh from the registry — on top of whatever the daemon
 * already has. Nothing is trimmed. PATH failures on Windows are silent and
 * expensive to diagnose; this is not a place to be clever or restrictive.
 *
 * Everything here is a no-op on POSIX.
 */

import { log } from "./logger.ts";

type Env = Record<string, string | undefined>;

const WIN_DELIMITER = ";";

/**
 * The key PATH lives under in `env`. On Windows that is whichever case variant
 * is present (`Path`, `PATH`, `path`); everywhere else, and when none is
 * present, it is `PATH`.
 */
export function pathKeyOf(env: Env, platform: string = process.platform): string {
  if (platform !== "win32") return "PATH";
  for (const key of Object.keys(env)) {
    if (key.toLowerCase() === "path" && env[key] !== undefined) return key;
  }
  return "PATH";
}

/** Case- and trailing-separator-insensitive identity of a Windows PATH entry. */
function winEntryId(entry: string): string {
  return entry.trim().replace(/[\\/]+$/, "").toLowerCase();
}

/** Join PATH entries, dropping blanks and (Windows-insensitive) duplicates. */
function mergeWinEntries(groups: string[][]): string {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const group of groups) {
    for (const raw of group) {
      const entry = raw.trim();
      if (!entry) continue;
      const id = winEntryId(entry);
      if (seen.has(id)) continue;
      seen.add(id);
      out.push(entry);
    }
  }
  return out.join(WIN_DELIMITER);
}

/**
 * Collapse every case variant of PATH in `env` into ONE key, so a Windows
 * child can never be handed `Path` and `PATH` side by side. Entries are merged
 * in key order and de-duplicated; the surviving key is the first variant
 * present. Returns the SAME reference when there is nothing to collapse (one
 * variant or none), a fresh object otherwise. No-op off Windows.
 */
export function normalizePathKey(env: Env, platform: string = process.platform): Env {
  if (platform !== "win32") return env;
  const variants = Object.keys(env).filter(
    (key) => key.toLowerCase() === "path" && env[key] !== undefined,
  );
  if (variants.length <= 1) return env;
  const merged = mergeWinEntries(
    variants.map((key) => (env[key] ?? "").split(WIN_DELIMITER)),
  );
  const out: Env = { ...env };
  for (const key of variants) delete out[key];
  out[variants[0]!] = merged;
  return out;
}

/** Case-insensitive env lookup (Windows variable names are case-insensitive). */
function winEnvLookup(env: Env, name: string): string | undefined {
  const wanted = name.toLowerCase();
  for (const key of Object.keys(env)) {
    if (key.toLowerCase() === wanted) return env[key];
  }
  return undefined;
}

/**
 * Expand `%VAR%` references the way the logon process expands a REG_EXPAND_SZ
 * PATH. An unknown variable is left verbatim (as Windows does), so a typo in
 * someone's PATH degrades to one dead entry rather than corrupting the rest.
 */
export function expandWindowsEnvRefs(value: string, env: Env): string {
  return value.replace(/%([^%;]+)%/g, (whole, name: string) => {
    const resolved = winEnvLookup(env, name);
    return resolved === undefined ? whole : resolved;
  });
}

/**
 * Pull the `Path` value out of `reg query <key> /v Path` output:
 *
 *     HKEY_CURRENT_USER\Environment
 *         Path    REG_EXPAND_SZ    %USERPROFILE%\bin;C:\tools
 *
 * Returns undefined when the value is absent (a user with no user-level PATH
 * is normal) or the output is not what we expect.
 */
export function parseRegQueryPath(stdout: string): string | undefined {
  for (const line of stdout.split(/\r?\n/)) {
    const m = /^\s+path\s+REG_(?:EXPAND_)?SZ(?:\s+(.*))?$/i.exec(line);
    if (m) return (m[1] ?? "").trim();
  }
  return undefined;
}

export const WINDOWS_MACHINE_ENV_KEY =
  "HKLM\\SYSTEM\\CurrentControlSet\\Control\\Session Manager\\Environment";
export const WINDOWS_USER_ENV_KEY = "HKCU\\Environment";

/** Reads the raw (unexpanded) `Path` value of one registry key, or undefined. */
export type RegistryPathReader = (regKey: string) => string | undefined;

/**
 * Default reader: `reg.exe query`, invoked by ABSOLUTE path under SystemRoot —
 * the whole point is to work when PATH is broken, so this must not depend on
 * PATH to find reg.exe. Never throws; any failure reads as "no value".
 */
export function defaultRegistryPathReader(env: Env = process.env): RegistryPathReader {
  return (regKey) => {
    const root =
      winEnvLookup(env, "SystemRoot") ?? winEnvLookup(env, "windir") ?? "C:\\Windows";
    const reg = `${root}\\System32\\reg.exe`;
    try {
      const r = Bun.spawnSync([reg, "query", regKey, "/v", "Path"], {
        stdout: "pipe",
        stderr: "ignore",
        stdin: "ignore",
        timeout: 5000,
        windowsHide: true,
      });
      if (r.exitCode !== 0) return undefined;
      return parseRegQueryPath(r.stdout.toString());
    } catch {
      return undefined;
    }
  };
}

/**
 * The PATH entries a fresh interactive login would get: machine PATH first,
 * then user PATH (the order Windows composes them in), `%VAR%` references
 * expanded against `env`. Empty when neither key yields a value.
 */
export function readWindowsLoginPath(
  env: Env,
  reader: RegistryPathReader = defaultRegistryPathReader(env),
): string[] {
  const entries: string[] = [];
  for (const regKey of [WINDOWS_MACHINE_ENV_KEY, WINDOWS_USER_ENV_KEY]) {
    const raw = reader(regKey);
    if (!raw) continue;
    for (const part of expandWindowsEnvRefs(raw, env).split(WIN_DELIMITER)) {
      if (part.trim()) entries.push(part.trim());
    }
  }
  return entries;
}

/**
 * How long a registry read is reused. Short enough that "I just installed Git"
 * is picked up on the next turn without a daemon restart; long enough that a
 * burst of spawns (a turn plus its delegates) costs one `reg query` pair.
 */
export const WINDOWS_LOGIN_PATH_TTL_MS = 30_000;

let cachedLoginPath: { at: number; entries: string[] } | undefined;
let warnedEmptyLoginPath = false;

/** Test-only: drop the cached registry read. */
export function clearWindowsLoginPathCache(): void {
  cachedLoginPath = undefined;
  warnedEmptyLoginPath = false;
}

export interface WindowsLoginPathOptions {
  platform?: string;
  /** Injected for tests; defaults to `reg.exe query`. */
  reader?: RegistryPathReader;
  /** Injected for tests; defaults to Date.now. */
  now?: () => number;
}

/**
 * Give a Windows child the full login PATH: every machine- and user-PATH entry
 * from the registry that the env does not already carry is APPENDED, so what
 * the daemon already had keeps its precedence and nothing is removed. Also
 * collapses `Path`/`PATH` duplicates first (see normalizePathKey).
 *
 * Returns the same reference when nothing changes; never mutates the caller's
 * env. No-op off Windows. A failed registry read leaves the env as it was —
 * degraded to the daemon's own PATH, never worse than before.
 */
export function withWindowsLoginPath(
  env: Env,
  opts: WindowsLoginPathOptions = {},
): Env {
  const platform = opts.platform ?? process.platform;
  if (platform !== "win32") return env;
  const base = normalizePathKey(env, platform);

  const now = (opts.now ?? Date.now)();
  let login: string[];
  if (!opts.reader && cachedLoginPath && now - cachedLoginPath.at < WINDOWS_LOGIN_PATH_TTL_MS) {
    login = cachedLoginPath.entries;
  } else {
    login = readWindowsLoginPath(base, opts.reader);
    if (!opts.reader) cachedLoginPath = { at: now, entries: login };
    if (login.length === 0 && !warnedEmptyLoginPath) {
      warnedEmptyLoginPath = true;
      log.warn(
        "windowsPath: could not read the machine/user PATH from the registry; " +
          "harness children keep the daemon's own PATH",
      );
    }
  }
  if (login.length === 0) return base;

  const key = pathKeyOf(base, platform);
  const current = base[key] ?? "";
  const merged = mergeWinEntries([current.split(WIN_DELIMITER), login]);
  if (merged === current) return base;
  return { ...base, [key]: merged };
}
