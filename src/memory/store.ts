/**
 * Memory store. STUB.
 *
 * Plan: SQLite + sqlite-vec for vector search.
 *
 * The store needs four operations:
 *   - appendTurn(conversationId, role, text, ts)
 *   - getRecentTurns(conversationId, n)
 *   - vectorSearch(query, k)         // top-k semantically similar past turns
 *   - close()
 *
 * Don't add an ORM. SQL strings are fine for this volume. Don't add a
 * migrations framework either — schema_version pragma + a switch in the
 * constructor handles it.
 *
 * If sqlite-vec is awkward to install or use, fall back to literal full-text
 * search via SQLite FTS5. Phantom's memory volume is low; an exhaustive scan
 * over a year of conversation is fine.
 */

export interface StoredTurn {
  conversationId: string;
  role: "user" | "assistant";
  text: string;
  timestamp: Date;
}

export interface MemoryStore {
  appendTurn(turn: StoredTurn): Promise<void>;
  getRecentTurns(conversationId: string, n: number): Promise<StoredTurn[]>;
  vectorSearch(query: string, k: number): Promise<StoredTurn[]>;
  close(): Promise<void>;
}

export async function openMemoryStore(_path: string): Promise<MemoryStore> {
  // TODO: open SQLite, run schema migration, return implementation
  return new NotYetImplementedStore();
}

class NotYetImplementedStore implements MemoryStore {
  async appendTurn(_turn: StoredTurn): Promise<void> {
    /* no-op until implemented */
  }
  async getRecentTurns(_conversationId: string, _n: number): Promise<StoredTurn[]> {
    return [];
  }
  async vectorSearch(_query: string, _k: number): Promise<StoredTurn[]> {
    return [];
  }
  async close(): Promise<void> {
    /* no-op */
  }
}
