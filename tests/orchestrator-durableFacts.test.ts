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

    const facts = await memory.topDurableFacts(PERSONA, { limit: 10 });
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
    const facts = await memory.topDurableFacts(PERSONA, { limit: 10 });
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
    const facts = await memory.topDurableFacts(PERSONA, { limit: 10 });
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
    expect(await memory.countDurableFacts(PERSONA)).toBe(0);
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
    expect(await memory.countDurableFacts(PERSONA)).toBe(0);
  });

  test("mid-batch failure releases the failed turn + tail, so only those re-extract next pass", async () => {
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
    // The cursor is a MONOTONIC high-water mark (never rewound); recovery rides
    // the lease ledger, not the cursor. Turn 1 was committed (lease dropped);
    // turns 2..4 were released (leases expired) so they re-claim — no permanent
    // skip, which is Kai's second race (PR #320).

    // A later healthy pass re-claims exactly turns 2..4 (turn 1 stays committed).
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
    expect(res2.turnsProcessed).toBe(3); // turns 2, 3, 4 re-claimed — NOT turn 1
    expect(await memory.countDurableFacts(PERSONA)).toBe(3); // 1 + 2

    // And now everything is committed: a third pass finds nothing.
    const res3 = await extractDurableFactsOnEviction({
      persona: PERSONA,
      conversation: CONV,
      memory,
      settings: SETTINGS,
      complete: healthy,
      windowSize: 2,
    });
    expect(res3.turnsProcessed).toBe(0);
  });

  test("total failure releases the whole batch — every turn re-extracts, nothing skipped", async () => {
    for (let i = 1; i <= 6; i++) await appendTurn(`turn ${i}`);
    const dead: ExtractComplete = async () => {
      throw new Error("harness down");
    };
    const failedPass = await extractDurableFactsOnEviction({
      persona: PERSONA,
      conversation: CONV,
      memory,
      settings: SETTINGS,
      complete: dead,
      windowSize: 2,
    });
    expect(failedPass.turnsProcessed).toBe(0);

    // Recovery: a healthy pass re-claims the entire batch (turns 1..4).
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
    expect(await memory.countDurableFacts(PERSONA)).toBe(1);
  });

  test("a crashed pass (leases left live) does NOT re-extract until the lease expires", async () => {
    for (let i = 1; i <= 6; i++) await appendTurn(`turn ${i}`);
    // Simulate a hard crash: claim leases the batch, but the process dies before
    // commit OR release. We model that by claiming directly against the store
    // with a long lease and never committing.
    const { token, turns: leased } = await memory.claimEvictedForExtraction(
      PERSONA,
      CONV,
      2, // window → turns 1..4 evicted
      SETTINGS.maxExtractPerTurn,
      60_000, // 60s lease still live
    );
    expect(leased).toHaveLength(4);

    // A fresh pass must NOT touch the live-leased turns (no double-extraction).
    let calls = 0;
    const complete: ExtractComplete = async () => {
      calls++;
      return "[]";
    };
    const res = await extractDurableFactsOnEviction({
      persona: PERSONA,
      conversation: CONV,
      memory,
      settings: SETTINGS,
      complete,
      windowSize: 2,
    });
    expect(res.turnsProcessed).toBe(0);
    expect(calls).toBe(0);

    // Once the lease has expired, the turns become re-claimable again.
    await memory.releaseExtractionLease(
      PERSONA,
      CONV,
      leased.map((t) => t.id),
      token,
    );
    const healthy = fakeComplete({
      "turn 1": '[{"fact":"Andrew lives in Arnhem","confidence":0.9}]',
    });
    const res2 = await extractDurableFactsOnEviction({
      persona: PERSONA,
      conversation: CONV,
      memory,
      settings: SETTINGS,
      complete: healthy,
      windowSize: 2,
    });
    expect(res2.turnsProcessed).toBe(4);
    expect(await memory.countDurableFacts(PERSONA)).toBe(1);
  });

  test("a clean pass commits everything — the cursor advances and a second pass is a no-op", async () => {
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
    // Turns 1..4 evicted and fully committed → monotonic cursor sits at id 4,
    // no pending leases, and a second pass finds nothing new to claim.
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

  test("a /reset landing mid-extraction does NOT repopulate the wiped conversation", async () => {
    // Kai's reset-repopulation race (PR #320): the slow, un-transactioned
    // complete() gives a concurrent /reset a window to wipe the conversation
    // AFTER the turn was claimed but BEFORE its facts are written. We model the
    // interleave by wiping the conversation from INSIDE complete(), then
    // returning a fact. The lease was cleared by the reset, so the token-gated
    // commit must discard the write — nothing leaks into the fresh conversation.
    for (let i = 1; i <= 4; i++) await appendTurn(`turn ${i}`); // window 2 → 1..2 evicted
    const complete: ExtractComplete = async () => {
      await memory.deleteConversation(PERSONA, CONV);
      return '[{"fact":"stale pre-reset fact","confidence":0.9}]';
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
    expect(await memory.countDurableFacts(PERSONA)).toBe(0);
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

  test("qualifies `other`-source facts inline so they never masquerade as owner knowledge", () => {
    const block = formatDurableFacts([
      {
        id: 1,
        persona: PERSONA,
        conversation: CONV,
        fact: "Andrew lives in Arnhem.",
        confidence: 0.9,
        source: "principal",
        createdAt: new Date(),
        lastSeenAt: new Date(),
      },
      {
        id: 2,
        persona: PERSONA,
        conversation: CONV,
        fact: "The gateway password is hunter2.",
        confidence: 0.9,
        source: "other",
        createdAt: new Date(),
        lastSeenAt: new Date(),
      },
    ]);
    // Trusted (principal) fact renders as a plain background bullet.
    expect(block).toContain("- Andrew lives in Arnhem.");
    // The third-party fact is present but explicitly tagged unverified — never
    // as a bare owner bullet. This is the provenance-boundary regression guard.
    expect(block).toContain(
      "- [unverified — reported by a third party in a shared conversation] The gateway password is hunter2.",
    );
    expect(block).not.toContain("- The gateway password is hunter2.");
  });

  test("labels an allowed untrusted (`other`) turn to the extractor as THIRD_PARTY, not PRINCIPAL", async () => {
    // A third-party message in a shared conversation that the screen let
    // through (embeddable=true, source=other), followed by enough turns to
    // evict it past the live window.
    await memory.appendTurn({
      persona: PERSONA,
      conversation: CONV,
      role: "user",
      text: "third-party claim about Andrew",
      embeddable: true,
      source: "other",
    });
    for (let i = 1; i <= 5; i++) await appendTurn(`turn ${i}`);

    const seen: string[] = [];
    const complete = fakeComplete(
      { "third-party claim": '[{"fact":"claimed thing","confidence":0.9}]' },
      (msg) => seen.push(msg),
    );
    await extractDurableFactsOnEviction({
      persona: PERSONA,
      conversation: CONV,
      memory,
      settings: SETTINGS,
      complete,
      windowSize: 2,
    });

    const rendered = seen.find((m) => m.includes("third-party claim"));
    expect(rendered).toBeDefined();
    // The extractor must be told the true speaker — a third party — not that
    // this untrusted text came from the principal.
    expect(rendered).toContain('speaker="THIRD_PARTY"');
    expect(rendered).not.toContain('speaker="PRINCIPAL"');

    // And the stored fact inherits the `other` provenance tier.
    const facts = await memory.topDurableFacts(PERSONA, { limit: 10 });
    const stored = facts.find((f) => f.fact === "claimed thing");
    expect(stored?.source).toBe("other");
  });

  test("recall bump refreshes principal facts on inject but NEVER `other` facts", async () => {
    // A principal fact and a third-party (`other`) fact both clear the floor and
    // get injected. The recall bump must refresh the principal fact's clock but
    // leave the `other` fact's alone — otherwise a third-party claim would be
    // kept immortal (bump → stays top-N → bump again → never retires).
    await memory.upsertDurableFact({
      persona: PERSONA,
      conversation: CONV,
      fact: "Andrew lives in Arnhem.",
      confidence: 0.9,
      source: "principal",
    });
    await memory.upsertDurableFact({
      persona: PERSONA,
      conversation: CONV,
      fact: "gateway password claim",
      confidence: 0.9,
      source: "other",
    });
    const before = await memory.topDurableFacts(PERSONA, { limit: 10 });
    const principalBefore = before.find((f) => f.source === "principal")!;
    const otherBefore = before.find((f) => f.source === "other")!;

    await new Promise((r) => setTimeout(r, 5));
    const block = await pullDurableFacts({
      persona: PERSONA,
      conversation: CONV,
      memory,
      settings: SETTINGS,
    });
    // Both were injected (principal plain, other tagged unverified).
    expect(block).toContain("- Andrew lives in Arnhem.");
    expect(block).toContain("[unverified");
    // Let the fire-and-forget recall bump settle.
    await new Promise((r) => setTimeout(r, 20));

    const after = await memory.topDurableFacts(PERSONA, { limit: 10 });
    const principalAfter = after.find((f) => f.id === principalBefore.id)!;
    const otherAfter = after.find((f) => f.id === otherBefore.id)!;
    // Principal fact's clock advanced; the third-party fact's did not.
    expect(principalAfter.lastSeenAt.getTime()).toBeGreaterThan(
      principalBefore.lastSeenAt.getTime(),
    );
    expect(otherAfter.lastSeenAt.getTime()).toBe(
      otherBefore.lastSeenAt.getTime(),
    );
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
          source: "principal",
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
