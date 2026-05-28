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
import type { Turn } from "../memory/store.ts";

export type Scope = "memory" | "kb" | "turns";

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

    const noteRows =
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
    const table = path.startsWith("turns/") ? "turn_docs" : "notes";
    const row = this.db
      .prepare(`SELECT content FROM ${table} WHERE path = ? LIMIT 1`)
      .get(path) as { content?: string } | null;
    return (row?.content ?? "").replace(/\s+/g, " ").trim().slice(0, 240);
  }

  private deletePath(path: string): void {
    this.db.prepare("DELETE FROM notes WHERE path = ?").run(path);
    this.db.prepare("DELETE FROM files WHERE path = ?").run(path);
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
