/**
 * Tests for the durable-facts orchestrator: the tolerant JSON parse, the
 * extract-at-eviction WRITE pass (cursor advance, de-dupe, quarantine skip,
 * bounding, disabled gating, never-throws), and the pure-SQL READ pull +
 * prompt formatting.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { DEFAULT_DURABLE_FACTS, type Config } from "../src/config.ts";
import { openMemoryStore, type MemoryStore } from "../src/memory/store.ts";
import {
  extractDurableFactsOnEviction,
  formatDurableFacts,
  makeDurableFactPuller,
  makeFactExtractor,
  parseExtractedFacts,
  pullDurableFacts,
  type ExtractComplete,
} from "../src/orchestrator/durableFacts.ts";

let workdir: string;
let memory: MemoryStore;

const PERSONA = "phantom";
const CONV = "telegram:1001";
const SETTINGS = { ...DEFAULT_DURABLE_FACTS };

beforeEach(async () => {
  workdir = await mkdtemp(join(tmpdir(), "phantombot-df-orch-"));
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

/** A fake extractor that emits a fixed fact array keyed off the turn text. */
function fakeComplete(
  byMarker: Record<string, string>,
  onCall?: (userMessage: string) => void,
): ExtractComplete {
  return async (_system, userMessage) => {
    onCall?.(userMessage);
    for (const [marker, out] of Object.entries(byMarker)) {
      if (userMessage.includes(marker)) return out;
    }
    return "[]";
  };
}

describe("parseExtractedFacts", () => {
  test("parses a plain JSON array", () => {
    const facts = parseExtractedFacts(
      '[{"fact":"Andrew lives in Arnhem","confidence":0.9}]',
    );
    expect(facts).toEqual([{ fact: "Andrew lives in Arnhem", confidence: 0.9 }]);
  });

  test("tolerates a ```json fence and surrounding prose", () => {
    const facts = parseExtractedFacts(
      'Sure!\n```json\n[{"fact":"He uses Deye inverters","confidence":0.8}]\n```',
    );
    expect(facts).toEqual([
      { fact: "He uses Deye inverters", confidence: 0.8 },
    ]);
  });

  test("empty array and garbage both yield []", () => {
    expect(parseExtractedFacts("[]")).toEqual([]);
    expect(parseExtractedFacts("not json at all")).toEqual([]);
    expect(parseExtractedFacts("")).toEqual([]);
  });

  test("drops blank facts, clamps confidence, defaults missing confidence", () => {
    const facts = parseExtractedFacts(
      '[{"fact":"","confidence":0.5},{"fact":"real","confidence":5},{"fact":"noconf"}]',
    );
    expect(facts).toEqual([
      { fact: "real", confidence: 1 },
      { fact: "noconf", confidence: 0.5 },
    ]);
  });
});

