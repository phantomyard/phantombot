/**
 * Tests for the durable_facts store surface: upsert/de-dupe, confidence-max +
 * recency semantics, ranked reads with a confidence floor, the eviction-window
 * query, the monotonic extractor cursor, the claim/commit/release lease ledger
 * (including concurrent-partial-failure recovery), and fact normalization.
 */

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

/**
 * Claim and return only the leased turns, discarding the ownership token — for
 * the many assertions that inspect only which turns were claimed. Tests that
 * exercise commit/release keep the full { token, turns } so they can pass the
 * token back.
 */
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
  test("inserts a fact and reads it back", async () => {
    await memory.upsertDurableFact({
      persona: PERSONA,
      conversation: CONV,
      fact: "Andrew lives in Arnhem.",
      confidence: 0.9,
    });
    const facts = await memory.topDurableFacts(PERSONA, CONV, { limit: 10 });
    expect(facts).toHaveLength(1);
    expect(facts[0]!.fact).toBe("Andrew lives in Arnhem.");
    expect(facts[0]!.confidence).toBeCloseTo(0.9);
    expect(await memory.countDurableFacts(PERSONA, CONV)).toBe(1);
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
    const facts = await memory.topDurableFacts(PERSONA, CONV, { limit: 10 });
    expect(facts).toHaveLength(1);
    expect(facts[0]!.confidence).toBeCloseTo(0.6);
    expect(await memory.countDurableFacts(PERSONA, CONV)).toBe(1);
  });

  test("re-extraction bumps recency (last_seen_at)", async () => {
    await memory.upsertDurableFact({
      persona: PERSONA,
      conversation: CONV,
      fact: "Andrew runs MAN Consulting.",
      confidence: 0.7,
    });
    const before = (
      await memory.topDurableFacts(PERSONA, CONV, { limit: 1 })
    )[0]!;
    await new Promise((r) => setTimeout(r, 5));
    await memory.upsertDurableFact({
      persona: PERSONA,
      conversation: CONV,
      fact: "Andrew runs MAN Consulting.",
      confidence: 0.7,
    });
    const after = (
      await memory.topDurableFacts(PERSONA, CONV, { limit: 1 })
    )[0]!;
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
    const all = await memory.topDurableFacts(PERSONA, CONV, { limit: 10 });
    expect(all.map((f) => f.fact)).toEqual([
      "high conf fact",
      "mid conf fact",
      "low conf fact",
    ]);

    const floored = await memory.topDurableFacts(PERSONA, CONV, {
      limit: 10,
      minConfidence: 0.5,
    });
    expect(floored.map((f) => f.fact)).toEqual(["high conf fact", "mid conf fact"]);

    const capped = await memory.topDurableFacts(PERSONA, CONV, { limit: 1 });
    expect(capped.map((f) => f.fact)).toEqual(["high conf fact"]);
  });

  test("facts are scoped per (persona, conversation)", async () => {
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
    const a = await memory.topDurableFacts(PERSONA, CONV, { limit: 10 });
    expect(a.map((f) => f.fact)).toEqual(["conv A fact"]);
    const b = await memory.topDurableFacts(PERSONA, "telegram:2002", {
      limit: 10,
    });
    expect(b.map((f) => f.fact)).toEqual(["conv B fact"]);
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
      (await memory.topDurableFacts(PERSONA, CONV, { limit: 10 })).map((f) => [
        f.fact,
        f.confidence,
      ]),
    );
    expect(byFact.over).toBeCloseTo(1);
    expect(byFact.under).toBeCloseTo(0);
    expect(byFact.default).toBeCloseTo(0.5);
  });
});

describe("turnsEvictedFromWindow", () => {
  test("returns only turns that have aged out of the live window", async () => {
    for (let i = 1; i <= 10; i++) await appendTurn(`turn ${i}`);
    // windowSize 4 keeps the newest 4 (turns 7..10); 1..6 are evicted.
    const evicted = await memory.turnsEvictedFromWindow(
      PERSONA,
      CONV,
      4,
      0,
      100,
    );
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
    const firstPass = await memory.turnsEvictedFromWindow(
      PERSONA,
      CONV,
      4,
      0,
      2,
    );
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
    const evicted = await memory.turnsEvictedFromWindow(
      PERSONA,
      CONV,
      30,
      0,
      100,
    );
    expect(evicted).toHaveLength(0);
  });

  test("carries the embeddable flag through so quarantined turns can be skipped", async () => {
    await appendTurn("quarantined", "user", false);
    for (let i = 1; i <= 5; i++) await appendTurn(`turn ${i}`);
    const evicted = await memory.turnsEvictedFromWindow(
      PERSONA,
      CONV,
      2,
      0,
      100,
    );
    const q = evicted.find((t) => t.text === "quarantined");
    expect(q).toBeDefined();
    expect(q!.embeddable).toBe(false);
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
    // A slower/older extraction pass tries to set a lower value; the MAX guard
    // keeps the newer cursor (Kai's cursor-regression concern, PR #320).
    await memory.setDurableFactCursor(PERSONA, CONV, 5);
    expect(await memory.durableFactCursor(PERSONA, CONV)).toBe(99);
  });
});

