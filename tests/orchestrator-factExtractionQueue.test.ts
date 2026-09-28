/**
 * Tests for the #626 extraction queue: short-lived processes (tick, ask)
 * ENQUEUE an eviction-cliff extraction request (an awaited INSERT, durable
 * before their teardown closes the shared SQLite handle) and the long-lived
 * daemon DRAIN loop runs the passes. Pins:
 *
 *   - the request row upserts (N turns in one conversation = one row);
 *   - the enqueue helper honours the enabled flag, and a write failure
 *     THROWS (durable-before-teardown is the whole point — Kai, PR #629);
 *   - the clear is generation-aware: a stale snapshot cannot delete a row a
 *     concurrent writer refreshed mid-pass (Kai's race pin, PR #629);
 *   - the drain clears a row only after a CLEAN pass — a harness failure or
 *     a blown-up pass keeps the row queued so the next sweep retries
 *     (at-least-once, the same guarantee the lease ledger gives turns);
 *   - a persona this host cannot serve (unknown / disabled) has its row
 *     dropped rather than retried forever.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { DEFAULT_DURABLE_FACTS, type Config } from "../src/config.ts";
import { openMemoryStore, type MemoryStore } from "../src/memory/store.ts";
import {
  drainFactExtractionRequests,
  requestFactExtractionIfEnabled,
  type ExtractComplete,
} from "../src/orchestrator/durableFacts.ts";

let memory: MemoryStore;

const PERSONA = "phantom";
const CONV = "tick:42";
const SETTINGS = { ...DEFAULT_DURABLE_FACTS };

beforeEach(async () => {
  memory = await openMemoryStore(":memory:");
});

afterEach(async () => {
  await memory.close();
});

const enabledConfig = (): Config =>
  ({ durableFacts: SETTINGS }) as unknown as Config;
const disabledConfig = (): Config =>
  ({ durableFacts: { ...SETTINGS, enabled: false } }) as unknown as Config;

/** Seed `n` turns so the oldest falls out of the default 30-turn window. */
async function seedTurns(n: number, textPrefix: string): Promise<void> {
  for (let i = 0; i < n; i++) {
    await memory.appendTurn({
      persona: PERSONA,
      conversation: CONV,
      role: i % 2 === 0 ? "user" : "assistant",
      text: `${textPrefix} turn ${i}`,
      embeddable: true,
    });
  }
}

describe("store: extraction request queue", () => {
  test("request → list → clear round-trip", async () => {
    expect(await memory.listFactExtractionRequests()).toEqual([]);

    await memory.requestFactExtraction(PERSONA, CONV);
    const rows = await memory.listFactExtractionRequests();
    expect(rows.length).toBe(1);
    expect(rows[0]!.persona).toBe(PERSONA);
    expect(rows[0]!.conversation).toBe(CONV);
    expect(rows[0]!.requestedAt.getTime()).toBeGreaterThan(0);

    const cleared = await memory.clearFactExtractionRequest(
      PERSONA,
      CONV,
      rows[0]!.requestedAt,
    );
    expect(cleared).toBe(true);
    expect(await memory.listFactExtractionRequests()).toEqual([]);
  });

  test("a second request for the same conversation upserts, never duplicates", async () => {
    await memory.requestFactExtraction(PERSONA, CONV);
    await memory.requestFactExtraction(PERSONA, CONV);
    await memory.requestFactExtraction(PERSONA, "tick:43");
    const rows = await memory.listFactExtractionRequests();
    // Without the ON CONFLICT upsert the second INSERT throws on the PRIMARY
    // KEY — this test is the pin for it.
    expect(rows.length).toBe(2);
    expect(rows.map((r) => r.conversation).sort()).toEqual(["tick:42", "tick:43"]);
  });

  test("clear is scoped to (persona, conversation)", async () => {
    await memory.requestFactExtraction(PERSONA, CONV);
    await memory.requestFactExtraction("other", CONV);
    const rows = await memory.listFactExtractionRequests();
    const cleared = await memory.clearFactExtractionRequest(
      PERSONA,
      CONV,
      rows.find((r) => r.persona === PERSONA)!.requestedAt,
    );
    expect(cleared).toBe(true);
    const remaining = await memory.listFactExtractionRequests();
    expect(remaining.length).toBe(1);
    expect(remaining[0]!.persona).toBe("other");
  });

  test("a stale snapshot does NOT clear a refreshed row (Kai's race, PR #629)", async () => {
    await memory.requestFactExtraction(PERSONA, CONV);
    const snapshot = (await memory.listFactExtractionRequests())[0]!.requestedAt;
    // A writer refreshes the row AFTER the drain snapshotted it — the clear
    // must refuse to delete, or the newer request is lost mid-drain. Wait
    // one tick so the two requested_at stamps definitely differ (ISO ms
    // precision would otherwise alias).
    await new Promise((resolve) => setTimeout(resolve, 2));
    await memory.requestFactExtraction(PERSONA, CONV);
    const cleared = await memory.clearFactExtractionRequest(
      PERSONA,
      CONV,
      snapshot,
    );
    expect(cleared).toBe(false);
    const rows = await memory.listFactExtractionRequests();
    expect(rows.length).toBe(1);
  });
});

describe("requestFactExtractionIfEnabled", () => {
  test("enabled config enqueues a row", async () => {
    await requestFactExtractionIfEnabled(enabledConfig(), PERSONA, CONV, memory);
    expect((await memory.listFactExtractionRequests()).length).toBe(1);
  });

  test("disabled config is a no-op", async () => {
    await requestFactExtractionIfEnabled(disabledConfig(), PERSONA, CONV, memory);
    expect(await memory.listFactExtractionRequests()).toEqual([]);
  });

  test("a failed write THROWS — a swallowed warn would defeat the guarantee", async () => {
    await expect(
      requestFactExtractionIfEnabled(
        enabledConfig(),
        PERSONA,
        CONV,
        new Proxy(memory, {
          get(target, prop, receiver) {
            if (prop === "requestFactExtraction") {
              return async () => {
                throw new Error("database is locked");
              };
            }
            const value = Reflect.get(target, prop, receiver);
            return typeof value === "function" ? value.bind(target) : value;
          },
        }),
      ),
    ).rejects.toThrow("database is locked");
  });
});

