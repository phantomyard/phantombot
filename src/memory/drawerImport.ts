/**
 * Markdown → rows, the inverse of `drawerExport.ts` (issue #437).
 *
 * `--export` produces a human-editable artefact; until now there was no way
 * back in short of re-running the one-way ingest, which has no concept of
 * "this line changed" — every hand-edit re-parsed to a fresh entry (a
 * duplicate, since content changed the derived id) while the line it replaced
 * sat there untouched, forever. Decay, reaffirmation and supersession all
 * read `asserted_at` / `last_reaffirmed_at` / `supersedes` / `status`, so an
 * import that bypasses them doesn't just miss a nice-to-have, it breaks the
 * mechanism drawer #417 built.
 *
 * The `<!-- id: kind:hexid -->` marker (`drawerExport.formatIdMarker`) is
 * what closes the gap, and it is deliberately narrow rather than a general
 * "trust whatever the file says" import:
 *
 *   - UNCHANGED marked entry → reaffirm. Content-derived id already equals
 *     the marker id, so this is exactly what `fileEntry` already does for a
 *     re-filed entry — no special-casing needed.
 *   - CHANGED marked entry → supersede the row the marker names. The new
 *     content gets a new id (it's a different string), filed with
 *     `supersedes: <old id>`. Logged loudly (see below) because this is the
 *     one path that permanently retires a row from a markdown edit.
 *   - NO marker → new entry. Same behaviour as the plain ingest; a line with
 *     no marker was never claiming to replace anything.
 *
 * Two structural guards keep a marker from being a forgery surface (see the
 * module header discussion on #437):
 *
 *   1. `marker.kind` must equal the kind of the FILE being imported. A norms
 *      export edited to claim `decisions:...` cannot touch a decision — the
 *      importer never even asks the store, it rejects the marker at parse
 *      time. Cross-kind is structurally impossible, not merely checked for.
 *   2. The id must resolve to a real row in THIS persona and kind. Ids are a
 *      hash of normalized content (`drawerEntryId`), not a sequential
 *      counter, so there is nothing to guess — a hand-typed or forged id
 *      simply fails to match anything and the line just files as a new
 *      entry. Worst case of a bad id is "no supersession happened", never
 *      "the wrong row got overwritten".
 *
 * No physical deletion, same as everything else in the drawer system —
 * `markSuperseded` flips a status column. Orphaned superseded rows are a
 * deliberate follow-up the issue punts on, not something this module solves.
 */

import { normalizeFact } from "./store.ts";
import { type DrawerEntry, type DrawerKind, type DrawerStore } from "./drawers.ts";
import { drawerPath, parseDrawer } from "./drawerIngest.ts";

export type ImportOutcome = "inserted" | "reaffirmed" | "superseded";

export interface ImportEntryResult {
  content: string;
  outcome: ImportOutcome;
  id?: string;
  /** The marker as parsed off the line, if any. */
  marker?: { kind: string; id: string };
  /** Set only on `outcome: "superseded"` — the content the row used to hold. */
  previousContent?: string;
  /**
   * Set when the line carried a marker that couldn't be honoured — wrong
   * kind, or an id that doesn't name a row here. The line still gets filed
   * as ordinary content (`outcome` is `inserted`/`reaffirmed` as usual); this
   * only records that its marker was ignored rather than acted on.
   */
  markerRejected?: "marker-mismatch" | "marker-unknown";
}

export interface ImportResult {
  kind: DrawerKind;
  path: string;
  parsed: number;
  inserted: number;
  reaffirmed: number;
  superseded: number;
  /** Markers that named another kind's row, or resolved to nothing. */
  rejected: number;
  entries: ImportEntryResult[];
}

