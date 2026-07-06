/**
 * SQLite FTS5 index over a persona's memory/ and kb/ directories, plus
 * derived conversation-turn rows.
 *
 * One file per persona at <dataDir>/memory-index.sqlite, holding:
 *   - notes      FTS5 virtual table (BM25-ranked content search)
 *   - files      mtime + size cache for stale detection on incremental rebuild
 *   - note_embeddings   (reserved — populated in phase 25, schema here so we
 *                       don't have to migrate later)
 *   - turn_docs / turn_embeddings / turn_index_state
 *                       (derived conversation continuity index)
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
import { posix } from "node:path";
import type { Turn } from "../memory/store.ts";
import { parseOkf } from "./okf.ts";

export type Scope = "memory" | "kb" | "turns";

/**
 * BM25F field weights for the `notes` table. A term hit in a concept's title,
 * tags, or aliases is worth far more than the same term buried in the body —
 * this is the lexical-precision half of the OKF superpowers, and it makes the
 * frontmatter the index actually leans on. Positionally these map to the
 * `notes` columns: [path, scope, title, tags, aliases, headings, body]. The
 * two UNINDEXED columns get weight 0 (ignored by bm25 anyway).
 */
export const NOTE_FIELD_WEIGHTS = [0, 0, 8.0, 6.0, 6.0, 3.0, 1.0] as const;

/** Column index of `body` in `notes` (for snippet()). */
const NOTES_BODY_COL = 6;

export interface IndexedFile {
  path: string; // relative to personaDir
  scope: Scope;
  mtimeMs: number;
  size: number;
}

export interface SearchHit {
  path: string;
  scope: Scope;
  /** BM25-derived score; higher = more relevant. Only set if FTS5 matched. */
  ftsScore?: number;
  /** Cosine similarity (-1..1); only set if vector search matched. */
  vecScore?: number;
  /** Reciprocal-rank-fusion score combining FTS + vec ranks. */
  rrfScore?: number;
  /**
   * True when this hit was not itself a lexical match but was pulled in by
   * graph-walk expansion from a hit that was (OKF link-graph recall). Lets
   * callers label or down-weight expanded neighbours.
   */
  expanded?: boolean;
  snippet: string;
}

export interface StoredEmbedding {
  path: string;
  chunkIdx: number;
  vec: Float32Array;
  textSha: string;
}

export interface TurnIndexState {
  persona: string;
  conversation: string;
  lastTurnId: number;
  userTurnsIndexed: number;
  indexedAt: string;
}

/** Brute-force cosine similarity. Both vectors must be the same length. */
export function cosineSimilarity(a: Float32Array, b: Float32Array): number {
  const len = Math.min(a.length, b.length);
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < len; i++) {
    const ai = a[i]!;
    const bi = b[i]!;
    dot += ai * bi;
    na += ai * ai;
    nb += bi * bi;
  }
  const denom = Math.sqrt(na) * Math.sqrt(nb);
  return denom > 0 ? dot / denom : 0;
}

/**
 * Reciprocal Rank Fusion. Each input is an ordered list of paths
 * (best-first). Returns a Map<path, rrfScore> combining the lists.
 * The standard k=60 from Cormack et al.
 */
export function rrfMerge(
  lists: ReadonlyArray<readonly string[]>,
  k = 60,
): Map<string, number> {
  const scores = new Map<string, number>();
  for (const list of lists) {
    list.forEach((path, idx) => {
      scores.set(path, (scores.get(path) ?? 0) + 1 / (k + idx + 1));
    });
  }
  return scores;
}

/**
 * Bump when the on-disk schema of derived-from-disk tables changes (notes /
 * files / note_links). On open, a mismatch drops and rebuilds JUST those
 * tables — they're fully reconstructable by walking memory/ + kb/, so this is
 * a safe, automatic, no-migration self-heal. The turn_docs / *_embeddings
 * tables are NOT versioned here: they carry Gemini vectors and turn-index
 * state that aren't cheaply rebuildable, so they're left untouched.
 *
 * v1 → v2: `notes` went from a single `content` column to OKF field columns
 * (title / tags / aliases / headings / body) for BM25F, and `note_links` was
 * added for graph-walk expansion.
 */