describe("drainFactExtractionRequests", () => {
  test("a conversation with nothing evicted is cleared without a model call", async () => {
    await memory.requestFactExtraction(PERSONA, CONV);
    let calls = 0;
    const complete: ExtractComplete = async () => {
      calls++;
      return "[]";
    };
    const result = await drainFactExtractionRequests({
      memory,
      resolvePersona: () => ({ settings: SETTINGS, complete }),
    });
    expect(result).toEqual({ drained: 1, retried: 0 });
    expect(calls).toBe(0);
    expect(await memory.listFactExtractionRequests()).toEqual([]);
  });

  test("a clean pass extracts facts and clears the row", async () => {
    await seedTurns(31, "arnhem");
    await memory.requestFactExtraction(PERSONA, CONV);
    const complete: ExtractComplete = async (_s, userMessage) =>
      userMessage.includes("arnhem")
        ? '[{"fact":"Andrew lives in Arnhem","confidence":0.9}]'
        : "[]";
    const result = await drainFactExtractionRequests({
      memory,
      resolvePersona: () => ({ settings: SETTINGS, complete }),
    });
    expect(result).toEqual({ drained: 1, retried: 0 });
    expect(await memory.listFactExtractionRequests()).toEqual([]);
    expect(await memory.countDurableFacts(PERSONA)).toBeGreaterThan(0);
  });

  test("a harness failure KEEPS the row queued, and the next sweep retries and drains it", async () => {
    await seedTurns(31, "retry-me");
    await memory.requestFactExtraction(PERSONA, CONV);

    let calls = 0;
    const flaky: ExtractComplete = async () => {
      calls++;
      if (calls === 1) throw new Error("provider 500");
      return '[{"fact":"retried fact","confidence":0.9}]';
    };
    const resolvePersona = () => ({ settings: SETTINGS, complete: flaky });

    const first = await drainFactExtractionRequests({ memory, resolvePersona });
    expect(first).toEqual({ drained: 0, retried: 1 });
    // The pin for the retry semantics: the row must still be there.
    expect((await memory.listFactExtractionRequests()).length).toBe(1);

    const second = await drainFactExtractionRequests({ memory, resolvePersona });
    expect(second).toEqual({ drained: 1, retried: 0 });
    expect(await memory.listFactExtractionRequests()).toEqual([]);
    expect(await memory.countDurableFacts(PERSONA)).toBeGreaterThan(0);
  });

  test("a pass that blows up entirely keeps the row queued", async () => {
    await seedTurns(31, "boom");
    await memory.requestFactExtraction(PERSONA, CONV);
    // Simulate the store failing mid-pass (the claim throws): the extraction
    // result carries `error`, which the drain must treat as failure, not as
    // "nothing to do". Proxy the real store so only the claim breaks.
    const broken = new Proxy(memory, {
      get(target, prop, receiver) {
        if (prop === "claimEvictedForExtraction") {
          return async () => {
            throw new Error("database is locked");
          };
        }
        const value = Reflect.get(target, prop, receiver);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    const result = await drainFactExtractionRequests({
      memory: broken,
      resolvePersona: () => ({ settings: SETTINGS, complete: async () => "[]" }),
    });
    expect(result).toEqual({ drained: 0, retried: 1 });
    expect((await memory.listFactExtractionRequests()).length).toBe(1);
  });

  test("a persona the host cannot serve has its row dropped, not retried", async () => {
    await memory.requestFactExtraction("ghost", CONV);
    const result = await drainFactExtractionRequests({
      memory,
      resolvePersona: () => undefined,
    });
    expect(result).toEqual({ drained: 1, retried: 0 });
    expect(await memory.listFactExtractionRequests()).toEqual([]);
  });

  test("a writer refreshing the row mid-pass survives the clear (Kai's race, PR #629)", async () => {
    await seedTurns(31, "survive-me");
    await memory.requestFactExtraction(PERSONA, CONV);
    const requeue: ExtractComplete = async () => {
      // A short-lived turn enqueues the SAME conversation while the drain's
      // extraction pass is in flight — the final clear must not delete it.
      // The 2ms gap models the real model-call latency: ISOms timestamps
      // otherwise alias and the refresh would land on the same generation.
      await new Promise((resolve) => setTimeout(resolve, 2));
      await memory.requestFactExtraction(PERSONA, CONV);
      return "[]";
    };
    const result = await drainFactExtractionRequests({
      memory,
      resolvePersona: () => ({ settings: SETTINGS, complete: requeue }),
    });
    expect(result).toEqual({ drained: 0, retried: 1 });
    // The pin: exactly one row remains — the refreshed request.
    expect((await memory.listFactExtractionRequests()).length).toBe(1);
  });

  test("an aborted signal stops the sweep between rows", async () => {
    await memory.requestFactExtraction(PERSONA, "tick:1");
    await memory.requestFactExtraction(PERSONA, "tick:2");
    const ac = new AbortController();
    ac.abort();
    const result = await drainFactExtractionRequests({
      memory,
      resolvePersona: () => ({ settings: SETTINGS, complete: async () => "[]" }),
      signal: ac.signal,
    });
    expect(result).toEqual({ drained: 0, retried: 0 });
    expect((await memory.listFactExtractionRequests()).length).toBe(2);
  });
});
