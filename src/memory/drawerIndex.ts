/**
 * Drawer rows in the search index (issue #758).
 *
 * The drawers are database rows, and the search index is built from files —
 * so before this, `memory search` could only find a lesson through the daily
 * file it happened to be captured in, and only while that file still ranked.
 * The persona prompt promised "`memory search` covers them too"; it did not.
 *
 * Each ACTIVE entry is published as a virtual note (the same mechanism the
 * open journal day uses, #461) at `drawers/<kind>/<id>.md`, scope `memory`.
 * Virtual notes are embedded by the ordinary embed job, so drawer entries are
 * reachable by meaning as well as by keyword. A row that leaves `active` —
 * superseded, dormant, discharged, expired — has its note removed, so search
 * and the standing-memory block agree on what is live.
 *
 * Reconciling, not appending: every call converges the index on the table, so
 * a missed call (a crash, a store that was briefly locked) is repaired by the
 * next one rather than leaving a permanent hole. Unchanged rows are skipped by
 * comparing against the stored bodies, read in ONE query
 * (`MemoryIndex.syncVirtualNotesUnder`): a per-row lookup scans the FTS table
 * each time, which on a real persona made every `memory search` take a
 * minute (#759 review).
 *
 * These paths exist only in the index, so `memory get` resolves them against
 * the drawer store ({@link readDrawerPath}) — search hits are readable in full.
 */

import type { MemoryIndex } from "../lib/memoryIndex.ts";
import type { DrawerEntry, DrawerKind, DrawerStore } from "./drawers.ts";

export const DRAWER_INDEX_PREFIX = "drawers/";

export function drawerIndexPath(kind: DrawerKind, id: string): string {
  return `${DRAWER_INDEX_PREFIX}${kind}/${id}.md`;
}

function bodyFor(entry: DrawerEntry): string {
  return `${entry.kind} [${entry.id}]\n\n${entry.content.trim()}\n`;
}

export interface DrawerIndexSync {
  upserted: number;
  removed: number;
}

export function syncDrawerIndex(
  ix: MemoryIndex,
  store: DrawerStore,
  persona: string,
): DrawerIndexSync {
  const desired = new Map<
    string,
    { scope: "memory"; title: string; body: string }
  >();
  for (const entry of store.list(persona)) {
    if (entry.status !== "active") continue;
    desired.set(drawerIndexPath(entry.kind, entry.id), {
      scope: "memory",
      title: `${entry.kind}: ${entry.content.replace(/\s+/g, " ").trim().slice(0, 80)}`,
      body: bodyFor(entry),
    });
  }
  return ix.syncVirtualNotesUnder(DRAWER_INDEX_PREFIX, desired);
}

/**
 * Resolve a `drawers/<kind>/<id>.md` path — the form search returns — back to
 * its row, so `memory get` can print the WHOLE entry rather than the snippet.
 * Undefined when the path is not a drawer path, or names no row of this
 * persona (any status: a closed commitment is still readable by id).
 */
export function readDrawerPath(
  store: DrawerStore,
  persona: string,
  path: string,
): DrawerEntry | undefined {
  const m = /^drawers\/([a-z]+)\/([^/]+)\.md$/.exec(path.replace(/\\/g, "/"));
  if (!m) return undefined;
  const entry = store.get(m[2]!);
  if (!entry || entry.persona !== persona || entry.kind !== m[1]) return undefined;
  return entry;
}

/** What `memory get drawers/<kind>/<id>.md` prints. */
export function renderDrawerEntry(entry: DrawerEntry): string {
  return `${bodyFor(entry).trimEnd()}\n\nstatus: ${entry.status}\n`;
}
