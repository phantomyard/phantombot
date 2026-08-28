/**
 * Read-only state for the TUI's screens.
 *
 * The whole point of the dashboard is that **state is rendered, not
 * remembered** — so this module's job is to turn what is actually on disk into
 * plain data, and to do it without changing anything. Nothing here writes; the
 * side-effecting half lives in `actions.ts`.
 *
 * Two rules it follows throughout:
 *
 *   - **Reuse the readers the CLI uses.** Persona listing, config layering,
 *     harness resolution and vault access all come from the same functions
 *     `phantombot persona`, `doctor` and `vault` call. Where a number has no
 *     existing reader (row counts), it is read with a direct read-only SQL
 *     query rather than a reimplemented parser.
 *   - **Every field is optional and every read is individually guarded.** A
 *     dashboard that throws because one persona has a half-written config is
 *     worse than a dashboard with one blank cell — the user opened it precisely
 *     because something is wrong.
 */

import { Database } from "bun:sqlite";
import { existsSync, statSync, readdirSync } from "node:fs";
import { join } from "node:path";

import {
  type Config,
  loadConfig,
  loadConfigForPersona,
  memoryIndexPath,
  personaDir,
} from "../config.ts";
import { VERSION } from "../version.ts";
import { listPersonaDirs } from "../lib/personaDefault.ts";
import {
  personaCompleteness,
  type PersonaCompleteness,
} from "../lib/personaComplete.ts";
import { resolveHarnessAvailability } from "../lib/harnessAvailability.ts";
import { openPersonaVault } from "../lib/vault.ts";
import { embeddingSpaceForConfig } from "../lib/embeddingSpace.ts";
import { log } from "../lib/logger.ts";

/** Run a read that must never take a screen down. */
function safe<T>(what: string, fn: () => T): T | undefined {
  try {
    return fn();
  } catch (e) {
    log.debug?.("tui: snapshot read failed", {
      what,
      error: (e as Error).message,
    });
    return undefined;
  }
}

/** Open a SQLite file read-only, or undefined if it is not there / not readable. */
function openReadonly(path: string): Database | undefined {
  if (!path || !existsSync(path)) return undefined;
  return safe(`open ${path}`, () => new Database(path, { readonly: true }));
}

function count(
  db: Database | undefined,
  sql: string,
  ...params: unknown[]
): number | undefined {
  if (!db) return undefined;
  return safe(sql, () => {
    const row = db.query(sql).get(...(params as never[])) as
      | { n?: number }
      | null;
    return typeof row?.n === "number" ? row.n : undefined;
  });
}

function bytesOf(path: string): number | undefined {
  return safe(`stat ${path}`, () =>
    existsSync(path) ? statSync(path).size : undefined,
  );
}

export interface MemorySnapshot {
  dbPath: string;
  dbBytes?: number;
  journalRows?: number;
  oldestJournalDay?: string;
  drawerCounts?: Partial<Record<string, number>>;
  kbNotes?: number;
  kbLinks?: number;
  /** Embedding space in force, or undefined when embeddings are off. */
  embedding?: {
    provider: string;
    model: string;
    dimensions: number;
    /** Space fingerprint — what makes old vectors visible or invisible. */
    fingerprint: string;
  };
  /** Chunks carrying a vector in the CURRENT space vs total indexed chunks. */
  indexedInSpace?: number;
  indexedTotal?: number;
}

export interface PersonaSnapshot {
  name: string;
  dir: string;
  isDefault: boolean;
  autostart: boolean;
  /** Harness chain as configured, and the first one whose binary resolves. */
  chain: string[];
  resolvedHarness?: { id: string; path: string };
  channels: string[];
  voiceProvider?: string;
  /** Secret NAMES only. Values are never read into the TUI. */
  secretNames?: string[];
  memory: MemorySnapshot;
  completeness: PersonaCompleteness;
}

export interface HostSnapshot {
  version: string;
  updateChannel: string;
  defaultPersona: string;
  personasDir: string;
  personas: PersonaSnapshot[];
}

/**
 * Which channels does this persona actually have configured?
 *
 * `telegramStated` is deliberately consulted alongside a resolved account: it
 * is what keeps "Telegram is configured but its token is missing" — which the
 * keys screen must warn about — distinguishable from "this phantom is
 * deliberately not on Telegram".
 *
 * phantomchat settings are PER-PERSONA (`<persona-dir>/phantomchat.json`),
 * not in config.toml, so its presence is read from disk rather than config.
 */
function channelsFor(config: Config, dir: string): string[] {
  const out: string[] = [];
  if (config.channels?.telegram || config.channels?.telegramStated) {
    out.push("telegram");
  }
  if (existsSync(join(dir, "phantomchat.json"))) out.push("chat");
  // Not a lesser answer: a phantom with no channel is a LOCAL phantom, and it
  // is exactly the one screen 0 opens on.
  if (out.length === 0) out.push("cli only");
  return out;
}

