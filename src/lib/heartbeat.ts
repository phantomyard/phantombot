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
 *   3. Refresh the FTS5 index so newly-written notes are searchable
 *      without waiting for the next manual `memory index`. Does NOT
 *      run the embedding pass (that's the nightly cycle's job).
 *
 * The harness never sees this — heartbeat runs as its own short-lived
 * process. Per the OpenClaw spec: "Heartbeat is mechanical, nightly is
 * cognitive. Don't let the heartbeat write KB notes."
 */

import { existsSync } from "node:fs";
import { appendFile, readFile } from "node:fs/promises";
import { join } from "node:path";
import { log } from "./logger.ts";
import { MemoryIndex } from "./memoryIndex.ts";

export interface HeartbeatResult {
  promoted: { drawer: string; line: string }[];
  staleRecent: { line: string; ageHours: number }[];
  indexedFiles: number;
  /** When the heartbeat ran. */
  ranAt: Date;
}

const TAG_TO_DRAWER: Record<string, string> = {
  decision: "memory/decisions.md",
  decisions: "memory/decisions.md",
  lesson: "memory/lessons.md",
  lessons: "memory/lessons.md",
  person: "memory/people.md",
  people: "memory/people.md",
  commitment: "memory/commitments.md",
  commitments: "memory/commitments.md",
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
}

export async function runHeartbeat(
  input: RunHeartbeatInput,
): Promise<HeartbeatResult> {
  const today = input.today ?? new Date().toISOString().slice(0, 10);
  const now = input.now ?? new Date();

  const promoted = await promoteTaggedLines(input.personaDir, today);
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

  return { promoted, staleRecent, indexedFiles, ranAt: now };
}

/** Scan today's daily file for [tag] lines; append to matching drawer. */
export async function promoteTaggedLines(
  personaDir: string,
  today: string,
): Promise<HeartbeatResult["promoted"]> {
  const dailyPath = join(personaDir, "memory", `${today}.md`);
  if (!existsSync(dailyPath)) return [];

  const text = await readFile(dailyPath, "utf8");
  const lines = text.split("\n");
  const promoted: HeartbeatResult["promoted"] = [];

  // Cache drawer contents to avoid re-reading per line.
  const drawerCache = new Map<string, string>();
  const loadDrawer = async (rel: string): Promise<string> => {
    if (drawerCache.has(rel)) return drawerCache.get(rel)!;
    const p = join(personaDir, rel);
    let content = "";
    if (existsSync(p)) content = await readFile(p, "utf8");
    drawerCache.set(rel, content);
    return content;
  };

  for (const raw of lines) {
    const m = TAG_PATTERN.exec(raw);
    if (!m) continue;
    const tag = m[1]!.toLowerCase();
    const drawer = TAG_TO_DRAWER[tag];
    if (!drawer) continue;
    const cleanLine = raw.trim();
    const existing = await loadDrawer(drawer);
    if (existing.includes(cleanLine)) continue;

    // Append under a date header. If today's header isn't there, add it.
    const header = `## ${today}`;
    let block = "";
    if (!existing.includes(header)) {
      block += `\n${header}\n\n`;
    }
    block += `- ${cleanLine}\n`;
    await appendFile(join(personaDir, drawer), block, "utf8");
    drawerCache.set(drawer, existing + block);
    promoted.push({ drawer, line: cleanLine });
  }
  return promoted;
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
