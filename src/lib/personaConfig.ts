/**
 * Per-persona config layering (phantombot#439).
 *
 * One phantombot process serves EVERY persona on the host — there is one
 * daemon, one binary, one update. What was missing is a place for a persona
 * to keep its OWN settings: until now every persona-scoped knob (its Telegram
 * bot, its voice block, its chattiness default) lived in the single global
 * `~/.config/phantombot/config.toml`, which made "start these three personas
 * at boot" a config-shaped problem rather than a code-shaped one.
 *
 * The model:
 *
 *   <config-home>/phantombot/config.toml   — HOST globals only:
 *                                            default_persona, autostart_personas,
 *                                            update_channel, paths, harness bins
 *   <personas-root>/<persona>/config.toml  — that persona's own settings
 *
 * Resolution is a PER-KEY deep merge with the persona file winning every
 * conflict, and env vars still winning over both (they are applied later, in
 * config.ts). A key absent from the persona file falls back to the global
 * file — never to a constant. That is deliberate: a "default" that outranks an
 * operator's existing global setting is a silent behaviour change on upgrade.
 *
 * Migration is COPY, NEVER DELETE, ADDITIVE, and idempotent:
 *
 *   - persona-scoped keys are COPIED out of the global file into
 *     `<persona>/config.toml`, and the global file is left byte-identical;
 *   - a key the persona file ALREADY sets is never touched, so a hand edit (or
 *     a half-written file left by `phantombot voice --persona`) always wins;
 *   - only the keys that are MISSING are filled in, so a partial persona file
 *     cannot leave the rest of that persona unmigrated.
 *
 * Copy-not-delete is what makes `/update` order-independent. Release rings mean
 * a host can be rolled BACK to a binary that has never heard of persona config
 * files; if migration had pruned `[channels.telegram]` from the global file,
 * that host would come back up with no channels and no error. Leaving the
 * original in place means the new binary reads the persona file, the old binary
 * reads the global one, and updating in either direction is a no-op. Users who
 * want a tidy global file can prune it by hand; nothing reads those keys once a
 * persona file exists.
 */

import { join } from "node:path";

import { readConfigToml, writeConfigToml, type TomlObject } from "./configWriter.ts";
import { log } from "./logger.ts";

/**
 * Top-level config keys that describe ONE persona rather than the host.
 * Used only by migration, to decide what to seed a fresh persona file with.
 *
 * The READ path is deliberately not restricted to this list: any key present in
 * a persona's config.toml overrides the global one. That keeps the mechanism
 * general (a future persona-scoped knob needs no change here) while migration
 * stays conservative and only moves what is unambiguously persona-shaped.
 *
 * `harnesses` IS persona-scoped (phantombot#441): which brain a persona thinks
 * with — the failover chain, the Claude/Codex model, Pi's capability routing —
 * is a property of the personality, not of the box. The whole block is copied,
 * INCLUDING `bin` paths, so a persona file is a complete, self-contained
 * description of that persona's harness; an unstated bin still falls back to
 * the host's probed path, so a moved binary does not require editing N files
 * unless the operator deliberately pinned one.
 *
 * Notably absent: `personas_dir`, `memory_db`, `update_channel`,
 * `default_persona`, `autostart_personas`.
 */
export const PERSONA_SCOPED_KEYS: readonly string[] = [
  "channels",
  "voice",
  "harnesses",
  "telegram_streaming",
  "chattiness",
  "retrieval",
  "durable_facts",
];

/**
 * Keys that belong to the HOST and must never be taken from a persona file.
 *
 * A persona cannot elect itself default, change the release ring the box
 * follows, relocate the personas root, or repoint the shared memory database.
 * Those decide things about the machine, not about a personality, and honoring
 * them from a persona file would let one persona reconfigure every other one.
 * Stripped from the persona layer before the merge, so a stray key is inert
 * rather than dangerous.
 */
export const HOST_ONLY_KEYS: readonly string[] = [
  "default_persona",
  "autostart_personas",
  "update_channel",
  "personas_dir",
  "memory_db",
];

/** Drop host-level keys from a persona layer. Returns a new object. */
export function stripHostOnlyKeys(toml: TomlObject): TomlObject {
  const out: TomlObject = {};
  for (const [k, v] of Object.entries(toml)) {
    if (HOST_ONLY_KEYS.includes(k)) {
      log.warn(
        "personaConfig: ignoring host-level key in persona config.toml",
        { key: k },
      );
      continue;
    }
    out[k] = v;
  }
  return out;
}

