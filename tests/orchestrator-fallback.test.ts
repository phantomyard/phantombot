/**
 * Tests for the runWithFallback orchestrator — focused on the
 * maxPayloadBytes precheck added in phase 10. Existing fallback
 * behavior (recoverable error → next harness, terminal error stops)
 * is exercised indirectly by tests/orchestrator-turn.test.ts.
 */

import { describe, expect, test } from "bun:test";
import {
  estimatePayloadBytes,
  runWithFallback,
} from "../src/orchestrator/fallback.ts";
import type {
  Harness,
  HarnessChunk,
  HarnessRequest,
} from "../src/harnesses/types.ts";

class FakeHarness implements Harness {
  invocations = 0;
  constructor(
    public readonly id: string,
    private readonly script: HarnessChunk[],
    public readonly maxPayloadBytes?: number,
  ) {}
  async available(): Promise<boolean> {
    return true;
  }
  async *invoke(_req: HarnessRequest): AsyncGenerator<HarnessChunk> {
    this.invocations++;
    for (const c of this.script) yield c;
  }
}

function newRequest(overrides: Partial<HarnessRequest> = {}): HarnessRequest {
  return {
    systemPrompt: "system prompt",
    userMessage: "user msg",
    history: [],
    workingDir: process.cwd(),
    timeoutMs: 5_000,
    ...overrides,
  };
}

async function collect(
  iter: AsyncIterable<HarnessChunk>,
): Promise<HarnessChunk[]> {
  const out: HarnessChunk[] = [];
  for await (const c of iter) out.push(c);
  return out;
}

describe("estimatePayloadBytes", () => {
  test("counts system prompt + user message", () => {
    const bytes = estimatePayloadBytes(
      newRequest({ systemPrompt: "abcd", userMessage: "ef" }),
    );
    expect(bytes).toBe(6);
  });

  test("counts history turns + wrapper bytes for assistant turns", () => {
    const req = newRequest({
      systemPrompt: "",
      userMessage: "",
      history: [
        { role: "user", text: "hi" },           // 2 + 0 wrapper + 2 joiner = 4
        { role: "assistant", text: "hello" },   // 5 + 36 wrapper + 2 joiner = 43
      ],
    });
    expect(estimatePayloadBytes(req)).toBe(4 + 43);
  });
});

describe("runWithFallback — maxPayloadBytes precheck", () => {
  test("skips a harness whose budget is exceeded and falls through to the next", async () => {
    const tiny = new FakeHarness("tiny", [
      { type: "done", finalText: "should not run" },
    ], 5);
    const big = new FakeHarness("big", [
      { type: "text", text: "ok" },
      { type: "done", finalText: "ok" },
    ]);
    const chunks = await collect(
      runWithFallback([tiny, big], newRequest({ systemPrompt: "long enough to blow tiny's budget" })),
    );
    expect(tiny.invocations).toBe(0);
    expect(big.invocations).toBe(1);
    expect(chunks.map((c) => c.type)).toEqual(["text", "done"]);
  });

  test("does not skip when payload is within budget", async () => {
    const claude = new FakeHarness("claude", [
      { type: "done", finalText: "ok" },
    ], 1_000_000);
    const chunks = await collect(
      runWithFallback([claude], newRequest({ systemPrompt: "tiny" })),
    );
    expect(claude.invocations).toBe(1);
    expect(chunks.map((c) => c.type)).toEqual(["done"]);
  });

  test("emits a terminal error when the LAST harness exceeds its budget", async () => {
    const onlyOne = new FakeHarness("only", [
      { type: "done", finalText: "x" },
    ], 5);
    const chunks = await collect(
      runWithFallback([onlyOne], newRequest({ systemPrompt: "way too long for budget" })),
    );
    expect(onlyOne.invocations).toBe(0);
    expect(chunks).toHaveLength(1);
    expect(chunks[0]).toMatchObject({
      type: "error",
      recoverable: false,
      error: expect.stringContaining("exceeds"),
    });
  });

  test("harness without maxPayloadBytes is never skipped on size grounds", async () => {
    const unbounded = new FakeHarness("unbounded", [
      { type: "done", finalText: "x" },
    ]); // no maxPayloadBytes
    const chunks = await collect(
      runWithFallback(
        [unbounded],
        newRequest({ systemPrompt: "x".repeat(10_000_000) }),
      ),
    );
    expect(unbounded.invocations).toBe(1);
    expect(chunks.map((c) => c.type)).toEqual(["done"]);
  });
});
