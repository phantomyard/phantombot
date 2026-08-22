/**
 * Persona-scoped path resolution — the single boundary for "where does this
 * persona's stuff live" (issue #435).
 *
 * THE RULE: a persona owns everything it needs. Config, state, database,
 * memory index, logs, secrets, runtime locks and temp files all live under
 * `<personas-root>/<persona>/`. Nothing phantombot writes at runtime lands
 * outside that directory — not `~/.config/phantombot`, not `~/.local/state`,
 * not the shared system `/tmp`.
 *
 * That is what lets N personas run concurrently in ONE user account on ONE
 * machine without sharing a single mutable byte. The pre-#435 layout inherited
 * from OpenClaw put config.toml, state.json, the task DB, the tick lock and the
 * logs in host-global paths, so two personas on a box silently fought over all
 * of them.
 *
 * Exactly two things are allowed outside a persona directory:
 *
 *   1. `<personas-root>/config.toml` — the GLOBAL file. It holds only knobs
 *      that cannot be per-persona: `default_persona` (which persona the
 *      installer and a `--persona`-less CLI call mean) and `update_channel`
 *      (there is one phantombot binary per box, so two personas cannot follow
 *      different release rings). No behaviour settings ever go here.
 *   2. Service definitions — systemd user units, launchd plists, Windows
 *      scheduled tasks. The OS insists on owning those; each one is named per
 *      persona and points at that persona's directory.
 *
 * Layout is identical on Linux, macOS and Windows (on Windows `~` is
 * `%USERPROFILE%`), so a persona directory is portable between machines by
 * copying it.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { parse as parseToml } from "smol-toml";

/** Built-in persona name used when nothing else resolves. */
export const FALLBACK_PERSONA = "phantom";

/**
 * XDG data home. Kept here (rather than imported from config.ts) so this
 * module has no dependency on the config loader — the config loader depends on
 * IT, since it needs a persona directory before it can read a config file.
 */
export function dataHome(): string {
  if (process.env.XDG_DATA_HOME) return process.env.XDG_DATA_HOME;
  return join(homedir(), ".local", "share");
}

/**
 * Root directory holding `<persona>/` subdirectories, plus the one global
 * config file. Overridable with PHANTOMBOT_PERSONAS_DIR — that env var is the
 * ONLY bootstrap knob, because a file inside the root cannot tell you where
 * the root is.
 */
export function personasRoot(): string {
  return (
    process.env.PHANTOMBOT_PERSONAS_DIR ??
    join(dataHome(), "phantombot", "personas")
  );
}

/** The one global config file: `<personas-root>/config.toml`. */
export function globalConfigPath(): string {
  return process.env.PHANTOMBOT_GLOBAL_CONFIG ?? join(personasRoot(), "config.toml");
}

/** Shape of the global file. Deliberately tiny — see the module header. */
export interface GlobalConfig {
  /** Persona used by the installer and by CLI calls that omit `--persona`. */
  default_persona?: string;
  /** Release ring for the shared binary: "stable" | "preview". */
  update_channel?: string;
}

/**
 * Read the global file. Synchronous and forgiving: path resolution runs on
 * every command, and a malformed or missing global file must degrade to
 * built-in defaults rather than take the process down.
 */
export function loadGlobalConfig(): GlobalConfig {
  try {
    const text = readFileSync(globalConfigPath(), "utf8");
    const parsed = parseToml(text) as Record<string, unknown>;
    const out: GlobalConfig = {};
    if (typeof parsed.default_persona === "string") {
      out.default_persona = parsed.default_persona;
    }
    if (typeof parsed.update_channel === "string") {
      out.update_channel = parsed.update_channel;
    }
    return out;
  } catch {
    return {};
  }
}

/**
 * The persona this process is acting as.
 *
 * PHANTOMBOT_PERSONA wins — it is what `--persona` and every service unit set,
 * and it is what makes concurrent personas in one account safe. Then the global
 * default, then the built-in fallback.
 */
export function activePersona(): string {
  const fromEnv = process.env.PHANTOMBOT_PERSONA?.trim();
  if (fromEnv) return fromEnv;
  const fromGlobal = loadGlobalConfig().default_persona?.trim();
  if (fromGlobal) return fromGlobal;
  return FALLBACK_PERSONA;
}

/** `<personas-root>/<persona>` — the boundary everything else hangs off. */
export function personaRoot(persona: string = activePersona()): string {
  return join(personasRoot(), persona);
}

