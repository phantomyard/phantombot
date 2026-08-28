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
import { existsSync, readFileSync, statSync, readdirSync } from "node:fs";
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
import { providerHearsVoice } from "../lib/voice.ts";
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

/**
 * The three prompt files a persona is BUILT from, as paths plus presence.
 *
 * These are shown first on the settings screen because they are the only
 * settings whose value is prose: everything else on that screen is a value you
 * pick, these are values you write. `↵` opens the file in `$EDITOR` rather than
 * trying to edit multi-kilobyte markdown inside a list row.
 */
export interface IdentityFile {
  name: string;
  path: string;
  present: boolean;
}

export interface IdentitySnapshot {
  files: IdentityFile[];
  /** One-line self-description, lifted from IDENTITY.md's first prose line. */
  description?: string;
}

/**
 * A channel as a STATE, not a name.
 *
 * "telegram" in a list tells you a channel was configured. It does not tell you
 * the token resolved, which is exactly the failure a settings screen exists to
 * surface — `telegramStated` without an account is a phantom that looks
 * connected in every listing and answers nobody.
 */
export interface ChannelDetail {
  id: string;
  label: string;
  state: "connected" | "broken" | "off";
  /** The line under the label: who may talk to it, or why it is not up. */
  detail: string;
}

export interface NightlySnapshot {
  status: string;
  detail: string;
  lastRun?: string;
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
  /** The configured voice NAME for that provider ("en-US-JennyNeural"). */
  voiceName?: string;
  /** Whether the configured provider can transcribe, not just speak. */
  voiceHears?: boolean;
  identity: IdentitySnapshot;
  channelDetails: ChannelDetail[];
  nightly?: NightlySnapshot;
  /** Secret NAMES only. Values are never read into the TUI. */
  secretNames?: string[];
  memory: MemorySnapshot;
  completeness: PersonaCompleteness;
}

export interface HostSnapshot {
  version: string;
  /**
   * Is the phantombot SERVICE up? Deliberately not inferred from this process:
   * the TUI runs in your shell, the daemon is what answers Telegram, and a
   * dashboard that reports its own liveness as the host's would be a lie you
   * only catch when a message goes unanswered.
   */
  serviceActive?: boolean;
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

/** The prompt files, in the order the settings screen lists them. */
const IDENTITY_FILES = ["SOUL.md", "IDENTITY.md", "USER.md"];

function readIdentity(dir: string): IdentitySnapshot {
  const files = IDENTITY_FILES.map((name) => {
    const path = join(dir, name);
    return { name, path, present: existsSync(path) };
  });
  const identityPath = join(dir, "IDENTITY.md");
  const description = safe("read IDENTITY.md", () => {
    if (!existsSync(identityPath)) return undefined;
    // First non-blank, non-heading line: headings are the persona's name, the
    // line after them is what it says it is FOR.
    for (const line of readFileSync(identityPath, "utf-8").split("\n")) {
      const text = line.trim();
      if (!text || text.startsWith("#") || text.startsWith(">")) continue;
      return text.length > 120 ? `${text.slice(0, 119)}…` : text;
    }
    return undefined;
  });
  return { files, ...(description ? { description } : {}) };
}

/**
 * Channels as states. Mirrors `channelsFor` but keeps the reason a channel is
 * down — see `ChannelDetail`.
 */
function channelDetailsFor(config: Config, dir: string): ChannelDetail[] {
  const out: ChannelDetail[] = [];
  const telegram = config.channels?.telegram;
  if (telegram) {
    const allowed = telegram.allowedUserIds ?? [];
    out.push({
      id: "telegram",
      label: "Telegram",
      state: "connected",
      detail:
        allowed.length > 0
          ? `allowed  ${allowed.join(", ")}`
          : "open to anyone who finds the bot",
    });
  } else if (config.channels?.telegramStated) {
    out.push({
      id: "telegram",
      label: "Telegram",
      state: "broken",
      detail: "configured but no token resolved — it will answer nobody",
    });
  } else {
    out.push({
      id: "telegram",
      label: "Telegram",
      state: "off",
      detail: "not configured",
    });
  }
  out.push(
    existsSync(join(dir, "phantomchat.json"))
      ? {
          id: "chat",
          label: "phantomchat",
          state: "connected",
          detail: "nostr DMs · phantomchat.json",
        }
      : {
          id: "chat",
          label: "phantomchat",
          state: "off",
          detail: "not configured",
        },
  );
  return out;
}

/** The configured voice name for whichever provider is selected. */
function voiceNameOf(config: Config): string | undefined {
  const voice = config.voice;
  if (!voice) return undefined;
  if (voice.provider === "azure_edge") return voice.azure_edge?.voice;
  if (voice.provider === "openai") return voice.openai?.voice;
  if (voice.provider === "elevenlabs") return voice.elevenlabs?.voiceId;
  return undefined;
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

  // The nightly is the one piece of persona health that is invisible until it
  // has been broken for days — a backlog does not announce itself.
  // Imported on demand: the nightly module pulls the whole memory stack in
  // behind it, and this file is on the app's startup path.
  const health = await safeAsync(async () => {
    const { nightlyHealth } = await import("../lib/nightly.ts");
    return nightlyHealth(dir);
  });
  const nightly: NightlySnapshot | undefined = health
    ? {
        status: health.status,
        detail: health.detail,
        ...(health.last_run ? { lastRun: health.last_run } : {}),
      }
    : undefined;

  return {
    name,
    dir,
    isDefault: host.defaultPersona === name,
    autostart: (host.autostartPersonas ?? []).includes(name),
    chain,
    resolvedHarness,
    channels: channelsFor(config, dir),
    voiceProvider: config.voice?.provider,
    voiceName: voiceNameOf(config),
    voiceHears: config.voice
      ? providerHearsVoice(config.voice.provider)
      : false,
    identity: readIdentity(dir),
    channelDetails: channelDetailsFor(config, dir),
    ...(nightly ? { nightly } : {}),
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

/**
 * Is the phantombot service up?
 *
 * Deliberately NOT part of `hostSnapshot`: this shells out to systemctl (or
 * launchctl, or schtasks), and every snapshot is on a path a screen is waiting
 * for — folding a subprocess into it made finishing the wizard wait on
 * systemd before the chat box appeared, which a regression test caught as the
 * app being unquittable in that window. Screens render from disk state
 * immediately; this fills its badge in when it arrives.
 */
export async function probeServiceActive(): Promise<boolean | undefined> {
  return safeAsync(async () => {
    const { defaultServiceControl } = await import("../lib/platform.ts");
    return defaultServiceControl().isActive();
  });
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
