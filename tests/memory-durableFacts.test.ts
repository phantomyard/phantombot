/**
 * Tests for the durable_facts store surface. As of the persona-scoping PR,
 * facts are keyed (persona, fact_norm) — de-duped PERSONA-wide, not per
 * conversation — and carry a provenance `source` (principal/self/other). This
 * covers: upsert/de-dupe, confidence-max + recency, source promotion on
 * conflict, persona-wide merge across conversations, ranked reads with a
 * confidence floor, the recall bump (touchDurableFacts), the retirement prune
 * (pruneExpiredDurableFacts), the eviction-window query, the monotonic
 * extractor cursor, the claim/commit/release lease ledger, and that /reset
 * clears per-conversation state while LEAVING persona-wide facts intact.
 */

import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  normalizeFact,
  openMemoryStore,
  type MemoryStore,
} from "../src/memory/store.ts";

let workdir: string;
let memory: MemoryStore;

const PERSONA = "phantom";
const CONV = "telegram:1001";
/** A long lease so claims stay live across a test unless we commit/release. */
const LEASE = 300_000;

beforeEach(async () => {
  workdir = await mkdtemp(join(tmpdir(), "phantombot-durable-facts-"));
  memory = await openMemoryStore(":memory:");
});

afterEach(async () => {
  await memory.close();
  await rm(workdir, { recursive: true, force: true });
});

async function appendTurn(
  text: string,
  role: "user" | "assistant" = "user",
  embeddable = true,
): Promise<void> {
  await memory.appendTurn({
    persona: PERSONA,
    conversation: CONV,
    role,
    text,
    embeddable,
  });
}

/** Claim and return only the leased turns, discarding the ownership token. */
async function claimTurns(
  windowSize: number,
  limit: number,
  lease = LEASE,
): Promise<Awaited<ReturnType<MemoryStore["claimEvictedForExtraction"]>>["turns"]> {
  const { turns } = await memory.claimEvictedForExtraction(
    PERSONA,
    CONV,
    windowSize,
    limit,
    lease,
  );
  return turns;
}

describe("normalizeFact", () => {
  test("lowercases, collapses whitespace, strips quotes + trailing punct", () => {
    expect(normalizeFact("He uses Deye inverters.")).toBe(
      "he uses deye inverters",
    );
    expect(normalizeFact('  "He uses  Deye inverters"  ')).toBe(
      "he uses deye inverters",
    );
    expect(normalizeFact("He uses Deye inverters!!!")).toBe(
      "he uses deye inverters",
    );
  });

  test("distinct facts keep distinct keys", () => {
    expect(normalizeFact("Andrew lives in Arnhem")).not.toBe(
      normalizeFact("Andrew lives in Amsterdam"),
    );
  });
});

