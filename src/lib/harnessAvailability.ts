import { access, constants, readdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { Config } from "../config.ts";

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

export async function whichBinary(
  bin: string,
  pathEnv = process.env.PATH ?? "",
): Promise<string | undefined> {
  if (bin.startsWith("/")) {
    return (await executableFile(bin)) ? bin : undefined;
  }
  for (const dir of pathEnv.split(":")) {
    if (!dir) continue;
    const candidate = join(dir, bin);
    if (await executableFile(candidate)) {
      return candidate;
    }
  }
  return undefined;
}

async function executable(path: string): Promise<boolean> {
  return executableFile(path);
}

async function executableFile(path: string): Promise<boolean> {
  try {
    const info = await stat(path);
    if (!info.isFile()) return false;
    await access(path, constants.X_OK);
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
  for (const dir of (process.env.PATH ?? "").split(":")) {
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
  if (bin.startsWith("/")) {
    return (await executable(bin))
      ? { path: bin, source: "configured" }
      : {};
  }

  const fromPath = await whichBinary(bin, pathEnv);
  if (fromPath) return { path: fromPath, source: "path" };

  for (const dir of await harnessSearchPath()) {
    const candidate = join(dir, bin);
    if (await executable(candidate)) {
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
    if (!resolved.path && bin.startsWith("/")) {
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
