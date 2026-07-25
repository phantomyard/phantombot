/**
 * Tests for the durable_facts store surface: upsert/de-dupe, confidence-max +
 * recency semantics, ranked reads with a confidence floor, the eviction-window
 * query, the extractor cursor, and fact normalization.
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
});
