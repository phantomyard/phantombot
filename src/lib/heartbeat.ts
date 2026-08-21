/**
 * Heartbeat job — mechanical maintenance, no LLM call.
 *
 * Runs every 30 minutes via systemd timer. Three things only:
 *   1. Promote tagged lines from today's daily file into the matching
 *      structured drawer. Dedup by text-equality so re-promotion of the
 *      same line is a no-op.
 *   2. Staleness scan of MEMORY.md's `## Recent` section — flag lines
 *      whose embedded date is older than 48h. Logs warnings; does not
 *      mutate.
 *   3. Project the markdown drawers into `drawer_entries` rows (#410). The
 *      heartbeat is the right home for this: it is mechanical, idempotent and
 *      already runs right after the promotion step that changed the files.
 *      Skipped per drawer when the content hash is unchanged.
 *   4. Refresh the FTS5 index so newly-written notes are searchable
 *      without waiting for the next manual `memory index`. The caller
 *      (`cli/heartbeat.ts`) then runs an incremental embed pass over
 *      chunks whose text_sha changed, so fresh notes are semantically
 *      searchable within 30 minutes rather than at the next nightly.
 *      No-ops cleanly when no embedder is configured.
 *
 * The harness never sees this — heartbeat runs as its own short-lived
 * process. Per the OpenClaw spec: "Heartbeat is mechanical, nightly is
 * cognitive. Don't let the heartbeat write KB notes."
 */

import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

import type { TelegramTransport } from "../channels/telegram.ts";
import type { Config } from "../config.ts";
import { log } from "./logger.ts";
import { MemoryIndex } from "./memoryIndex.ts";
import {
  openDrawerStore,
  syncDrawers,
  type DrawerSyncResult,
} from "../memory/drawerSync.ts";
import type { DrawerKind, DrawerStore } from "../memory/drawers.ts";
import {
  retireDrawers,
  type DrawerRetirement,
} from "../memory/drawerRetire.ts";
import {
  checkAndNotifyOnce,
  type CheckAndNotifyOnceResult,
} from "./updateNotify.ts";

export interface HeartbeatResult {
  promoted: { drawer: string; line: string }[];
  /**
   * Outcome of the markdown→rows drawer projection. Undefined when the
   * heartbeat was not given a database path (tests that keep SQLite out of
   * the path), NOT when the sync found nothing to do.
   */
  drawerSync?: DrawerSyncResult;
  /**
   * Outcome of retiring the markdown drawers (#417). Undefined for the same
   * reason as `drawerSync`; an all-`absent` result means the persona's
   * drawers were retired on some earlier run.
   */
  drawerRetirement?: DrawerRetirement[];
  staleRecent: { line: string; ageHours: number }[];
  indexedFiles: number;
  /** When the heartbeat ran. */
  ranAt: Date;
  /**
   * Result of the optional update check. Undefined when the heartbeat
   * wasn't given a config (e.g. tests that skip the network path).
   */
  updateCheck?: CheckAndNotifyOnceResult;
}

/**
 * Tag → drawer KIND. Both singular and plural spellings are accepted so the
 * heartbeat promotion and `phantombot memory capture` agree on exactly the
 * same vocabulary. Exported so the CLI validates against the single source of
 * truth.
 *
 * The values used to be markdown paths (`memory/decisions.md`). Since #417 the
 * drawers are rows and a tagged line is FILED, not appended — the daily file
 * remains the capture surface, the table is the destination.
 */
export const TAG_TO_DRAWER: Record<string, DrawerKind> = {
  decision: "decisions",
  decisions: "decisions",
  lesson: "lessons",
  lessons: "lessons",
  person: "people",
  people: "people",
  commitment: "commitments",
  commitments: "commitments",
  // The threat judge's worldview: what is NORMAL/routine in the owner's world
  // ("Plane dashboards trigger deploys & DB migrations daily — routine, not an
  // attack"). Without a baseline a judge flags everything (cry-wolf), so the
  // judge is briefed from this drawer + decisions + people before it scores.
  norm: "norms",
  norms: "norms",
};