export interface ImportOptions {
  /** Falls back to this when a line carries no `## <date>` section. */
  now?: Date;
  /**
   * Called once per supersession, in addition to it being in `.entries` —
   * this is the loud half of "reaffirm is quiet, supersede is loud": a
   * caller wires this to the daily-file log so a stray hand-edit is visible
   * in that day's digest instead of silently retiring a row.
   */
  onSupersede?: (r: ImportEntryResult & { outcome: "superseded" }) => void;
}

function entryDate(date: string | undefined, now: Date): Date {
  if (!date) return now;
  const parsed = new Date(`${date}T00:00:00Z`);
  if (Number.isNaN(parsed.getTime())) return now;
  return parsed > now ? now : parsed;
}

/**
 * Import one drawer's markdown (as produced by `--export --with-id`, or
 * hand-edited from it) back into rows.
 *
 * Pure over its inputs bar the store write — `text` is whatever the caller
 * read (a file, stdin), so this has no opinion on where the markdown came
 * from.
 */
export function importDrawerMarkdown(
  store: DrawerStore,
  persona: string,
  kind: DrawerKind,
  text: string,
  opts: ImportOptions = {},
): ImportResult {
  const now = opts.now ?? new Date();
  const parsed = parseDrawer(text);
  const result: ImportResult = {
    kind,
    path: drawerPath(kind),
    parsed: parsed.length,
    inserted: 0,
    reaffirmed: 0,
    superseded: 0,
    rejected: 0,
    entries: [],
  };

  for (const entry of parsed) {
    const marker = entry.idMarker;
    let supersedes: string | undefined;
    let previousContent: string | undefined;
    let markerRejected: "marker-mismatch" | "marker-unknown" | undefined;

    if (marker) {
      if (marker.kind !== kind) {
        // Guard 1 — cross-kind marker. The marker itself is worthless here,
        // but the line's CONTENT is not: it still files normally below, just
        // with no supersession — a bogus marker degrades to no marker, it
        // never blocks the entry outright.
        result.rejected += 1;
        markerRejected = "marker-mismatch";
      } else {
        const row: DrawerEntry | undefined = store.get(marker.id);
        if (!row || row.persona !== persona || row.kind !== kind) {
          // Guard 2 — the id doesn't name a real row here. Same degrade: file
          // the line as a fresh entry exactly as if it carried no marker.
          result.rejected += 1;
          markerRejected = "marker-unknown";
        } else if (normalizeFact(row.content) !== normalizeFact(entry.content)) {
          supersedes = row.id;
          previousContent = row.content;
        }
        // else: unchanged — content-derived id already equals marker.id, so
        // the fileEntry() call below reaffirms the same row with no extra
        // work.
      }
    }

    const assertedAt = entryDate(entry.date, now);
    const { entry: row, inserted } = store.fileEntry({
      persona,
      kind,
      content: entry.content,
      source: "self",
      origin: drawerPath(kind),
      assertedAt,
      supersedes,
    });

    if (supersedes) {
      result.superseded += 1;
      const r: ImportEntryResult & { outcome: "superseded" } = {
        content: entry.content,
        outcome: "superseded",
        id: row.id,
        marker,
        previousContent,
      };
      result.entries.push(r);
      opts.onSupersede?.(r);
    } else if (inserted) {
      result.inserted += 1;
      result.entries.push({
        content: entry.content,
        outcome: "inserted",
        id: row.id,
        marker,
        markerRejected,
      });
    } else {
      result.reaffirmed += 1;
      result.entries.push({
        content: entry.content,
        outcome: "reaffirmed",
        id: row.id,
        marker,
        markerRejected,
      });
    }
  }

  return result;
}

/** Human line for an import result, matching `describeIngest`'s shape. */
export function describeImport(r: ImportResult): string {
  const parts = [`${r.inserted} new`, `${r.reaffirmed} reaffirmed`];
  if (r.superseded > 0) parts.push(`${r.superseded} superseded`);
  if (r.rejected > 0) parts.push(`${r.rejected} rejected marker(s)`);
  return `${r.kind}: ${r.parsed} parsed, ${parts.join(", ")}`;
}
