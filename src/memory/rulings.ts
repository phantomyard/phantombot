/**
 * The owner's rulings on held work, filed as decisions (#768).
 *
 * A ruling used to live only where someone remembered to capture it. Now the
 * command that records one (`phantombot judge rule`) files it straight into
 * the `decisions` drawer, so the judge — which briefs from decisions
 * first-by-relevance — sees it on the next check that touches the same sender.
 *
 * Every ruling carries a stable key (`[ruling judge:billing@vendor.com]`). Filing a new ruling for a key retires
 * the live one before it (superseded), so a deny after an allow is the only
 * ruling the readers see, and a withdrawal leaves none. The stamp in the text
 * makes every ruling a new row; re-ruling never collides with a retired one.
 *
 * Never throws into the caller's real job.
 */

import { memoryIndexPath } from "../config.ts";
import { log } from "../lib/logger.ts";
import { MemoryIndex } from "../lib/memoryIndex.ts";
import { syncDrawerIndex } from "./drawerIndex.ts";
import { openDrawerStore } from "./drawerSync.ts";

/** Normalise a ruling subject into its key: lowercase, single spaces, capped. */
export function rulingKey(scope: "judge", subject: string): string {
  const s = subject.toLowerCase().replace(/[\[\]\n\r]+/g, " ").replace(/\s+/g, " ").trim().slice(0, 120);
  return `${scope}:${s}`;
}

function marker(key: string): string {
  return `[ruling ${key}]`;
}

/** `YYYY-MM-DD HH:MMZ`, the stamp every ruling carries. */
function stamp(now: Date): string {
  return now.toISOString().slice(0, 16).replace("T", " ") + "Z";
}

export interface FileRulingInput {
  dbPath: string;
  persona: string;
  key: string;
  /** The ruling sentence. Undefined = withdraw: retire the live one, file none. */
  text?: string;
  now?: Date;
  /** Search index path. Default: memoryIndexPath(persona). */
  indexPath?: string;
  /** Skip index publishing (tests). */
  skipIndex?: boolean;
}

export interface FileRulingResult {
  id?: string;
  /** How many earlier live rulings for this key were retired. */
  superseded: number;
}

/** File (or withdraw) one ruling. Never throws; a failure returns superseded 0, no id. */
export async function fileRuling(input: FileRulingInput): Promise<FileRulingResult> {
  const now = input.now ?? new Date();
  const tag = marker(input.key);
  let opened: Awaited<ReturnType<typeof openDrawerStore>> | undefined;
  try {
    opened = await openDrawerStore(input.dbPath);
    const { store } = opened;
    const live = store
      .list(input.persona, "decisions")
      .filter((e) => e.status === "active" && e.content.includes(tag));
    for (const e of live) store.markSuperseded(input.persona, "decisions", e.id);
    let id: string | undefined;
    if (input.text !== undefined) {
      const content = `Owner ruling (${stamp(now)}): ${input.text.replace(/\s+/g, " ").trim()} ${tag}`;
      id = store.file({
        persona: input.persona,
        kind: "decisions",
        content,
        // Only a trusted turn runs the commands that get here, and they write
        // the owner's own words: weight it like the owner's assertion.
        source: "principal",
        origin: "ruling",
        assertedAt: now,
        ...(live[live.length - 1] ? { supersedes: live[live.length - 1]!.id } : {}),
      }).id;
    }
    if (!input.skipIndex) {
      let ix: MemoryIndex | undefined;
      try {
        ix = await MemoryIndex.open(input.indexPath ?? memoryIndexPath(input.persona));
        syncDrawerIndex(ix, store, input.persona);
      } catch {
        // The heartbeat reconciles the index on its next cycle.
      } finally {
        ix?.close();
      }
    }
    return { ...(id ? { id } : {}), superseded: live.length };
  } catch (e) {
    log.warn("ruling: could not file to decisions", { key: input.key, error: (e as Error).message });
    return { superseded: 0 };
  } finally {
    opened?.close();
  }
}