describe("upsertDurableFact / topDurableFacts", () => {
  test("inserts a fact and reads it back (defaults to principal source)", async () => {
    await memory.upsertDurableFact({
      persona: PERSONA,
      conversation: CONV,
      fact: "Andrew lives in Arnhem.",
      confidence: 0.9,
    });
    const facts = await memory.topDurableFacts(PERSONA, { limit: 10 });
    expect(facts).toHaveLength(1);
    expect(facts[0]!.fact).toBe("Andrew lives in Arnhem.");
    expect(facts[0]!.confidence).toBeCloseTo(0.9);
    expect(facts[0]!.source).toBe("principal");
    expect(await memory.countDurableFacts(PERSONA)).toBe(1);
  });

  test("restating a fact de-dupes to one row, keeps max confidence", async () => {
    await memory.upsertDurableFact({
      persona: PERSONA,
      conversation: CONV,
      fact: "He uses Deye inverters.",
      confidence: 0.6,
    });
    await memory.upsertDurableFact({
      persona: PERSONA,
      conversation: CONV,
      fact: "  he uses  deye inverters  ", // same normalized key
      confidence: 0.4, // lower — must NOT lower the stored confidence
    });
    const facts = await memory.topDurableFacts(PERSONA, { limit: 10 });
    expect(facts).toHaveLength(1);
    expect(facts[0]!.confidence).toBeCloseTo(0.6);
    expect(await memory.countDurableFacts(PERSONA)).toBe(1);
  });

  test("re-extraction bumps recency (last_seen_at)", async () => {
    await memory.upsertDurableFact({
      persona: PERSONA,
      conversation: CONV,
      fact: "Andrew runs MAN Consulting.",
      confidence: 0.7,
    });
    const before = (await memory.topDurableFacts(PERSONA, { limit: 1 }))[0]!;
    await new Promise((r) => setTimeout(r, 5));
    await memory.upsertDurableFact({
      persona: PERSONA,
      conversation: CONV,
      fact: "Andrew runs MAN Consulting.",
      confidence: 0.7,
    });
    const after = (await memory.topDurableFacts(PERSONA, { limit: 1 }))[0]!;
    expect(after.lastSeenAt.getTime()).toBeGreaterThanOrEqual(
      before.lastSeenAt.getTime(),
    );
  });

  test("ranks by confidence then recency; honors minConfidence floor", async () => {
    await memory.upsertDurableFact({
      persona: PERSONA,
      conversation: CONV,
      fact: "low conf fact",
      confidence: 0.3,
    });
    await memory.upsertDurableFact({
      persona: PERSONA,
      conversation: CONV,
      fact: "high conf fact",
      confidence: 0.95,
    });
    await memory.upsertDurableFact({
      persona: PERSONA,
      conversation: CONV,
      fact: "mid conf fact",
      confidence: 0.7,
    });
    const all = await memory.topDurableFacts(PERSONA, { limit: 10 });
    expect(all.map((f) => f.fact)).toEqual([
      "high conf fact",
      "mid conf fact",
      "low conf fact",
    ]);

    const floored = await memory.topDurableFacts(PERSONA, {
      limit: 10,
      minConfidence: 0.5,
    });
    expect(floored.map((f) => f.fact)).toEqual(["high conf fact", "mid conf fact"]);

    const capped = await memory.topDurableFacts(PERSONA, { limit: 1 });
    expect(capped.map((f) => f.fact)).toEqual(["high conf fact"]);
  });

  test("facts MERGE across conversations for one persona (persona-wide pool)", async () => {
    // The core behaviour change: a fact learned in conversation A is visible
    // persona-wide, not siloed to A.
    await memory.upsertDurableFact({
      persona: PERSONA,
      conversation: CONV,
      fact: "conv A fact",
      confidence: 0.8,
    });
    await memory.upsertDurableFact({
      persona: PERSONA,
      conversation: "telegram:2002",
      fact: "conv B fact",
      confidence: 0.8,
    });
    const facts = await memory.topDurableFacts(PERSONA, { limit: 10 });
    expect(facts.map((f) => f.fact).sort()).toEqual(["conv A fact", "conv B fact"]);
    expect(await memory.countDurableFacts(PERSONA)).toBe(2);
  });

  test("same fact from two conversations collapses to ONE persona-wide row", async () => {
    await memory.upsertDurableFact({
      persona: PERSONA,
      conversation: CONV,
      fact: "Andrew lives in Arnhem.",
      confidence: 0.6,
    });
    await memory.upsertDurableFact({
      persona: PERSONA,
      conversation: "telegram:2002",
      fact: "andrew lives in arnhem", // same normalized key, other conversation
      confidence: 0.9,
    });
    const facts = await memory.topDurableFacts(PERSONA, { limit: 10 });
    expect(facts).toHaveLength(1);
    expect(facts[0]!.confidence).toBeCloseTo(0.9); // max kept
    expect(await memory.countDurableFacts(PERSONA)).toBe(1);
  });

  test("facts stay separated per persona", async () => {
    await memory.upsertDurableFact({
      persona: PERSONA,
      conversation: CONV,
      fact: "phantom fact",
      confidence: 0.8,
    });
    await memory.upsertDurableFact({
      persona: "lena",
      conversation: CONV,
      fact: "lena fact",
      confidence: 0.8,
    });
    expect(
      (await memory.topDurableFacts(PERSONA, { limit: 10 })).map((f) => f.fact),
    ).toEqual(["phantom fact"]);
    expect(
      (await memory.topDurableFacts("lena", { limit: 10 })).map((f) => f.fact),
    ).toEqual(["lena fact"]);
  });

  test("confidence clamps to 0..1, defaults to 0.5 when omitted", async () => {
    await memory.upsertDurableFact({
      persona: PERSONA,
      conversation: CONV,
      fact: "over",
      confidence: 5,
    });
    await memory.upsertDurableFact({
      persona: PERSONA,
      conversation: CONV,
      fact: "under",
      confidence: -3,
    });
    await memory.upsertDurableFact({
      persona: PERSONA,
      conversation: CONV,
      fact: "default",
    });
    const byFact = Object.fromEntries(
      (await memory.topDurableFacts(PERSONA, { limit: 10 })).map((f) => [
        f.fact,
        f.confidence,
      ]),
    );
    expect(byFact.over).toBeCloseTo(1);
    expect(byFact.under).toBeCloseTo(0);
    expect(byFact.default).toBeCloseTo(0.5);
  });
});

