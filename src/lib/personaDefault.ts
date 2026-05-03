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

import { existsSync } from "node:fs";

import { type Config, personaDir } from "../config.ts";
import { loadState, saveState } from "../state.ts";
import type { WriteSink } from "./io.ts";

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
