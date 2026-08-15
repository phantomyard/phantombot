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
import type { FactSource } from "../config.ts";
import type { Turn } from "../memory/store.ts";
import { parseOkf } from "./okf.ts";

export type Scope = "memory" | "kb" | "turns";

/**
 * Audience class of a conversation turn — who was in the room when the
 * content was produced. Indexed with every turn so the retrieval layer can
 * enforce the confidentiality boundary IN SQL, not in prompt text:
 *
 *   a memory may surface only in a room at least as wide as the audience
 *   it was originally spoken to.
 *
 * private → private ✅ · multi-party → private ✅ · private → multi-party ❌
 * ("public" is reserved for future channels with an open audience.)
 */
export type TurnAudience = "private" | "multi-party" | "public";

/** Higher = more private. A candidate may surface in a room whose rank is
 * >= the candidate's own (see TurnAudience). */
export function audienceRank(a: TurnAudience): number {
  return a === "private" ? 2 : a === "multi-party" ? 1 : 0;
}

/** Audience classes eligible to surface in a room of `room` class. */
export function allowedAudiencesForRoom(room: TurnAudience): TurnAudience[] {
  const r = audienceRank(room);
  return (["private", "multi-party", "public"] as const).filter(
    (a) => audienceRank(a) <= r,
  );
}

/**
 * Derive a conversation's audience class from its key shape. Group keys
 * carry a `:group:` segment (`phantomchat:group:<id>`); Telegram group and
 * supergroup chat ids are negative (`telegram:-100…`). Everything else —
 * DMs, CLI, tick/system contexts — is private. Deriving from the key keeps
 * this free at index time (no LLM, no config), and the classification is
 * stable for the life of the conversation.
 */
export function conversationAudience(conversation: string): TurnAudience {
  if (conversation.includes(":group:")) return "multi-party";
  if (/^telegram:-/.test(conversation)) return "multi-party";
  return "private";
}

/**
 * SQL-side filter for conversation-turn candidate queries. Lets callers
 * exclude the current conversation and the tier-2 exclude list BEFORE the
 * LIMIT is applied (post-filtering a capped pool starves exactly the chats
 * tier 2 exists for), and restrict which audience classes may surface in
 * the current room.
 */
export interface TurnFilter {
  /** Exclude this exact conversation key (typically the current one). */
  excludeConversation?: string;
  /**
   * Tier-2 exclude list: an entry matches the full conversation key or a
   * channel prefix ("telegram" → every "telegram:*" conversation).
   */
  exclude?: readonly string[];
  /** Audience classes eligible to surface in the current room. */
  allowedAudiences?: readonly TurnAudience[];
}

/**
 * Time-decay parameters for raw conversation-turn ranking. Passed down from the
 * retrieval settings; when omitted, ranking is purely relevance-based (the
 * historical behaviour, still used by the CLI `memory search`). Decay applies
 * ONLY to `turns` — curated memory/ + kb/ notes are never aged.
 */
export interface TurnDecay {
  /** Half-life in days; `<= 0` disables (factor stays 1). */
  halfLifeDays: number;
  /** Lower bound on the multiplier so ancient turns damp but never hit 0. */
  floor: number;
  /** Injectable clock for tests; defaults to Date.now() at call time. */
  nowMs?: number;
}

/**
 * Multiplicative time-decay factor for a turn `ageDays` old: `0.5^(age/half)`,
 * clamped to `[floor, 1]`. A half-life of 0 (or less) disables decay → 1.
 * Exported for testing.
 */
export function turnDecayFactor(ageDays: number, decay: TurnDecay): number {
  if (decay.halfLifeDays <= 0) return 1;
  const f = Math.pow(0.5, Math.max(0, ageDays) / decay.halfLifeDays);
  return Math.max(decay.floor, Math.min(1, f));
}

/**
 * Extract the turn's creation time from an indexed `turn_docs.content` string.
 * renderTurnForIndex writes `[<role> <ISO8601>]\n<text>`, so the ISO timestamp
 * is the second whitespace-delimited token inside the leading bracket. Returns
 * undefined if the prefix doesn't match (older/hand-written rows) — callers
 * treat that as "no decay" rather than guessing an age. Exported for testing.
 */