describe("source provenance", () => {
  test("stores the source it is given", async () => {
    await memory.upsertDurableFact({
      persona: PERSONA,
      conversation: CONV,
      fact: "self observation",
      confidence: 0.7,
      source: "self",
    });
    const facts = await memory.topDurableFacts(PERSONA, { limit: 10 });
    expect(facts[0]!.source).toBe("self");
  });

  test("conflict PROMOTES to the higher-trust source, never downgrades", async () => {
    // First learned as a self-observation, later confirmed by the principal:
    // should upgrade self → principal.
    await memory.upsertDurableFact({
      persona: PERSONA,
      conversation: CONV,
      fact: "Andrew backs up nightly.",
      confidence: 0.5,
      source: "self",
    });
    await memory.upsertDurableFact({
      persona: PERSONA,
      conversation: CONV,
      fact: "Andrew backs up nightly.",
      confidence: 0.5,
      source: "principal",
    });
    expect((await memory.topDurableFacts(PERSONA, { limit: 1 }))[0]!.source).toBe(
      "principal",
    );

    // A later, lower-trust mention (other) must NOT downgrade it.
    await memory.upsertDurableFact({
      persona: PERSONA,
      conversation: CONV,
      fact: "Andrew backs up nightly.",
      confidence: 0.5,
      source: "other",
    });
    expect((await memory.topDurableFacts(PERSONA, { limit: 1 }))[0]!.source).toBe(
      "principal",
    );
  });
});

describe("touchDurableFacts (recall bump)", () => {
  test("refreshes last_seen_at for the given ids only", async () => {
    await memory.upsertDurableFact({
      persona: PERSONA,
      conversation: CONV,
      fact: "recalled fact",
      confidence: 0.8,
    });
    await memory.upsertDurableFact({
      persona: PERSONA,
      conversation: CONV,
      fact: "untouched fact",
      confidence: 0.8,
    });
    const before = await memory.topDurableFacts(PERSONA, { limit: 10 });
    const recalled = before.find((f) => f.fact === "recalled fact")!;
    const untouched = before.find((f) => f.fact === "untouched fact")!;
    await new Promise((r) => setTimeout(r, 5));
    await memory.touchDurableFacts([recalled.id]);

    const after = await memory.topDurableFacts(PERSONA, { limit: 10 });
    const recalledAfter = after.find((f) => f.id === recalled.id)!;
    const untouchedAfter = after.find((f) => f.id === untouched.id)!;
    expect(recalledAfter.lastSeenAt.getTime()).toBeGreaterThan(
      recalled.lastSeenAt.getTime(),
    );
    expect(untouchedAfter.lastSeenAt.getTime()).toBe(
      untouched.lastSeenAt.getTime(),
    );
  });

  test("empty list is a no-op", async () => {
    await memory.upsertDurableFact({
      persona: PERSONA,
      conversation: CONV,
      fact: "x",
      confidence: 0.8,
    });
    await memory.touchDurableFacts([]);
    expect(await memory.countDurableFacts(PERSONA)).toBe(1);
  });
});

