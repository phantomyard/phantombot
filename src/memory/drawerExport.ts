/**
 * Rows → markdown, and the proof that the trip is lossless.
 *
 * Issue #417 retires the five markdown drawers: `drawer_entries` becomes the
 * source of truth and the files stop existing. That is a ONE-WAY DOOR unless
 * two things are true first, and this module is where both are established:
 *
 *   1. Every entry that was ever in a drawer file is in the table. The ingest
 *      (`drawerIngest.ts`) is a parser over four years of hand-written and
 *      LLM-written prose; "it looked right in review" is not evidence.
 *   2. The table can be rendered BACK into a drawer file that the same parser
 *      reads as the same set of entries. Without a renderer, retiring the
 *      files would leave the memory of decisions, lessons, people and
 *      commitments in exactly one binary artefact with no way back out.
 *
 * `verifyDrawerRoundTrip` closes that loop: rows → markdown → parse → ids,
 * compared against the ids in the table. It is what `--retire` demands a pass
 * from before it will archive a file, and what `--export` writes.
 *
 * WHAT ROUND-TRIP MEANS HERE, precisely. A drawer file cannot carry `weight`,
 * `status`, `source` or a supersession edge — those are row-only columns that
 * never existed on disk. So the invariant is over CONTENT IDENTITY, not bytes:
 * the exported file must parse back to exactly the same set of content-derived
 * ids, no entry dropped and none invented. Bytes cannot match the original
 * file either, and claiming they could would be a lie — the original carries
 * blockquote preambles, `---` rules, section headings like `## Family` and
 * inconsistent shapes that were never entries. Those are formatting, and this
 * export deliberately normalizes them away.
 *
 * Every status is exported, not just `active`. A superseded or dormant entry
 * is still memory; the export is the human-readable, greppable, git-able
 * artefact of the whole table, and dropping the retired half would make it a
 * summary rather than a backup.
 */

import { basename } from "node:path";
import {
  DRAWER_KINDS,
  type DrawerEntry,
  type DrawerKind,
  type DrawerStore,
  drawerEntryId,
} from "./drawers.ts";
import { drawerPath, parseDrawer } from "./drawerIngest.ts";

/** Title line for a rendered drawer, matching the scaffold's wording. */
const TITLES: Record<DrawerKind, string> = {
  people: "People",
  decisions: "Decisions",
  lessons: "Lessons",
  commitments: "Commitments",
  norms: "Norms",
};

function isoDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/**
 * One entry as markdown the parser reads back as ONE entry.
 *
 * A single-line entry is a flat bullet. A multi-line entry becomes a `###`
 * block, because a flat bullet's continuation rule only holds for INDENTED
 * lines — emitting a multi-line entry as a bullet would split it at the first
 * column-0 line and invent an entry that was never filed. The block form has
 * no such ambiguity, which is why the shape is chosen from the content rather
 * than fixed.
 */
export function renderEntryMarkdown(
  entry: DrawerEntry,
  opts: RenderEntryOptions = {},
): string {
  const lines = entry.content.split("\n").map((l) => l.trimEnd());
  const marker = opts.withId ? `\n${formatIdMarker(entry.kind, entry.id)}` : "";
  if (lines.length === 1) return `- ${lines[0]}${marker}`;
  const [head, ...rest] = lines;
  // Body lines are INDENTED, and that indentation is load-bearing rather than
  // cosmetic. An entry whose body happens to contain a line starting `## ` or
  // `### ` — a decision that quotes a drawer, say — would otherwise be read
  // back as a section header: the parser would flush there and split one entry
  // into two, failing the round-trip and holding the drawer's retirement
  // forever. Indenting keeps every body line body.
  //
  // It costs nothing in identity: entry ids are computed over
  // `normalizeFact`, which collapses runs of whitespace, so the indented
  // re-parse yields exactly the id the row already has.
  return (
    [
      `### ${head!.replace(/^#+\s*/, "")}`,
      ...rest.map((l) => (l.trim() === "" ? "" : `  ${l.replace(/^\s+/, "")}`)),
    ].join("\n") + marker
  );
}

export interface RenderEntryOptions {
  /**
   * Append a trailing `<!-- id: kind:hexid -->` marker so the render can be
   * hand-edited and imported back (#437) instead of only ever being a
   * read-only backup. Off by default: the round-trip verifier and the plain
   * `--export` artefact both predate the marker and their tests pin the
   * marker-free shape, so this is opt-in rather than a silent format change.
   */
  withId?: boolean;
}

