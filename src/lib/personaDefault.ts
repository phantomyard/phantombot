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
 *
 * Everything here canonicalises the configured name against the persona
 * directory listing rather than asking the filesystem whether a path
 * exists. `existsSync` answers case-INSENSITIVELY on macOS and Windows, so
 * a `default_persona = "ghostfixture"` against an on-disk `Ghostfixture`
 * looks healthy and the wrong-cased string then flows on verbatim as the
 * persona key for `drawer_entries` / `journal_entries` — same files, a
 * different memory namespace, and memory silently reads empty.
 */

import { existsSync, readdirSync } from "node:fs";

import type { Config } from "../config.ts";
import { loadState, saveState } from "../state.ts";
import type { WriteSink } from "./io.ts";
import { log } from "./logger.ts";

/**
 * Resolve `name` to the persona directory that actually backs it, as spelled
 * on disk. Exact match wins; otherwise a unique case-insensitive match. null
 * when no directory backs the name at all.
 *
 * Use this instead of `existsSync(personaDir(config, name))`: on a
 * case-insensitive filesystem that check conflates "this persona exists" with
 * "this is the persona's name", and only the latter is safe to use as a key.
 */
export function canonicalPersonaName(
  config: Config,
  name: string,
): string | null {
  const existing = listPersonaDirs(config);
  if (existing.includes(name)) return name;
  const wanted = name.toLowerCase();
  const matches = existing.filter((n) => n.toLowerCase() === wanted);
  // Two dirs differing only by case can coexist on a case-sensitive FS. There
  // is no principled way to pick one, so leave it to the caller's fallback.
  return matches.length === 1 ? matches[0]! : null;
}

/**
 * If the current `default_persona` points at a directory that doesn't
 * exist on disk, set `default_persona` to `name` (and write state.json).
 * Otherwise no-op.
 *
 * A default that exists but is spelled with the wrong case is repaired in
 * place — that persona keeps the default, it just stops being addressed by a
 * name that no directory carries. Reported as unchanged, because `name` was
 * not adopted.
 *
 * Returns true if `name` became the new default.
 */
export async function adoptAsDefaultIfMissing(
  config: Config,
  name: string,
  out?: WriteSink,
): Promise<boolean> {
  const canonical = canonicalPersonaName(config, config.defaultPersona);
  if (canonical === config.defaultPersona) return false;
  if (canonical !== null) {
    await writeDefaultPersona(canonical);
    log.warn("persona default case-normalized", {
      from: config.defaultPersona,
      to: canonical,
      reason: "case mismatch against persona dir",
    });
    out?.write(
      `\nnormalized default_persona: '${config.defaultPersona}' → '${canonical}' ` +
        `(the persona dir on disk is spelled '${canonical}')\n`,
    );
    return false;
  }
  await writeDefaultPersona(name);
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
 *   1. If a persona dir is spelled exactly like the resolved default →
 *      return it (no-op).
 *   2. If one is spelled the same but for case → adopt that spelling. The
 *      persona is unchanged; only the key used to address its memory is.
 *   3. Scan the personas dir. If empty → return null (caller bails).
 *   4. Otherwise pick the first alphabetically.
 *
 * Returns the healed persona name, or null if no personas exist at all.
 */
export async function healDefaultPersonaIfBroken(
  config: Config,
  out?: WriteSink,
): Promise<string | null> {
  const canonical = canonicalPersonaName(config, config.defaultPersona);
  if (canonical === config.defaultPersona) return config.defaultPersona;

  const existing = listPersonaDirs(config);
  if (canonical === null && existing.length === 0) return null;

  const healed = canonical ?? existing[0]!;
  const reason =
    canonical === null ? "missing on disk" : "case mismatch against persona dir";

  await writeDefaultPersona(healed);
  log.warn("persona healed", {
    from: config.defaultPersona,
    to: healed,
    reason,
  });
  out?.write(
    `healed default_persona: '${config.defaultPersona}' → '${healed}' (${reason})\n`,
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

async function writeDefaultPersona(name: string): Promise<void> {
  const state = await loadState();
  state.default_persona = name;
  await saveState(state);
}