describe("pruneExpiredDurableFacts (retirement floor)", () => {
  async function seed(
    fact: string,
    source: "principal" | "self" | "other",
  ): Promise<void> {
    await memory.upsertDurableFact({
      persona: PERSONA,
      conversation: CONV,
      fact,
      confidence: 0.8,
      source,
    });
  }

  test("deletes only facts past their per-source cutoff", async () => {
    await seed("fresh principal", "principal");
    await seed("fresh self", "self");
    await seed("fresh other", "other");

    // Cutoffs in the FUTURE for `other` (so it's expired) but in the PAST for
    // principal/self (so they survive). ISO strings compare lexicographically.
    const now = Date.now();
    const iso = (msFromNow: number) => new Date(now + msFromNow).toISOString();
    const pruned = await memory.pruneExpiredDurableFacts(PERSONA, {
      principal: iso(-1000), // nothing older than 1s ago → survives
      self: iso(-1000),
      other: iso(60_000), // everything before 1min-from-now → other retires
    });
    expect(pruned).toBe(1);
    const remaining = (await memory.topDurableFacts(PERSONA, { limit: 10 })).map(
      (f) => f.fact,
    );
    expect(remaining.sort()).toEqual(["fresh principal", "fresh self"]);
  });

  test("no-op when nothing is old enough", async () => {
    await seed("p", "principal");
    const now = Date.now();
    const past = new Date(now - 10_000).toISOString();
    const pruned = await memory.pruneExpiredDurableFacts(PERSONA, {
      principal: past,
      self: past,
      other: past,
    });
    expect(pruned).toBe(0);
    expect(await memory.countDurableFacts(PERSONA)).toBe(1);
  });
});

describe("turnsEvictedFromWindow", () => {
  test("returns only turns that have aged out of the live window", async () => {
    for (let i = 1; i <= 10; i++) await appendTurn(`turn ${i}`);
    const evicted = await memory.turnsEvictedFromWindow(PERSONA, CONV, 4, 0, 100);
    expect(evicted.map((t) => t.text)).toEqual([
      "turn 1",
      "turn 2",
      "turn 3",
      "turn 4",
      "turn 5",
      "turn 6",
    ]);
  });

  test("respects the afterId cursor and the limit", async () => {
    for (let i = 1; i <= 10; i++) await appendTurn(`turn ${i}`);
    const firstPass = await memory.turnsEvictedFromWindow(PERSONA, CONV, 4, 0, 2);
    expect(firstPass.map((t) => t.text)).toEqual(["turn 1", "turn 2"]);
    const cursor = firstPass[firstPass.length - 1]!.id;
    const secondPass = await memory.turnsEvictedFromWindow(
      PERSONA,
      CONV,
      4,
      cursor,
      2,
    );
    expect(secondPass.map((t) => t.text)).toEqual(["turn 3", "turn 4"]);
  });

  test("nothing is evicted while the window still holds every turn", async () => {
    for (let i = 1; i <= 3; i++) await appendTurn(`turn ${i}`);
    const evicted = await memory.turnsEvictedFromWindow(PERSONA, CONV, 30, 0, 100);
    expect(evicted).toHaveLength(0);
  });

  test("carries the embeddable flag through so quarantined turns can be skipped", async () => {
    await appendTurn("quarantined", "user", false);
    for (let i = 1; i <= 5; i++) await appendTurn(`turn ${i}`);
    const evicted = await memory.turnsEvictedFromWindow(PERSONA, CONV, 2, 0, 100);
    const q = evicted.find((t) => t.text === "quarantined");
    expect(q).toBeDefined();
    expect(q!.embeddable).toBe(false);
  });

  test("carries the turn's provenance source through", async () => {
    await memory.appendTurn({
      persona: PERSONA,
      conversation: CONV,
      role: "assistant",
      text: "self turn",
    });
    for (let i = 1; i <= 3; i++) await appendTurn(`turn ${i}`);
    const evicted = await memory.turnsEvictedFromWindow(PERSONA, CONV, 1, 0, 100);
    const self = evicted.find((t) => t.text === "self turn")!;
    expect(self.source).toBe("self"); // assistant turn defaults to self
  });
});

