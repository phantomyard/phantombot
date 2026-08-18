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

import {
  DEFAULT_CROSS_CONVERSATION,
  DEFAULT_RETRIEVAL,
  type Config,
  type RetrievalSettings,
} from "../src/config.ts";
import { MemoryIndex } from "../src/lib/memoryIndex.ts";
import {
  conversationChannel,
  crossAttribution,
  formatRetrieved,
  isConversationExcluded,
  makeRetriever,
  retrieveContext,
  selectCrossConversationHits,
  turnPathConversation,
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

  test("cross-conversation hits get attribution and the disclosure rule", () => {
    const out = formatRetrieved(
      [
        { path: "kb/x.md", scope: "kb", ftsScore: 5, snippet: "local note" },
        {
          path: "turns/phantom/telegram%3ABBB/9",
          scope: "turns",
          ftsScore: 4,
          snippet: "[user 2026-05-27T06:00:00Z] solved it there",
          crossConversation: "telegram:2002",
        },
      ],
      settings,
    )!;
    expect(out).toContain("(cross-conversation: Telegram, May 27)");
    expect(out).toContain("never quote them verbatim");
  });

  test("no cross-conversation hits → no disclosure sentence in the header", () => {
    const out = formatRetrieved(
      [{ path: "kb/x.md", scope: "kb", ftsScore: 5, snippet: "local note" }],
      settings,
    )!;
    expect(out).not.toContain("cross-conversation");
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

  test("an oversized hit is skipped, not fatal — smaller hits behind it still fit (#379)", () => {
    // maxTokens tuned so the header + first hit comfortably fit, the second
    // (oversized) hit alone would blow the remaining budget, but the third —
    // small, and positioned behind the oversized block — still fits in
    // what's left once the oversized block is skipped rather than fatal.
    const settingsTight: RetrievalSettings = { ...settings, maxTokens: 175 }; // ~700 chars
    const hits = [
      { path: "kb/first.md", scope: "kb" as const, ftsScore: 3, snippet: "x".repeat(150) },
      { path: "kb/oversized.md", scope: "kb" as const, ftsScore: 2, snippet: "y".repeat(500) },
      {
        path: "turns/phantom/telegram%3ABBB/9",
        scope: "turns" as const,
        ftsScore: 1,
        snippet: "small cross-conversation hit",
        crossConversation: "telegram:2002",
      },
    ];
    const out = formatRetrieved(hits, settingsTight)!;
    expect(out).toContain("kb/first.md");
    expect(out).not.toContain("kb/oversized.md");
    expect(out).toContain("small cross-conversation hit");
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

  /**
   * Seed filler turns with a disjoint vocabulary so the test index has a
   * realistic document count. BM25's idf is corpus-relative: in a 2-doc
   * index every term is in ~every doc, idf ≈ 0, and NO score can clear the
   * absolute tier-2 floor (minScore 2.0) — tests for tier-2 behaviour
   * would silently test the floor instead. 25 fillers put idf in the same
   * range as a real multi-thousand-turn index for rare terms.
   */
  const seedFillerTurns = (
    ix: MemoryIndex,
    count = 25,
    conversation = "cli:filler",
  ): void => {
    for (let i = 1; i <= count; i++) {
      // Every filler contains "the" so the floor-regression test's common
      // token is genuinely low-IDF (raw BM25 ≈ 0), not merely decayed low.
      ix.upsertTurn({
        id: 10_000 + i,
        persona: "phantom",
        conversation,
        role: "assistant",
        text: `the fillerturn${i} notion${i} widget${i} gizmo${i}`,
        createdAt: new Date("2026-05-20T06:00:00Z"),
        embeddable: true,
        source: "unverified",
        origin: "channel",
      });
    }
  };

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

  test("opt-out restores strict per-conversation scoping (PR #132 behaviour)", async () => {
    // Seed two conversations' turns into the on-disk index, then retrieve
    // for conversation AAA with cross-conversation retrieval explicitly
    // disabled. The BBB turn must never surface. (Kai, PR #132.)
    const ix = await MemoryIndex.open(indexPath);
    await ix.refreshStale(personaDir);
    ix.upsertTurn({
      id: 1,
      persona: "phantom",
      conversation: "telegram:1001",
      role: "user",
      text: "The private figure we discussed in chat AAA was 12345.",
      createdAt: new Date("2026-05-28T06:00:00Z"),
      embeddable: true,
      source: "principal",
      origin: "channel",
    });
    ix.upsertTurn({
      id: 2,
      persona: "phantom",
      conversation: "telegram:2002",
      role: "user",
      text: "The private figure we discussed in chat BBB was 67890.",
      createdAt: new Date("2026-05-28T06:01:00Z"),
      embeddable: true,
      source: "principal",
      origin: "channel",
    });
    ix.close();

    const out = await retrieveContext({
      query: "private figure we discussed",
      personaDir,
      indexPath,
      embeddings: noEmbeddings,
      settings: {
        ...DEFAULT_RETRIEVAL,
        crossConversation: { ...DEFAULT_CROSS_CONVERSATION, enabled: false },
      },
      conversation: "telegram:1001",
    });
    expect(out).toBeDefined();
    // The current conversation's turn surfaces (path encodes "AAA")...
    expect(out!).toContain("AAA");
    // ...and the other chat is wholly absent: neither its path nor its
    // private content (67890) can leak in. That's the bug Kai caught.
    expect(out!).not.toContain("BBB");
    expect(out!).not.toContain("67890");
  });

  test("default ON: cross-conversation turn surfaces with attribution, tier 1 first", async () => {
    const ix = await MemoryIndex.open(indexPath);
    await ix.refreshStale(personaDir);
    seedFillerTurns(ix);
    // Both conversations are GROUPS (multi-party → multi-party is allowed
    // by the audience boundary). Dates are RECENT so the default 30-day
    // decay barely damps the scores — the distinctive content then clears
    // the absolute tier-2 floor on BM25 alone.
    const daysAgo = (n: number) => new Date(Date.now() - n * 86_400_000);
    ix.upsertTurn({
      id: 1,
      persona: "phantom",
      conversation: "phantomchat:group:AAA",
      role: "user",
      text: "The relay auth fix we discussed in chat AAA used kind 22242.",
      createdAt: daysAgo(3),
      embeddable: true,
      source: "principal",
      origin: "channel",
    });
    ix.upsertTurn({
      id: 2,
      persona: "phantom",
      conversation: "telegram:-1002002",
      role: "user",
      text: "The relay auth fix we discussed in chat BBB used kind 22242.",
      createdAt: daysAgo(2),
      embeddable: true,
      source: "principal",
      origin: "channel",
    });
    ix.close();

    const out = await retrieveContext({
      query: "relay auth fix we discussed",
      personaDir,
      indexPath,
      embeddings: noEmbeddings,
      settings: { ...DEFAULT_RETRIEVAL }, // crossConversation defaults ON
      conversation: "phantomchat:group:AAA",
    });
    expect(out).toBeDefined();
    // Tier 1 first: the current conversation's hit precedes the cross hit.
    expect(out!.indexOf("AAA")).toBeLessThan(out!.indexOf("1002002"));
    // Attribution: channel + date, and the disclosure rule rides the header.
    const d = daysAgo(2);
    const month = "Jan Feb Mar Apr May Jun Jul Aug Sep Oct Nov Dec".split(" ")[d.getUTCMonth()];
    expect(out!).toContain(
      `(cross-conversation: Telegram, ${month} ${d.getUTCDate()})`,
    );
    expect(out!).toContain("never quote them verbatim");
  });

  test("ad-hoc settings without a crossConversation block still default to ON", async () => {
    const ix = await MemoryIndex.open(indexPath);
    await ix.refreshStale(personaDir);
    seedFillerTurns(ix);
    ix.upsertTurn({
      id: 1,
      persona: "phantom",
      conversation: "telegram:2002",
      role: "user",
      text: "The flux capacitor calibration constant is 42.",
      createdAt: new Date(Date.now() - 2 * 86_400_000),
      embeddable: true,
      source: "principal",
      origin: "channel",
    });
    ix.close();

    const settings = { ...DEFAULT_RETRIEVAL } as Partial<RetrievalSettings>;
    delete settings.crossConversation; // simulate an ad-hoc config
    const out = await retrieveContext({
      query: "flux capacitor calibration",
      personaDir,
      indexPath,
      embeddings: noEmbeddings,
      settings: settings as RetrievalSettings,
      conversation: "telegram:1001", // private → private is allowed
    });
    expect(out).toBeDefined();
    expect(out!).toContain("(cross-conversation: Telegram");
  });

  test("cross-conversation hits are hard-capped at the configured limit", async () => {
    const ix = await MemoryIndex.open(indexPath);
    await ix.refreshStale(personaDir);
    seedFillerTurns(ix);
    for (let i = 1; i <= 5; i++) {
      ix.upsertTurn({
        id: i,
        persona: "phantom",
        conversation: "phantomchat:group:CCC",
        role: "user",
        text: `Zebra crossing anecdote number ${i} about striped equines.`,
        createdAt: new Date(Date.now() - i * 86_400_000),
        embeddable: true,
        source: "principal",
        origin: "channel",
      });
    }
    ix.close();

    const out = await retrieveContext({
      query: "zebra crossing striped equines",
      personaDir,
      indexPath,
      embeddings: noEmbeddings,
      settings: {
        ...DEFAULT_RETRIEVAL,
        crossConversation: { ...DEFAULT_CROSS_CONVERSATION, limit: 2 },
      },
      conversation: "phantomchat:group:AAA", // no in-conversation match
    });
    expect(out).toBeDefined();
    const crossLabels = out!.match(/\(cross-conversation:/g) ?? [];
    expect(crossLabels.length).toBe(2);
  });

  test("candidate pool is wider than crossLimit, so provenance re-ranking has something to work with (#382)", async () => {
    // Two candidates, one per conversation, both clearing the raw-relevance
    // floor. DDD has the stronger raw BM25 (repeats the query terms) but
    // weak provenance (unverified/internal, weight 0.42). EEE has weaker raw
    // BM25 (states the terms once) but full-trust provenance
    // (principal/channel, weight 1.0) — so weighted, EEE should outrank DDD.
    //
    // Before the fix, hybridSearch's own `limit` was crossLimit (1 here), so
    // only DDD (the raw-BM25 winner) ever reached selectCrossConversationHits
    // — EEE was truncated out of the pool before provenance got a vote, and
    // the hard-capped output was always DDD. The fix widens the pool so both
    // candidates survive into the re-rank.
    const ix = await MemoryIndex.open(indexPath);
    await ix.refreshStale(personaDir);
    seedFillerTurns(ix);
    const when = new Date(Date.now() - 86_400_000); // same day: decay a wash
    ix.upsertTurn({
      id: 1,
      persona: "phantom",
      conversation: "phantomchat:group:DDD",
      role: "user",
      text: "Narwhal telemetry narwhal telemetry narwhal telemetry checksum retry backoff.",
      createdAt: when,
      embeddable: true,
      source: "unverified",
      origin: "internal",
    });
    ix.upsertTurn({
      id: 2,
      persona: "phantom",
      conversation: "phantomchat:group:EEE",
      role: "user",
      text: "Narwhal telemetry checksum noted once for the record.",
      createdAt: when,
      embeddable: true,
      source: "principal",
      origin: "channel",
    });
    ix.close();

    const out = await retrieveContext({
      query: "narwhal telemetry checksum",
      personaDir,
      indexPath,
      embeddings: noEmbeddings,
      settings: {
        ...DEFAULT_RETRIEVAL,
        crossConversation: { ...DEFAULT_CROSS_CONVERSATION, limit: 1 },
      },
      conversation: "phantomchat:group:AAA", // no in-conversation match
    });
    expect(out).toBeDefined();
    expect(out!).toContain("EEE");
    expect(out!).not.toContain("DDD");
  });

  test("time-decay still wins a cross-conversation tie-break with the widened pool (#390)", async () => {
    // Same shape as the #382 test above, but the axis under test is AGE, not
    // provenance — both candidates share provenance (unverified/internal) so
    // decay is the only thing that can separate them. FRESH is 1 day old;
    // ANCIENT is 400 days old (well past the 30-day half-life, pinned at the
    // 0.02 floor) and states the query terms more times, so it wins on raw
    // BM25 alone.
    //
    // Before the #390 fix, hybridSearch's OWN decay-adjusted ordering decided
    // who survived truncation to `limit` — but #382 widened that pool well
    // past crossLimit, so decay only gated pool ENTRY, and the final
    // selectCrossConversationHits re-rank (raw score × provenance) had no
    // decay term at all: ANCIENT's stronger raw BM25 let it win outright.
    const ix = await MemoryIndex.open(indexPath);
    await ix.refreshStale(personaDir);
    seedFillerTurns(ix);
    ix.upsertTurn({
      id: 1,
      persona: "phantom",
      conversation: "phantomchat:group:FRESH",
      role: "user",
      text: "Yeti spelunking checksum noted once for the record.",
      createdAt: new Date(Date.now() - 86_400_000), // 1 day old
      embeddable: true,
      source: "unverified",
      origin: "internal",
    });
    ix.upsertTurn({
      id: 2,
      persona: "phantom",
      conversation: "phantomchat:group:ANCIENT",
      role: "user",
      text: "Yeti spelunking yeti spelunking yeti spelunking checksum retry backoff.",
      createdAt: new Date(Date.now() - 400 * 86_400_000), // 400 days old
      embeddable: true,
      source: "unverified",
      origin: "internal",
    });
    ix.close();

    const out = await retrieveContext({
      query: "yeti spelunking checksum",
      personaDir,
      indexPath,
      embeddings: noEmbeddings,
      settings: {
        ...DEFAULT_RETRIEVAL,
        crossConversation: { ...DEFAULT_CROSS_CONVERSATION, limit: 1 },
      },
      conversation: "phantomchat:group:AAA", // no in-conversation match
    });
    expect(out).toBeDefined();
    expect(out!).toContain("FRESH");
    expect(out!).not.toContain("ANCIENT");
  });

  test("excluded sources never surface cross-conversation", async () => {
    const ix = await MemoryIndex.open(indexPath);
    await ix.refreshStale(personaDir);
    ix.upsertTurn({
      id: 1,
      persona: "phantom",
      conversation: "telegram:SECRET",
      role: "user",
      text: "The bank vault combination is 67890.",
      createdAt: new Date("2026-05-27T06:00:00Z"),
      embeddable: true,
      source: "principal",
      origin: "channel",
    });
    ix.close();

    const out = await retrieveContext({
      query: "bank vault combination",
      personaDir,
      indexPath,
      embeddings: noEmbeddings,
      settings: {
        ...DEFAULT_RETRIEVAL,
        crossConversation: {
          ...DEFAULT_CROSS_CONVERSATION,
          exclude: ["telegram"], // channel prefix excludes ALL telegram:*
        },
      },
      // Private destination so the EXCLUDE — not the audience boundary —
      // is what blocks the (private) source.
      conversation: "cli:local",
    });
    expect(out).toBeUndefined(); // only candidate was excluded → no block
  });

  test("excluded destination receives no cross-conversation hits", async () => {
    const ix = await MemoryIndex.open(indexPath);
    await ix.refreshStale(personaDir);
    ix.upsertTurn({
      id: 1,
      persona: "phantom",
      conversation: "phantomchat:group:PUBLIC",
      role: "user",
      text: "The staging deploy token rotation procedure is documented.",
      createdAt: new Date("2026-05-27T06:00:00Z"),
      embeddable: true,
      source: "principal",
      origin: "channel",
    });
    ix.close();

    const out = await retrieveContext({
      query: "staging deploy token rotation",
      personaDir,
      indexPath,
      embeddings: noEmbeddings,
      settings: {
        ...DEFAULT_RETRIEVAL,
        crossConversation: {
          ...DEFAULT_CROSS_CONVERSATION,
          exclude: ["telegram:PRIVATE"],
        },
      },
      conversation: "telegram:PRIVATE", // excluded as destination
    });
    expect(out).toBeUndefined();
  });

  test("floor regression: an empty tier 1 does not inject weak cross hits (bar is absolute, not 0)", async () => {
    // Robert's PR #378 blocking review: with minScore = 0 the old derived
    // bar collapsed to 0 exactly when tier 1 had no hits, so ANY turn that
    // matched FTS at all was injected. Seed a cross turn whose only overlap
    // with the query is a token that is common ACROSS THE INDEX ("the" is
    // in every filler turn → IDF ≈ 0 → raw BM25 ≈ 0) — it must NOT
    // surface. (The floor applies to the RAW score; decay only re-ranks.)
    const ix = await MemoryIndex.open(indexPath);
    await ix.refreshStale(personaDir);
    seedFillerTurns(ix);
    ix.upsertTurn({
      id: 1,
      persona: "phantom",
      conversation: "telegram:2002",
      role: "user",
      text: "the plan is basically fine, we should just ship it",
      createdAt: new Date("2026-05-28T06:00:00Z"),
      embeddable: true,
      source: "principal",
      origin: "channel",
    });
    ix.close();

    const out = await retrieveContext({
      query: "the", // common token: matches, but BM25 ≈ 0 < default floor 2.0
      personaDir,
      indexPath,
      embeddings: noEmbeddings,
      settings: { ...DEFAULT_RETRIEVAL },
      conversation: "telegram:1001", // no in-conversation hits → empty tier 1
    });
    // Notes may or may not match; the invariant is that NO cross hit did.
    expect(out?.includes("cross-conversation") ?? false).toBe(false);
  });

  test("pool regression: 15 in-conversation turns cannot starve the cross hit (Kai)", async () => {
    // Old code fetched an unscoped pool of 12 and filtered in JS: when the
    // current conversation occupied all 12 slots, tier 2 yielded nothing.
    // Exclusions now happen in SQL before LIMIT, so the eligible cross hit
    // always gets a pool slot.
    const ix = await MemoryIndex.open(indexPath);
    await ix.refreshStale(personaDir);
    for (let i = 1; i <= 15; i++) {
      ix.upsertTurn({
        id: i,
        persona: "phantom",
        conversation: "telegram:1001",
        role: "user",
        text: `zephyr maintenance note ${i} about the current chat topic`,
        createdAt: new Date(Date.now() - i * 86_400_000),
        embeddable: true,
        source: "principal",
        origin: "channel",
      });
    }
    ix.upsertTurn({
      id: 100,
      persona: "phantom",
      conversation: "telegram:2002",
      role: "user",
      text: "the zephyr quill calibration trick from the other chat",
      createdAt: new Date(Date.now() - 86_400_000),
      embeddable: true,
      source: "principal",
      origin: "channel",
    });
    ix.close();

    const out = await retrieveContext({
      // "quill" appears ONLY in the cross turn → idf high, floor cleared.
      query: "zephyr quill",
      personaDir,
      indexPath,
      embeddings: noEmbeddings,
      settings: { ...DEFAULT_RETRIEVAL },
      conversation: "telegram:1001",
    });
    expect(out).toBeDefined();
    expect(out!).toContain("cross-conversation");
    expect(out!).toContain("quill");
  });

  test("audience boundary: a private-DM turn never surfaces in a group room (Robert)", async () => {
    // The negative test that actually guards containment: private source,
    // multi-party destination → no cross hit, content cannot leak.
    const ix = await MemoryIndex.open(indexPath);
    await ix.refreshStale(personaDir);
    seedFillerTurns(ix);
    ix.upsertTurn({
      id: 1,
      persona: "phantom",
      conversation: "telegram:7001",
      role: "user",
      text: "the mortgage overpayment figure we settled on was 418.60",
      createdAt: new Date(Date.now() - 2 * 86_400_000),
      embeddable: true,
      source: "principal",
      origin: "channel",
    });
    ix.close();

    const inGroup = await retrieveContext({
      query: "mortgage overpayment figure",
      personaDir,
      indexPath,
      embeddings: noEmbeddings,
      settings: { ...DEFAULT_RETRIEVAL },
      conversation: "phantomchat:group:TEAM", // multi-party room
    });
    expect(inGroup?.includes("418.60") ?? false).toBe(false);
    expect(inGroup?.includes("cross-conversation") ?? false).toBe(false);

    // Positive control: the SAME turn surfaces in a private room — proving
    // the group miss above is the audience boundary, not the floor.
    const inPrivate = await retrieveContext({
      query: "mortgage overpayment figure",
      personaDir,
      indexPath,
      embeddings: noEmbeddings,
      settings: { ...DEFAULT_RETRIEVAL },
      conversation: "telegram:7002", // private room
    });
    expect(inPrivate).toBeDefined();
    expect(inPrivate!).toContain("cross-conversation");
  });

  test("audience boundary: a group turn MAY surface in a private room", async () => {
    const ix = await MemoryIndex.open(indexPath);
    await ix.refreshStale(personaDir);
    seedFillerTurns(ix);
    ix.upsertTurn({
      id: 1,
      persona: "phantom",
      conversation: "phantomchat:group:TEAM",
      role: "user",
      text: "the staging runbook overhaul checklist we agreed in the group",
      createdAt: new Date(Date.now() - 2 * 86_400_000),
      embeddable: true,
      source: "principal",
      origin: "channel",
    });
    ix.close();

    const out = await retrieveContext({
      query: "staging runbook overhaul checklist",
      personaDir,
      indexPath,
      embeddings: noEmbeddings,
      settings: { ...DEFAULT_RETRIEVAL },
      conversation: "telegram:7001", // private room, group source ✅
    });
    expect(out).toBeDefined();
    expect(out!).toContain("cross-conversation");
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

// ---------------------------------------------------------------------------
// Tier-2 helpers — pure
// ---------------------------------------------------------------------------

describe("turnPathConversation", () => {
  test("decodes the conversation out of a turn path", () => {
    expect(turnPathConversation("turns/phantom/phantomchat%3Agroup%3Aabc/42")).toBe(
      "phantomchat:group:abc",
    );
  });

  test("returns undefined for non-turn paths", () => {
    expect(turnPathConversation("kb/infra/Inverter.md")).toBeUndefined();
    expect(turnPathConversation("turns/short")).toBeUndefined();
  });
});

describe("isConversationExcluded", () => {
  test("matches a full conversation key", () => {
    expect(
      isConversationExcluded("telegram:123", ["phantomchat:group:x", "telegram:123"]),
    ).toBe(true);
  });

  test("matches a channel prefix", () => {
    expect(isConversationExcluded("telegram:123", ["telegram"])).toBe(true);
    expect(isConversationExcluded("phantomchat:group:x", ["telegram"])).toBe(false);
  });

  test("does not over-match on bare substrings", () => {
    // "telegram" must not exclude a hypothetical "telegramx:1" channel.
    expect(isConversationExcluded("telegramx:1", ["telegram"])).toBe(false);
  });
});

describe("conversationChannel / crossAttribution", () => {
  test("prettifies the channel head", () => {
    expect(conversationChannel("phantomchat:group:abc")).toBe("Phantomchat");
    expect(conversationChannel("telegram:1")).toBe("Telegram");
  });

  test("attributes channel + date parsed from the snippet", () => {
    expect(
      crossAttribution("telegram:1", "[user 2026-05-27T06:00:00Z] hi"),
    ).toBe("Telegram, May 27");
  });

  test("falls back to channel-only when no date is parseable", () => {
    expect(crossAttribution("telegram:1", "no date here")).toBe("Telegram");
  });
});

describe("selectCrossConversationHits", () => {
  const hit = (
    conversation: string,
    ftsScore: number,
    extra: Partial<import("../src/lib/memoryIndex.ts").SearchHit> = {},
  ): import("../src/lib/memoryIndex.ts").SearchHit => ({
    path: `turns/phantom/${encodeURIComponent(conversation)}/1`,
    scope: "turns",
    ftsScore,
    audience: "private",
    snippet: "s",
    ...extra,
  });
  const base = {
    currentConversation: "telegram:1001",
    exclude: [] as string[],
    allowedAudiences: ["private", "multi-party", "public"] as const,
    minScore: 0,
    minVecScore: 1,
    limit: 3,
  };

  test("drops the current conversation, tags survivors with their source", () => {
    const out = selectCrossConversationHits(
      [hit("telegram:1001", 10), hit("telegram:2002", 9)],
      { ...base },
    );
    expect(out.length).toBe(1);
    expect(out[0]!.crossConversation).toBe("telegram:2002");
  });

  test("drops excluded sources and non-turn candidates", () => {
    const out = selectCrossConversationHits(
      [
        hit("telegram:SECRET", 10),
        { path: "kb/x.md", scope: "kb", ftsScore: 9, snippet: "s" },
        hit("phantomchat:group:OK", 8),
      ],
      { ...base, exclude: ["telegram:SECRET"] },
    );
    expect(out.length).toBe(1);
    expect(out[0]!.crossConversation).toBe("phantomchat:group:OK");
  });

  test("enforces the absolute floor on BM25 — RRF rank is never a bar", () => {
    const out = selectCrossConversationHits(
      [hit("telegram:2002", 5), hit("telegram:3003", 2)],
      { ...base, minScore: 3 },
    );
    expect(out.map((h) => h.crossConversation)).toEqual(["telegram:2002"]);
  });

  test("rejects a vector-only hit with no lexical support (boilerplate class)", () => {
    // Regression for the PR #378 blocking review: the gate is applied to
    // the maximum over the whole index, where anisotropic embeddings score
    // register/boilerplate similarity — on a live 4k-turn index 79% of
    // arbitrary queries had a cross-conversation hit above 0.85 on cosine
    // alone. Cosine without any shared query term must never admit.
    const out = selectCrossConversationHits(
      [
        // No FTS match at all (vector-only candidate).
        hit("telegram:2002", 0, { ftsScore: undefined, vecScore: 0.97, rrfScore: 0.016 }),
        // High cosine, zero lexical overlap.
        hit("telegram:3003", 0, { vecScore: 0.93 }),
      ],
      { ...base, minScore: 2, minVecScore: 0.85 },
    );
    expect(out).toEqual([]);
  });

  test("admits a vector hit with lexical support below the BM25 floor", () => {
    // A paraphrase match: cosine clears the floor and the turn shares at
    // least one query term (raw BM25 > 0) but not enough for the lexical
    // leg. The vector leg exists for exactly this case.
    const out = selectCrossConversationHits(
      [hit("telegram:2002", 0.4, { vecScore: 0.9, rrfScore: 0.016 })],
      { ...base, minScore: 2, minVecScore: 0.85 },
    );
    expect(out.map((h) => h.crossConversation)).toEqual(["telegram:2002"]);
  });

  test("fails closed when a candidate carries no audience", () => {
    // Defence in depth: a caller that bypassed the SQL audience filter is
    // the one most likely to produce unclassified hits — undefined must
    // not sail through.
    const out = selectCrossConversationHits(
      [hit("telegram:2002", 10, { audience: undefined })],
      { ...base },
    );
    expect(out).toEqual([]);
  });

  test("drops candidates whose audience is too private for the room", () => {
    const out = selectCrossConversationHits(
      [hit("telegram:DM", 10), hit("phantomchat:group:G", 9, { audience: "multi-party" })],
      { ...base, allowedAudiences: ["multi-party", "public"] },
    );
    expect(out.map((h) => h.crossConversation)).toEqual(["phantomchat:group:G"]);
  });

  test("caps at the limit, best-first order preserved", () => {
    const out = selectCrossConversationHits(
      [hit("telegram:B", 10), hit("telegram:C", 9), hit("telegram:D", 8)],
      { ...base, limit: 2 },
    );
    expect(out.map((h) => h.crossConversation)).toEqual([
      "telegram:B",
      "telegram:C",
    ]);
  });
});