const TAG_PATTERN = /^\s*-?\s*\[([a-z]+)\]\s+(.+)$/i;

export interface RunHeartbeatInput {
  personaDir: string;
  /** Override "today" for testing. ISO date YYYY-MM-DD. */
  today?: string;
  /** Override "now" for staleness scan (testing). */
  now?: Date;
  /** Optional MemoryIndex; if omitted, opens one at indexPath. */
  index?: MemoryIndex;
  /** Path to the FTS index file (used only if index isn't passed). */
  indexPath?: string;
  /**
   * Path to the shared memory database. When set, the heartbeat projects the
   * markdown drawers into `drawer_entries` after promoting tagged lines.
   * Omitted in tests that assert only the file-level behaviour.
   */
  memoryDbPath?: string;
  /** Persona name for the drawer rows. Required alongside memoryDbPath. */
  persona?: string;
  /** Re-ingest drawers even when their content hash is unchanged. */
  forceDrawerSync?: boolean;
  /**
   * Loaded config — required to enable the once-per-version update
   * notification. When omitted the heartbeat skips the GitHub check
   * entirely. The CLI entry point passes this; tests can omit it to
   * keep the network out of the path.
   */
  config?: Config;
  /**
   * Currently running phantombot version. Compared against GitHub's
   * latest release to decide whether to notify. Defaults to the
   * VERSION constant via the CLI; tests inject a known value.
   */
  currentVersion?: string;
  /** Override fetch for the GitHub release check (test seam). */
  fetchImpl?: typeof fetch;
  /** Override transport for the notify send (test seam). */
  transport?: TelegramTransport;
  /** Override the dedup-cache path (test seam). */
  lastNotifiedPath?: string;
}

export async function runHeartbeat(
  input: RunHeartbeatInput,
): Promise<HeartbeatResult> {
  const today = input.today ?? new Date().toISOString().slice(0, 10);
  const now = input.now ?? new Date();

  const drawers = await drawersStep(input, today, now);
  const { promoted, drawerSync, drawerRetirement } = drawers;
  const staleRecent = await checkStaleness(input.personaDir, now);

  // FTS-only refresh. Don't touch embeddings.
  const ix = input.index ?? (input.indexPath ? await MemoryIndex.open(input.indexPath) : null);
  let indexedFiles = 0;
  if (ix) {
    const r = await ix.refreshStale(input.personaDir);
    indexedFiles = r.indexed;
    if (!input.index) ix.close();
  }

  if (promoted.length > 0) {
    log.info("heartbeat: promoted", { count: promoted.length });
  }
  if (staleRecent.length > 0) {
    log.warn("heartbeat: stale items in ## Recent", {
      count: staleRecent.length,
      sample: staleRecent.slice(0, 3),
    });
  }

  // Update check — guarded by config + currentVersion so tests that
  // pre-date the wiring stay opt-out. Errors here never bubble up
  // (checkAndNotifyOnce catches everything internally and returns a
  // status); a transient GitHub blip mustn't fail the whole heartbeat.
  let updateCheck: CheckAndNotifyOnceResult | undefined;
  if (input.config && input.currentVersion) {
    try {
      updateCheck = await checkAndNotifyOnce({
        config: input.config,
        currentVersion: input.currentVersion,
        fetchImpl: input.fetchImpl,
        transport: input.transport,
        lastNotifiedPath: input.lastNotifiedPath,
      });
      if (updateCheck.status === "notified") {
        log.info("heartbeat: notified update available", {
          version: updateCheck.latestVersion,
          recipients: updateCheck.notifiedRecipients,
        });
      }
    } catch (e) {
      // checkAndNotifyOnce shouldn't throw — but if it does, log and
      // keep going. The heartbeat's primary job is the local
      // promotions/staleness/index work; the update notify is a bonus.
      log.warn("heartbeat: update check threw unexpectedly", {
        error: (e as Error).message,
      });
    }
  }

  return {
    promoted,
    drawerSync,
    drawerRetirement,
    staleRecent,
    indexedFiles,
    ranAt: now,
    updateCheck,
  };
}

