import { access, constants } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { Config } from "../config.ts";

export type KnownHarnessId = "claude" | "pi" | "gemini" | "codex";

export interface HarnessAvailability {
  id: string;
  bin: string;
  resolved?: string;
}

export function harnessBin(config: Config, id: string): string | undefined {
  if (id === "claude") return config.harnesses.claude.bin;
  if (id === "pi") return config.harnesses.pi.bin;
  if (id === "gemini") return config.harnesses.gemini.bin;
  if (id === "codex") return config.harnesses.codex?.bin ?? "codex";
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
    try {
      await access(bin, constants.X_OK);
      return bin;
    } catch {
      return undefined;
    }
  }
  for (const dir of pathEnv.split(":")) {
    if (!dir) continue;
    const candidate = join(dir, bin);
    try {
      await access(candidate, constants.X_OK);
      return candidate;
    } catch {
      /* keep looking */
    }
  }
  return undefined;
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
    const resolved = await whichBinary(bin, pathEnv);
    out.push({
      id,
      bin,
      ...(resolved ? { resolved } : {}),
    });
  }
  return out;
}

export function missingHarnesses(
  availability: readonly HarnessAvailability[],
): HarnessAvailability[] {
  return availability.filter((h) => !h.resolved);
}
