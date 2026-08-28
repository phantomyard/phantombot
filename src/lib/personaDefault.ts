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
import { updateConfigToml, type TomlObject } from "./configWriter.ts";

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
  log.warn("persona healed", {
    from: config.defaultPersona,
    to: healed,
    reason: "missing on disk",
  });
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

/**
 * Write the host-global `autostart_personas` list.
 *
 * Extracted from the `phantombot persona` autostart picker so the TUI and the
 * CLI go through ONE writer. `autostart_personas` is a HOST-ONLY key
 * (`lib/personaConfig.ts` HOST_ONLY_KEYS): it lives in the global config.toml
 * and never in a persona file. A second writer that reached for the persona
 * layer instead would "save" successfully and change nothing, and two personas
 * editing their own copies would silently fight over who boots.
 *
 * The on-disk order of names already present is preserved and new names are
 * appended, so toggling one persona never shows up as an unrelated reorder in
 * the user's config file. An empty list removes the key entirely, which is
 * exactly the pre-existing "default persona only" behaviour.
 *
 * Mutates `config.autostartPersonas` to match, so an in-memory caller does not
 * have to reload to render the change it just made.
 */
export async function writeAutostartPersonas(
  config: Config,
  picked: readonly string[],
): Promise<string[]> {
  const current = config.autostartPersonas ?? [];
  const chosen = [
    ...current.filter((n) => picked.includes(n)),
    ...picked.filter((n) => !current.includes(n)),
  ];
  await updateConfigToml(config.configPath, (toml: TomlObject) => {
    if (chosen.length === 0) {
      delete toml.autostart_personas;
    } else {
      toml.autostart_personas = chosen;
    }
  });
  config.autostartPersonas = chosen;
  return chosen;
}