/**
 * `<!-- id: kind:hexid -->` — the marker `renderEntryMarkdown({ withId: true
 * })` appends and `parseDrawer` strips back out. One place so the export
 * writer and the importer's validation both agree on the exact shape.
 */
export function formatIdMarker(kind: DrawerKind, id: string): string {
  return `<!-- id: ${kind}:${id} -->`;
}

export interface ExportOptions {
  /** Include entries in these statuses only. Default: every status. */
  statuses?: readonly string[];
  /** Append the `<!-- id: kind:hexid -->` marker to every entry (#437). */
  withId?: boolean;
}

/**
 * Render one drawer's rows as markdown, grouped under `## <date>` headers.
 *
 * Grouping is by `assertedAt`, not `lastReaffirmedAt`: the date header is what
 * the parser reads back as the entry's assertion date, so grouping by the
 * reaffirmation clock would walk every re-filed entry's origin date forward a
 * little on every export — a slow, silent rewrite of history that no diff
 * would obviously show.
 */
export function exportDrawerMarkdown(
  store: DrawerStore,
  persona: string,
  kind: DrawerKind,
  opts: ExportOptions = {},
): string {
  const entries = store
    .list(persona, kind)
    .filter((e) => !opts.statuses || opts.statuses.includes(e.status));
  const byDate = new Map<string, DrawerEntry[]>();
  for (const e of entries) {
    const key = isoDate(e.assertedAt);
    const bucket = byDate.get(key);
    if (bucket) bucket.push(e);
    else byDate.set(key, [e]);
  }
  const out: string[] = [
    `# ${TITLES[kind]}`,
    "",
    `> Generated from drawer_entries by \`phantombot memory drawers --export\`.`,
    `> The database is the source of truth; this file is an artefact.`,
    "",
  ];
  for (const date of [...byDate.keys()].sort()) {
    out.push(`## ${date}`, "");
    for (const entry of byDate.get(date)!) {
      out.push(renderEntryMarkdown(entry, { withId: opts.withId }), "");
    }
  }
  return `${out.join("\n").trimEnd()}\n`;
}

export interface RoundTripResult {
  kind: DrawerKind;
  /** Rows in the table for this persona + kind. */
  rows: number;
  /** Entries the exported markdown parses back into. */
  parsed: number;
  /** Row ids absent from the re-parsed export. Non-empty means DATA LOSS. */
  missing: string[];
  /** Ids the export produced that no row has. Non-empty means INVENTION. */
  extra: string[];
  ok: boolean;
  /** The markdown that was verified — reused by callers so it renders once. */
  markdown: string;
}

/**
 * Render one drawer and prove the render is lossless.
 *
 * `ok` is the gate `--retire` checks. It is deliberately an EQUALITY, not a
 * containment: a missing id is data loss, and an extra id means the renderer
 * split one entry into two, which corrupts the decay clock and the
 * supersession graph of everything downstream. Either direction fails.
 */
export function verifyDrawerRoundTrip(
  store: DrawerStore,
  persona: string,
  kind: DrawerKind,
  opts: ExportOptions = {},
): RoundTripResult {
  const markdown = exportDrawerMarkdown(store, persona, kind, opts);
  const rows = store
    .list(persona, kind)
    .filter((e) => !opts.statuses || opts.statuses.includes(e.status));
  const rowIds = new Set(rows.map((e) => e.id));
  const parsedIds = new Set(
    parseDrawer(markdown).map((e) => drawerEntryId(persona, kind, e.content)),
  );
  const missing = [...rowIds].filter((id) => !parsedIds.has(id));
  const extra = [...parsedIds].filter((id) => !rowIds.has(id));
  return {
    kind,
    rows: rowIds.size,
    parsed: parsedIds.size,
    missing,
    extra,
    ok: missing.length === 0 && extra.length === 0,
    markdown,
  };
}

/** Round-trip every drawer. */
export function verifyAllDrawers(
  store: DrawerStore,
  persona: string,
  opts: ExportOptions = {},
): RoundTripResult[] {
  return DRAWER_KINDS.map((kind) =>
    verifyDrawerRoundTrip(store, persona, kind, opts),
  );
}

/** Human line for a round-trip result. */
export function describeRoundTrip(r: RoundTripResult): string {
  const file = basename(drawerPath(r.kind));
  if (r.ok) return `${file}: ${r.rows} rows → ${r.parsed} parsed, lossless`;
  return (
    `${file}: ${r.rows} rows → ${r.parsed} parsed, ` +
    `${r.missing.length} missing, ${r.extra.length} unexpected`
  );
}
