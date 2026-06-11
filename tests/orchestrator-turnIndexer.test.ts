/**
 * Tests for conversation-turn indexing cadence.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
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
    const settings = { enabled: true, interval: 1, batchSize: 200 };

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
