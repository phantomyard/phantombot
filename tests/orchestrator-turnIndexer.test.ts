/**
 * Tests for conversation-turn indexing cadence.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  DEFAULT_RETRIEVAL,
  memoryIndexPath,
  type Config,
} from "../src/config.ts";
import { MemoryIndex } from "../src/lib/memoryIndex.ts";
import { openMemoryStore, type MemoryStore } from "../src/memory/store.ts";
import {
  flushDueConversationTurns,
  indexConversationTurnsIfDue,
  makeTurnIndexer,
} from "../src/orchestrator/turnIndexer.ts";

let workdir: string;
let savedXdgDataHome: string | undefined;
let memory: MemoryStore;

beforeEach(async () => {
  workdir = await mkdtemp(join(tmpdir(), "phantombot-turn-index-"));
  savedXdgDataHome = process.env.XDG_DATA_HOME;
  process.env.XDG_DATA_HOME = workdir;
  memory = await openMemoryStore(":memory:");
});

afterEach(async () => {
  await memory.close();
  if (savedXdgDataHome === undefined) delete process.env.XDG_DATA_HOME;
  else process.env.XDG_DATA_HOME = savedXdgDataHome;
  await rm(workdir, { recursive: true, force: true });
});

const baseConfig = (retrieval: Config["retrieval"] = DEFAULT_RETRIEVAL): Config =>
  ({
    defaultPersona: "phantom",
    embeddings: { provider: "none" },
    retrieval,
  }) as unknown as Config;

async function appendPair(i: number): Promise<void> {
  await memory.appendTurn({
    persona: "phantom",
    conversation: "telegram:1001",
    role: "user",
    text: `user turn ${i} Vesuvius pension`,
  });
  await memory.appendTurn({
    persona: "phantom",
    conversation: "telegram:1001",
    role: "assistant",
    text: `assistant turn ${i}`,
  });
}

describe("indexConversationTurnsIfDue", () => {
  test("skips before the configured user-turn interval", async () => {
    for (let i = 1; i <= 19; i++) await appendPair(i);

    const result = await indexConversationTurnsIfDue({
      config: baseConfig(),
      persona: "phantom",
      conversation: "telegram:1001",
      memory,
      settings: DEFAULT_RETRIEVAL.turnIndexing,
    });

    expect(result?.triggered).toBe(false);
    const ix = await MemoryIndex.open(memoryIndexPath("phantom"));
    expect(ix.search("Vesuvius pension", { scope: "turns" })).toEqual([]);
    ix.close();
  });

  test("indexes all unindexed turns once the 20-user-turn trigger is reached", async () => {
    for (let i = 1; i <= 20; i++) await appendPair(i);

    const result = await indexConversationTurnsIfDue({
      config: baseConfig(),
      persona: "phantom",
      conversation: "telegram:1001",
      memory,
      settings: DEFAULT_RETRIEVAL.turnIndexing,
    });

    expect(result?.triggered).toBe(true);
    expect(result?.indexed).toBe(40);
    expect(result?.userTurns).toBe(20);

    const ix = await MemoryIndex.open(memoryIndexPath("phantom"));
    const hits = ix.search("Vesuvius pension", { scope: "turns", limit: 3 });
    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0]?.scope).toBe("turns");
    expect(ix.turnIndexState("phantom", "telegram:1001")?.userTurnsIndexed).toBe(20);
    ix.close();
  });

  test("skips a quarantined turn (embeddable=false) but advances the cursor past it", async () => {
    // A held-episode quarantined user turn must never be indexed/embedded, but
    // it still counts as processed so the cursor moves past it; a following
    // embeddable turn IS indexed. Use interval 1 so a single user turn triggers.
    const settings = {
      enabled: true,
      interval: 1,
      batchSize: 200,
      flushAfterHours: 0,
    };

    // Quarantined raw payload (would otherwise FTS-match "Etna secret").
    await memory.appendTurn({
      persona: "phantom",
      conversation: "telegram:1001",
      role: "user",
      text: "Etna secret quarantined payload",
      embeddable: false,
    });
    // A normal, indexable turn that should surface.
    await memory.appendTurn({
      persona: "phantom",
      conversation: "telegram:1001",
      role: "assistant",
      text: "Stromboli indexable reasoning",
      embeddable: true,
    });

    const result = await indexConversationTurnsIfDue({
      config: baseConfig(),
      persona: "phantom",
      conversation: "telegram:1001",
      memory,
      settings,
    });

    expect(result?.triggered).toBe(true);
    // Both rows are "processed" (cursor advanced past both)...
    expect(result?.indexed).toBe(2);

    const ix = await MemoryIndex.open(memoryIndexPath("phantom"));
    // ...but only the embeddable one is searchable; the quarantined payload
    // never entered the index.
    expect(ix.search("Stromboli indexable", { scope: "turns" }).length).toBeGreaterThan(0);
    expect(ix.search("Etna secret quarantined", { scope: "turns" })).toEqual([]);
    ix.close();
  });

  test("second trigger only indexes turns since the previous state", async () => {
    for (let i = 1; i <= 20; i++) await appendPair(i);
    await indexConversationTurnsIfDue({
      config: baseConfig(),
      persona: "phantom",
      conversation: "telegram:1001",
      memory,
      settings: DEFAULT_RETRIEVAL.turnIndexing,
    });
    for (let i = 21; i <= 40; i++) await appendPair(i);

    const result = await indexConversationTurnsIfDue({
      config: baseConfig(),
      persona: "phantom",
      conversation: "telegram:1001",
      memory,
      settings: DEFAULT_RETRIEVAL.turnIndexing,
    });

    expect(result?.triggered).toBe(true);
    expect(result?.indexed).toBe(40);
    expect(result?.previousUserTurnsIndexed).toBe(20);
    expect(result?.userTurns).toBe(40);
  });
});

describe("time-based and forced flush", () => {
  // These tests need to age turns into the past. The store auto-stamps
  // created_at to "now", so we use a file-backed DB and backdate every row
  // via a second connection — the only way to simulate a stale tail.
  async function openFileStore(): Promise<{ store: MemoryStore; path: string }> {
    const path = join(workdir, `mem-${Math.random().toString(36).slice(2)}.sqlite`);
    return { store: await openMemoryStore(path), path };
  }

  async function appendUserPair(
    store: MemoryStore,
    conversation: string,
    i: number,
  ): Promise<void> {
    await store.appendTurn({
      persona: "phantom",
      conversation,
      role: "user",
      text: `aged turn ${i} Vesuvius pension`,
    });
    await store.appendTurn({
      persona: "phantom",
      conversation,
      role: "assistant",
      text: `assistant turn ${i}`,
    });
  }

  function backdateAllTurns(path: string, hoursAgo: number): void {
    const raw = new Database(path);
    const ts = new Date(Date.now() - hoursAgo * 3_600_000).toISOString();
    raw.prepare("UPDATE turns SET created_at = ?").run(ts);
    raw.close();
  }

  test("flushes a sub-threshold tail older than flushAfterHours without a 20th message", async () => {
    const { store, path } = await openFileStore();
    try {
      // 19 user turns — one short of the 20-turn batch.
      for (let i = 1; i <= 19; i++) await appendUserPair(store, "telegram:2002", i);
      backdateAllTurns(path, 3); // age the whole tail 3h into the past

      const settings = { ...DEFAULT_RETRIEVAL.turnIndexing, flushAfterHours: 2 };
      const result = await indexConversationTurnsIfDue({
        config: baseConfig(),
        persona: "phantom",
        conversation: "telegram:2002",
        memory: store,
        settings,
      });

      expect(result?.triggered).toBe(true);
      expect(result?.indexed).toBe(38); // 19 user + 19 assistant rows
      const ix = await MemoryIndex.open(memoryIndexPath("phantom"));
      expect(
        ix.search("Vesuvius pension", { scope: "turns" }).length,
      ).toBeGreaterThan(0);
      ix.close();
    } finally {
      await store.close();
    }
  });

  test("does NOT flush a fresh sub-threshold tail (younger than flushAfterHours)", async () => {
    const { store } = await openFileStore();
    try {
      for (let i = 1; i <= 19; i++) await appendUserPair(store, "telegram:2003", i);
      // No backdating: the tail is brand new, so the 2h window hasn't elapsed.
      const settings = { ...DEFAULT_RETRIEVAL.turnIndexing, flushAfterHours: 2 };
      const result = await indexConversationTurnsIfDue({
        config: baseConfig(),
        persona: "phantom",
        conversation: "telegram:2003",
        memory: store,
        settings,
      });

      expect(result?.triggered).toBe(false);
    } finally {
      await store.close();
    }
  });

  test("flushAfterHours = 0 disables the time-based flush", async () => {
    const { store, path } = await openFileStore();
    try {
      for (let i = 1; i <= 19; i++) await appendUserPair(store, "telegram:2004", i);
      backdateAllTurns(path, 100); // very old, but time flush is disabled
      const settings = { ...DEFAULT_RETRIEVAL.turnIndexing, flushAfterHours: 0 };
      const result = await indexConversationTurnsIfDue({
        config: baseConfig(),
        persona: "phantom",
        conversation: "telegram:2004",
        memory: store,
        settings,
      });

      expect(result?.triggered).toBe(false);
    } finally {
      await store.close();
    }
  });

  test("force flushes a fresh sub-threshold tail regardless of count or age", async () => {
    const { store } = await openFileStore();
    try {
      for (let i = 1; i <= 5; i++) await appendUserPair(store, "telegram:2005", i);
      const result = await indexConversationTurnsIfDue({
        config: baseConfig(),
        persona: "phantom",
        conversation: "telegram:2005",
        memory: store,
        settings: DEFAULT_RETRIEVAL.turnIndexing,
        force: true,
      });

      expect(result?.triggered).toBe(true);
      expect(result?.indexed).toBe(10);
    } finally {
      await store.close();
    }
  });

  test("flushDueConversationTurns sweeps every conversation (force backfill)", async () => {
    const { store } = await openFileStore();
    try {
      for (let i = 1; i <= 3; i++) await appendUserPair(store, "telegram:3001", i);
      for (let i = 1; i <= 4; i++) await appendUserPair(store, "telegram:3002", i);

      // listConversations underpins the sweep.
      expect(await store.listConversations("phantom")).toEqual([
        "telegram:3001",
        "telegram:3002",
      ]);

      const summary = await flushDueConversationTurns({
        config: baseConfig(),
        persona: "phantom",
        memory: store,
        settings: DEFAULT_RETRIEVAL.turnIndexing,
        force: true,
      });

      expect(summary.conversations).toBe(2);
      expect(summary.triggered).toBe(2);
      expect(summary.indexed).toBe(14); // (3 + 4) pairs × 2 rows
    } finally {
      await store.close();
    }
  });
});

describe("makeTurnIndexer", () => {
  test("returns undefined when retrieval or turn indexing is disabled", () => {
    expect(
      makeTurnIndexer(
        baseConfig({ ...DEFAULT_RETRIEVAL, enabled: false }),
        "phantom",
        "telegram:1001",
        memory,
      ),
    ).toBeUndefined();
    expect(
      makeTurnIndexer(
        baseConfig({
          ...DEFAULT_RETRIEVAL,
          turnIndexing: {
            ...DEFAULT_RETRIEVAL.turnIndexing,
            enabled: false,
          },
        }),
        "phantom",
        "telegram:1001",
        memory,
      ),
    ).toBeUndefined();
  });

  test("returns a callable indexer when enabled", () => {
    const fn = makeTurnIndexer(
      baseConfig(),
      "phantom",
      "telegram:1001",
      memory,
    );
    expect(typeof fn).toBe("function");
  });
});