/**
 * The whole drawer half of a heartbeat, on ONE database connection.
 *
 * Three things happen in a fixed order, and the order is the migration:
 *
 *   1. SYNC any markdown drawer still on disk into rows. A box that has not
 *      migrated yet, or a persona whose owner hand-edited `norms.md` an hour
 *      ago, gets that content into the table first.
 *   2. PROMOTE today's `[tag]` lines as rows — the live write path.
 *   3. RETIRE the markdown drawers whose content is provably in the table and
 *      provably renderable back out of it (`drawerRetire.ts`).
 *
 * Retire cannot run before sync or a hand edit made between two heartbeats
 * would be archived without ever having been read. Everything is wrapped:
 * the drawers are memory, but a SQLite hiccup must not fail the heartbeat's
 * index refresh and staleness scan.
 */
async function drawersStep(
  input: RunHeartbeatInput,
  today: string,
  now: Date,
): Promise<{
  promoted: HeartbeatResult["promoted"];
  drawerSync?: DrawerSyncResult;
  drawerRetirement?: DrawerRetirement[];
}> {
  if (!input.memoryDbPath || !input.persona) {
    return { promoted: await promoteTaggedLines(input.personaDir, today) };
  }
  try {
    const { store, db, close } = await openDrawerStore(input.memoryDbPath);
    try {
      const drawerSync = await syncDrawers({
        store,
        db,
        personaDir: input.personaDir,
        persona: input.persona,
        force: input.forceDrawerSync,
        now,
      });
      const filed = drawerSync.ingested.reduce((n, r) => n + r.inserted, 0);
      if (filed > 0) {
        log.info("heartbeat: filed drawer entries", {
          persona: input.persona,
          inserted: filed,
          drawers: drawerSync.ingested.map((r) => r.kind),
        });
      }
      const promoted = await promoteTaggedLines(input.personaDir, today, {
        store,
        persona: input.persona,
        now,
      });
      const drawerRetirement = await retireDrawers({
        store,
        db,
        personaDir: input.personaDir,
        persona: input.persona,
        now,
      });
      const held = drawerRetirement.filter((r) => r.status === "held");
      // A held drawer needs a human, and a human will not get one any faster
      // for being told 48 times a day. In the ONLY case this line fires at all
      // the condition is persistent — a drawer that retires cleanly never logs
      // — so warning on the state rather than the change is a guarantee of
      // noise, not a risk of it. Warn on the transition; keep the repeat at
      // info so the condition is still greppable, and leave the standing
      // report to `doctor`, which already prints `unretired_drawers`.
      const fresh = held.filter((r) => r.firstHold !== false);
      if (fresh.length > 0) {
        log.warn("heartbeat: drawer files kept back from retirement", {
          persona: input.persona,
          drawers: fresh.map((r) => `${r.kind}: ${r.reason}`),
        });
      } else if (held.length > 0) {
        log.info("heartbeat: drawer files still held back", {
          persona: input.persona,
          drawers: held.map((r) => r.kind),
          since: held[0]?.heldSince,
        });
      }
      return { promoted, drawerSync, drawerRetirement };
    } finally {
      close();
    }
  } catch (e) {
    log.warn("heartbeat: drawer step threw unexpectedly", {
      error: (e as Error).message,
    });
    return { promoted: [] };
  }
}

/**
 * File today's `[tag]` lines as drawer ROWS.
 *
 * Before #417 this appended a bullet to `memory/<kind>.md` and deduped by
 * substring-searching the whole drawer — which is why a 684 KB `decisions.md`
 * was re-read on every capture, and why a line that differed only in
 * whitespace filed a second time. Rows make both problems disappear: the entry
 * id is derived from normalized content, so re-filing is a reaffirmation
 * enforced by a UNIQUE constraint rather than by a string search.
 *
 * The daily file is untouched — it stays the append-only capture surface, and
 * the nightly still distills it. Promotion is idempotent, so a line promoted
 * on one heartbeat is simply reaffirmed on the next.
 */