describe("extractDurableFactsOnEviction", () => {
  test("extracts from evicted turns, upserts facts, advances cursor", async () => {
    for (let i = 1; i <= 6; i++) await appendTurn(`turn ${i}`);
    const complete = fakeComplete({
      "turn 1": '[{"fact":"Andrew lives in Arnhem","confidence":0.9}]',
      "turn 2": '[{"fact":"He uses Deye inverters","confidence":0.8}]',
    });
    const res = await extractDurableFactsOnEviction({
      persona: PERSONA,
      conversation: CONV,
      memory,
      settings: SETTINGS,
      complete,
      windowSize: 2, // keep newest 2 → turns 1..4 evicted
    });
    expect(res.triggered).toBe(true);
    expect(res.turnsProcessed).toBe(4);
    expect(res.factsWritten).toBe(2);

    const facts = await memory.topDurableFacts(PERSONA, CONV, { limit: 10 });
    expect(facts.map((f) => f.fact).sort()).toEqual([
      "Andrew lives in Arnhem",
      "He uses Deye inverters",
    ]);
    // Cursor advanced past the last evicted turn, so a second pass is a no-op.
    const again = await extractDurableFactsOnEviction({
      persona: PERSONA,
      conversation: CONV,
      memory,
      settings: SETTINGS,
      complete,
      windowSize: 2,
    });
    expect(again.turnsProcessed).toBe(0);
  });

  test("skips quarantined (embeddable=false) turns but advances the cursor past them", async () => {
    await appendTurn("SECRET untrusted payload", "user", false);
    for (let i = 1; i <= 5; i++) await appendTurn(`turn ${i}`);
    const seen: string[] = [];
    const complete = fakeComplete(
      { "turn 1": '[{"fact":"kept","confidence":0.9}]' },
      (msg) => seen.push(msg),
    );
    const res = await extractDurableFactsOnEviction({
      persona: PERSONA,
      conversation: CONV,
      memory,
      settings: SETTINGS,
      complete,
      windowSize: 2,
    });
    // The quarantined turn must never be handed to the extractor.
    expect(seen.some((m) => m.includes("SECRET"))).toBe(false);
    expect(res.factsWritten).toBe(1);
    const facts = await memory.topDurableFacts(PERSONA, CONV, { limit: 10 });
    expect(facts.map((f) => f.fact)).toEqual(["kept"]);
  });

  test("de-dupes a fact restated across two evicted turns", async () => {
    for (let i = 1; i <= 6; i++) await appendTurn(`turn ${i}`);
    const complete = fakeComplete({
      "turn 1": '[{"fact":"He uses Deye inverters","confidence":0.6}]',
      "turn 2": '[{"fact":"he uses deye inverters.","confidence":0.9}]',
    });
    await extractDurableFactsOnEviction({
      persona: PERSONA,
      conversation: CONV,
      memory,
      settings: SETTINGS,
      complete,
      windowSize: 2,
    });
    const facts = await memory.topDurableFacts(PERSONA, CONV, { limit: 10 });
    expect(facts).toHaveLength(1);
    expect(facts[0]!.confidence).toBeCloseTo(0.9); // max of the two
  });

  test("bounds work to maxExtractPerTurn per pass", async () => {
    for (let i = 1; i <= 12; i++) await appendTurn(`turn ${i}`);
    let calls = 0;
    const complete: ExtractComplete = async () => {
      calls++;
      return "[]";
    };
    const res = await extractDurableFactsOnEviction({
      persona: PERSONA,
      conversation: CONV,
      memory,
      settings: { ...SETTINGS, maxExtractPerTurn: 3 },
      complete,
      windowSize: 2, // 10 turns evicted, but capped at 3 this pass
    });
    expect(res.turnsProcessed).toBe(3);
    expect(calls).toBe(3);
  });

  test("disabled settings do nothing", async () => {
    for (let i = 1; i <= 6; i++) await appendTurn(`turn ${i}`);
    let calls = 0;
    const complete: ExtractComplete = async () => {
      calls++;
      return '[{"fact":"x","confidence":1}]';
    };
    const res = await extractDurableFactsOnEviction({
      persona: PERSONA,
      conversation: CONV,
      memory,
      settings: { ...SETTINGS, enabled: false },
      complete,
      windowSize: 2,
    });
    expect(res.triggered).toBe(false);
    expect(calls).toBe(0);
    expect(await memory.countDurableFacts(PERSONA, CONV)).toBe(0);
  });

  test("never throws when the completion fn rejects", async () => {
    for (let i = 1; i <= 6; i++) await appendTurn(`turn ${i}`);
    const complete: ExtractComplete = async () => {
      throw new Error("harness exploded");
    };
    const res = await extractDurableFactsOnEviction({
      persona: PERSONA,
      conversation: CONV,
      memory,
      settings: SETTINGS,
      complete,
      windowSize: 2,
    });
    expect(res.factsWritten).toBe(0);
    expect(await memory.countDurableFacts(PERSONA, CONV)).toBe(0);
  });

  test("mid-batch failure rolls the cursor back to the last handled turn, so the rest re-extracts next pass", async () => {
    for (let i = 1; i <= 6; i++) await appendTurn(`turn ${i}`);
    // window 2 → turns 1..4 evicted (ids 1..4), claimed in one pass (cap 4).
    // Extract turn 1 fine, then the harness dies on turn 2.
    const flaky: ExtractComplete = async (_s, userMessage) => {
      if (userMessage.includes("turn 1"))
        return '[{"fact":"Andrew lives in Arnhem","confidence":0.9}]';
      throw new Error("harness timeout");
    };
    const res = await extractDurableFactsOnEviction({
      persona: PERSONA,
      conversation: CONV,
      memory,
      settings: SETTINGS,
      complete: flaky,
      windowSize: 2,
    });
    expect(res.turnsProcessed).toBe(1);
    expect(res.factsWritten).toBe(1);
    // Cursor rolled back to turn 1 (id 1) — NOT left at the claimed max (id 4),
    // which would silently skip turns 2..4 forever (Kai's at-most-once flag).
    expect(await memory.durableFactCursor(PERSONA, CONV)).toBe(1);

    // A later healthy pass re-claims turns 2..4 and extracts what they hold.
    const healthy = fakeComplete({
      "turn 2": '[{"fact":"He uses Deye inverters","confidence":0.8}]',
      "turn 3": '[{"fact":"His homelab runs Proxmox","confidence":0.7}]',
    });
    const res2 = await extractDurableFactsOnEviction({
      persona: PERSONA,
      conversation: CONV,
      memory,
      settings: SETTINGS,
      complete: healthy,
      windowSize: 2,
    });
    expect(res2.turnsProcessed).toBe(3); // turns 2, 3, 4 re-claimed
    expect(await memory.countDurableFacts(PERSONA, CONV)).toBe(3); // 1 + 2
  });

  test("total failure rewinds the whole batch — cursor back to the start, nothing skipped", async () => {
    for (let i = 1; i <= 6; i++) await appendTurn(`turn ${i}`);
    const dead: ExtractComplete = async () => {
      throw new Error("harness down");
    };
    await extractDurableFactsOnEviction({
      persona: PERSONA,
      conversation: CONV,
      memory,
      settings: SETTINGS,
      complete: dead,
      windowSize: 2,
    });
    // First evicted turn is id 1 → nothing handled → cursor rewound to 0.
    expect(await memory.durableFactCursor(PERSONA, CONV)).toBe(0);

    // Recovery: a healthy pass re-extracts the entire batch (turns 1..4).
    const healthy = fakeComplete({
      "turn 1": '[{"fact":"Andrew lives in Arnhem","confidence":0.9}]',
    });
    const res = await extractDurableFactsOnEviction({
      persona: PERSONA,
      conversation: CONV,
      memory,
      settings: SETTINGS,
      complete: healthy,
      windowSize: 2,
    });
    expect(res.turnsProcessed).toBe(4);
    expect(await memory.countDurableFacts(PERSONA, CONV)).toBe(1);
  });

  test("a clean pass does NOT roll back — cursor stays at the claimed max", async () => {
    for (let i = 1; i <= 6; i++) await appendTurn(`turn ${i}`);
    const complete = fakeComplete({
      "turn 1": '[{"fact":"Andrew lives in Arnhem","confidence":0.9}]',
    });
    await extractDurableFactsOnEviction({
      persona: PERSONA,
      conversation: CONV,
      memory,
      settings: SETTINGS,
      complete,
      windowSize: 2,
    });
    // Turns 1..4 evicted and fully handled → cursor sits at id 4, and a second
    // pass finds nothing new to claim.
    expect(await memory.durableFactCursor(PERSONA, CONV)).toBe(4);
    const again = await extractDurableFactsOnEviction({
      persona: PERSONA,
      conversation: CONV,
      memory,
      settings: SETTINGS,
      complete,
      windowSize: 2,
    });
    expect(again.turnsProcessed).toBe(0);
  });
});