export function parseTurnCreatedAtMs(content: string): number | undefined {
  const m = /^\[\S+ (\S+)\]/.exec(content);
  if (!m) return undefined;
  const t = Date.parse(m[1]!);
  return Number.isFinite(t) ? t : undefined;
}

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

/**
 * How many raw-BM25 turn candidates to pull before decay re-ranks them (per
 * search when decay is active). Wider than the usual `limit` so a fresh turn
 * that BM25 ranks just outside the top-N can climb in once older front-runners
 * are damped. 25 matches hybridSearch's internal candidate pool.
 */
const DECAY_CANDIDATE_POOL = 25;

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
  /**
   * Set by the auto-retrieval layer (orchestrator/retrieval.ts) when this
   * hit was surfaced from a DIFFERENT conversation than the current one
   * (tier-2 cross-conversation retrieval). Carries the decoded source
   * conversation key so the formatter can attribute it. Never set by the
   * index itself.
   */
  crossConversation?: string;
  /**
   * Provenance tier of a turn hit (who produced the content), carried from
   * the turn_docs.source column so the retrieval layer can weigh where a
   * memory came from. Only set for conversation-turn hits.
   */
  source?: FactSource;
  /**
   * Audience class of a turn hit (who was in the room), carried from the
   * turn_docs.audience column so retrieval can enforce the cross-room
   * confidentiality boundary. Only set for conversation-turn hits.
   */
  audience?: TurnAudience;
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

/**
 * Version of the turn_docs schema. Unlike the notes tables, turn rows are
 * derived from the turns STORE (not from files on disk), so a schema bump
 * drops turn_docs and clears turn_index_state — the next turn-indexer run
 * re-walks the store and repopulates. turn_embeddings SURVIVES: the
 * indexer reuses any embedding whose text_sha still matches, so a rebuild
 * costs no embed API calls.
 *
 * v1 → v2: `source` (provenance tier) and `audience` (room class) columns
 * added so cross-conversation retrieval can enforce the audience boundary
 * and weigh provenance in SQL instead of prompt text (PR #378 review).
 */
