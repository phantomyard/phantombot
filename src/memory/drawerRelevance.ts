/**
 * Relevance-first ordering for drawer entries (#761, widened for #768).
 *
 * The drawers are ranked by freshness (decayed score, or weight then recency).
 * That order is right for "what matters lately", and wrong for "what has the
 * owner said about THIS": an old ruling on the exact sender or action can sit
 * below the cap and never reach the reader. This moves the entries the search
 * index matches against a query to the front, best match first; everything
 * else keeps its ranked order behind them, so the cap still trims the weakest.
 *
 * Used by the standing-memory block (commitments, matched against the user's
 * message) and by the threat judge and the escort (decisions, people and
 * norms, matched against what is being judged).
 *
 * The query can be untrusted text (an email, a webhook, a task's wake
 * message). That only changes which of the owner's own entries come first; it
 * can never add text the owner did not file, and the entries are context for
 * a judgement, never a bypass of it.
 *
 * Never throws: no index, no match or a failing index leaves the order as is.
 */

import { existsSync } from "node:fs";
import { memoryIndexPath } from "../config.ts";
import { log } from "../lib/logger.ts";
import { MemoryIndex } from "../lib/memoryIndex.ts";
import { DRAWER_INDEX_PREFIX } from "./drawerIndex.ts";
import type { DrawerEntry, DrawerKind } from "./drawers.ts";

/** Longest query passed to the matcher; the matcher keeps 32 terms anyway. */
export const RELEVANCE_QUERY_CAP_CHARS = 2000;

export interface RelevanceInput {
  persona: string;
  kind: DrawerKind;
  query?: string;
  /** Search index path. Default: memoryIndexPath(persona). */
  indexPath?: string;
  /** An index the caller already opened (and will close). */
  index?: MemoryIndex;
}

/**
 * Hits are ordered by match strength weighted by rank fade (#767): the i-th
 * best match scores `fade / (1 + i)`, where fade is the entry's ranked score.
 * A stale strong match therefore yields to a fresh decent one, but still ranks
 * among the hits.
 */
export async function relevanceFirst<T extends DrawerEntry & { score?: number }>(
  entries: T[],
  input: RelevanceInput,
): Promise<T[]> {
  const query = input.query?.slice(0, RELEVANCE_QUERY_CAP_CHARS).trim();
  if (!query || entries.length < 2) return entries;
  let ix = input.index;
  const owned = ix === undefined;
  try {
    if (!ix) {
      const path = input.indexPath ?? memoryIndexPath(input.persona);
      if (!existsSync(path)) return entries;
      ix = await MemoryIndex.open(path);
    }
    const order = new Map<string, number>();
    for (const p of ix.matchPathsUnder(`${DRAWER_INDEX_PREFIX}${input.kind}/`, query)) {
      const id = /\/([^/]+)\.md$/.exec(p)?.[1];
      if (id && !order.has(id)) order.set(id, order.size);
    }
    if (order.size === 0) return entries;
    const hit = entries.filter((e) => order.has(e.id));
    const strength = (e: T) => (e.score ?? 1) / (1 + order.get(e.id)!);
    hit.sort((a, b) => strength(b) - strength(a) || order.get(a.id)! - order.get(b.id)!);
    return [...hit, ...entries.filter((e) => !order.has(e.id))];
  } catch (e) {
    log.warn("drawer relevance skipped", { kind: input.kind, error: (e as Error).message });
    return entries;
  } finally {
    if (owned) ix?.close();
  }
}