export const NOTES_SCHEMA_VERSION = 3;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE VIRTUAL TABLE IF NOT EXISTS notes USING fts5(
  path UNINDEXED,
  scope UNINDEXED,
  title,
  tags,
  aliases,
  headings,
  body,
  tokenize = 'porter unicode61'
);

CREATE TABLE IF NOT EXISTS files (
  path        TEXT PRIMARY KEY,
  scope       TEXT NOT NULL,
  mtime_ms    INTEGER NOT NULL,
  size        INTEGER NOT NULL,
  title       TEXT NOT NULL DEFAULT '',
  aliases     TEXT NOT NULL DEFAULT '',
  indexed_at  TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_files_scope ON files(scope);

CREATE TABLE IF NOT EXISTS note_links (
  src_path     TEXT NOT NULL,
  target_raw   TEXT NOT NULL,
  kind         TEXT NOT NULL,
  target_path  TEXT
);
CREATE INDEX IF NOT EXISTS idx_note_links_src ON note_links(src_path);
CREATE INDEX IF NOT EXISTS idx_note_links_target ON note_links(target_path);

CREATE TABLE IF NOT EXISTS note_embeddings (
  path         TEXT NOT NULL,
  chunk_idx    INTEGER NOT NULL,
  vec          BLOB NOT NULL,
  text_sha     TEXT NOT NULL,
  embedded_at  TEXT NOT NULL,
  PRIMARY KEY (path, chunk_idx)
);
CREATE INDEX IF NOT EXISTS idx_note_embeddings_sha ON note_embeddings(text_sha);

CREATE VIRTUAL TABLE IF NOT EXISTS turn_docs USING fts5(
  path UNINDEXED,
  persona UNINDEXED,
  conversation UNINDEXED,
  role UNINDEXED,
  turn_id UNINDEXED,
  content,
  tokenize = 'porter unicode61'
);

CREATE TABLE IF NOT EXISTS turn_embeddings (
  path         TEXT PRIMARY KEY,
  vec          BLOB NOT NULL,
  text_sha     TEXT NOT NULL,
  embedded_at  TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_turn_embeddings_sha ON turn_embeddings(text_sha);

CREATE TABLE IF NOT EXISTS turn_index_state (
  persona            TEXT NOT NULL,
  conversation       TEXT NOT NULL,
  last_turn_id       INTEGER NOT NULL,
  user_turns_indexed INTEGER NOT NULL,
  indexed_at         TEXT NOT NULL,
  PRIMARY KEY (persona, conversation)
);
`;

export class MemoryIndex {
  constructor(private readonly db: Database) {
    // Pragmas must already be applied on `db` before this runs (see open()).
    // busy_timeout in particular has to be set before the very first
    // statement, or schema setup itself can throw SQLITE_BUSY when another
    // process touches the index DB concurrently.
    db.exec(SCHEMA);
    this.selfHealNotesSchema();
  }

  /**
   * If the persisted notes-schema version is older than NOTES_SCHEMA_VERSION
   * (or absent, i.e. a pre-versioning v1 index), drop the derived-from-disk
   * tables and let the next refreshStale() rebuild them from memory/ + kb/.
   * Turn and embedding tables are untouched. Cheap and idempotent.
   */
  private selfHealNotesSchema(): void {
    const row = this.db
      .query("SELECT value FROM meta WHERE key = 'notes_schema_version'")
      .get() as { value?: string } | null;
    const have = row?.value ? Number(row.value) : 0;
    // A fresh DB has the current `notes` columns already (just created), but
    // no meta row and no rows yet — stamp it and move on.
    const isEmpty =
      (this.db.query("SELECT COUNT(*) AS c FROM files").get() as { c: number })
        .c === 0;
    if (have === NOTES_SCHEMA_VERSION) return;
    if (have === 0 && isEmpty) {
      this.stampNotesSchemaVersion();
      return;
    }
    // Stale derived tables: drop and recreate so the new column layout sticks
    // (CREATE ... IF NOT EXISTS won't alter an existing table's columns). All
    // three are fully rebuilt from disk by the next refreshStale().
    this.db.exec(
      "DROP TABLE IF EXISTS notes;" +
        "DROP TABLE IF EXISTS files;" +
        "DROP TABLE IF EXISTS note_links;",
    );
    this.db.exec(SCHEMA);
    this.stampNotesSchemaVersion();
  }

  private stampNotesSchemaVersion(): void {
    this.db
      .prepare(
        "INSERT INTO meta (key, value) VALUES ('notes_schema_version', ?) " +
          "ON CONFLICT(key) DO UPDATE SET value = excluded.value",
      )
      .run(String(NOTES_SCHEMA_VERSION));
  }

  static async open(indexPath: string): Promise<MemoryIndex> {
    if (indexPath !== ":memory:") {
      await mkdir(dirname(indexPath), { recursive: true });
    }
    const db = new Database(indexPath, { create: true });
    // Apply pragmas BEFORE constructing (which runs schema setup). The index
    // DB is shared across processes (tick reindex vs. run query); without
    // busy_timeout the first concurrent writer — including schema setup —
    // gets an immediate SQLITE_BUSY throw instead of block-and-retry.
    // See store.ts for the same ordering.
    db.exec("PRAGMA journal_mode = WAL");
    db.exec("PRAGMA busy_timeout = 5000");
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
      const doc = parseOkf(content);
      this.deletePath(f.path);
      this.db
        .prepare(
          "INSERT INTO notes (path, scope, title, tags, aliases, headings, body) " +
            "VALUES (?, ?, ?, ?, ?, ?, ?)",
        )
        .run(
          f.path,
          f.scope,
          doc.title,
          doc.tags.join(" "),
          doc.aliases.join(" "),
          doc.headings.join(" \n "),
          // Body keeps title/desc folded in so a query that matches them still
          // returns a usable snippet, and so BM25 term-frequency stays sane on
          // notes that put everything in frontmatter.
          [doc.title, doc.description, doc.body].filter(Boolean).join("\n"),
        );
      this.db
        .prepare(
          "INSERT INTO files (path, scope, mtime_ms, size, title, aliases, indexed_at) " +
            "VALUES (?, ?, ?, ?, ?, ?, ?)",
        )
        .run(
          f.path,
          f.scope,
          f.mtimeMs,
          f.size,
          doc.title,
          // Newline-delimited (not space-joined) so multi-word aliases like
          // "credential cycling" survive intact for wiki-target resolution.
          doc.aliases.join("\n").toLowerCase(),
          new Date().toISOString(),
        );
      for (const link of doc.links) {
        this.db
          .prepare(
            "INSERT INTO note_links (src_path, target_raw, kind, target_path) " +
              "VALUES (?, ?, ?, ?)",
          )
          .run(
            f.path,
            link.target,
            link.kind,
            link.kind === "md"
              ? resolveMdLink(f.path, link.target)
              : null,
          );
      }
      indexed++;
    }
    // Resolve wikilink targets to concrete paths now that every changed note
    // is in the files table. Done as a post-pass (not inline) so forward
    // references — a note that [[links]] to one indexed later — still resolve,
    // and so both outbound and inbound lookups can rely on target_path. Only
    // runs when something changed, since unchanged runs can't add new targets.
    if (indexed > 0 || removed > 0) this.resolveWikiLinks();
    return { indexed, removed };
  }

  /**
   * Fill in `target_path` for every wikilink by matching its raw target
   * against indexed notes' basename, title, or aliases. (Markdown links are
   * resolved by relative path inline at insert time.) Idempotent: re-resolves
   * the whole wiki link set so links that pointed at a now-renamed/-deleted
   * note get repaired or cleared. This is what lets a note pull in the notes
   * that wikilink *to* it — inbound lookup keys on target_path, so unresolved
   * wikilinks are invisible to it.
   */
  private resolveWikiLinks(): void {
    const nameIndex = this.buildNameIndex();
    const rows = this.db
      .query(
        "SELECT rowid, target_raw FROM note_links WHERE kind = 'wiki'",
      )
      .all() as Array<{ rowid: number; target_raw: string }>;
    const upd = this.db.prepare(
      "UPDATE note_links SET target_path = ? WHERE rowid = ?",
    );
    for (const r of rows) {
      const key = r.target_raw.trim().toLowerCase().replace(/\.md$/, "");
      upd.run(key ? (nameIndex.get(key) ?? null) : null, r.rowid);
    }
  }

  /**
   * Lowercased name → indexed path map for wiki-target resolution. Built once
   * per resolve pass (not per link) to avoid an O(files) scan per wikilink.
   * Precedence basename > title > alias; first writer wins for stable results.
   */
  private buildNameIndex(): Map<string, string> {
    const map = new Map<string, string>();
    const rows = this.db
      .query("SELECT path, title, aliases FROM files")
      .all() as Array<{ path: string; title: string; aliases: string }>;
    const add = (key: string, path: string) => {
      const k = key.trim().toLowerCase();
      if (k && !map.has(k)) map.set(k, path);
    };
    for (const r of rows) {
      add(
        posix.basename(r.path.replace(/\\/g, "/")).replace(/\.md$/i, ""),
        r.path,
      );
    }
    for (const r of rows) if (r.title) add(r.title, r.path);
    for (const r of rows) {
      // files.aliases is newline-delimited so multi-word aliases stay intact.
      for (const a of r.aliases.split("\n")) if (a) add(a, r.path);
    }
    return map;
  }

  // -------------------------------------------------------------
  // Embedding storage
  // -------------------------------------------------------------

  upsertEmbedding(
    path: string,
    chunkIdx: number,
    vec: Float32Array,
    textSha: string,
  ): void {
    const buf = Buffer.from(vec.buffer, vec.byteOffset, vec.byteLength);
    this.db
      .prepare(
        "INSERT OR REPLACE INTO note_embeddings " +
          "(path, chunk_idx, vec, text_sha, embedded_at) " +
          "VALUES (?, ?, ?, ?, ?)",
      )
      .run(path, chunkIdx, buf, textSha, new Date().toISOString());
  }

  upsertTurn(turn: Turn, vec?: Float32Array, textSha?: string): void {
    const path = turnPath(turn);
    this.deleteTurnPath(path);
    this.db
      .prepare(
        "INSERT INTO turn_docs (path, persona, conversation, role, turn_id, content) " +
          "VALUES (?, ?, ?, ?, ?, ?)",
      )
      .run(
        path,
        turn.persona,
        turn.conversation,
        turn.role,
        turn.id,
        renderTurnForIndex(turn),
      );

    if (vec && textSha) {
      const buf = Buffer.from(vec.buffer, vec.byteOffset, vec.byteLength);
      this.db
        .prepare(
          "INSERT OR REPLACE INTO turn_embeddings " +
            "(path, vec, text_sha, embedded_at) VALUES (?, ?, ?, ?)",
        )
        .run(path, buf, textSha, new Date().toISOString());
    }
  }

  turnEmbeddingSha(path: string): string | undefined {
    const row = this.db
      .prepare("SELECT text_sha FROM turn_embeddings WHERE path = ?")
      .get(path) as { text_sha?: string } | null;
    return row?.text_sha;
  }

  turnIndexState(
    persona: string,
    conversation: string,
  ): TurnIndexState | undefined {
    const row = this.db
      .prepare(
        `SELECT persona, conversation, last_turn_id, user_turns_indexed, indexed_at
         FROM turn_index_state
         WHERE persona = ? AND conversation = ?`,
      )
      .get(persona, conversation) as
      | {
          persona: string;
          conversation: string;
          last_turn_id: number;
          user_turns_indexed: number;
          indexed_at: string;
        }
      | undefined;
    if (!row) return undefined;
    return {
      persona: row.persona,
      conversation: row.conversation,
      lastTurnId: row.last_turn_id,
      userTurnsIndexed: row.user_turns_indexed,
      indexedAt: row.indexed_at,
    };
  }

  updateTurnIndexState(
    persona: string,
    conversation: string,
    lastTurnId: number,
    userTurnsIndexed: number,
  ): void {
    this.db
      .prepare(
        `INSERT INTO turn_index_state
           (persona, conversation, last_turn_id, user_turns_indexed, indexed_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(persona, conversation) DO UPDATE SET
           last_turn_id = excluded.last_turn_id,
           user_turns_indexed = excluded.user_turns_indexed,
           indexed_at = excluded.indexed_at`,
      )
      .run(
        persona,
        conversation,
        Math.max(0, Math.floor(lastTurnId)),
        Math.max(0, Math.floor(userTurnsIndexed)),
        new Date().toISOString(),
      );
  }

  deleteConversationTurns(persona: string, conversation: string): void {
    const rows = this.db
      .query(
        "SELECT path FROM turn_docs WHERE persona = ? AND conversation = ?",
      )
      .all(persona, conversation) as Array<{ path: string }>;
    for (const row of rows) this.deleteTurnPath(row.path);
    this.db
      .prepare(
        "DELETE FROM turn_index_state WHERE persona = ? AND conversation = ?",
      )
      .run(persona, conversation);
  }

  /** Return the recorded text_sha for a (path, chunk_idx) or undefined. */
  embeddingSha(path: string, chunkIdx: number): string | undefined {
    const row = this.db
      .prepare(
        "SELECT text_sha FROM note_embeddings WHERE path = ? AND chunk_idx = ?",
      )
      .get(path, chunkIdx) as { text_sha?: string } | null;
    return row?.text_sha;
  }

  /** Walk every stored embedding. Loads all into memory — fine up to ~50K rows. */
  allEmbeddings(): StoredEmbedding[] {
    const noteRows = this.db
      .query(
        "SELECT path, chunk_idx, vec, text_sha FROM note_embeddings",
      )
      .all() as Array<{
      path: string;
      chunk_idx: number;
      vec: Buffer | Uint8Array;
      text_sha: string;
    }>;
    const turnRows = this.db
      .query("SELECT path, vec, text_sha FROM turn_embeddings")
      .all() as Array<{
      path: string;
      vec: Buffer | Uint8Array;
      text_sha: string;
    }>;
    return [
      ...noteRows.map((r) => ({
      path: r.path,
      chunkIdx: r.chunk_idx,
      vec: blobToFloat32(r.vec),
      textSha: r.text_sha,
      })),
      ...turnRows.map((r) => ({
        path: r.path,
        chunkIdx: 0,
        vec: blobToFloat32(r.vec),
        textSha: r.text_sha,
      })),
    ];
  }

  embeddingCount(): number {
    const notes = (
      this.db
        .prepare("SELECT COUNT(*) AS c FROM note_embeddings")
        .get() as { c: number }
    ).c;
    const turns = (
      this.db
        .prepare("SELECT COUNT(*) AS c FROM turn_embeddings")
        .get() as { c: number }
    ).c;
    return notes + turns;
  }

  // -------------------------------------------------------------
  // Search
  // -------------------------------------------------------------

  search(
    query: string,
    opts: {
      scope?: Scope | "all";
      limit?: number;
      /**
       * When set, conversation-turn rows are restricted to this conversation.
       * memory/ + kb/ notes stay global to the persona regardless. Omitted →
       * turns are searched across all conversations (the CLI `memory search`
       * behaviour); the auto-retrieval hot path always passes it so chat A
       * never surfaces chat B's turns. (Kai's review on PR #132.)
       */
      conversation?: string;
    } = {},
  ): SearchHit[] {
    const limit = Math.max(1, Math.min(opts.limit ?? 5, 50));
    const scope = opts.scope ?? "all";
    if (!query.trim()) return [];

    const ftsQuery = sanitizeFtsQuery(query);

    // BM25F: weight title/tags/aliases/headings above body. Weights are SQL
    // literals (bm25() doesn't bind them), sourced from NOTE_FIELD_WEIGHTS.
    const bm = `bm25(notes, ${NOTE_FIELD_WEIGHTS.join(", ")})`;
    const snip = `snippet(notes, ${NOTES_BODY_COL}, '«', '»', ' … ', 12)`;

    const noteRows =
      scope === "all"
        ? (this.db
            .query(
              `SELECT path, scope, ${bm} AS rank, ${snip} AS snip ` +
                "FROM notes WHERE notes MATCH ? " +
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
              `SELECT path, scope, ${bm} AS rank, ${snip} AS snip ` +
                "FROM notes WHERE notes MATCH ? AND scope = ? " +
                "ORDER BY rank LIMIT ?",
            )
            .all(ftsQuery, scope, limit) as Array<{
            path: string;
            scope: Scope;
            rank: number;
            snip: string;
          }>);

    const turnRows =
      scope === "all" || scope === "turns"
        ? opts.conversation !== undefined
          ? (this.db
              .query(
                "SELECT path, bm25(turn_docs) AS rank, " +
                  "snippet(turn_docs, 5, '«', '»', ' … ', 16) AS snip " +
                  "FROM turn_docs WHERE content MATCH ? AND conversation = ? " +
                  "ORDER BY rank LIMIT ?",
              )
              .all(ftsQuery, opts.conversation, limit) as Array<{
              path: string;
              rank: number;
              snip: string;
            }>)
          : (this.db
              .query(
                "SELECT path, bm25(turn_docs) AS rank, " +
                  "snippet(turn_docs, 5, '«', '»', ' … ', 16) AS snip " +
                  "FROM turn_docs WHERE content MATCH ? " +
                  "ORDER BY rank LIMIT ?",
              )
              .all(ftsQuery, limit) as Array<{
              path: string;
              rank: number;
              snip: string;
            }>)
        : [];

    return [
      ...noteRows.map((r) => ({
      path: r.path,
      scope: r.scope,
      // bm25() in FTS5 is "lower is better"; flip the sign so callers can
      // sort/threshold consistently with cosine sim later (higher = better).
      ftsScore: -r.rank,
      snippet: r.snip,
      })),
      ...turnRows.map((r) => ({
        path: r.path,
        scope: "turns" as const,
        ftsScore: -r.rank,
        snippet: r.snip,
      })),
    ]
      .sort((a, b) => (b.ftsScore ?? 0) - (a.ftsScore ?? 0))
      .slice(0, limit);
  }

  /**
   * BM25F search PLUS OKF link-graph expansion — the no-embeddings superpower.
   *
   * Runs the normal fielded BM25 search, then walks the link graph one or more
   * hops out from the lexical hits and folds in directly-connected neighbour
   * concepts that didn't match on their own. This is the keyword-only stand-in
   * for the "semantic spread" embeddings give you: instead of a learned vector
   * space, it uses the author's own explicit links to surface related concepts
   * a bare term query would miss.
   *
   * Expanded neighbours are appended after the lexical hits (never displacing a
   * real match) and flagged `expanded: true`. Only memory/ + kb/ notes
   * participate — conversation turns aren't part of the concept graph.
   */
  searchExpanded(
    query: string,
    opts: {
      scope?: Scope | "all";
      limit?: number;
      conversation?: string;
      /** Hops to walk out from each lexical hit. Default 1. */
      hops?: number;
      /** Max neighbours to fold in. Default 3. */
      maxAdd?: number;
    } = {},
  ): SearchHit[] {
    const limit = Math.max(1, Math.min(opts.limit ?? 5, 50));
    const hits = this.search(query, {
      scope: opts.scope,
      limit,
      conversation: opts.conversation,
    });
    const maxAdd = Math.max(0, opts.maxAdd ?? 3);
    if (maxAdd === 0) return hits;

    // Only note hits (memory/kb) seed graph expansion; turns aren't concepts.
    const seeds = hits.filter((h) => h.scope !== "turns").map((h) => h.path);
    if (seeds.length === 0) return hits;

    const present = new Set(hits.map((h) => h.path));
    const neighbours = this.graphNeighbours(
      seeds,
      Math.max(1, opts.hops ?? 1),
      present,
      maxAdd,
    );

    const extra: SearchHit[] = [];
    for (const path of neighbours) {
      const hit = this.hitForPath(path);
      if (hit) extra.push({ ...hit, expanded: true });
    }
    return [...hits, ...extra];
  }

  /**
   * Breadth-first walk over note_links from the seed paths. Follows both
   * outbound links (seed → target) and inbound links (other → seed), and
   * resolves wikilink/markdown targets to concrete indexed paths. Returns up
   * to `maxAdd` neighbour paths not already in `exclude`, nearest first.
   */
  private graphNeighbours(
    seeds: string[],
    hops: number,
    exclude: Set<string>,
    maxAdd: number,
  ): string[] {
    const found: string[] = [];
    const visited = new Set<string>(seeds);
    let frontier = [...seeds];

    for (let hop = 0; hop < hops && found.length < maxAdd; hop++) {
      const next: string[] = [];
      for (const src of frontier) {
        for (const path of this.linkedPaths(src)) {
          if (visited.has(path)) continue;
          visited.add(path);
          next.push(path);
          if (!exclude.has(path)) {
            found.push(path);
            if (found.length >= maxAdd) return found;
          }
        }
      }
      frontier = next;
    }
    return found;
  }

  /**
   * Concrete indexed paths linked to/from `src` (outbound + inbound). Both
   * markdown and wikilink targets are resolved to concrete paths at index time
   * (see resolveWikiLinks), so both directions simply key on target_path — no
   * per-query table scan, and inbound wikilinks resolve symmetrically.
   */
  private linkedPaths(src: string): string[] {
    const out = new Set<string>();

    // Outbound: this note's links whose target resolved to an indexed note.
    const outboundRows = this.db
      .query(
        "SELECT target_path FROM note_links WHERE src_path = ? AND target_path IS NOT NULL",
      )
      .all(src) as Array<{ target_path: string }>;
    for (const r of outboundRows) {
      if (this.pathExists(r.target_path)) out.add(r.target_path);
    }

    // Inbound: notes whose (markdown OR wiki) link resolved to this one.
    const inboundRows = this.db
      .query("SELECT src_path FROM note_links WHERE target_path = ?")
      .all(src) as Array<{ src_path: string }>;
    for (const r of inboundRows) out.add(r.src_path);

    out.delete(src);
    return [...out];
  }

  private pathExists(path: string): boolean {
    return (
      this.db.prepare("SELECT 1 FROM files WHERE path = ? LIMIT 1").get(path) !=
      null
    );
  }

  /** Build a SearchHit for a known indexed path (no lexical scores). */
  private hitForPath(path: string): SearchHit | undefined {
    const scope = this.lookupScope(path);
    if (!scope) return undefined;
    return { path, scope, snippet: this.snippetForPath(path) };
  }

  /**
   * Hybrid search: BM25 + cosine similarity over stored embeddings,
   * combined via RRF. Falls back to FTS-only when queryVec is undefined.
   */
  hybridSearch(
    query: string,
    queryVec: Float32Array | undefined,
    opts: {
      scope?: Scope | "all";
      limit?: number;
      /** See `search()` — scopes conversation-turn rows to one conversation. */
      conversation?: string;
    } = {},
  ): SearchHit[] {
    const limit = Math.max(1, Math.min(opts.limit ?? 5, 50));
    const ftsHits = this.search(query, {
      scope: opts.scope,
      limit: 25,
      conversation: opts.conversation,
    });

    if (!queryVec || queryVec.length === 0) return ftsHits.slice(0, limit);

    // Vector search. Brute-force cosine over all embeddings.
    const all = this.allEmbeddings();
    const vecScores = new Map<string, number>(); // path → max chunk score
    for (const emb of all) {
      const s = cosineSimilarity(queryVec, emb.vec);
      const cur = vecScores.get(emb.path);
      if (cur === undefined || s > cur) vecScores.set(emb.path, s);
    }

    // Filter vector hits by scope by joining with the metadata tables —
    // embeddings tables have no scope column, so we look up each path.
    //
    // memory/ + kb/ notes stay GLOBAL to the persona (shared knowledge), but
    // conversation-turn rows are scoped to opts.conversation when given, so
    // chat A never surfaces chat B's turns through the vector path. This
    // mirrors the FTS scoping in search(). (Kai's review on PR #132.)
    const searchScope = opts.scope ?? "all";
    const conversation = opts.conversation;
    if (searchScope !== "all" || conversation !== undefined) {
      const allowedPaths = new Set<string>();
      // Notes (memory/kb): allowed by scope, never filtered by conversation.
      if (searchScope === "all") {
        for (const r of this.db
          .query("SELECT path FROM files")
          .all() as Array<{ path: string }>)
          allowedPaths.add(r.path);
      } else if (searchScope === "memory" || searchScope === "kb") {
        for (const r of this.db
          .query("SELECT path FROM files WHERE scope = ?")
          .all(searchScope) as Array<{ path: string }>)
          allowedPaths.add(r.path);
      }
      // Conversation turns: scoped to the current conversation when provided.
      if (searchScope === "all" || searchScope === "turns") {
        const turnRows =
          conversation !== undefined
            ? (this.db
                .query("SELECT path FROM turn_docs WHERE conversation = ?")
                .all(conversation) as Array<{ path: string }>)
            : (this.db
                .query("SELECT path FROM turn_docs")
                .all() as Array<{ path: string }>);
        for (const r of turnRows) allowedPaths.add(r.path);
      }
      for (const path of [...vecScores.keys()]) {
        if (!allowedPaths.has(path)) vecScores.delete(path);
      }
    }

    const vecRanked = [...vecScores.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 25);

    // RRF merge of FTS + vec ranks.
    const ftsRanked = ftsHits.map((h) => h.path);
    const vecPaths = vecRanked.map(([path]) => path);
    const rrf = rrfMerge([ftsRanked, vecPaths]);

    // Build the final hit list, ordered by rrf score, including both
    // sub-scores when available.
    const merged: SearchHit[] = [...rrf.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, limit)
      .map(([path, rrfScore]) => {
        const ftsHit = ftsHits.find((h) => h.path === path);
        const scope =
          ftsHit?.scope ??
          this.lookupScope(path) ??
          (path.startsWith("turns/") ? "turns" : ("kb" as Scope)); // best guess
        return {
          path,
          scope,
          ftsScore: ftsHit?.ftsScore,
          vecScore: vecScores.get(path),
          rrfScore,
          snippet: ftsHit?.snippet ?? this.snippetForPath(path),
        };
      });
    return merged;
  }

  private lookupScope(path: string): Scope | undefined {
    if (path.startsWith("turns/")) return "turns";
    const row = this.db
      .prepare("SELECT scope FROM files WHERE path = ?")
      .get(path) as { scope?: Scope } | null;
    return row?.scope;
  }

  private snippetForPath(path: string): string {
    const isTurn = path.startsWith("turns/");
    const sql = isTurn
      ? "SELECT content AS text FROM turn_docs WHERE path = ? LIMIT 1"
      : "SELECT body AS text FROM notes WHERE path = ? LIMIT 1";
    const row = this.db.prepare(sql).get(path) as { text?: string } | null;
    return (row?.text ?? "").replace(/\s+/g, " ").trim().slice(0, 240);
  }

  private deletePath(path: string): void {
    this.db.prepare("DELETE FROM notes WHERE path = ?").run(path);
    this.db.prepare("DELETE FROM files WHERE path = ?").run(path);
    this.db.prepare("DELETE FROM note_links WHERE src_path = ?").run(path);
    this.db
      .prepare("DELETE FROM note_embeddings WHERE path = ?")
      .run(path);
  }

  private deleteTurnPath(path: string): void {
    this.db.prepare("DELETE FROM turn_docs WHERE path = ?").run(path);
    this.db.prepare("DELETE FROM turn_embeddings WHERE path = ?").run(path);
  }
}

function blobToFloat32(blob: Buffer | Uint8Array): Float32Array {
  // bun:sqlite may return either Buffer (Node-style) or Uint8Array.
  // Both expose .buffer + .byteOffset + .byteLength so we can construct
  // a Float32Array view without copying.
  return new Float32Array(blob.buffer, blob.byteOffset, blob.byteLength / 4);
}

/**
 * Resolve a relative markdown link target against the linking note's path to a
 * personaDir-relative note path (e.g. src "kb/infra/dns.md" + "../ops/ns" →
 * "kb/ops/ns.md"). Returns null for absolute URLs or links that escape the
 * persona tree. Exported for testing.
 */
export function resolveMdLink(srcPath: string, target: string): string | null {
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(target) || target.startsWith("/")) {
    return null;
  }
  const dir = posix.dirname(srcPath.replace(/\\/g, "/"));
  let rel = posix.normalize(posix.join(dir, target.replace(/\\/g, "/")));
  if (!/\.md$/i.test(rel)) rel += ".md";
  rel = rel.replace(/^\.\//, "");
  if (rel.startsWith("..")) return null;
  return rel;
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

export function turnPath(
  turn: Pick<Turn, "persona" | "conversation" | "id">,
): string {
  return `turns/${turn.persona}/${encodeURIComponent(turn.conversation)}/${turn.id}`;
}

export function renderTurnForIndex(
  turn: Pick<Turn, "role" | "text" | "createdAt">,
): string {
  return `[${turn.role} ${turn.createdAt.toISOString()}]\n${turn.text}`;
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
      // Store paths posix-style (forward slashes) on every OS. relative()
      // emits the platform separator, so Windows would record backslash
      // paths. That makes the index non-portable: move a persona's memory
      // between Linux and Windows and the first walk finds zero matching
      // rows, so every note is deleted and re-embedded (or, if the source
      // files are missing, the whole index is wiped). Normalising here keys
      // the index the same way everywhere. Downstream reads use join(), and
      // resolveMdLink/buildNameIndex already normalise, so this is safe.
      path: relative(dir.startsWith(root) ? dirname(root) : root, full).replace(
        /\\/g,
        "/",
      ),
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