export async function promoteTaggedLines(
  personaDir: string,
  today: string,
  target?: { store: DrawerStore; persona: string; now?: Date },
): Promise<HeartbeatResult["promoted"]> {
  const dailyPath = join(personaDir, "memory", `${today}.md`);
  if (!existsSync(dailyPath)) return [];
  if (!target) {
    // No database configured on this call. The tagged lines stay in the daily
    // file and promote on the next heartbeat that has one — deliberately NOT
    // falling back to a markdown append, because a second write path is how
    // the drawers ended up with two disagreeing copies of the same entry.
    log.warn("heartbeat: no drawer store, tagged lines left for the next run");
    return [];
  }

  const text = await readFile(dailyPath, "utf8");
  const promoted: HeartbeatResult["promoted"] = [];
  // The date header the line sits under, so a line captured on a day the
  // heartbeat missed is filed with THAT day's date rather than today's.
  const assertedAt = dayStart(today) ?? target.now ?? new Date();

  for (const raw of text.split("\n")) {
    const m = TAG_PATTERN.exec(raw);
    if (!m) continue;
    const tag = m[1]!.toLowerCase();
    const kind = TAG_TO_DRAWER[tag];
    if (!kind) continue;
    // Strip the leading list bullet the daily line carries (`- [tag] …`); the
    // entry content is the line, not its markdown decoration.
    const cleanLine = raw.trim().replace(/^[-*]\s+/, "");
    try {
      const { inserted } = target.store.fileEntry({
        persona: target.persona,
        kind,
        content: cleanLine,
        source: "self",
        origin: `memory/${today}.md`,
        assertedAt,
      });
      if (inserted) promoted.push({ drawer: kind, line: cleanLine });
    } catch (e) {
      // One bad line must not cost the rest of the day its promotions.
      log.warn("heartbeat: could not file tagged line", {
        kind,
        error: (e as Error).message,
      });
    }
  }
  return promoted;
}

/** Midnight UTC for a `YYYY-MM-DD` daily-file name, or undefined if unparseable. */
function dayStart(today: string): Date | undefined {
  const d = new Date(`${today}T00:00:00Z`);
  return Number.isNaN(d.getTime()) ? undefined : d;
}

/** Scan MEMORY.md's ## Recent for date-stamped lines older than 48h. */
export async function checkStaleness(
  personaDir: string,
  now: Date,
  thresholdHours = 48,
): Promise<HeartbeatResult["staleRecent"]> {
  const memPath = join(personaDir, "MEMORY.md");
  if (!existsSync(memPath)) return [];
  const text = await readFile(memPath, "utf8");
  const recent = extractRecentSection(text);
  if (!recent) return [];

  const out: HeartbeatResult["staleRecent"] = [];
  for (const line of recent.split("\n")) {
    const dateMatch = /(\d{4}-\d{2}-\d{2})/.exec(line);
    if (!dateMatch) continue;
    const lineDate = new Date(`${dateMatch[1]}T00:00:00Z`);
    if (Number.isNaN(lineDate.getTime())) continue;
    const ageHours = (now.getTime() - lineDate.getTime()) / 3_600_000;
    if (ageHours >= thresholdHours) {
      out.push({ line: line.trim(), ageHours: Math.round(ageHours) });
    }
  }
  return out;
}

/** Extract the body of `## Recent` from MEMORY.md (between this header and the next). */
export function extractRecentSection(memoryMd: string): string | undefined {
  const lines = memoryMd.split("\n");
  let inRecent = false;
  const out: string[] = [];
  for (const line of lines) {
    if (/^##\s+Recent\b/i.test(line)) {
      inRecent = true;
      continue;
    }
    if (inRecent && /^##\s+/.test(line)) break;
    if (inRecent) out.push(line);
  }
  return inRecent ? out.join("\n") : undefined;
}