/** Path to a persona's own config file. */
export function personaConfigPath(
  personasDir: string,
  persona: string,
): string {
  return join(personasDir, persona, "config.toml");
}

/** Read a persona's config.toml. A missing file reads as `{}`. */
export async function readPersonaToml(
  personasDir: string,
  persona: string,
): Promise<TomlObject> {
  return await readConfigToml(personaConfigPath(personasDir, persona));
}

function isPlainObject(v: unknown): v is TomlObject {
  return typeof v === "object" && v !== null && !Array.isArray(v) &&
    !(v instanceof Date);
}

/**
 * Deep per-key merge. `override` wins; tables recurse; arrays and scalars
 * replace wholesale.
 *
 * Arrays are replaced rather than concatenated because every array in this
 * config is a complete statement — `allowed_user_ids`, `harnesses.chain`,
 * `stun_servers`. Element-wise merging would make it impossible for a persona
 * to NARROW an inherited allowlist, which is the direction that matters for
 * security.
 *
 * Neither input is mutated.
 */
export function mergeToml(base: TomlObject, override: TomlObject): TomlObject {
  const out: TomlObject = { ...base };
  for (const [key, value] of Object.entries(override)) {
    const prev = out[key];
    if (isPlainObject(prev) && isPlainObject(value)) {
      out[key] = mergeToml(prev, value);
    } else {
      out[key] = value;
    }
  }
  return out;
}

/** Structural clone that is safe for the TOML value domain. */
function cloneToml<T>(v: T): T {
  if (Array.isArray(v)) return v.map((x) => cloneToml(x)) as unknown as T;
  if (isPlainObject(v)) {
    const out: TomlObject = {};
    for (const [k, val] of Object.entries(v)) out[k] = cloneToml(val);
    return out as unknown as T;
  }
  return v;
}


/**
 * Where a per-persona SETTING must be written so that reading it back gives
 * the value just written (phantombot#439).
 *
 * The read path is: persona file wins, global file is the fallback. A writer
 * that ignores that ends in split-brain — `phantombot telegram --persona lena`
 * updating the legacy `[channels.telegram.personas.lena]` table while the
 * daemon keeps reading the token from `<lena>/config.toml`, so the change
 * "saves" and nothing happens.
 *
 * The rule is therefore the read rule, backwards:
 *
 *   - `<persona>/config.toml` exists → write THERE. It exists because
 *     migration ran, or because the user made it; either way it outranks the
 *     global file on read, so it is the only place a write can win.
 *   - it does not exist → write the GLOBAL file in its historical shape. That
 *     keeps an unmigrated host readable by an older binary (release rings make
 *     rollback real), and the next daemon start copies the key into the
 *     persona file anyway.
 */
export type PersonaWriteScope = "persona" | "global";

export async function resolvePersonaWriteTarget(input: {
  configPath: string;
  personasDir: string;
  persona: string;
}): Promise<{ path: string; scope: PersonaWriteScope }> {
  const path = personaConfigPath(input.personasDir, input.persona);
  const existing = await readConfigToml(path);
  if (Object.keys(existing).length > 0) return { path, scope: "persona" };
  return { path: input.configPath, scope: "global" };
}

export interface MigratePersonaConfigInput {
  personasDir: string;
  persona: string;
  /** Parsed contents of the global config.toml. */
  globalToml: TomlObject;
  /**
   * True when `persona` is the host's default persona. The default persona
   * inherits the global `[channels.telegram]` block; a non-default persona
   * inherits `[channels.telegram.personas.<persona>]` instead, since that is
   * where its bot lived under the old layout.
   */
  isDefault: boolean;
}

export type MigratePersonaConfigResult =
  | { migrated: false; reason: "exists" | "nothing-to-copy" }
  | { migrated: true; keys: string[]; path: string };

/**
 * Fill in only what `existing` does not already say.
 *
 * Recurses into tables so a persona file that sets `[voice]` alone still gets
 * `[channels.telegram]` seeded, and a file that sets
 * `channels.telegram.token` keeps its token while gaining the allowlist it
 * omitted. Never overwrites a value the persona file already has — the whole
 * point is that a hand edit outranks a migration.
 *
 * Returns the top-level keys that gained something, so the caller can decide
 * whether there is anything to write at all.
 */
