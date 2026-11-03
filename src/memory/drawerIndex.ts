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
 * comparing the stored body, so the steady-state cost is one read per row.
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
  const out: DrawerIndexSync = { upserted: 0, removed: 0 };
  const live = new Set<string>();
  for (const entry of store.list(persona)) {
    if (entry.status !== "active") continue;
    const path = drawerIndexPath(entry.kind, entry.id);
    live.add(path);
    const body = bodyFor(entry);
    if (ix.virtualText(path) === body) continue;
    ix.upsertVirtualNote({
      path,
      scope: "memory",
      title: `${entry.kind}: ${entry.content.replace(/\s+/g, " ").trim().slice(0, 80)}`,
      body,
    });
    out.upserted++;
  }
  for (const path of ix.allNotePaths()) {
    if (!path.startsWith(DRAWER_INDEX_PREFIX) || live.has(path)) continue;
    ix.removeVirtualNote(path);
    out.removed++;
  }
  return out;
}
