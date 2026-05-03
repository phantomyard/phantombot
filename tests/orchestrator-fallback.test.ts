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
    idleTimeoutMs: 5_000, hardTimeoutMs: 5_000,
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

describe("runWithFallback — empty done falls through", () => {
  test("non-last harness emitting done with empty finalText falls through", async () => {
    // Repro of the gemini "(no reply)" bug: gemini exits 0 (e.g.
    // SIGTERMed by an updater restart, or did tool calls without a
    // final assistant message) and yields done with empty finalText.
    // Without the fall-through, the orchestrator considered this
    // success and the user got "(no reply)" instead of pi's reply.
    const empty = new FakeHarness("gemini-like", [
      { type: "progress", note: "tool: do_something" },
      { type: "done", finalText: "" },
    ]);
    const filler = new FakeHarness("pi-like", [
      { type: "text", text: "real reply" },
      { type: "done", finalText: "real reply" },
    ]);
    const chunks = await collect(
      runWithFallback([empty, filler], newRequest()),
    );
    expect(empty.invocations).toBe(1);
    expect(filler.invocations).toBe(1);
    // The empty done is suppressed; pi's progress + real reply land.
    expect(chunks.map((c) => c.type)).toEqual(["progress", "text", "done"]);
    const last = chunks[chunks.length - 1];
    expect(last && last.type === "done" ? last.finalText : "").toBe(
      "real reply",
    );
  });

  test("LAST harness emitting done with empty finalText still yields the empty done", async () => {
    // We deliberately preserve the existing "(no reply)" surface on the
    // last harness so the user sees that something happened — better
    // than no reply at all when there are no more harnesses to try.
    const empty = new FakeHarness("only", [
      { type: "done", finalText: "" },
    ]);
    const chunks = await collect(runWithFallback([empty], newRequest()));
    expect(empty.invocations).toBe(1);
    expect(chunks.map((c) => c.type)).toEqual(["done"]);
    expect(chunks[0]).toMatchObject({ type: "done", finalText: "" });
  });
});
