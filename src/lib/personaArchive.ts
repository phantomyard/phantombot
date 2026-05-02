/**
 * Persona archive — moves a persona directory into a sibling
 * "personas-archive/" so it's not lost when a new persona of the same
 * name is created. Archived entries are timestamped so multiple snapshots
 * of the same name coexist.
 *
 *   personasDir/<name>/                   ->  personasDir/../personas-archive/<name>-<ISO>/
 *   ~/.local/share/phantombot/personas/<name>/
 *     ->  ~/.local/share/phantombot/personas-archive/<name>-2026-05-01T15-00-00Z/
 *
 * `phantombot create-persona` calls archivePersona before overwriting an
 * existing persona; `phantombot import-persona` shows the archive list
 * so the user can restore one.
 */

import { existsSync } from "node:fs";
import { cp, mkdir, readdir, rename } from "node:fs/promises";
import { dirname, join } from "node:path";

export interface ArchivedPersona {
  /** The original persona name (e.g. "phantom"). */
  name: string;
  /** ISO-8601 timestamp parsed from the archive directory name. */
  archivedAt: Date;
  /** Absolute path to the archive directory. */
  dir: string;
  /** The basename of the archive directory ("<name>-2026-05-01T15-00-00-000Z"). */
  archiveName: string;
}

export function archivesDir(personasDir: string): string {
  return join(dirname(personasDir), "personas-archive");
}

/** Move personasDir/<name>/ into the archive. Returns the new location. */
export async function archivePersona(
  personasDir: string,
  name: string,
): Promise<ArchivedPersona> {
  const src = join(personasDir, name);
  if (!existsSync(src)) {
    throw new Error(`persona '${name}' does not exist at ${src}`);
  }
  const ts = new Date();
  const stamp = ts.toISOString().replace(/[:.]/g, "-");
  const baseName = `${name}-${stamp}`;
  const archiveRoot = archivesDir(personasDir);
  await mkdir(archiveRoot, { recursive: true });

  // Same-millisecond collisions get a numeric suffix.
  let archiveName = baseName;
  let dst = join(archiveRoot, archiveName);
  for (let suffix = 1; existsSync(dst); suffix++) {
    archiveName = `${baseName}-${suffix}`;
    dst = join(archiveRoot, archiveName);
  }
  await rename(src, dst);
  return { name, archivedAt: ts, dir: dst, archiveName };
}

/** List archives newest-first. Returns [] if the archive dir doesn't exist. */
export async function listArchives(
  personasDir: string,
): Promise<ArchivedPersona[]> {
  const dir = archivesDir(personasDir);
  if (!existsSync(dir)) return [];
  const entries = await readdir(dir, { withFileTypes: true });
  const out: ArchivedPersona[] = [];
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    const parsed = parseArchiveName(e.name);
    if (!parsed) continue;
    out.push({
      ...parsed,
      dir: join(dir, e.name),
      archiveName: e.name,
    });
  }
  out.sort((a, b) => b.archivedAt.getTime() - a.archivedAt.getTime());
  return out;
}

/**
 * Restore an archived persona into personasDir/<asName>/. If a persona
 * by that name already exists, it's archived first.
 */
export async function restoreArchive(
  personasDir: string,
  archive: ArchivedPersona,
  asName: string,
): Promise<void> {
  const dst = join(personasDir, asName);
  if (existsSync(dst)) {
    await archivePersona(personasDir, asName);
  }
  await cp(archive.dir, dst, { recursive: true });
}

function parseArchiveName(
  name: string,
): { name: string; archivedAt: Date } | null {
  // "<name>-<YYYY-MM-DDTHH-MM-SS-mmmZ>" with optional "-<n>" collision suffix
  const m = /^(.+)-(\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z)(?:-\d+)?$/.exec(
    name,
  );
  if (!m) return null;
  const isoLike = m[2]!.replace(
    /^(\d{4}-\d{2}-\d{2}T\d{2})-(\d{2})-(\d{2})-(\d{3}Z)$/,
    "$1:$2:$3.$4",
  );
  const d = new Date(isoLike);
  if (Number.isNaN(d.getTime())) return null;
  return { name: m[1]!, archivedAt: d };
}
