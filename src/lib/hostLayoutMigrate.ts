/**
 * One-shot migration from the pre-#435 HOST-GLOBAL layout to the per-persona
 * one. Runs automatically at startup, is idempotent, and is a cheap no-op once
 * there is nothing left to move.
 *
 * What moves, and why the split is what it is:
 *
 *   ~/.config/phantombot/config.toml  → <persona>/config.toml, for EVERY
 *       persona on the box. Copied verbatim (comments and all) rather than
 *       re-serialized, minus the handful of top-level keys that are genuinely
 *       global. Any `[harnesses.personas.X]` / `[channels.telegram.personas.X]`
 *       override tables are left in place: the loader still honours them, so a
 *       migrated box behaves EXACTLY as it did before, and the owner can prune
 *       the copies at leisure. A verbatim copy is the only form of this
 *       migration that cannot silently change behaviour.
 *
 *   ~/.config/phantombot/.env         → <default persona>/.env
 *   ~/.local/share/phantombot/state.json    → <default persona>/state.json
 *   ~/.local/share/phantombot/memory.sqlite → <default persona>/memory.sqlite
 *   ~/.local/share/phantombot/memory-index/<p>.sqlite → <p>/memory-index.sqlite
 *   ~/.local/share/phantombot/logs, inbox   → <default persona>/
 *   ~/.local/state/phantombot/*             → <default persona>/run/
 *
 * The DEFAULT persona inherits the shared database, state and logs because
 * there was only ever one of each and it is the persona that was actually
 * using them; the per-persona memory INDEX was already split by filename, so
 * each persona keeps its own. Other personas start with an empty task/turn
 * database — surfaced in the migration report rather than hidden, because it
 * is the one user-visible consequence.
 *
 * Nothing is deleted. The old directories are RENAMED to
 * `<name>.pre-435-<timestamp>`, so a bad migration is undone by renaming them
 * back.
 *
 * ── The rollback boundary (#436) ──
 * "Leaves the old layout in place" has to be TRUE, not aspirational. The moves
 * are sequential renames of `.env`, `state.json`, `memory.sqlite`, logs and
 * run-state; a failure partway through used to leave the secrets and the
 * database already moved while the caller logged a warning and carried on
 * booting against a half-migrated box. So every mutation is recorded in an
 * UNDO JOURNAL as it succeeds, and any throw rolls the whole migration back in
 * reverse order before rethrowing. The outcome is all-or-nothing: either the
 * box is on the new layout, or it is exactly where it started.
 *
 * Rollback is itself best-effort — if undoing a rename ALSO fails we cannot do
 * better than say so loudly, so each failed undo is logged with both paths and
 * collected into the thrown error, which is the one case a human has to look at.
 */

import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import { log } from "./logger.ts";
import {
  dataHome,
  globalConfigPath,
  personasRoot,
  personaRoot,
  personaRunDir,
  setGlobalConfigValue,
} from "./personaPaths.ts";

/** Top-level keys that stay global and must NOT be copied into a persona. */
const GLOBAL_ONLY_KEYS = [
  "default_persona",
  "update_channel",
  "personas_dir",
  "memory_db",
];

export interface MigrationReport {
  /** True when anything at all was moved. */
  migrated: boolean;
  /** Personas that received a copy of the old host config. */
  personas: string[];
  /** Directories renamed out of the way, in the order they were renamed. */
  archived: string[];
  /** Human-readable notes worth surfacing (e.g. "lena starts with an empty DB"). */
  notes: string[];
}

function legacyConfigDir(): string {
  if (process.env.XDG_CONFIG_HOME) return join(process.env.XDG_CONFIG_HOME, "phantombot");
  return join(homedir(), ".config", "phantombot");
}

function legacyDataDir(): string {
  return join(dataHome(), "phantombot");
}

function legacyStateDir(): string {
  if (process.env.XDG_STATE_HOME) return join(process.env.XDG_STATE_HOME, "phantombot");
  return join(homedir(), ".local", "state", "phantombot");
}