/** `<persona>/config.toml` — channels, voice, harnesses, everything. */
export function personaConfigPath(persona?: string): string {
  return process.env.PHANTOMBOT_CONFIG ?? join(personaRoot(persona), "config.toml");
}

/** `<persona>/state.json` — phantombot-owned mutable state. */
export function personaStatePath(persona?: string): string {
  return process.env.PHANTOMBOT_STATE ?? join(personaRoot(persona), "state.json");
}

/** `<persona>/.env` — this persona's secrets file. */
export function personaEnvPath(persona?: string): string {
  return process.env.PHANTOMBOT_ENV_FILE ?? join(personaRoot(persona), ".env");
}

/** `<persona>/memory.sqlite` — tasks, drawers, turns. */
export function personaDbPath(persona?: string): string {
  return process.env.PHANTOMBOT_MEMORY_DB ?? join(personaRoot(persona), "memory.sqlite");
}

/** `<persona>/memory-index.sqlite` — FTS5 + embeddings. */
export function personaMemoryIndexPath(persona?: string): string {
  return join(personaRoot(persona), "memory-index.sqlite");
}

/**
 * `<persona>/run/` — ephemeral runtime state: locks, last-fired stamps, turn
 * registry, digests, reply-mode overrides. Pre-#435 this was
 * `~/.local/state/phantombot`, shared by every persona on the box.
 */
export function personaRunDir(persona?: string): string {
  return join(personaRoot(persona), "run");
}

/** `<persona>/logs/` — this persona's log files. */
export function personaLogDir(persona?: string): string {
  return join(personaRoot(persona), "logs");
}

/**
 * `<persona>/tmp/` — temp dir for this persona AND for every subprocess it
 * spawns (see childEnv). Nothing phantombot runs writes to the shared system
 * temp directory, so one persona can never read another's scratch files and a
 * `/tmp` sweep can never yank a file out from under a live turn.
 */
export function personaTmpDir(persona?: string): string {
  return join(personaRoot(persona), "tmp");
}

/** Create the persona's tmp dir if needed and return it. Best-effort. */
export function ensurePersonaTmpDir(persona?: string): string {
  const dir = personaTmpDir(persona);
  try {
    mkdirSync(dir, { recursive: true });
  } catch {
    /* caller falls back to whatever the OS gives it */
  }
  return dir;
}

/**
 * Environment overlay for EVERY subprocess phantombot spawns (harnesses, git,
 * gog, hooks, scheduled commands). Pins the temp directory to the persona's
 * own — TMPDIR on POSIX, TMP/TEMP on Windows, plus PHANTOMBOT_TMP_DIR for
 * phantombot-aware children like the pi extension.
 *
 * This is applied to the CHILD's env, never to `process.env` of the parent:
 * one phantombot process may act for several personas across its lifetime, so
 * mutating the ambient TMPDIR would leak the wrong persona's directory into
 * whatever ran next.
 */
export function tmpEnvOverlay(persona?: string): Record<string, string> {
  const dir = ensurePersonaTmpDir(persona);
  return {
    TMPDIR: dir,
    TMP: dir,
    TEMP: dir,
    PHANTOMBOT_TMP_DIR: dir,
  };
}

/** True when a persona directory exists on disk. */
export function personaExists(persona: string): boolean {
  return existsSync(personaRoot(persona));
}

/**
 * Write the global file, preserving any key we do not manage here.
 *
 * Hand-rolled rather than round-tripped through a TOML serializer because the
 * file is small, user-editable and comment-bearing: we rewrite only the line
 * for the key being set and leave every other line — including comments —
 * byte-identical.
 */
export function setGlobalConfigValue(key: keyof GlobalConfig, value: string): void {
  const path = globalConfigPath();
  let text = "";
  try {
    text = readFileSync(path, "utf8");
  } catch {
    /* first write — start from an empty file */
  }
  const line = `${key} = ${JSON.stringify(value)}`;
  const pattern = new RegExp(`^\\s*${key}\\s*=.*$`, "m");
  if (pattern.test(text)) {
    text = text.replace(pattern, line);
  } else {
    // Global keys are top-level, so a new key must be inserted BEFORE the
    // first `[section]` header or TOML would silently swallow it into that
    // section. Today the file has no sections; this keeps it correct if one
    // is ever added.
    const sectionIdx = text.search(/^\s*\[/m);
    if (sectionIdx === -1) {
      text = text.length === 0 || text.endsWith("\n") ? text + line + "\n" : text + "\n" + line + "\n";
    } else {
      text = text.slice(0, sectionIdx) + line + "\n" + text.slice(sectionIdx);
    }
  }
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text, "utf8");
}
