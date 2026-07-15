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
import type { Embedder } from "../src/lib/embedJob.ts";
import {
  flushDueConversationTurns,
  indexConversationTurnsIfDue,
  makeTurnIndexer,
  repairMissingTurnEmbeddings,
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
      repairBatchSize: 0,
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

/**
 * Repair pass for turns that reached FTS but whose embedding call failed.
 *
 * The trap being pinned here (phantombot#293): the indexer advances
 * `lastTurnId` past a turn whether or not its embed succeeded. A failed turn
 * therefore sits BEHIND the cursor, and every cursor-driven path — batch
 * trigger, age flush, sweep, and `memory index --turns --force` — selects work
 * via `turnsAfterId(..., lastTurnId)`. None of them can ever see it again. It
 * stays lexical-only forever, silently.
 */
describe("repairMissingTurnEmbeddings", () => {
  /** Stub embedder: fails while `failing` is true, otherwise returns a vector. */
  function stubEmbedder(): {
    embedder: Embedder;
    calls: () => number;
    setFailing: (v: boolean) => void;
  } {
    let failing = false;
    let calls = 0;
    const embedder: Embedder = async (_text: string) => {
      calls++;
      if (failing) return { ok: false, error: "429 rate limited" };
      return { ok: true, values: new Float32Array([0.1, 0.2, 0.3]), dims: 3 };
    };
    return {
      embedder,
      calls: () => calls,
      setFailing: (v) => {
        failing = v;
      },
    };
  }

  const settings = (over: Partial<typeof DEFAULT_RETRIEVAL.turnIndexing> = {}) => ({
    ...DEFAULT_RETRIEVAL.turnIndexing,
    interval: 1,
    flushAfterHours: 0,
    ...over,
  });

  /** How many indexed turns currently have no embedding row. */
  async function missingCount(): Promise<number> {
    const ix = await MemoryIndex.open(memoryIndexPath("phantom"));
    const n = ix.turnsMissingEmbeddings("phantom", 1_000).length;
    ix.close();
    return n;
  }

  async function embeddedCount(): Promise<number> {
    const db = new Database(memoryIndexPath("phantom"));
    const row = db
      .query("SELECT COUNT(*) AS c FROM turn_embeddings")
      .get() as { c: number };
    db.close();
    return row.c;
  }

  test("a failed embed leaves an FTS row with no vector, and the cursor moves past it", async () => {
    const stub = stubEmbedder();
    stub.setFailing(true);
    await appendPair(1);

    const r = await indexConversationTurnsIfDue({
      config: baseConfig(),
      persona: "phantom",
      conversation: "telegram:1001",
      memory,
      settings: settings(),
      embedder: stub.embedder,
    });

    expect(r?.triggered).toBe(true);
    expect(r?.embeddingFailures).toBe(2);
    expect(r?.embedded).toBe(0);
    // Searchable lexically...
    const ix = await MemoryIndex.open(memoryIndexPath("phantom"));
    expect(ix.search("Vesuvius pension", { scope: "turns" }).length).toBeGreaterThan(0);
    ix.close();
    // ...but with no vector at all.
    expect(await embeddedCount()).toBe(0);
    expect(await missingCount()).toBe(2);
  });

  test("no cursor-driven path can recover a failed turn — not even --force", async () => {
    // This is the bug. Fail the embed, then run the operator escape hatch
    // (force flush) with a HEALTHY embedder. It force-flushes the *tail*; it
    // does not rescan. So the stranded turns stay vector-less.
    const stub = stubEmbedder();
    stub.setFailing(true);
    await appendPair(1);
    await indexConversationTurnsIfDue({
      config: baseConfig(),
      persona: "phantom",
      conversation: "telegram:1001",
      memory,
      settings: settings(),
      embedder: stub.embedder,
    });
    expect(await embeddedCount()).toBe(0);

    // Embedder recovers. Force-flush, but with the repair pass disabled so we
    // isolate the cursor path.
    stub.setFailing(false);
    await indexConversationTurnsIfDue({
      config: baseConfig(),
      persona: "phantom",
      conversation: "telegram:1001",
      memory,
      settings: settings({ repairBatchSize: 0 }),
      force: true,
      embedder: stub.embedder,
    });

    // Still zero: force-flush only looks at turns AFTER lastTurnId.
    expect(await embeddedCount()).toBe(0);
    expect(await missingCount()).toBe(2);
  });

  test("the repair pass re-embeds turns stranded behind the cursor", async () => {
    const stub = stubEmbedder();
    stub.setFailing(true);
    await appendPair(1);
    await indexConversationTurnsIfDue({
      config: baseConfig(),
      persona: "phantom",
      conversation: "telegram:1001",
      memory,
      settings: settings(),
      embedder: stub.embedder,
    });
    expect(await embeddedCount()).toBe(0);

    stub.setFailing(false);
    const r = await repairMissingTurnEmbeddings({
      config: baseConfig(),
      persona: "phantom",
      settings: settings(),
      embedder: stub.embedder,
    });

    expect(r.repaired).toBe(2);
    expect(r.failures).toBe(0);
    expect(await embeddedCount()).toBe(2);
    expect(await missingCount()).toBe(0);
  });

  test("repair is idempotent — a second pass spends no embedding calls", async () => {
    const stub = stubEmbedder();
    stub.setFailing(true);
    await appendPair(1);
    await indexConversationTurnsIfDue({
      config: baseConfig(),
      persona: "phantom",
      conversation: "telegram:1001",
      memory,
      settings: settings(),
      embedder: stub.embedder,
    });

    stub.setFailing(false);
    await repairMissingTurnEmbeddings({
      config: baseConfig(),
      persona: "phantom",
      settings: settings(),
      embedder: stub.embedder,
    });
    const afterFirst = stub.calls();

    const second = await repairMissingTurnEmbeddings({
      config: baseConfig(),
      persona: "phantom",
      settings: settings(),
      embedder: stub.embedder,
    });

    expect(second.repaired).toBe(0);
    // A repaired turn now has an embedding row, so it drops out of the scan.
    expect(stub.calls()).toBe(afterFirst);
  });

  test("the heartbeat sweep self-heals a previously failed turn", async () => {
    // End-to-end: the sweep is what the 30-min heartbeat calls, so this is the
    // path that actually makes the bug self-correcting in production.
    const stub = stubEmbedder();
    stub.setFailing(true);
    await appendPair(1);
    await flushDueConversationTurns({
      config: baseConfig(),
      persona: "phantom",
      memory,
      settings: settings(),
      embedder: stub.embedder,
    });
    expect(await embeddedCount()).toBe(0);

    stub.setFailing(false);
    const sweep = await flushDueConversationTurns({
      config: baseConfig(),
      persona: "phantom",
      memory,
      settings: settings(),
      embedder: stub.embedder,
    });

    expect(sweep.repaired).toBe(2);
    expect(await embeddedCount()).toBe(2);
  });

  test("a quarantined turn is never resurrected by the repair pass", async () => {
    // Security invariant. A held untrusted payload (embeddable=0) has no
    // turn_docs row at all, so a scan rooted in turn_docs structurally cannot
    // reach it. The repair pass must not become a back door into the vector
    // index for quarantined content.
    const stub = stubEmbedder();
    stub.setFailing(true);
    await memory.appendTurn({
      persona: "phantom",
      conversation: "telegram:1001",
      role: "user",
      text: "Etna secret quarantined payload",
      embeddable: false,
    });
    await memory.appendTurn({
      persona: "phantom",
      conversation: "telegram:1001",
      role: "user",
      text: "Stromboli indexable",
      embeddable: true,
    });
    await indexConversationTurnsIfDue({
      config: baseConfig(),
      persona: "phantom",
      conversation: "telegram:1001",
      memory,
      settings: settings(),
      embedder: stub.embedder,
    });

    stub.setFailing(false);
    const r = await repairMissingTurnEmbeddings({
      config: baseConfig(),
      persona: "phantom",
      settings: settings(),
      embedder: stub.embedder,
    });

    // Only the embeddable turn was repaired — the quarantined one is invisible.
    expect(r.repaired).toBe(1);
    const ix = await MemoryIndex.open(memoryIndexPath("phantom"));
    expect(ix.search("Etna secret quarantined", { scope: "turns" })).toEqual([]);
    ix.close();
  });

  test("gives up early when the embedder is still down, instead of burning the budget", async () => {
    const stub = stubEmbedder();
    stub.setFailing(true);
    for (let i = 1; i <= 10; i++) await appendPair(i);
    await indexConversationTurnsIfDue({
      config: baseConfig(),
      persona: "phantom",
      conversation: "telegram:1001",
      memory,
      settings: settings(),
      embedder: stub.embedder,
    });
    const afterIndex = stub.calls();
    expect(await missingCount()).toBe(20);

    // Embedder is STILL failing. Budget is 20, but we should bail after a few
    // consecutive failures rather than firing 20 doomed calls at a provider
    // that is evidently rate-limiting us.
    const r = await repairMissingTurnEmbeddings({
      config: baseConfig(),
      persona: "phantom",
      settings: settings({ repairBatchSize: 20 }),
      embedder: stub.embedder,
    });

    expect(r.repaired).toBe(0);
    expect(r.failures).toBe(3);
    expect(stub.calls() - afterIndex).toBe(3);
    // Nothing lost — the tail is still there for the next sweep.
    expect(await missingCount()).toBe(20);
  });

  test("repairBatchSize bounds one pass, and 0 disables the repair", async () => {
    const stub = stubEmbedder();
    stub.setFailing(true);
    for (let i = 1; i <= 5; i++) await appendPair(i);
    await indexConversationTurnsIfDue({
      config: baseConfig(),
      persona: "phantom",
      conversation: "telegram:1001",
      memory,
      settings: settings(),
      embedder: stub.embedder,
    });
    expect(await missingCount()).toBe(10);

    stub.setFailing(false);

    const off = await repairMissingTurnEmbeddings({
      config: baseConfig(),
      persona: "phantom",
      settings: settings({ repairBatchSize: 0 }),
      embedder: stub.embedder,
    });
    expect(off.repaired).toBe(0);
    expect(await missingCount()).toBe(10);

    const bounded = await repairMissingTurnEmbeddings({
      config: baseConfig(),
      persona: "phantom",
      settings: settings({ repairBatchSize: 4 }),
      embedder: stub.embedder,
    });
    expect(bounded.repaired).toBe(4);
    expect(await missingCount()).toBe(6);
  });

  test("no embedder configured: nothing is treated as broken", async () => {
    // An embeddings-disabled install has zero vectors by design. The repair
    // pass must not decide the entire history is damaged and try to fix it.
    await appendPair(1);
    await indexConversationTurnsIfDue({
      config: baseConfig(),
      persona: "phantom",
      conversation: "telegram:1001",
      memory,
      settings: settings(),
    });

    const r = await repairMissingTurnEmbeddings({
      config: baseConfig(), // embeddings.provider = "none"
      persona: "phantom",
      settings: settings(),
    });

    expect(r.repaired).toBe(0);
    expect(r.failures).toBe(0);
  });
});