describe("durable fact cursor", () => {
  test("defaults to 0 and round-trips through set", async () => {
    expect(await memory.durableFactCursor(PERSONA, CONV)).toBe(0);
    await memory.setDurableFactCursor(PERSONA, CONV, 42);
    expect(await memory.durableFactCursor(PERSONA, CONV)).toBe(42);
    await memory.setDurableFactCursor(PERSONA, CONV, 99);
    expect(await memory.durableFactCursor(PERSONA, CONV)).toBe(99);
  });

  test("cursor is scoped per (persona, conversation)", async () => {
    await memory.setDurableFactCursor(PERSONA, CONV, 7);
    expect(await memory.durableFactCursor(PERSONA, "telegram:2002")).toBe(0);
  });

  test("cursor advance is monotonic — a stale lower write never regresses it", async () => {
    await memory.setDurableFactCursor(PERSONA, CONV, 99);
    await memory.setDurableFactCursor(PERSONA, CONV, 5);
    expect(await memory.durableFactCursor(PERSONA, CONV)).toBe(99);
  });
});

describe("claimEvictedForExtraction (lease-based claim)", () => {
  test("advances the monotonic cursor and leases the batch so the next claim is disjoint", async () => {
    for (let i = 1; i <= 10; i++) await appendTurn(`turn ${i}`);
    const first = await claimTurns(4, 2);
    expect(first.map((t) => t.text)).toEqual(["turn 1", "turn 2"]);
    expect(await memory.durableFactCursor(PERSONA, CONV)).toBe(first[1]!.id);

    const second = await claimTurns(4, 2);
    expect(second.map((t) => t.text)).toEqual(["turn 3", "turn 4"]);
    const firstIds = new Set(first.map((t) => t.id));
    expect(second.some((t) => firstIds.has(t.id))).toBe(false);
  });

  test("each claim returns a distinct ownership token", async () => {
    for (let i = 1; i <= 6; i++) await appendTurn(`turn ${i}`);
    const a = await memory.claimEvictedForExtraction(PERSONA, CONV, 2, 2, LEASE);
    const b = await memory.claimEvictedForExtraction(PERSONA, CONV, 2, 2, LEASE);
    expect(a.token).toBeTruthy();
    expect(b.token).toBeTruthy();
    expect(a.token).not.toBe(b.token);
  });

  test("racing claims get disjoint batches and never double-process a turn", async () => {
    for (let i = 1; i <= 10; i++) await appendTurn(`turn ${i}`);
    const claims = await Promise.all(
      Array.from({ length: 6 }, () =>
        memory.claimEvictedForExtraction(PERSONA, CONV, 4, 2, LEASE),
      ),
    );
    const ids = claims.flatMap((c) => c.turns).map((t) => t.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(new Set(ids).size).toBe(6);
  });

  test("empty claim leaves the cursor untouched", async () => {
    for (let i = 1; i <= 3; i++) await appendTurn(`turn ${i}`);
    const claimed = await claimTurns(30, 5);
    expect(claimed).toHaveLength(0);
    expect(await memory.durableFactCursor(PERSONA, CONV)).toBe(0);
  });

  test("a committed turn is never re-claimed; a released one is re-claimed at once", async () => {
    for (let i = 1; i <= 6; i++) await appendTurn(`turn ${i}`);
    const { token, turns: first } = await memory.claimEvictedForExtraction(
      PERSONA,
      CONV,
      2,
      4,
      LEASE,
    );
    expect(first.map((t) => t.text)).toEqual([
      "turn 1",
      "turn 2",
      "turn 3",
      "turn 4",
    ]);
    await memory.commitExtractedTurn(PERSONA, CONV, first[0]!.id, token);
    await memory.commitExtractedTurn(PERSONA, CONV, first[1]!.id, token);
    await memory.releaseExtractionLease(
      PERSONA,
      CONV,
      [first[2]!.id, first[3]!.id],
      token,
    );

    const second = await claimTurns(2, 4);
    expect(second.map((t) => t.text)).toEqual(["turn 3", "turn 4"]);
  });

  test("commitExtraction writes facts (with source) AND drops the lease under a matching token", async () => {
    for (let i = 1; i <= 4; i++) await appendTurn(`turn ${i}`);
    const { token, turns } = await memory.claimEvictedForExtraction(
      PERSONA,
      CONV,
      2,
      4,
      LEASE,
    );
    const wrote = await memory.commitExtraction(PERSONA, CONV, turns[0]!.id, token, [
      { fact: "Andrew lives in Arnhem.", confidence: 0.9, source: "principal" },
    ]);
    expect(wrote).toBe(true);
    expect(await memory.countDurableFacts(PERSONA)).toBe(1);
    expect((await memory.topDurableFacts(PERSONA, { limit: 1 }))[0]!.source).toBe(
      "principal",
    );
    const next = await claimTurns(2, 4);
    expect(next.some((t) => t.id === turns[0]!.id)).toBe(false);
  });

  test("commitExtraction writes NOTHING when the token no longer matches (stale finisher)", async () => {
    for (let i = 1; i <= 4; i++) await appendTurn(`turn ${i}`);
    const { turns } = await memory.claimEvictedForExtraction(
      PERSONA,
      CONV,
      2,
      4,
      LEASE,
    );
    const wrote = await memory.commitExtraction(
      PERSONA,
      CONV,
      turns[0]!.id,
      "not-the-real-token",
      [{ fact: "should not be written", confidence: 0.9, source: "principal" }],
    );
    expect(wrote).toBe(false);
    expect(await memory.countDurableFacts(PERSONA)).toBe(0);
  });

  test("lease-expiry re-claim: the ORIGINAL owner's late commit is discarded, no duplicate fact", async () => {
    for (let i = 1; i <= 4; i++) await appendTurn(`turn ${i}`);
    const passA = await memory.claimEvictedForExtraction(PERSONA, CONV, 2, 1, 0);
    const turnId = passA.turns[0]!.id;
    const passB = await memory.claimEvictedForExtraction(PERSONA, CONV, 2, 1, LEASE);
    expect(passB.turns[0]!.id).toBe(turnId);

    const bWrote = await memory.commitExtraction(PERSONA, CONV, turnId, passB.token, [
      { fact: "Andrew lives in Arnhem.", confidence: 0.9, source: "principal" },
    ]);
    expect(bWrote).toBe(true);
    const aWrote = await memory.commitExtraction(PERSONA, CONV, turnId, passA.token, [
      { fact: "Andrew lives in Arnhem.", confidence: 0.9, source: "principal" },
    ]);
    expect(aWrote).toBe(false);
    expect(await memory.countDurableFacts(PERSONA)).toBe(1);
  });

  test("release is token-gated: a stale owner cannot resurrect a turn another pass holds", async () => {
    for (let i = 1; i <= 4; i++) await appendTurn(`turn ${i}`);
    const passA = await memory.claimEvictedForExtraction(PERSONA, CONV, 2, 2, 0);
    const passB = await memory.claimEvictedForExtraction(PERSONA, CONV, 2, 2, LEASE);
    const bIds = passB.turns.map((t) => t.id);
    await memory.releaseExtractionLease(PERSONA, CONV, bIds, passA.token);
    const next = await claimTurns(2, 4);
    expect(next).toHaveLength(0);
  });

  test("Kai's interleave: a partial failure never strands turns behind an advanced cursor", async () => {
    for (let i = 1; i <= 10; i++) await appendTurn(`turn ${i}`);

    const passA = await memory.claimEvictedForExtraction(PERSONA, CONV, 2, 4, LEASE);
    expect(passA.turns.map((t) => t.text)).toEqual([
      "turn 1",
      "turn 2",
      "turn 3",
      "turn 4",
    ]);
    const passB = await memory.claimEvictedForExtraction(PERSONA, CONV, 2, 4, LEASE);
    expect(passB.turns.map((t) => t.text)).toEqual([
      "turn 5",
      "turn 6",
      "turn 7",
      "turn 8",
    ]);

    for (const t of passB.turns) {
      await memory.commitExtractedTurn(PERSONA, CONV, t.id, passB.token);
    }
    expect(await memory.durableFactCursor(PERSONA, CONV)).toBe(passB.turns[3]!.id);

    await memory.commitExtractedTurn(PERSONA, CONV, passA.turns[0]!.id, passA.token);
    await memory.releaseExtractionLease(
      PERSONA,
      CONV,
      [passA.turns[1]!.id, passA.turns[2]!.id, passA.turns[3]!.id],
      passA.token,
    );

    const recovered = await claimTurns(2, 10);
    expect(recovered.map((t) => t.text)).toEqual(["turn 2", "turn 3", "turn 4"]);
  });

  test("live leases are excluded but STALE leases (expired) are re-claimable", async () => {
    for (let i = 1; i <= 6; i++) await appendTurn(`turn ${i}`);
    const first = await claimTurns(2, 4, 0);
    expect(first).toHaveLength(4);
    const second = await claimTurns(2, 4);
    expect(second.map((t) => t.id).sort((a, b) => a - b)).toEqual(
      first.map((t) => t.id).sort((a, b) => a - b),
    );
  });
});

describe("legacy DB migration (per-conversation → persona-wide + source)", () => {
  test("collapses duplicate facts per persona, keeps max confidence, backfills source", async () => {
    const dir = await mkdtemp(join(tmpdir(), "phantombot-df-migrate-"));
    const dbPath = join(dir, "memory.db");
    try {
      // Hand-build the PRE-PR schema: durable_facts keyed
      // (persona, conversation, fact_norm), no `source` column; turns with no
      // `source` column either.
      const legacy = new Database(dbPath, { create: true });
      legacy.exec(`
        CREATE TABLE turns (
          id INTEGER PRIMARY KEY AUTOINCREMENT, persona TEXT NOT NULL,
          conversation TEXT NOT NULL, role TEXT NOT NULL, text TEXT NOT NULL,
          created_at TEXT NOT NULL, embeddable INTEGER NOT NULL DEFAULT 1
        );
        CREATE TABLE durable_facts (
          id INTEGER PRIMARY KEY AUTOINCREMENT, persona TEXT NOT NULL,
          conversation TEXT NOT NULL, fact TEXT NOT NULL, fact_norm TEXT NOT NULL,
          confidence REAL NOT NULL DEFAULT 0.5, source_turn_id INTEGER,
          created_at TEXT NOT NULL, last_seen_at TEXT NOT NULL,
          UNIQUE (persona, conversation, fact_norm)
        );
      `);
      const ins = legacy.prepare(
        `INSERT INTO durable_facts
           (persona, conversation, fact, fact_norm, confidence, created_at, last_seen_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      );
      // Same fact in two conversations at different confidences → must collapse
      // to one persona-wide row keeping the higher confidence (0.9).
      ins.run("phantom", "telegram:A", "Andrew lives in Arnhem.", "andrew lives in arnhem", 0.6, "2026-01-01T00:00:00Z", "2026-01-01T00:00:00Z");
      ins.run("phantom", "telegram:B", "andrew lives in arnhem", "andrew lives in arnhem", 0.9, "2026-01-02T00:00:00Z", "2026-01-03T00:00:00Z");
      // A distinct fact and a different persona survive independently.
      ins.run("phantom", "telegram:A", "He uses Deye inverters.", "he uses deye inverters", 0.7, "2026-01-01T00:00:00Z", "2026-01-01T00:00:00Z");
      ins.run("lena", "telegram:C", "Lena fact", "lena fact", 0.8, "2026-01-01T00:00:00Z", "2026-01-01T00:00:00Z");
      // A legacy turn with no source column.
      legacy
        .prepare(
          "INSERT INTO turns (persona, conversation, role, text, created_at) VALUES (?, ?, ?, ?, ?)",
        )
        .run("phantom", "telegram:A", "assistant", "old reply", "2026-01-01T00:00:00Z");
      legacy.close();

      // Opening through the store runs the migration.
      const store = await openMemoryStore(dbPath);
      try {
        const phantom = await store.topDurableFacts("phantom", { limit: 10 });
        // Two persona-wide phantom facts (the duplicate collapsed).
        expect(phantom).toHaveLength(2);
        const arnhem = phantom.find((f) =>
          f.fact.toLowerCase().includes("arnhem"),
        )!;
        expect(arnhem.confidence).toBeCloseTo(0.9); // max kept
        expect(arnhem.source).toBe("principal"); // legacy backfill
        expect(await store.countDurableFacts("phantom")).toBe(2);
        // Other persona untouched.
        expect(await store.countDurableFacts("lena")).toBe(1);
        // The re-scoped table accepts a persona-wide upsert (new unique key).
        await store.upsertDurableFact({
          persona: "phantom",
          conversation: "telegram:Z",
          fact: "andrew lives in arnhem", // same norm, third conversation
          confidence: 0.95,
          source: "self",
        });
        // Still one row for that norm (persona-wide), confidence bumped to 0.95,
        // source stays principal (self does not downgrade principal).
        expect(await store.countDurableFacts("phantom")).toBe(2);
        const after = (await store.topDurableFacts("phantom", { limit: 10 })).find(
          (f) => f.fact.toLowerCase().includes("arnhem"),
        )!;
        expect(after.confidence).toBeCloseTo(0.95);
        expect(after.source).toBe("principal");
      } finally {
        await store.close();
      }
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("deleteConversation (/reset) — facts are persona-wide and SURVIVE", () => {
  test("clears turns, cursor, and leases but LEAVES durable facts intact", async () => {
    for (let i = 1; i <= 6; i++) await appendTurn(`turn ${i}`);
    await memory.claimEvictedForExtraction(PERSONA, CONV, 2, 4, LEASE);
    await memory.upsertDurableFact({
      persona: PERSONA,
      conversation: CONV,
      fact: "Andrew lives in Arnhem.",
      confidence: 0.9,
    });
    expect(await memory.countDurableFacts(PERSONA)).toBe(1);
    expect(await memory.durableFactCursor(PERSONA, CONV)).toBeGreaterThan(0);

    const deleted = await memory.deleteConversation(PERSONA, CONV);
    expect(deleted).toBeGreaterThan(0); // returns the turn count

    // Facts are persona-wide shared knowledge → they SURVIVE a conversation reset.
    expect(await memory.countDurableFacts(PERSONA)).toBe(1);
    // But the conversation's per-conversation extractor state is cleared.
    expect(await memory.durableFactCursor(PERSONA, CONV)).toBe(0);

    // A fresh claim after reset starts from a clean slate.
    for (let i = 1; i <= 6; i++) await appendTurn(`fresh ${i}`);
    const claimed = await claimTurns(2, 10);
    expect(claimed.every((t) => t.text.startsWith("fresh"))).toBe(true);
  });

  test("resetting one conversation does not touch another conversation's cursor", async () => {
    const OTHER = "telegram:2002";
    await memory.setDurableFactCursor(PERSONA, CONV, 5);
    await memory.setDurableFactCursor(PERSONA, OTHER, 7);
    await memory.deleteConversation(PERSONA, CONV);
    expect(await memory.durableFactCursor(PERSONA, CONV)).toBe(0);
    expect(await memory.durableFactCursor(PERSONA, OTHER)).toBe(7);
  });
});