describe("pullDurableFacts / formatDurableFacts", () => {
  test("formats stored facts as a background-context block", async () => {
    await memory.upsertDurableFact({
      persona: PERSONA,
      conversation: CONV,
      fact: "Andrew lives in Arnhem.",
      confidence: 0.9,
    });
    await memory.upsertDurableFact({
      persona: PERSONA,
      conversation: CONV,
      fact: "He uses Deye inverters.",
      confidence: 0.8,
    });
    const block = await pullDurableFacts({
      persona: PERSONA,
      conversation: CONV,
      memory,
      settings: SETTINGS,
    });
    expect(block).toContain("- Andrew lives in Arnhem.");
    expect(block).toContain("- He uses Deye inverters.");
    expect(block!.toLowerCase()).toContain("not instructions");
  });

  test("returns undefined when disabled, when maxInjected is 0, or when empty", async () => {
    expect(
      await pullDurableFacts({
        persona: PERSONA,
        conversation: CONV,
        memory,
        settings: { ...SETTINGS, enabled: false },
      }),
    ).toBeUndefined();
    await memory.upsertDurableFact({
      persona: PERSONA,
      conversation: CONV,
      fact: "x",
      confidence: 0.9,
    });
    expect(
      await pullDurableFacts({
        persona: PERSONA,
        conversation: CONV,
        memory,
        settings: { ...SETTINGS, maxInjected: 0 },
      }),
    ).toBeUndefined();
    // Nothing clears a high floor.
    expect(
      await pullDurableFacts({
        persona: PERSONA,
        conversation: CONV,
        memory,
        settings: { ...SETTINGS, minConfidence: 0.99 },
      }),
    ).toBeUndefined();
  });

  test("formatDurableFacts returns undefined for an all-blank set", () => {
    expect(
      formatDurableFacts([
        {
          id: 1,
          persona: PERSONA,
          conversation: CONV,
          fact: "   ",
          confidence: 1,
          createdAt: new Date(),
          lastSeenAt: new Date(),
        },
      ]),
    ).toBeUndefined();
  });
});

describe("factory gating", () => {
  const cfg = (durableFacts: unknown): Config =>
    ({ durableFacts }) as unknown as Config;

  test("makeDurableFactPuller returns undefined when disabled/absent", () => {
    expect(
      makeDurableFactPuller(cfg(undefined), PERSONA, CONV, memory),
    ).toBeUndefined();
    expect(
      makeDurableFactPuller(
        cfg({ ...SETTINGS, enabled: false }),
        PERSONA,
        CONV,
        memory,
      ),
    ).toBeUndefined();
    expect(
      makeDurableFactPuller(cfg({ ...SETTINGS }), PERSONA, CONV, memory),
    ).toBeInstanceOf(Function);
  });

  test("makeFactExtractor returns undefined when disabled or no harness", () => {
    expect(
      makeFactExtractor(cfg({ ...SETTINGS }), PERSONA, CONV, memory, []),
    ).toBeUndefined();
    expect(
      makeFactExtractor(
        cfg({ ...SETTINGS, enabled: false }),
        PERSONA,
        CONV,
        memory,
        [],
      ),
    ).toBeUndefined();
  });
});