/**
 * Strip the global-only keys from a host config.toml.
 *
 * Line-based on purpose: parsing and re-emitting TOML would drop every comment
 * the owner wrote. The keys we remove are all top-level scalars, so a
 * line-anchored match is exact — and we stop at the first `[section]` header so
 * a key of the same name nested inside a table is never touched.
 */
export function stripGlobalKeys(toml: string): string {
  const out: string[] = [];
  let inSection = false;
  for (const line of toml.split("\n")) {
    if (/^\s*\[/.test(line)) inSection = true;
    if (!inSection) {
      const m = /^\s*([A-Za-z0-9_]+)\s*=/.exec(line);
      if (m && GLOBAL_ONLY_KEYS.includes(m[1]!)) continue;
    }
    out.push(line);
  }
  return out.join("\n");
}

/** Read a top-level scalar string out of a host config.toml, comments intact. */
function readTopLevelString(toml: string, key: string): string | undefined {
  let inSection = false;
  for (const line of toml.split("\n")) {
    if (/^\s*\[/.test(line)) inSection = true;
    if (inSection) continue;
    const m = new RegExp(`^\\s*${key}\\s*=\\s*["']([^"']*)["']`).exec(line);
    if (m) return m[1];
  }
  return undefined;
}

/** Rename a path out of the way. Returns the new name, or undefined if absent. */
function archive(path: string, stamp: string, journal?: MigrationJournal): string | undefined {
  if (!existsSync(path)) return undefined;
  const dest = `${path}.pre-435-${stamp}`;
  renameSync(path, dest);
  journal?.record(() => {
    if (existsSync(dest) && !existsSync(path)) renameSync(dest, path);
  });
  return dest;
}

/**
 * Undo journal: every mutation the migration makes, in the order it made them,
 * paired with the inverse operation. `rollback()` replays the inverses in
 * REVERSE order, which matters — a directory has to be put back before the
 * file that was moved out of it.
 */
export interface MigrationJournal {
  record: (undo: () => void) => void;
  rollback: () => string[];
  size: () => number;
}

export function createJournal(): MigrationJournal {
  const undos: Array<() => void> = [];
  return {
    record: (undo) => {
      undos.push(undo);
    },
    size: () => undos.length,
    rollback: () => {
      const failures: string[] = [];
      for (let i = undos.length - 1; i >= 0; i--) {
        try {
          undos[i]!();
        } catch (e) {
          failures.push((e as Error).message);
        }
      }
      undos.length = 0;
      return failures;
    },
  };
}

/**
 * Move a file or directory if the source exists and the destination does not.
 * Records the inverse rename so a later failure can put it back.
 */
function moveIfAbsent(from: string, to: string, journal?: MigrationJournal): boolean {
  if (!existsSync(from) || existsSync(to)) return false;
  mkdirSync(join(to, ".."), { recursive: true });
  renameSync(from, to);
  journal?.record(() => {
    if (existsSync(to) && !existsSync(from)) renameSync(to, from);
  });
  return true;
}

/** Persona directories present under the personas root. */
function listPersonas(root: string): string[] {
  try {
    return readdirSync(root)
      .filter((name) => {
        if (name.startsWith(".")) return false;
        try {
          return statSync(join(root, name)).isDirectory();
        } catch {
          return false;
        }
      })
      .sort();
  } catch {
    return [];
  }
}

/**
 * True when there is anything left to migrate. Cheap enough to call on every
 * startup: three `existsSync` calls.
 */
export function needsMigration(): boolean {
  return (
    existsSync(join(legacyConfigDir(), "config.toml")) ||
    existsSync(join(legacyConfigDir(), ".env")) ||
    existsSync(join(legacyDataDir(), "state.json")) ||
    existsSync(join(legacyDataDir(), "memory.sqlite")) ||
    existsSync(join(legacyDataDir(), "memory-index")) ||
    existsSync(legacyStateDir())
  );
}

function runMigration(journal: MigrationJournal): MigrationReport {
  const report: MigrationReport = {
    migrated: false,
    personas: [],
    archived: [],
    notes: [],
  };
  if (!needsMigration()) return report;

  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const oldConfigPath = join(legacyConfigDir(), "config.toml");
  const hostToml = existsSync(oldConfigPath) ? readFileSync(oldConfigPath, "utf8") : "";

  // A custom `personas_dir` in the OLD host config is a BOOTSTRAP input, not a
  // key to throw away: strip it from the per-persona copies (it is global), but
  // read it first, or a box with a non-default root migrates nothing — we would
  // look for personas under the default root, find none, and report success on
  // an empty box. PHANTOMBOT_PERSONAS_DIR still wins when it is already set.
  const legacyRoot = readTopLevelString(hostToml, "personas_dir");
  if (legacyRoot && !process.env.PHANTOMBOT_PERSONAS_DIR) {
    process.env.PHANTOMBOT_PERSONAS_DIR = legacyRoot;
    journal.record(() => {
      delete process.env.PHANTOMBOT_PERSONAS_DIR;
    });
    report.notes.push(
      `personas root taken from the old config's personas_dir (${legacyRoot}) — set PHANTOMBOT_PERSONAS_DIR in the environment (the service unit bakes it) or phantombot will look under ${join(dataHome(), "phantombot", "personas")} next boot`,
    );
  }
  const root = personasRoot();
  const personas = listPersonas(root);

  // 1. Global file first, so `activePersona()` resolves correctly for every
  //    path computed below. The old default came from state.json (which wins)
  //    and then the host config.
  let defaultPersona: string | undefined;
  try {
    const oldState = JSON.parse(readFileSync(join(legacyDataDir(), "state.json"), "utf8")) as {
      default_persona?: string;
    };
    defaultPersona = oldState.default_persona;
  } catch {
    /* no old state file, or unreadable — fall through to the config */
  }
  defaultPersona ??= readTopLevelString(hostToml, "default_persona");
  const updateChannel = readTopLevelString(hostToml, "update_channel");
  if (defaultPersona || updateChannel) {
    // One restore point for the whole global file: capture it (or its absence)
    // before the first write, so rollback puts back exactly what was there.
    const gpath = globalConfigPath();
    const before = existsSync(gpath) ? readFileSync(gpath, "utf8") : undefined;
    journal.record(() => {
      if (before === undefined) rmSync(gpath, { force: true });
      else writeFileSync(gpath, before, "utf8");
    });
    if (defaultPersona) setGlobalConfigValue("default_persona", defaultPersona);
    if (updateChannel) setGlobalConfigValue("update_channel", updateChannel);
  }

  // 2. The host config, verbatim-minus-global-keys, into every persona that
  //    does not already have one of its own.
  if (hostToml) {
    const body = stripGlobalKeys(hostToml);
    const header =
      "# Migrated from ~/.config/phantombot/config.toml by phantombot #435.\n" +
      "# Config is per persona now: this file configures ONLY this persona, so\n" +
      "# several personas can run side by side in one user account. It is a\n" +
      "# verbatim copy of the old host file, so behaviour is unchanged — any\n" +
      "# settings here that belong to another persona are safe to delete.\n" +
      "# `default_persona` and `update_channel` moved to " +
      globalConfigPath() +
      "\n\n";
    for (const persona of personas) {
      const dest = join(personaRoot(persona), "config.toml");
      if (existsSync(dest)) continue;
      mkdirSync(personaRoot(persona), { recursive: true });
      writeFileSync(dest, header + body, "utf8");
      journal.record(() => rmSync(dest, { force: true }));
      report.personas.push(persona);
      report.migrated = true;
    }
  }

  const target = defaultPersona && personas.includes(defaultPersona)
    ? defaultPersona
    : personas[0];

  if (target) {
    // 3. Secrets, state, database and logs — all singletons, so they go to the
    //    persona that was actually using them.
    const moves: Array<[string, string]> = [
      [join(legacyConfigDir(), ".env"), join(personaRoot(target), ".env")],
      [join(legacyDataDir(), "state.json"), join(personaRoot(target), "state.json")],
      [join(legacyDataDir(), "memory.sqlite"), join(personaRoot(target), "memory.sqlite")],
      [join(legacyDataDir(), "logs"), join(personaRoot(target), "logs")],
      [join(legacyDataDir(), "inbox"), join(personaRunDir(target), "inbox")],
    ];
    for (const [from, to] of moves) {
      if (moveIfAbsent(from, to, journal)) report.migrated = true;
    }
    // SQLite side files travel with their database or the next open sees a
    // truncated WAL and loses the tail of the journal.
    for (const suffix of ["-wal", "-shm"]) {
      moveIfAbsent(
        join(legacyDataDir(), `memory.sqlite${suffix}`),
        join(personaRoot(target), `memory.sqlite${suffix}`),
        journal,
      );
    }
    for (const other of personas) {
      if (other === target) continue;
      report.notes.push(
        `${other} starts with an empty task/turn database — the shared one went to ${target}, which was using it`,
      );
    }

    // 4. Runtime state: locks, last-fired markers, turn registry, digests.
    const oldState = legacyStateDir();
    if (existsSync(oldState)) {
      mkdirSync(personaRunDir(target), { recursive: true });
      for (const entry of readdirSync(oldState)) {
        moveIfAbsent(join(oldState, entry), join(personaRunDir(target), entry), journal);
      }
      report.migrated = true;
    }
  } else {
    report.notes.push(
      "no persona directories found — host settings were left in place for a later run",
    );
  }

  // 5. The per-persona memory index was already split by filename.
  const oldIndexDir = join(legacyDataDir(), "memory-index");
  if (existsSync(oldIndexDir)) {
    for (const file of readdirSync(oldIndexDir)) {
      const m = /^(.+)\.sqlite(-wal|-shm)?$/.exec(file);
      if (!m) continue;
      const persona = m[1]!;
      if (!existsSync(personaRoot(persona))) continue;
      moveIfAbsent(
        join(oldIndexDir, file),
        join(personaRoot(persona), `memory-index.sqlite${m[2] ?? ""}`),
        journal,
      );
    }
    report.migrated = true;
  }

  // 6. Archive whatever is left. Renamed, never deleted — undo is a rename back.
  if (report.migrated) {
    for (const dir of [legacyConfigDir(), legacyStateDir(), oldIndexDir]) {
      try {
        const dest = archive(dir, stamp, journal);
        if (dest) report.archived.push(dest);
      } catch (e) {
        log.warn("host-layout migration: could not archive a legacy directory", {
          dir,
          error: (e as Error).message,
        });
      }
    }
  }

  return report;
}

/**
 * Run the migration as ONE transaction. Any throw rolls back every mutation
 * made so far — config copies, the global file, and every rename — and then
 * rethrows, so the caller's "leave the old layout in place" promise is real.
 */
export function migrateHostLayout(): MigrationReport {
  const journal = createJournal();
  try {
    return runMigration(journal);
  } catch (e) {
    const failures = journal.rollback();
    if (failures.length > 0) {
      log.error("host-layout migration rollback INCOMPLETE — inspect by hand", {
        error: (e as Error).message,
        rollbackFailures: failures,
      });
      throw new Error(
        `host-layout migration failed (${(e as Error).message}) and rollback did not fully complete: ` +
          failures.join("; "),
      );
    }
    log.warn("host-layout migration rolled back; the box is on the old layout", {
      error: (e as Error).message,
    });
    throw e;
  }
}

/**
 * Startup wrapper: migrate, log what happened, and never throw. A migration
 * failure must leave the box on the OLD layout and still boot, not wedge the
 * CLI — which is why every filesystem step above is guarded and nothing is
 * deleted.
 */
export function migrateHostLayoutAtStartup(): MigrationReport | undefined {
  try {
    if (!needsMigration()) return undefined;
    const report = migrateHostLayout();
    if (report.migrated) {
      log.info("migrated to the per-persona layout (#435)", {
        personas: report.personas,
        archived: report.archived,
      });
      for (const note of report.notes) log.warn(`migration: ${note}`);
    }
    return report;
  } catch (e) {
    log.warn("host-layout migration failed; leaving the old layout in place", {
      error: (e as Error).message,
    });
    return undefined;
  }
}
