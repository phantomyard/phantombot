import { access, constants, readdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { delimiter, isAbsolute, join } from "node:path";
import type { Config } from "../config.ts";
import { log } from "./logger.ts";
import { saveHarnessBins } from "../state.ts";
import { recordHarnessBinDirs } from "./processGroup.ts";
import type { WriteSink } from "./io.ts";

export type KnownHarnessId = "claude" | "pi" | "gemini" | "codex";

export interface HarnessAvailability {
  id: string;
  bin: string;
  resolved?: string;
  source?: "path" | "configured" | "search";
}

export interface ResolvedHarnessBinary {
  path?: string;
  source?: "path" | "configured" | "search";
}

export function harnessBin(config: Config, id: string): string | undefined {
  if (id === "claude") return config.harnesses.claude.bin;
  if (id === "pi") return config.harnesses.pi.bin;
  if (id === "gemini") return config.harnesses.gemini.bin;
  if (id === "codex") return config.harnesses.codex?.bin ?? "codex";
  return undefined;
}

function defaultHarnessBin(id: string): string | undefined {
  if (id === "claude") return "claude";
  if (id === "pi") return "pi";
  if (id === "gemini") return "gemini";
  if (id === "codex") return "codex";
  return undefined;
}

export function expandSystemdPath(path: string, home = homedir()): string {
  return path
    .split(":")
    .map((part) => part.replaceAll("%h", home))
    .join(":");
}

const isWindows = process.platform === "win32";

/**
 * Extensions to try when resolving a bare command name against a directory.
 *
 * POSIX executables have no extension, so the only candidate is the name as
 * given (""). On Windows the shipped harness CLIs are `claude.cmd`, `pi.cmd`,
 * `gemini.cmd`, `codex.exe` etc., and which suffixes count as "runnable" is
 * defined by PATHEXT. We try "" first so an already-qualified name (bin =
 * "claude.cmd", or an absolute path) resolves directly, then every PATHEXT
 * suffix for the bare-name case.
 */
export function executableExtensions(
  platform: NodeJS.Platform = process.platform,
  pathext: string | undefined = process.env.PATHEXT,
): string[] {
  if (platform !== "win32") return [""];
  const raw = pathext ?? ".COM;.EXE;.BAT;.CMD";
  const exts = raw
    .split(";")
    .map((e) => e.trim())
    .filter((e) => e.length > 0);
  return ["", ...exts];
}

/**
 * Resolve a base path to a runnable file, trying platform executable
 * extensions. Returns the matched path (with extension, if one was appended).
 */
async function resolveExecutable(basePath: string): Promise<string | undefined> {
  for (const ext of executableExtensions()) {
    const candidate = basePath + ext;
    if (await executableFile(candidate)) return candidate;
  }
  return undefined;
}

export async function whichBinary(
  bin: string,
  pathEnv = process.env.PATH ?? "",
): Promise<string | undefined> {
  if (isAbsolute(bin)) {
    return await resolveExecutable(bin);
  }
  for (const dir of pathEnv.split(delimiter)) {
    if (!dir) continue;
    const found = await resolveExecutable(join(dir, bin));
    if (found) return found;
  }
  return undefined;
}

async function executableFile(path: string): Promise<boolean> {
  try {
    const info = await stat(path);
    if (!info.isFile()) return false;
    // The Unix execute bit isn't modeled on Windows: access(X_OK) there can
    // spuriously fail (or pass) and would wrongly reject a real `.cmd`/`.exe`.
    // A regular file with a PATHEXT-recognised extension is runnable, so on
    // win32 the isFile() check above is the gate.
    if (!isWindows) {
      await access(path, constants.X_OK);
    }
    return true;
  } catch {
    return false;
  }
}

async function existingChildDirs(parent: string): Promise<string[]> {
  try {
    const entries = await readdir(parent, { withFileTypes: true });
    return entries
      .filter((entry) => entry.isDirectory())
      .map((entry) => join(parent, entry.name));
  } catch {
    return [];
  }
}

export async function harnessSearchPath(home = homedir()): Promise<string[]> {
  const dirs = new Set<string>();
  for (const dir of (process.env.PATH ?? "").split(delimiter)) {
    if (dir) dirs.add(dir);
  }

  const staticDirs = [
    join(home, ".local", "bin"),
    join(home, ".npm-global", "bin"),
    join(home, ".npm", "bin"),
    join(home, ".bun", "bin"),
    join(home, ".volta", "bin"),
    join(home, ".pi", "agent", "bin"),
    join(home, ".local", "share", "pi-node", "bin"),
    join(home, ".local", "share", "pi-node", "current", "bin"),
  ];
  for (const dir of staticDirs) dirs.add(dir);

  if (isWindows) {
    // Windows global-install locations the POSIX home subdirs don't cover:
    // npm global shims land in %APPDATA%\npm, and bun's global bin in
    // %USERPROFILE%\.bun\bin (already added above) - add the npm one here.
    const appData = process.env.APPDATA;
    if (appData) dirs.add(join(appData, "npm"));
  }

  for (const nodeDir of await existingChildDirs(join(home, ".nvm", "versions", "node"))) {
    dirs.add(join(nodeDir, "bin"));
  }
  for (const nodeDir of await existingChildDirs(join(home, ".fnm", "node-versions"))) {
    dirs.add(join(nodeDir, "installation", "bin"));
  }
  for (const appDir of await existingChildDirs(join(home, ".local", "share"))) {
    for (const child of await existingChildDirs(appDir)) {
      if (child.includes("node-") || child.includes("node-v")) {
        dirs.add(join(child, "bin"));
      }
    }
  }

  return [...dirs];
}

export async function resolveHarnessBinary(
  bin: string,
  pathEnv = process.env.PATH ?? "",
): Promise<ResolvedHarnessBinary> {
  if (isAbsolute(bin)) {
    const resolved = await resolveExecutable(bin);
    return resolved ? { path: resolved, source: "configured" } : {};
  }

  const fromPath = await whichBinary(bin, pathEnv);
  if (fromPath) return { path: fromPath, source: "path" };

  for (const dir of await harnessSearchPath()) {
    const candidate = await resolveExecutable(join(dir, bin));
    if (candidate) {
      return { path: candidate, source: "search" };
    }
  }
  return {};
}

export async function checkConfiguredHarnesses(
  config: Config,
  pathEnv = process.env.PATH ?? "",
): Promise<HarnessAvailability[]> {
  const seen = new Set<string>();
  const out: HarnessAvailability[] = [];
  for (const id of config.harnesses.chain) {
    if (seen.has(id)) continue;
    seen.add(id);
    const bin = harnessBin(config, id);
    if (!bin) continue;
    let resolved = await resolveHarnessBinary(bin, pathEnv);
    if (!resolved.path && isAbsolute(bin)) {
      const fallbackBin = defaultHarnessBin(id);
      if (fallbackBin) {
        resolved = await resolveHarnessBinary(fallbackBin, pathEnv);
      }
    }
    out.push({
      id,
      bin,
      ...(resolved.path ? { resolved: resolved.path } : {}),
      ...(resolved.source ? { source: resolved.source } : {}),
    });
  }
  return out;
}

export function missingHarnesses(
  availability: readonly HarnessAvailability[],
): HarnessAvailability[] {
  return availability.filter((h) => !h.resolved);
}

export function resolvedHarnessBins(
  availability: readonly HarnessAvailability[],
): Record<string, string> {
  return Object.fromEntries(
    availability
      .filter((h) => h.resolved)
      .map((h) => [h.id, h.resolved!]),
  );
}

/**
 * Resolve every configured harness binary against the live filesystem,
 * persist the resolved absolute paths to state, and return a config whose
 * harness bins point at those absolute paths.
 *
 * Why this exists as a shared helper: the long-running `run` daemon already
 * did this inline, but the systemd ONESHOTS (`nightly`, `tick`) and `ask`
 * did not — they built their harness chain straight off `loadConfig()`. A
 * PATH-relative bin like `pi` then relied solely on the unit's narrow
 * `Environment=PATH=` (PHANTOMBOT_SERVICE_PATH). If `pi` lives anywhere
 * outside those dirs — a versioned nvm/fnm/volta/.bun path that only the
 * broad `harnessSearchPath()` covers — the oneshot spawned `pi` and got
 * `exit 127` (command not found) every single night, while the interactive
 * daemon (which DID resolve) worked fine. That divergence was phantombot
 * issue #181 §1. Routing all four entry points through this one helper
 * means a oneshot resolves binaries exactly the way the daemon does.
 *
 * `check` is injectable for tests; `persist` defaults to true (cheap write
 * that keeps state.json's resolved bins fresh for the next loadConfig).
 */
export async function resolveHarnessBinsForConfig(
  config: Config,
  opts: {
    check?: (c: Config) => Promise<HarnessAvailability[]>;
    persist?: boolean;
    err?: WriteSink;
  } = {},
): Promise<{ config: Config; missing: HarnessAvailability[] }> {
  const checks = opts.check
    ? await opts.check(config)
    : await checkConfiguredHarnesses(config);
  const resolved = resolvedHarnessBins(checks);
  // Make the resolved harness dirs available on every harness child's PATH so
  // the agent's Bash tool can invoke pi/claude/gemini/codex by bare name even
  // under a narrow launcher PATH (Windows machine-PATH-only Scheduled Task).
  // Retires the by-hand machine-PATH band-aid. See processGroup.harnessBinDirs.
  recordHarnessBinDirs(Object.values(resolved));
  let next = config;
  if (Object.keys(resolved).length > 0) {
    if (opts.persist !== false) await saveHarnessBins(resolved);
    next = applyResolvedHarnessBins(config, checks);
  }
  const missing = missingHarnesses(checks);
  if (missing.length > 0) {
    log.warn("harness binary not found on PATH or search path", {
      missing: missing.map((h) => ({ id: h.id, bin: h.bin })),
    });
    opts.err?.write(
      "warning: configured harness binary not found:\n" +
        missing.map((h) => `  ${h.id}: '${h.bin}'`).join("\n") +
        "\n",
    );
  }
  return { config: next, missing };
}

export function applyResolvedHarnessBins(
  config: Config,
  availability: readonly HarnessAvailability[],
): Config {
  const bins = resolvedHarnessBins(availability);
  return {
    ...config,
    harnesses: {
      ...config.harnesses,
      claude: bins.claude
        ? { ...config.harnesses.claude, bin: bins.claude }
        : config.harnesses.claude,
      pi: bins.pi ? { ...config.harnesses.pi, bin: bins.pi } : config.harnesses.pi,
      gemini: bins.gemini
        ? { ...config.harnesses.gemini, bin: bins.gemini }
        : config.harnesses.gemini,
      codex: bins.codex
        ? { ...(config.harnesses.codex ?? { bin: "codex", model: "" }), bin: bins.codex }
        : config.harnesses.codex,
    },
  };
}