describe("claimEvictedForExtraction (lease-based claim)", () => {
  test("advances the monotonic cursor and leases the batch so the next claim is disjoint", async () => {
    for (let i = 1; i <= 10; i++) await appendTurn(`turn ${i}`);
    // windowSize 4 evicts 1..6; claim 2 at a time, never committing.
    const first = await claimTurns(4, 2);
    expect(first.map((t) => t.text)).toEqual(["turn 1", "turn 2"]);
    // Cursor moved past the batch WITHOUT a separate setDurableFactCursor call.
    expect(await memory.durableFactCursor(PERSONA, CONV)).toBe(first[1]!.id);

    const second = await claimTurns(4, 2);
    expect(second.map((t) => t.text)).toEqual(["turn 3", "turn 4"]);
    // No overlap: turns 1..2 hold live leases and are excluded from the SELECT.
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
    // Fire many claims concurrently; the serialized transaction + live-lease
    // exclusion must partition the evicted turns (1..6) with zero overlap.
    const claims = await Promise.all(
      Array.from({ length: 6 }, () =>
        memory.claimEvictedForExtraction(PERSONA, CONV, 4, 2, LEASE),
      ),
    );
    const ids = claims.flatMap((c) => c.turns).map((t) => t.id);
    expect(new Set(ids).size).toBe(ids.length); // no id claimed twice
    expect(new Set(ids).size).toBe(6); // all six evicted turns claimed once
  });

  test("empty claim leaves the cursor untouched", async () => {
    for (let i = 1; i <= 3; i++) await appendTurn(`turn ${i}`);
    const claimed = await claimTurns(30, 5);
    expect(claimed).toHaveLength(0);
    expect(await memory.durableFactCursor(PERSONA, CONV)).toBe(0);
  });

  test("a committed turn is never re-claimed; a released one is re-claimed at once", async () => {
    for (let i = 1; i <= 6; i++) await appendTurn(`turn ${i}`); // window 2 → 1..4 evicted
    const { token, turns: first } =
      await memory.claimEvictedForExtraction(PERSONA, CONV, 2, 4, LEASE);
    expect(first.map((t) => t.text)).toEqual([
      "turn 1",
      "turn 2",
      "turn 3",
      "turn 4",
    ]);
    // Commit turns 1 & 2; release 3 & 4 (as a failed pass would).
    await memory.commitExtractedTurn(PERSONA, CONV, first[0]!.id, token);
    await memory.commitExtractedTurn(PERSONA, CONV, first[1]!.id, token);
    await memory.releaseExtractionLease(
      PERSONA,
      CONV,
      [first[2]!.id, first[3]!.id],
      token,
    );

    // Next claim sees ONLY the released turns — committed ones stay gone even
    // though they sit below the (monotonic) cursor.
    const second = await claimTurns(2, 4);
    expect(second.map((t) => t.text)).toEqual(["turn 3", "turn 4"]);
  });

  test("commitExtraction writes facts AND drops the lease under a matching token", async () => {
    for (let i = 1; i <= 4; i++) await appendTurn(`turn ${i}`); // window 2 → 1..2 evicted
    const { token, turns } =
      await memory.claimEvictedForExtraction(PERSONA, CONV, 2, 4, LEASE);
    const wrote = await memory.commitExtraction(
      PERSONA,
      CONV,
      turns[0]!.id,
      token,
      [{ fact: "Andrew lives in Arnhem.", confidence: 0.9 }],
    );
    expect(wrote).toBe(true);
    expect(await memory.countDurableFacts(PERSONA, CONV)).toBe(1);
    // Lease dropped: turn is not re-claimed on the next pass.
    const next = await claimTurns(2, 4);
    expect(next.some((t) => t.id === turns[0]!.id)).toBe(false);
  });

  test("commitExtraction writes NOTHING when the token no longer matches (stale finisher)", async () => {
    for (let i = 1; i <= 4; i++) await appendTurn(`turn ${i}`); // window 2 → 1..2 evicted
    const { turns } =
      await memory.claimEvictedForExtraction(PERSONA, CONV, 2, 4, LEASE);
    // A stale pass tries to commit with a token it never held.
    const wrote = await memory.commitExtraction(
      PERSONA,
      CONV,
      turns[0]!.id,
      "not-the-real-token",
      [{ fact: "should not be written", confidence: 0.9 }],
    );
    expect(wrote).toBe(false);
    expect(await memory.countDurableFacts(PERSONA, CONV)).toBe(0);
  });

  test("lease-expiry re-claim: the ORIGINAL owner's late commit is discarded, no duplicate fact", async () => {
    // Kai's lease-expiry race (PR #320): pass A claims turn 1 with a zero-length
    // (already-stale) lease, pass B re-claims the same turn (fresh token), B
    // commits its fact — then A, having finally finished its slow harness call,
    // tries to commit the SAME turn. A's token is stale, so its write is dropped
    // and there is exactly one fact, not two.
    for (let i = 1; i <= 4; i++) await appendTurn(`turn ${i}`); // window 2 → 1..2 evicted
    const passA = await memory.claimEvictedForExtraction(PERSONA, CONV, 2, 1, 0);
    const turnId = passA.turns[0]!.id;
    const passB = await memory.claimEvictedForExtraction(PERSONA, CONV, 2, 1, LEASE);
    expect(passB.turns[0]!.id).toBe(turnId); // B re-claimed the stale turn

    const bWrote = await memory.commitExtraction(PERSONA, CONV, turnId, passB.token, [
      { fact: "Andrew lives in Arnhem.", confidence: 0.9 },
    ]);
    expect(bWrote).toBe(true);
    const aWrote = await memory.commitExtraction(PERSONA, CONV, turnId, passA.token, [
      { fact: "Andrew lives in Arnhem.", confidence: 0.9 },
    ]);
    expect(aWrote).toBe(false);
    expect(await memory.countDurableFacts(PERSONA, CONV)).toBe(1);
  });

  test("release is token-gated: a stale owner cannot resurrect a turn another pass holds", async () => {
    for (let i = 1; i <= 4; i++) await appendTurn(`turn ${i}`); // window 2 → 1..2 evicted
    const passA = await memory.claimEvictedForExtraction(PERSONA, CONV, 2, 2, 0);
    const passB = await memory.claimEvictedForExtraction(PERSONA, CONV, 2, 2, LEASE);
    const bIds = passB.turns.map((t) => t.id);
    // A (now stale) tries to release turns B legitimately holds — must be a no-op
    // so B's live leases aren't reset out from under it.
    await memory.releaseExtractionLease(PERSONA, CONV, bIds, passA.token);
    const next = await claimTurns(2, 4);
    // B still holds live leases on those turns; nothing new is claimable.
    expect(next).toHaveLength(0);
  });

  test("Kai's interleave: a partial failure never strands turns behind an advanced cursor", async () => {
    // The exact scenario from PR #320 review: pass A claims 1..4, pass B claims
    // 5..8 and finishes first (cursor → 8), then A fails on turn 2. With a
    // monotonic cursor + lease ledger, A's released 2..4 are still re-claimable
    // even though they sit far below cursor 8.
    for (let i = 1; i <= 10; i++) await appendTurn(`turn ${i}`); // window 2 → 1..8 evicted

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

    // B commits its whole batch; cursor is now well past A's turns.
    for (const t of passB.turns) {
      await memory.commitExtractedTurn(PERSONA, CONV, t.id, passB.token);
    }
    expect(await memory.durableFactCursor(PERSONA, CONV)).toBe(passB.turns[3]!.id);

    // A commits turn 1, then fails → releases 2,3,4.
    await memory.commitExtractedTurn(PERSONA, CONV, passA.turns[0]!.id, passA.token);
    await memory.releaseExtractionLease(
      PERSONA,
      CONV,
      [passA.turns[1]!.id, passA.turns[2]!.id, passA.turns[3]!.id],
      passA.token,
    );

    // The stranded turns come back — re-claimable despite being below cursor 8.
    const recovered = await claimTurns(2, 10);
    expect(recovered.map((t) => t.text)).toEqual(["turn 2", "turn 3", "turn 4"]);
  });

  test("live leases are excluded but STALE leases (expired) are re-claimable", async () => {
    for (let i = 1; i <= 6; i++) await appendTurn(`turn ${i}`); // window 2 → 1..4 evicted
    // Zero-length lease: every claimed turn is instantly stale.
    const first = await claimTurns(2, 4, 0);
    expect(first).toHaveLength(4);
    // Because the leases are already expired, a second claim re-selects them.
    const second = await claimTurns(2, 4);
    expect(second.map((t) => t.id).sort((a, b) => a - b)).toEqual(
      first.map((t) => t.id).sort((a, b) => a - b),
    );
  });
});