export const TURN_SCHEMA_VERSION = 2;

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
  source UNINDEXED,
  audience UNINDEXED,
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
    this.selfHealTurnSchema();
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

  /**
   * If the persisted turn-schema version is older than TURN_SCHEMA_VERSION
   * (or absent while turn_docs holds rows, i.e. a pre-versioning index),
   * drop turn_docs and clear turn_index_state: the next turn-indexer run
   * re-walks the turns store and repopulates with the new columns.
   * turn_embeddings is deliberately NOT dropped — the indexer reuses any
   * embedding whose text_sha still matches, so the rebuild costs no embed
   * API calls. Cheap and idempotent.
   */
  private selfHealTurnSchema(): void {
    const row = this.db
      .query("SELECT value FROM meta WHERE key = 'turn_schema_version'")
      .get() as { value?: string } | null;
    const have = row?.value ? Number(row.value) : 0;
    if (have >= TURN_SCHEMA_VERSION) return;
    // Meta rows are only written by versions that already self-heal, so a
    // missing/low stamp alone isn't proof of an old layout — an old EMPTY
    // index has no meta row either. The authoritative check is the column
    // set itself: if `source` is present the table is already v2-shaped
    // (fresh DBs land here) and only needs the stamp.
    const cols = this.db
      .query("PRAGMA table_info(turn_docs)")
      .all() as Array<{ name: string }>;
    if (cols.some((c) => c.name === "source")) {
      this.stampTurnSchemaVersion();
      return;
    }
    this.db.exec("DROP TABLE IF EXISTS turn_docs;");
    this.db.exec(SCHEMA);
    this.db.exec("DELETE FROM turn_index_state;");
    this.stampTurnSchemaVersion();
  }

  private stampTurnSchemaVersion(): void {
    this.db
      .prepare(
        "INSERT INTO meta (key, value) VALUES ('turn_schema_version', ?) " +
          "ON CONFLICT(key) DO UPDATE SET value = excluded.value",
      )
      .run(String(TURN_SCHEMA_VERSION));
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
    // Delete ONLY the turn_docs row. Turn paths are id-keyed and turn text
    // is immutable, so a surviving turn_embeddings row for this path always
    // matches the content being (re-)inserted — keeping it is what makes a
    // turn-schema rebuild cost zero embed API calls. A stale embedding can
    // only be orphaned if the embed call fails on a genuinely changed text,
    // which the id-keyed path makes impossible.
    this.db.prepare("DELETE FROM turn_docs WHERE path = ?").run(path);
    this.db
      .prepare(
        "INSERT INTO turn_docs (path, persona, conversation, role, turn_id, source, audience, content) " +
          "VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
      )
      .run(
        path,
        turn.persona,
        turn.conversation,
        turn.role,
        turn.id,
        turn.source,
        conversationAudience(turn.conversation),
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

  /**
   * Write ONLY the embedding row for an already-indexed turn. Unlike
   * upsertTurn this never touches turn_docs, so the repair pass can add a
   * missing vector without rewriting (or accidentally duplicating) the FTS
   * row that is already there and correct.
   */
  upsertTurnEmbedding(path: string, vec: Float32Array, textSha: string): void {
    const buf = Buffer.from(vec.buffer, vec.byteOffset, vec.byteLength);
    this.db
      .prepare(
        "INSERT OR REPLACE INTO turn_embeddings " +
          "(path, vec, text_sha, embedded_at) VALUES (?, ?, ?, ?)",
      )
      .run(path, buf, textSha, new Date().toISOString());
  }

  /**
   * Turns that made it into the FTS index but have no embedding — i.e. the
   * embed call failed at index time. Found by scanning for the *absence* of
   * an embedding row rather than by walking the turn cursor, which is the
   * whole point: these rows sit behind `last_turn_id`, so every cursor-driven
   * path skips them permanently.
   *
   * Quarantined turns (embeddable=0) are structurally excluded — the indexer
   * never writes a turn_docs row for them at all, so a scan rooted in
   * turn_docs cannot reach one. The repair pass therefore cannot resurrect a
   * held untrusted payload into the vector index, by construction and not by
   * a filter someone could later drop.
   *
   * `content` is returned straight from the FTS row, so the text we re-embed
   * is byte-identical to the text that is searchable — no round-trip to the
   * raw turn store, and no risk of the two drifting.
   */
  turnsMissingEmbeddings(
    persona: string,
    limit: number,
  ): Array<{ path: string; content: string }> {
    if (limit <= 0) return [];
    return this.db
      .prepare(
        `SELECT d.path AS path, d.content AS content
           FROM turn_docs d
           LEFT JOIN turn_embeddings e ON e.path = d.path
          WHERE d.persona = ? AND e.path IS NULL
          LIMIT ?`,
      )
      .all(persona, Math.floor(limit)) as Array<{
      path: string;
      content: string;
    }>;
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

  /**
   * Compile a TurnFilter into SQL AND-clauses (with bound params) for the
   * turn_docs queries. Filtering in SQL — before ORDER BY … LIMIT — means
   * every slot in the candidate pool is an ELIGIBLE hit; post-filtering a
   * capped pool in JS starves tier 2 exactly when the current chat matches
   * its own query best (Kai's PR #378 review).
   */
  private turnFilterSql(filter: TurnFilter | undefined): {
    where: string;
    params: string[];
  } {
    if (!filter) return { where: "", params: [] };
    const clauses: string[] = [];
    const params: string[] = [];
    if (filter.excludeConversation !== undefined) {
      clauses.push("conversation != ?");
      params.push(filter.excludeConversation);
    }
    for (const e of filter.exclude ?? []) {
      // Full-key match OR channel-prefix match, mirroring
      // isConversationExcluded. substr() instead of LIKE so `_`/`%` in a
      // key can never act as wildcards.
      clauses.push("conversation != ? AND substr(conversation, 1, ?) != ?");
      params.push(e, String(e.length + 1), `${e}:`);
    }
    if (filter.allowedAudiences && filter.allowedAudiences.length > 0) {
      clauses.push(
        `audience IN (${filter.allowedAudiences.map(() => "?").join(", ")})`,
      );
      params.push(...filter.allowedAudiences);
    }
    return {
      where: clauses.length > 0 ? ` AND ${clauses.join(" AND ")}` : "",
      params,
    };
  }

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
      /**
       * Time-decay for turn hits (see TurnDecay). When set, turn scores are
       * multiplied by a half-life factor before the final sort/slice, so a
       * fresh turn beyond the raw-BM25 top-N can still surface over a stale
       * ghost. Omitted → relevance-only ranking (CLI `memory search`).
       */
      decay?: TurnDecay;
      /**
       * SQL-side candidate filter for turn rows (see TurnFilter). Applied
       * before LIMIT so the pool contains only eligible hits. Combinable
       * with `conversation` (both clauses apply).
       */
      turnFilter?: TurnFilter;
    } = {},
  ): SearchHit[] {
    const limit = Math.max(1, Math.min(opts.limit ?? 5, 50));
    const scope = opts.scope ?? "all";
    if (!query.trim()) return [];

    const ftsQuery = sanitizeFtsQuery(query);

    // When decay is active, pull a wider pool of turn candidates than `limit`
    // before re-ranking: a fresh turn that BM25 puts just outside the top-N
    // should be able to climb in once the stale front-runners are damped.
    // Notes are unaffected (immune to decay), so their pool stays at `limit`.
    const turnLimit = opts.decay ? Math.max(limit, DECAY_CANDIDATE_POOL) : limit;

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

    const tf = this.turnFilterSql(opts.turnFilter);
    const turnRows =
      scope === "all" || scope === "turns"
        ? opts.conversation !== undefined
          ? (this.db
              .query(
                "SELECT path, source, audience, bm25(turn_docs) AS rank, " +
                  "snippet(turn_docs, 7, '«', '»', ' … ', 16) AS snip " +
                  "FROM turn_docs WHERE content MATCH ? AND conversation = ? " +
                  tf.where +
                  " ORDER BY rank LIMIT ?",
              )
              .all(ftsQuery, opts.conversation, ...tf.params, turnLimit) as Array<{
              path: string;
              source: FactSource;
              audience: TurnAudience;
              rank: number;
              snip: string;
            }>)
          : (this.db
              .query(
                "SELECT path, source, audience, bm25(turn_docs) AS rank, " +
                  "snippet(turn_docs, 7, '«', '»', ' … ', 16) AS snip " +
                  "FROM turn_docs WHERE content MATCH ? " +
                  tf.where +
                  " ORDER BY rank LIMIT ?",
              )
              .all(ftsQuery, ...tf.params, turnLimit) as Array<{
              path: string;
              source: FactSource;
              audience: TurnAudience;
              rank: number;
              snip: string;
            }>)
        : [];

    // Turn scores get time-decayed (curated notes are immune); look up each
    // candidate turn's age once, in a single batched query.
    const decayFactors = opts.decay
      ? this.turnDecayFactors(
          turnRows.map((r) => r.path),
          opts.decay,
        )
      : undefined;

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
        // Decay damps stale turns (factor in [floor,1]); default 1 when decay
        // is off or the turn's age couldn't be parsed.
        ftsScore: -r.rank * (decayFactors?.get(r.path) ?? 1),
        source: r.source ?? undefined,
        audience: r.audience ?? undefined,
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
      /** Time-decay for turn hits (see TurnDecay); forwarded to search(). */
      decay?: TurnDecay;
      /** SQL-side turn candidate filter; forwarded to search(). */
      turnFilter?: TurnFilter;
    } = {},
  ): SearchHit[] {
    const limit = Math.max(1, Math.min(opts.limit ?? 5, 50));
    const hits = this.search(query, {
      scope: opts.scope,
      limit,
      conversation: opts.conversation,
      decay: opts.decay,
      turnFilter: opts.turnFilter,
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
      /**
       * Time-decay for turn hits (see TurnDecay). Applied ONCE, to the final
       * fused RRF scores of turn paths, before the top-`limit` slice. The inner
       * FTS/vector candidate lists stay relevance-ordered so RRF fuses on merit
       * and decay isn't double-counted.
       */
      decay?: TurnDecay;
      /**
       * SQL-side turn candidate filter (see TurnFilter). Applied to BOTH the
       * inner FTS search and the vector allowed-paths set, so ineligible
       * turns never occupy a candidate slot on either ranking.
       */
      turnFilter?: TurnFilter;
    } = {},
  ): SearchHit[] {
    const limit = Math.max(1, Math.min(opts.limit ?? 5, 50));
    const ftsHits = this.search(query, {
      scope: opts.scope,
      limit: 25,
      conversation: opts.conversation,
      turnFilter: opts.turnFilter,
    });

    // No vector → FTS-only fallback. Still honour decay here (the inner search
    // above is left undecayed so the RRF path below fuses on raw relevance),
    // otherwise a vector-less call would silently skip decay.
    if (!queryVec || queryVec.length === 0) {
      if (!opts.decay) return ftsHits.slice(0, limit);
      const factors = this.turnDecayFactors(
        ftsHits.map((h) => h.path),
        opts.decay,
      );
      return [...ftsHits]
        .sort(
          (a, b) =>
            (b.ftsScore ?? 0) * (factors.get(b.path) ?? 1) -
            (a.ftsScore ?? 0) * (factors.get(a.path) ?? 1),
        )
        .slice(0, limit);
    }

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
    if (
      searchScope !== "all" ||
      conversation !== undefined ||
      opts.turnFilter !== undefined
    ) {
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
      // Conversation turns: scoped to the current conversation when provided,
      // and always through the SQL turn filter (audience/exclusions).
      if (searchScope === "all" || searchScope === "turns") {
        const tf = this.turnFilterSql(opts.turnFilter);
        const turnRows =
          conversation !== undefined
            ? (this.db
                .query(
                  "SELECT path FROM turn_docs WHERE conversation = ?" + tf.where,
                )
                .all(conversation, ...tf.params) as Array<{ path: string }>)
            : (this.db
                .query(
                  "SELECT path FROM turn_docs WHERE 1 = 1" + tf.where,
                )
                .all(...tf.params) as Array<{ path: string }>);
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

    // Time-decay the fused scores of turn paths (curated notes are immune), so
    // a stale turn that fused high on raw relevance still sinks below a fresher
    // one. Done here — after the merge, before the slice — so decay is applied
    // exactly once and can reorder the whole candidate pool. `rrfScore` in the
    // emitted hit stays the RAW fused score (what callers threshold on); only
    // the ordering key carries the decay multiplier.
    const decayFactors = opts.decay
      ? this.turnDecayFactors([...rrf.keys()], opts.decay)
      : undefined;
    const orderKey = (path: string, rrfScore: number): number =>
      rrfScore * (decayFactors?.get(path) ?? 1);

    // Build the final hit list, ordered by decay-adjusted rrf score, including
    // both sub-scores when available.
    const merged: SearchHit[] = [...rrf.entries()]
      .sort((a, b) => orderKey(b[0], b[1]) - orderKey(a[0], a[1]))
      .slice(0, limit)
      .map(([path, rrfScore]) => {
        const ftsHit = ftsHits.find((h) => h.path === path);
        const scope =
          ftsHit?.scope ??
          this.lookupScope(path) ??
          (path.startsWith("turns/") ? "turns" : ("kb" as Scope)); // best guess
        const turnMeta =
          ftsHit?.source !== undefined
            ? { source: ftsHit.source, audience: ftsHit.audience }
            : this.turnMetaForPath(path);
        return {
          path,
          scope,
          ftsScore: ftsHit?.ftsScore,
          vecScore: vecScores.get(path),
          rrfScore,
          ...turnMeta,
          snippet: ftsHit?.snippet ?? this.snippetForPath(path),
        };
      });
    // Per-path BM25 lookup: vector-only turn hits (those not in the FTS
    // top-25 pool) have ftsScore === undefined. Fetch their actual BM25
    // score directly so the tier-2 dual-gate (cosine ≥ minVecScore AND
    // fts > 0) works as documented — without this, a vector hit ranked
    // 26th+ lexically is silently dropped by pool truncation, not by the
    // score rule, quietly degrading tier 2 to cosine-only on busy indexes.
    // (Robbie's non-blocking finding on #378, resolved.)
    const vecOnlyTurnPaths = merged
      .filter((h) => h.ftsScore === undefined && h.path.startsWith("turns/"))
      .map((h) => h.path);
    if (vecOnlyTurnPaths.length > 0) {
      const ftsQuery2 = sanitizeFtsQuery(query);
      const ph = vecOnlyTurnPaths.map(() => "?").join(", ");
      const tf2 = this.turnFilterSql(opts.turnFilter);
      const rows2 = this.db
        .query(
          "SELECT path, bm25(turn_docs) AS rank FROM turn_docs " +
            "WHERE content MATCH ? AND path IN (" + ph + ") " +
            tf2.where +
            " ORDER BY rank",
        )
        .all(ftsQuery2, ...vecOnlyTurnPaths, ...tf2.params) as Array<{
        path: string;
        rank: number;
      }>;
      for (const r of rows2) {
        const hit = merged.find((h) => h.path === r.path);
        if (hit) {
          // bm25() is "lower is better"; flip sign. Keep raw — pool hits
          // from search() carry undecayed ftsScore, and the tier-2 floor
          // (minScore: 2.0) is calibrated on raw BM25. Decaying here would
          // inflate the threshold for aged content, narrowing tier 2.
          hit.ftsScore = -r.rank;
        }
      }
    }

    return merged;
  }

  /** Provenance/audience for a turn path (undefined for non-turn paths). */
  private turnMetaForPath(
    path: string,
  ): { source?: FactSource; audience?: TurnAudience } {
    if (!path.startsWith("turns/")) return {};
    const row = this.db
      .query("SELECT source, audience FROM turn_docs WHERE path = ? LIMIT 1")
      .get(path) as
      | { source?: FactSource | null; audience?: TurnAudience | null }
      | null;
    return {
      source: row?.source ?? undefined,
      audience: row?.audience ?? undefined,
    };
  }

  /**
   * Map each candidate `turns/…` path to its decay multiplier. Non-turn paths
   * are skipped (they're immune → caller defaults them to 1). Ages come from
   * the ISO timestamp renderTurnForIndex bakes into each turn's content, so no
   * schema change or extra column is needed. A single batched query fetches all
   * candidate contents; rows whose age can't be parsed are omitted (→ factor 1,
   * i.e. no decay rather than a guessed age).
   */
  private turnDecayFactors(
    paths: string[],
    decay: TurnDecay,
  ): Map<string, number> {
    const factors = new Map<string, number>();
    const turnPaths = paths.filter((p) => p.startsWith("turns/"));
    if (turnPaths.length === 0) return factors;
    const now = decay.nowMs ?? Date.now();
    const placeholders = turnPaths.map(() => "?").join(", ");
    const rows = this.db
      .query(
        `SELECT path, content FROM turn_docs WHERE path IN (${placeholders})`,
      )
      .all(...turnPaths) as Array<{ path: string; content: string }>;
    for (const r of rows) {
      const createdMs = parseTurnCreatedAtMs(r.content);
      if (createdMs === undefined) continue;
      const ageDays = (now - createdMs) / 86_400_000;
      factors.set(r.path, turnDecayFactor(ageDays, decay));
    }
    return factors;
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
    // Store paths posix-style (forward slashes) on every OS. relative()
    // emits the platform separator, so Windows would record backslash
    // paths. That makes the index non-portable: move a persona's memory
    // between Linux and Windows and the first walk finds zero matching
    // rows, so every note is deleted and re-embedded (or, if the source
    // files are missing, the whole index is wiped). Normalising here keys
    // the index the same way everywhere. Downstream reads use join(), and
    // resolveMdLink/buildNameIndex already normalise, so this is safe.
    //
    // The replace is gated to Windows only: on POSIX a backslash is a legal
    // filename character, so rewriting it there could corrupt a path for a
    // note literally named with a backslash. Windows separators are always
    // backslashes, so the guard is safe and leaves Linux/Mac paths untouched.
    const rel = relative(dir.startsWith(root) ? dirname(root) : root, full);
    out.push({
      path: process.platform === "win32" ? rel.replace(/\\/g, "/") : rel,
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
