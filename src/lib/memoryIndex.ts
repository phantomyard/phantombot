/**
 * SQLite FTS5 index over a persona's memory/ and kb/ directories.
 *
 * One file per persona at <dataDir>/memory-index.sqlite, holding:
 *   - notes      FTS5 virtual table (BM25-ranked content search)
 *   - files      mtime + size cache for stale detection on incremental rebuild
 *   - note_embeddings   (reserved — populated in phase 25, schema here so we
 *                       don't have to migrate later)
 *
 * Updates: any phantombot memory search call does a quick stale-check
 * (compare on-disk mtime with the index's recorded mtime per file) and
 * incrementally re-indexes anything that changed. Cheap because FTS5
 * insert is fast and we typically touch < 10 files per invocation.
 *
 * The vector embeddings (note_embeddings) are NOT touched here — they're
 * managed by the nightly cycle (phase 25 onwards).
 */

import { Database } from "bun:sqlite";
import { existsSync, readdirSync, statSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { mkdir } from "node:fs/promises";
import { dirname, join, relative } from "node:path";

export type Scope = "memory" | "kb";

export interface IndexedFile {
  path: string; // relative to personaDir
  scope: Scope;
  mtimeMs: number;
  size: number;
}

export interface SearchHit {
  path: string;
  scope: Scope;
  ftsScore: number;
  snippet: string;
}

const SCHEMA = `
CREATE VIRTUAL TABLE IF NOT EXISTS notes USING fts5(
  path UNINDEXED,
  scope UNINDEXED,
  content,
  tokenize = 'porter unicode61'
);

CREATE TABLE IF NOT EXISTS files (
  path        TEXT PRIMARY KEY,
  scope       TEXT NOT NULL,
  mtime_ms    INTEGER NOT NULL,
  size        INTEGER NOT NULL,
  indexed_at  TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_files_scope ON files(scope);

CREATE TABLE IF NOT EXISTS note_embeddings (
  path         TEXT NOT NULL,
  chunk_idx    INTEGER NOT NULL,
  vec          BLOB NOT NULL,
  embedded_at  TEXT NOT NULL,
  PRIMARY KEY (path, chunk_idx)
);
`;

export class MemoryIndex {
  constructor(private readonly db: Database) {
    db.exec(SCHEMA);
    db.exec("PRAGMA journal_mode = WAL");
  }

  static async open(indexPath: string): Promise<MemoryIndex> {
    if (indexPath !== ":memory:") {
      await mkdir(dirname(indexPath), { recursive: true });
    }
    const db = new Database(indexPath, { create: true });
    return new MemoryIndex(db);
  }

  close(): void {
    this.db.close();
  }

  /**
   * Rebuild from scratch — drop all rows in `notes` and `files` and
   * re-walk personaDir/memory/ and personaDir/kb/. Safe to call on a
   * fresh persona with no memory/kb dirs yet (returns 0 indexed).
   */
  async rebuild(personaDir: string): Promise<{ indexed: number }> {
    this.db.exec("DELETE FROM notes; DELETE FROM files;");
    return this.refreshStale(personaDir, /* forceAll */ true);
  }

  /**
   * Incremental refresh — re-index any file whose mtime differs from the
   * recorded mtime. Removes index entries for files that have been deleted
   * from disk. Returns count of (re)indexed files.
   */
  async refreshStale(
    personaDir: string,
    forceAll = false,
  ): Promise<{ indexed: number; removed: number }> {
    const live = walkMarkdown(personaDir);
    let indexed = 0;
    let removed = 0;

    const recorded = new Map<string, { mtimeMs: number }>();
    for (const row of this.db
      .query("SELECT path, mtime_ms FROM files")
      .all() as Array<{ path: string; mtime_ms: number }>) {
      recorded.set(row.path, { mtimeMs: row.mtime_ms });
    }

    const livePathSet = new Set(live.map((f) => f.path));
    for (const recordedPath of recorded.keys()) {
      if (!livePathSet.has(recordedPath)) {
        this.deletePath(recordedPath);
        removed++;
      }
    }

    for (const f of live) {
      const prev = recorded.get(f.path);
      if (!forceAll && prev && prev.mtimeMs === f.mtimeMs) continue;
      const content = await readFile(join(personaDir, f.path), "utf8");
      this.deletePath(f.path);
      this.db
        .prepare(
          "INSERT INTO notes (path, scope, content) VALUES (?, ?, ?)",
        )
        .run(f.path, f.scope, content);
      this.db
        .prepare(
          "INSERT INTO files (path, scope, mtime_ms, size, indexed_at) " +
            "VALUES (?, ?, ?, ?, ?)",
        )
        .run(f.path, f.scope, f.mtimeMs, f.size, new Date().toISOString());
      indexed++;
    }
    return { indexed, removed };
  }

  search(
    query: string,
    opts: { scope?: Scope | "all"; limit?: number } = {},
  ): SearchHit[] {
    const limit = Math.max(1, Math.min(opts.limit ?? 5, 50));
    const scope = opts.scope ?? "all";
    if (!query.trim()) return [];

    const ftsQuery = sanitizeFtsQuery(query);

    const rows =
      scope === "all"
        ? (this.db
            .query(
              "SELECT path, scope, bm25(notes) AS rank, " +
                "snippet(notes, 2, '«', '»', ' … ', 12) AS snip " +
                "FROM notes WHERE content MATCH ? " +
                "ORDER BY rank LIMIT ?",
            )
            .all(ftsQuery, limit) as Array<{
            path: string;
            scope: Scope;
            rank: number;
            snip: string;
          }>)
        : (this.db
            .query(
              "SELECT path, scope, bm25(notes) AS rank, " +
                "snippet(notes, 2, '«', '»', ' … ', 12) AS snip " +
                "FROM notes WHERE content MATCH ? AND scope = ? " +
                "ORDER BY rank LIMIT ?",
            )
            .all(ftsQuery, scope, limit) as Array<{
            path: string;
            scope: Scope;
            rank: number;
            snip: string;
          }>);

    return rows.map((r) => ({
      path: r.path,
      scope: r.scope,
      // bm25() in FTS5 is "lower is better"; flip the sign so callers can
      // sort/threshold consistently with cosine sim later (higher = better).
      ftsScore: -r.rank,
      snippet: r.snip,
    }));
  }

  private deletePath(path: string): void {
    this.db.prepare("DELETE FROM notes WHERE path = ?").run(path);
    this.db.prepare("DELETE FROM files WHERE path = ?").run(path);
    this.db
      .prepare("DELETE FROM note_embeddings WHERE path = ?")
      .run(path);
  }
}

/** Walk personaDir/memory/ and personaDir/kb/ for .md files. Synchronous. */
export function walkMarkdown(personaDir: string): IndexedFile[] {
  const out: IndexedFile[] = [];
  for (const scope of ["memory", "kb"] as Scope[]) {
    const root = join(personaDir, scope);
    if (!existsSync(root)) continue;
    walk(root, root, scope, out);
  }
  return out;
}

function walk(
  root: string,
  dir: string,
  scope: Scope,
  out: IndexedFile[],
): void {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name.startsWith(".")) continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      walk(root, full, scope, out);
      continue;
    }
    if (!entry.isFile() || !entry.name.endsWith(".md")) continue;
    const st = statSync(full);
    out.push({
      path: relative(dir.startsWith(root) ? dirname(root) : root, full),
      scope,
      mtimeMs: Math.floor(st.mtimeMs),
      size: st.size,
    });
  }
}

/**
 * Convert a free-form user query into something safe to pass to FTS5.
 * Strips characters that have special meaning in the FTS query language
 * (quotes, parens, etc.) and joins remaining tokens with implicit AND.
 *
 * Exported for testing.
 */
export function sanitizeFtsQuery(q: string): string {
  // Allow letters, digits, underscore, hyphen, whitespace.
  const cleaned = q
    .replace(/[^A-Za-z0-9_\- ]+/g, " ")
    .split(/\s+/)
    .map((t) => t.trim())
    .filter((t) => t.length > 0);
  if (cleaned.length === 0) return '""';
  // Quote each token so we don't accidentally trigger NEAR/AND/etc.
  return cleaned.map((t) => `"${t}"`).join(" ");
}