describe("deleteConversation clears durable-fact leases + fresh-claim (/reset)", () => {
  test("wipes facts, cursor, and leases — nothing leaks into a fresh conversation", async () => {
    for (let i = 1; i <= 6; i++) await appendTurn(`turn ${i}`);
    // Claim (leaves a cursor + live leases) and write a fact.
    await memory.claimEvictedForExtraction(PERSONA, CONV, 2, 4, LEASE);
    await memory.upsertDurableFact({
      persona: PERSONA,
      conversation: CONV,
      fact: "Andrew lives in Arnhem.",
      confidence: 0.9,
    });
    expect(await memory.countDurableFacts(PERSONA, CONV)).toBe(1);
    expect(await memory.durableFactCursor(PERSONA, CONV)).toBeGreaterThan(0);

    const deleted = await memory.deleteConversation(PERSONA, CONV);
    expect(deleted).toBeGreaterThan(0); // returns the turn count

    // Every durable store is now empty for this key.
    expect(await memory.countDurableFacts(PERSONA, CONV)).toBe(0);
    expect(await memory.durableFactCursor(PERSONA, CONV)).toBe(0);
    expect(
      await memory.topDurableFacts(PERSONA, CONV, { limit: 10 }),
    ).toHaveLength(0);

    // And a fresh claim after reset starts from a clean slate: with no turns and
    // no leftover leases/cursor, nothing is claimable.
    for (let i = 1; i <= 6; i++) await appendTurn(`fresh ${i}`);
    const claimed = await claimTurns(2, 10);
    // Only the brand-new turns are eligible — no stale lease resurrects an old
    // turn id, and the cursor started at 0 again.
    expect(claimed.every((t) => t.text.startsWith("fresh"))).toBe(true);
  });

  test("reset is scoped — a sibling conversation's facts survive", async () => {
    await memory.upsertDurableFact({
      persona: PERSONA,
      conversation: CONV,
      fact: "conv A fact",
      confidence: 0.9,
    });
    await memory.upsertDurableFact({
      persona: PERSONA,
      conversation: "telegram:2002",
      fact: "conv B fact",
      confidence: 0.9,
    });
    await memory.deleteConversation(PERSONA, CONV);
    expect(await memory.countDurableFacts(PERSONA, CONV)).toBe(0);
    expect(await memory.countDurableFacts(PERSONA, "telegram:2002")).toBe(1);
  });
});

