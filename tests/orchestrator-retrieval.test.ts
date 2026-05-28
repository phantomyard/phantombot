/**
 * Tests for turn-time auto-retrieval (orchestrator/retrieval.ts).
 *
 * Three units:
 *   - formatRetrieved   — pure formatter (filtering, budget, framing)
 *   - retrieveContext   — real FTS5 index over temp files; hybrid via a
 *                         mocked embed fetch; never-throws guarantee
 *   - makeRetriever     — config gating (undefined / disabled / enabled)
 *
 * No network: the Gemini embed call is injected via fetchImpl.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { DEFAULT_RETRIEVAL, type Config } from "../src/config.ts";
import { MemoryIndex } from "../src/lib/memoryIndex.ts";
import {
  formatRetrieved,
  makeRetriever,
  retrieveContext,
} from "../src/orchestrator/retrieval.ts";

// ---------------------------------------------------------------------------
// formatRetrieved — pure
// ---------------------------------------------------------------------------

describe("formatRetrieved", () => {
  const settings = { ...DEFAULT_RETRIEVAL };

  test("returns undefined when there are no hits", () => {
    expect(formatRetrieved([], settings)).toBeUndefined();
  });

  test("includes a background-not-instructions framing header", () => {
    const out = formatRetrieved(
      [{ path: "kb/x.md", scope: "kb", ftsScore: 1, snippet: "hello" }],
      settings,
    );
    expect(out).toBeDefined();
    expect(out!).toContain("background context, not");
    expect(out!).toContain("memory get");
  });

  test("lists each hit's path and snippet", () => {
    const out = formatRetrieved(
      [
        { path: "memory/decisions.md", scope: "memory", ftsScore: 2, snippet: "chose deye" },
        { path: "kb/infra/Inverter.md", scope: "kb", ftsScore: 1, snippet: "sun-12k" },
      ],
      settings,
    )!;
    expect(out).toContain("## memory/decisions.md");
    expect(out).toContain("chose deye");
    expect(out).toContain("## kb/infra/Inverter.md");
    expect(out).toContain("sun-12k");
  });

  test("strips FTS highlight markers and collapses whitespace", () => {
    const out = formatRetrieved(
      [{ path: "kb/x.md", scope: "kb", ftsScore: 1, snippet: "a «match»\n  with   gaps" }],
      settings,
    )!;
    expect(out).not.toContain("«");
    expect(out).not.toContain("»");
    expect(out).toContain("a match with gaps");
  });

  test("drops hits below minScore", () => {
    const out = formatRetrieved(
      [
        { path: "kb/keep.md", scope: "kb", rrfScore: 0.9, snippet: "strong" },
        { path: "kb/drop.md", scope: "kb", rrfScore: 0.1, snippet: "weak" },
      ],
      { ...settings, minScore: 0.5 },
    )!;
    expect(out).toContain("kb/keep.md");
    expect(out).not.toContain("kb/drop.md");
  });

  test("returns undefined when every hit is below minScore", () => {
    const out = formatRetrieved(
      [{ path: "kb/x.md", scope: "kb", rrfScore: 0.1, snippet: "weak" }],
      { ...settings, minScore: 0.5 },
    );
    expect(out).toBeUndefined();
  });

  test("respects the token budget but always keeps at least one hit", () => {
    const hits = Array.from({ length: 10 }, (_, i) => ({
      path: `kb/note-${i}.md`,
      scope: "kb" as const,
      ftsScore: 10 - i,
      snippet: "x".repeat(200),
    }));
    // maxTokens 0 → 0-char budget → only the guaranteed first hit lands.
    const out = formatRetrieved(hits, { ...settings, maxTokens: 0 })!;
    expect(out).toContain("kb/note-0.md");
    expect(out).not.toContain("kb/note-1.md");
  });
});

// ---------------------------------------------------------------------------
// retrieveContext — real index over temp files
// ---------------------------------------------------------------------------

describe("retrieveContext", () => {
  let workdir: string;
  let personaDir: string;
  let indexPath: string;

  beforeEach(async () => {
    workdir = await mkdtemp(join(tmpdir(), "phantombot-retrieval-"));
    personaDir = join(workdir, "persona");
    await mkdir(join(personaDir, "memory"), { recursive: true });
    await mkdir(join(personaDir, "kb", "infra"), { recursive: true });
    indexPath = join(workdir, "index.sqlite");
    await writeFile(
      join(personaDir, "memory", "decisions.md"),
      "We chose the deye inverter for the solar install.",
    );
    await writeFile(
      join(personaDir, "kb", "infra", "Inverter.md"),
      "The deye sun-12k inverter spec and wiring notes.",
    );
  });

  afterEach(async () => {
    await rm(workdir, { recursive: true, force: true });
  });

  const noEmbeddings: Config["embeddings"] = { provider: "none" };

  test("FTS-only: returns a block naming the matching files", async () => {
    const out = await retrieveContext({
      query: "deye inverter",
      personaDir,
      indexPath,
      embeddings: noEmbeddings,
      settings: { ...DEFAULT_RETRIEVAL },
    });
    expect(out).toBeDefined();
    expect(out!).toContain("Inverter.md");
    expect(out!).toContain("decisions.md");
  });

  test("returns undefined for an empty query (no work, no bloat)", async () => {
    const out = await retrieveContext({
      query: "   ",
      personaDir,
      indexPath,
      embeddings: noEmbeddings,
      settings: { ...DEFAULT_RETRIEVAL },
    });
    expect(out).toBeUndefined();
  });

  test("returns undefined when disabled, without opening the index", async () => {
    const out = await retrieveContext({
      query: "deye inverter",
      personaDir,
      indexPath,
      embeddings: noEmbeddings,
      settings: { ...DEFAULT_RETRIEVAL, enabled: false },
    });
    expect(out).toBeUndefined();
  });

  test("returns undefined when nothing matches", async () => {
    const out = await retrieveContext({
      query: "kangaroo helicopter zucchini",
      personaDir,
      indexPath,
      embeddings: noEmbeddings,
      settings: { ...DEFAULT_RETRIEVAL },
    });
    expect(out).toBeUndefined();
  });

  test("never throws — a bad index path resolves to undefined", async () => {
    // Point the index at a directory; MemoryIndex.open can't create a DB
    // there, so the whole thing must degrade to undefined, not throw.
    const out = await retrieveContext({
      query: "deye inverter",
      personaDir,
      indexPath: personaDir, // a directory, not a file
      embeddings: noEmbeddings,
      settings: { ...DEFAULT_RETRIEVAL },
    });
    expect(out).toBeUndefined();
  });

  test("hybrid: uses the injected embedder and still returns matching files", async () => {
    // Seed an embedding for the inverter note so embeddingCount() > 0 and
    // the hybrid path activates. Vector is arbitrary but fixed.
    const ix = await MemoryIndex.open(indexPath);
    await ix.refreshStale(personaDir);
    const vec = new Float32Array(1536);
    vec[0] = 1;
    ix.upsertEmbedding("kb/infra/Inverter.md", 0, vec, "sha-test");
    ix.close();

    // fetchImpl returns the same vector so cosine similarity is maximal.
    const fetchImpl = (async () =>
      new Response(
        JSON.stringify({ embedding: { values: Array.from(vec) } }),
        { status: 200, headers: { "content-type": "application/json" } },
      )) as unknown as typeof fetch;

    const out = await retrieveContext({
      query: "deye inverter",
      personaDir,
      indexPath,
      embeddings: {
        provider: "gemini",
        gemini: { apiKey: "test-key", model: "gemini-embedding-001", dims: 1536 },
      },
      settings: { ...DEFAULT_RETRIEVAL },
      fetchImpl,
    });
    expect(out).toBeDefined();
    expect(out!).toContain("Inverter.md");
  });

  test("scopes indexed turns to the current conversation (no cross-chat bleed)", async () => {
    // Seed two conversations' turns into the on-disk index, then retrieve
    // for conversation AAA. The BBB turn must never surface. (Kai, PR #132.)
    const ix = await MemoryIndex.open(indexPath);
    await ix.refreshStale(personaDir);
    ix.upsertTurn({
      id: 1,
      persona: "phantom",
      conversation: "telegram:AAA",
      role: "user",
      text: "The private figure we discussed in chat AAA was 12345.",
      createdAt: new Date("2026-05-28T06:00:00Z"),
    });
    ix.upsertTurn({
      id: 2,
      persona: "phantom",
      conversation: "telegram:BBB",
      role: "user",
      text: "The private figure we discussed in chat BBB was 67890.",
      createdAt: new Date("2026-05-28T06:01:00Z"),
    });
    ix.close();

    const out = await retrieveContext({
      query: "private figure we discussed",
      personaDir,
      indexPath,
      embeddings: noEmbeddings,
      settings: { ...DEFAULT_RETRIEVAL },
      conversation: "telegram:AAA",
    });
    expect(out).toBeDefined();
    // The current conversation's turn surfaces (path encodes "AAA")...
    expect(out!).toContain("AAA");
    // ...and the other chat is wholly absent: neither its path nor its
    // private content (67890) can leak in. That's the bug Kai caught.
    expect(out!).not.toContain("BBB");
    expect(out!).not.toContain("67890");
  });

  test("hybrid falls back to FTS when the embed call fails", async () => {
    const ix = await MemoryIndex.open(indexPath);
    await ix.refreshStale(personaDir);
    ix.upsertEmbedding("kb/infra/Inverter.md", 0, new Float32Array(1536), "sha");
    ix.close();

    const failing = (async () =>
      new Response(JSON.stringify({ error: { message: "boom" } }), {
        status: 500,
        headers: { "content-type": "application/json" },
      })) as unknown as typeof fetch;

    const out = await retrieveContext({
      query: "deye inverter",
      personaDir,
      indexPath,
      embeddings: {
        provider: "gemini",
        gemini: { apiKey: "test-key", model: "gemini-embedding-001", dims: 1536 },
      },
      settings: { ...DEFAULT_RETRIEVAL },
      fetchImpl: failing,
    });
    // Embed failed → FTS-only → still finds the files.
    expect(out).toBeDefined();
    expect(out!).toContain("Inverter.md");
  });
});

// ---------------------------------------------------------------------------
// makeRetriever — config gating
// ---------------------------------------------------------------------------

describe("makeRetriever", () => {
  const baseConfig = (retrieval?: Config["retrieval"]): Config =>
    ({
      defaultPersona: "phantom",
      embeddings: { provider: "none" },
      retrieval,
    }) as unknown as Config;

  test("returns undefined when retrieval is absent on the config", () => {
    expect(
      makeRetriever(baseConfig(undefined), "phantom", "/tmp/x", "telegram:1"),
    ).toBeUndefined();
  });

  test("returns undefined when retrieval is disabled", () => {
    expect(
      makeRetriever(
        baseConfig({ ...DEFAULT_RETRIEVAL, enabled: false }),
        "phantom",
        "/tmp/x",
        "telegram:1",
      ),
    ).toBeUndefined();
  });

  test("returns a callable retriever when enabled", () => {
    const r = makeRetriever(
      baseConfig({ ...DEFAULT_RETRIEVAL, enabled: true }),
      "phantom",
      "/tmp/x",
      "telegram:1",
    );
    expect(typeof r).toBe("function");
  });
});