export function seedMissing(
  existing: TomlObject,
  seed: TomlObject,
): { merged: TomlObject; added: string[] } {
  const added: string[] = [];
  const merged: TomlObject = { ...existing };
  for (const [key, value] of Object.entries(seed)) {
    const prev = merged[key];
    if (prev === undefined) {
      merged[key] = cloneToml(value);
      added.push(key);
      continue;
    }
    if (isPlainObject(prev) && isPlainObject(value)) {
      const sub = seedMissing(prev, value);
      if (sub.added.length > 0) {
        merged[key] = sub.merged;
        added.push(key);
      }
    }
    // Scalar or array already present: the persona file wins, untouched.
  }
  return { merged, added };
}

/**
 * Seed `<persona>/config.toml` from the global file, once.
 *
 * Idempotent by construction: the presence of the persona file is the entire
 * guard, so running this on every daemon start (which is the point — a user
 * types `/update` and lands correct, whatever version they came from) costs one
 * stat after the first time. It never writes an empty file, so a host with no
 * global config stays clean rather than growing an empty one per persona.
 */
export async function migratePersonaConfig(
  input: MigratePersonaConfigInput,
): Promise<MigratePersonaConfigResult> {
  const path = personaConfigPath(input.personasDir, input.persona);
  const existing = await readConfigToml(path);

  const seed: TomlObject = {};
  for (const key of PERSONA_SCOPED_KEYS) {
    const value = input.globalToml[key];
    if (value === undefined) continue;
    seed[key] = cloneToml(value);
  }

  // `[channels.telegram.personas]` is a routing table for the OLD layout: it
  // maps persona name → that persona's bot. It is host-shaped, not
  // persona-shaped, so it must never be copied verbatim into a persona file.
  // Instead the persona takes its OWN entry from that table as its
  // `[channels.telegram]`, and the table itself is dropped from the copy.
  const channels = seed.channels;
  if (isPlainObject(channels)) {
    const telegram = channels.telegram;
    if (isPlainObject(telegram)) {
      const table = telegram.personas;
      const own = isPlainObject(table) ? table[input.persona] : undefined;
      const { personas: _dropped, ...ownAccount } = telegram;
      if (input.isDefault) {
        // The unsuffixed host account remains authoritative when present. Some
        // older hosts, however, stored even the default persona exclusively in
        // the legacy routing table. Translate that matching entry rather than
        // seeding a stated-but-empty account that suppresses Telegram entirely.
        if (Object.keys(ownAccount).length > 0) {
          channels.telegram = ownAccount;
        } else if (isPlainObject(own) && Object.keys(own).length > 0) {
          channels.telegram = cloneToml(own);
        } else {
          delete channels.telegram;
        }
      } else if (isPlainObject(own) && Object.keys(own).length > 0) {
        channels.telegram = cloneToml(own);
      } else {
        // A non-default persona with no bot of its own inherits nothing from
        // the default persona's Telegram block — that bot belongs to someone
        // else, and copying it would hand two personas the same token.
        delete channels.telegram;
      }
    }
    if (Object.keys(channels).length === 0) delete seed.channels;
  }

  // `[harnesses]` is copied whole — chain, models, routing, bins — minus the
  // host-shaped `personas` routing table, which is dropped for the same reason
  // as `[channels.telegram.personas]`: inside a persona file it would read as
  // "this persona's override for a persona of the same name". That persona's
  // OWN legacy entry is instead translated into the plain `[harnesses].chain`,
  // overriding the host chain that was just copied — the legacy entry is the
  // more specific statement about this persona, so it must win.
  const harnesses = seed.harnesses;
  if (isPlainObject(harnesses)) {
    const table = harnesses.personas;
    const own = isPlainObject(table) ? table[input.persona] : undefined;
    delete harnesses.personas;
    if (isPlainObject(own) && Array.isArray(own.chain)) {
      harnesses.chain = cloneToml(own.chain);
    }
    if (Object.keys(harnesses).length === 0) delete seed.harnesses;
  }

  if (Object.keys(seed).length === 0) {
    return { migrated: false, reason: "nothing-to-copy" };
  }

  // A persona file that already exists is not proof that migration ran: the
  // voice TUI writes `<persona>/config.toml` with a `[voice]` block alone, and
  // a user may hand-write one. Treating any non-empty file as "done" would
  // skip that persona's Telegram translation forever, leaving it to inherit
  // the DEFAULT persona's bot from the global file — two listeners on one
  // token, which planListeners rightly refuses to start. So seed only the
  // MISSING keys and never touch what is already there.
  const { merged, added } = seedMissing(existing, seed);
  if (added.length === 0) {
    return { migrated: false, reason: "exists" };
  }

  await writeConfigToml(path, merged);
  log.info("personaConfig: seeded persona config from global config.toml", {
    persona: input.persona,
    path,
    keys: added,
  });
  return { migrated: true, keys: added, path };
}