function readMemory(config: Config, persona: string): MemorySnapshot {
  const snapshot: MemorySnapshot = {
    dbPath: config.memoryDbPath,
    dbBytes: bytesOf(config.memoryDbPath),
  };

  const db = openReadonly(config.memoryDbPath);
  if (db) {
    // Bound parameters throughout: a persona name is a directory name, but it
    // is still user-supplied text and this is the only place the TUI writes SQL.
    snapshot.journalRows = count(
      db,
      "SELECT COUNT(*) AS n FROM journal_entries WHERE persona = ?",
      persona,
    );
    snapshot.oldestJournalDay = safe("oldest journal day", () => {
      const row = db
        .query("SELECT MIN(day) AS d FROM journal_entries WHERE persona = ?")
        .get(persona) as { d?: string } | null;
      return row?.d ?? undefined;
    });
    snapshot.drawerCounts = safe("drawer counts", () => {
      const rows = db
        .query(
          "SELECT kind, COUNT(*) AS n FROM drawer_entries WHERE persona = ? GROUP BY kind",
        )
        .all(persona) as Array<{ kind: string; n: number }>;
      return Object.fromEntries(rows.map((r) => [r.kind, r.n]));
    });
    safe("close memory db", () => db.close());
  }

  // The search index is a SEPARATE database, per persona.
  const indexDb = openReadonly(memoryIndexPath(persona));
  if (indexDb) {
    snapshot.kbNotes = count(
      indexDb,
      "SELECT COUNT(*) AS n FROM files WHERE path LIKE 'kb/%'",
    );
    snapshot.kbLinks = count(indexDb, "SELECT COUNT(*) AS n FROM note_links");
    snapshot.indexedTotal = count(
      indexDb,
      "SELECT COUNT(*) AS n FROM leaves",
    );
    snapshot.indexedInSpace = count(
      indexDb,
      "SELECT COUNT(*) AS n FROM note_embeddings",
    );
    safe("close index db", () => indexDb.close());
  }

  const space = safe("embedding space", () => embeddingSpaceForConfig(config));
  if (space) {
    snapshot.embedding = {
      provider: space.provider,
      model: space.model,
      dimensions: space.dimensions,
      fingerprint: space.fingerprint,
    };
  }

  return snapshot;
}

/**
 * Snapshot one persona. `config` must be that persona's EFFECTIVE config
 * (`loadConfigForPersona`), never the default layer — see the persona
 * invariant in AGENTS.md.
 */
export async function personaSnapshot(
  config: Config,
  host: Config,
  name: string,
): Promise<PersonaSnapshot> {
  const dir = personaDir(config, name);
  const chain = config.harnesses?.chain ?? [];

  let resolvedHarness: PersonaSnapshot["resolvedHarness"];
  for (const id of chain) {
    const availability = await safeAsync(() =>
      resolveHarnessAvailability(config, id),
    );
    if (availability?.resolved) {
      resolvedHarness = { id, path: availability.resolved };
      break;
    }
  }

  // Secret NAMES only — the vault is opened, listed, and closed. No screen in
  // this app ever holds a secret VALUE, so there is nothing to leak into a
  // render, a scrollback buffer or a crash dump.
  const secretNames = await safeAsync(async () => {
    const vault = await openPersonaVault(dir);
    try {
      return vault.list();
    } finally {
      vault.close();
    }
  });

  return {
    name,
    dir,
    isDefault: host.defaultPersona === name,
    autostart: (host.autostartPersonas ?? []).includes(name),
    chain,
    resolvedHarness,
    channels: channelsFor(config, dir),
    voiceProvider: config.voice?.provider,
    secretNames,
    memory: readMemory(config, name),
    completeness: await personaCompleteness(config, name),
  };
}

async function safeAsync<T>(fn: () => Promise<T> | T): Promise<T | undefined> {
  try {
    return await fn();
  } catch {
    return undefined;
  }
}

/**
 * Snapshot the whole host: every persona on disk, each judged on its OWN
 * config layer.
 */
export async function hostSnapshot(): Promise<HostSnapshot> {
  const host = await loadConfig();
  const names = listPersonaDirs(host);
  const personas: PersonaSnapshot[] = [];
  for (const name of names) {
    const { config } = await loadConfigForPersona(name);
    personas.push(await personaSnapshot(config, host, name));
  }
  return {
    version: VERSION,
    updateChannel: host.updateChannel ?? "stable",
    defaultPersona: host.defaultPersona,
    personasDir: host.personasDir,
    personas,
  };
}

/** KB note count straight off the filesystem, for a persona with no index yet. */
export function countKbFiles(dir: string): number | undefined {
  return safe("count kb files", () => {
    const kb = join(dir, "kb");
    if (!existsSync(kb)) return undefined;
    let n = 0;
    const walk = (path: string) => {
      for (const entry of readdirSync(path, { withFileTypes: true })) {
        if (entry.isDirectory()) walk(join(path, entry.name));
        else if (entry.name.endsWith(".md")) n++;
      }
    };
    walk(kb);
    return n;
  });
}