describe("deleteConversation clears durable-fact state (/reset)", () => {
  test("wipes durable facts AND the extractor cursor, not just turns", async () => {
    // Seed a conversation with turns, extracted facts, and an advanced cursor.
    for (let i = 1; i <= 3; i++) await appendTurn(`turn ${i}`);
    await memory.upsertDurableFact({
      persona: PERSONA,
      conversation: CONV,
      fact: "Andrew lives in Arnhem.",
      confidence: 0.9,
    });
    await memory.setDurableFactCursor(PERSONA, CONV, 3);
    expect(await memory.countDurableFacts(PERSONA, CONV)).toBe(1);
    expect(await memory.durableFactCursor(PERSONA, CONV)).toBe(3);

    // /reset.
    await memory.deleteConversation(PERSONA, CONV);

    // Every per-conversation trace is gone: no facts leak into a fresh
    // conversation reusing the key, and the cursor is back to 0 so new turns
    // (whose ids may be below the old cursor after a fresh DB, or which must
    // be re-extracted) are considered again.
    expect(await memory.countDurableFacts(PERSONA, CONV)).toBe(0);
    expect(await memory.durableFactCursor(PERSONA, CONV)).toBe(0);
    expect(await memory.topDurableFacts(PERSONA, CONV, { limit: 10 })).toEqual(
      [],
    );
  });

  test("only clears the target (persona, conversation), leaving others intact", async () => {
    const OTHER = "telegram:2002";
    await memory.upsertDurableFact({
      persona: PERSONA,
      conversation: CONV,
      fact: "Fact in conversation A.",
      confidence: 0.8,
    });
    await memory.setDurableFactCursor(PERSONA, CONV, 5);
    await memory.upsertDurableFact({
      persona: PERSONA,
      conversation: OTHER,
      fact: "Fact in conversation B.",
      confidence: 0.8,
    });
    await memory.setDurableFactCursor(PERSONA, OTHER, 7);

    await memory.deleteConversation(PERSONA, CONV);

    expect(await memory.countDurableFacts(PERSONA, CONV)).toBe(0);
    expect(await memory.durableFactCursor(PERSONA, CONV)).toBe(0);
    // The untouched conversation keeps its facts and cursor.
    expect(await memory.countDurableFacts(PERSONA, OTHER)).toBe(1);
    expect(await memory.durableFactCursor(PERSONA, OTHER)).toBe(7);
  });
});
