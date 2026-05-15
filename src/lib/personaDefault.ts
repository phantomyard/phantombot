/**
 * Shared "adopt this persona as default if the current default is broken"
 * helper. Used by every code path that creates, imports, or restores a
 * persona — without this, a fresh box keeps `default_persona = "phantom"`
 * (the built-in fallback), and `phantombot run` fails with
 * "persona 'phantom' not found at .../personas/phantom" because the
 * directory was never created.
 *
 * Doesn't override a working default — additive create/import/restore
 * operations stay non-destructive.
 */

import { existsSync, readdirSync } from "node:fs";

import { type Config, personaDir } from "../config.ts";
import { loadState, saveState } from "../state.ts";
import type { WriteSink } from "./io.ts";
import { log } from "./logger.ts";

/**
 * If the current `default_persona` points at a directory that doesn't
 * exist on disk, set `default_persona` to `name` (and write state.json).
 * Otherwise no-op.
 *
 * Returns true if the default was changed.
 */
export async function adoptAsDefaultIfMissing(
  config: Config,
  name: string,
  out?: WriteSink,
): Promise<boolean> {
  const currentDefaultDir = personaDir(config, config.defaultPersona);
  if (existsSync(currentDefaultDir)) return false;
  const state = await loadState();
  state.default_persona = name;
  await saveState(state);
  out?.write(
    `\nadopted '${name}' as default_persona (previous default '${config.defaultPersona}' has no persona dir on disk)\n`,
  );
  return true;
}

/**
 * Startup safety net: if the resolved `defaultPersona` doesn't exist on
 * disk, scan the personas directory for a valid replacement, write it to
 * state.json, and return the healed name.
 *
 * Without this, a corrupted `state.json` (e.g. pointing at a persona
 * that was never created on this host, or one that was deleted) causes
 * `phantombot run` to crash-loop until the user manually runs
 * `phantombot persona` to switch back.
 *
 * Strategy:
 *   1. If the resolved default exists on disk → return it (no-op).
 *   2. Scan the personas dir. If empty → return null (caller bails).
 *   3. If exactly one persona exists → adopt it.
 *   4. If multiple exist → try the one with the same name as the broken
 *      default (could be a case mismatch or partial name collision),
 *      otherwise pick the first alphabetically.
 *
 * Returns the healed persona name, or null if no personas exist at all.
 */
export async function healDefaultPersonaIfBroken(
  config: Config,
  out?: WriteSink,
): Promise<string | null> {
  const currentDefaultDir = personaDir(config, config.defaultPersona);
  if (existsSync(currentDefaultDir)) return config.defaultPersona;

  const existing = listPersonaDirs(config);
  if (existing.length === 0) return null;

  // Prefer a persona whose name matches the broken default (case-insensitive).
  const brokenName = config.defaultPersona.toLowerCase();
  const match = existing.find((n) => n.toLowerCase() === brokenName);
  const healed = match ?? existing[0]!;

  const state = await loadState();
  state.default_persona = healed;
  await saveState(state);
  out?.write(
    `healed default_persona: '${config.defaultPersona}' → '${healed}' ` +
      `(previous default has no persona dir on disk)\n`,
  );
  return healed;
}

/** List persona subdirectory names. Returns [] if the dir doesn't exist. */
export function listPersonaDirs(config: Config): string[] {
  if (!existsSync(config.personasDir)) return [];
  try {
    return readdirSync(config.personasDir, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name)
      .sort();
  } catch (e) {
    log.warn("personaDefault: failed to read personas dir", {
      personasDir: config.personasDir,
      error: (e as Error).message,
    });
    return [];
  }
}
