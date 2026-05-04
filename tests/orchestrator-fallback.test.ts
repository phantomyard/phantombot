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
import { CooldownStore } from "../src/lib/cooldown.ts";
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

// ---------------------------------------------------------------------------
// Cooldown integration. Per-harness cooldown lives in CooldownStore; the
// orchestrator owns the markFailure/markSuccess calls. Each test passes a
// fresh store via options.cooldown to avoid bleed.
// ---------------------------------------------------------------------------

describe("runWithFallback — cooldown integration", () => {
  test("recoverable error → cooldown.markFailure called for that harness", async () => {
    const cooldown = new CooldownStore(() => 0.5);
    const failing = new FakeHarness("gemini", [
      { type: "error", error: "boom", recoverable: true },
    ]);
    const ok = new FakeHarness("pi", [
      { type: "text", text: "hi" },
      { type: "done", finalText: "hi" },
    ]);
    await collect(runWithFallback([failing, ok], newRequest(), { cooldown }));
    // gemini should now be cooled; pi should remain cool-free (it succeeded).
    expect(cooldown.isCooledDown("gemini").cooled).toBe(true);
    expect(cooldown.isCooledDown("pi").cooled).toBe(false);
  });

  test("4XX error chunk → cooldown counted same as any recoverable error", async () => {
    // The orchestrator doesn't special-case the httpStatus value beyond
    // logging it — counting it as a failure is enough; the store handles
    // the exponential backoff identically. Verify the failure DID land.
    const cooldown = new CooldownStore(() => 0.5);
    const four_xx = new FakeHarness("gemini", [
      { type: "error", error: "429 capacity", recoverable: true, httpStatus: 429 },
    ]);
    const ok = new FakeHarness("pi", [
      { type: "text", text: "hi" },
      { type: "done", finalText: "hi" },
    ]);
    await collect(runWithFallback([four_xx, ok], newRequest(), { cooldown }));
    expect(cooldown.isCooledDown("gemini").consecutiveFailures).toBe(1);
  });

  test("successful done with non-empty text clears prior cooldown for that harness", async () => {
    const cooldown = new CooldownStore(() => 0.5);
    cooldown.markFailure("gemini"); // simulate prior turn's failure
    cooldown.markFailure("gemini"); // and another
    expect(cooldown.isCooledDown("gemini").consecutiveFailures).toBe(2);

    // Trick: skip cooldown skipping for THIS test by also cooling pi
    // and claude — escape hatch fires when everything is cooled, so the
    // orchestrator tries gemini first regardless of cooldown state.
    cooldown.markFailure("pi");
    cooldown.markFailure("claude");

    const ok = new FakeHarness("gemini", [
      { type: "text", text: "back online" },
      { type: "done", finalText: "back online" },
    ]);
    const pi = new FakeHarness("pi", [
      { type: "done", finalText: "should not run" },
    ]);
    const claude = new FakeHarness("claude", [
      { type: "done", finalText: "should not run" },
    ]);

    await collect(
      runWithFallback([ok, pi, claude], newRequest(), { cooldown }),
    );
    expect(ok.invocations).toBe(1);
    expect(pi.invocations).toBe(0);
    expect(claude.invocations).toBe(0);
    // Success cleared gemini's failure counter; pi/claude untouched.
    const after = cooldown.isCooledDown("gemini");
    expect(after.consecutiveFailures).toBe(0);
    expect(after.cooled).toBe(false);
  });

  test("cooled harness is skipped when at least one non-cooled harness remains", async () => {
    const cooldown = new CooldownStore(() => 0.5);
    cooldown.markFailure("gemini"); // cool gemini
    const gemini = new FakeHarness("gemini", [
      { type: "done", finalText: "should not run" },
    ]);
    const pi = new FakeHarness("pi", [
      { type: "text", text: "answered" },
      { type: "done", finalText: "answered" },
    ]);
    const chunks = await collect(
      runWithFallback([gemini, pi], newRequest(), { cooldown }),
    );
    expect(gemini.invocations).toBe(0);
    expect(pi.invocations).toBe(1);
    expect(chunks.map((c) => c.type)).toEqual(["text", "done"]);
  });

  test("escape hatch: every harness in the chain is cooled → run them anyway in chain order", async () => {
    const cooldown = new CooldownStore(() => 0.5);
    cooldown.markFailure("gemini");
    cooldown.markFailure("pi");
    cooldown.markFailure("claude");
    const gemini = new FakeHarness("gemini", [
      { type: "error", error: "still down", recoverable: true },
    ]);
    const pi = new FakeHarness("pi", [
      { type: "error", error: "still down", recoverable: true },
    ]);
    const claude = new FakeHarness("claude", [
      { type: "text", text: "rescue" },
      { type: "done", finalText: "rescue" },
    ]);
    const chunks = await collect(
      runWithFallback([gemini, pi, claude], newRequest(), { cooldown }),
    );
    // All three were attempted in order; claude saved the day.
    expect(gemini.invocations).toBe(1);
    expect(pi.invocations).toBe(1);
    expect(claude.invocations).toBe(1);
    const last = chunks[chunks.length - 1];
    expect(last && last.type === "done" ? last.finalText : "").toBe("rescue");
    // Claude succeeded → its failure counter cleared.
    expect(cooldown.isCooledDown("claude").consecutiveFailures).toBe(0);
  });

  test("three-harness chain traversal: recoverable failure on first two → third gets the turn", async () => {
    // Direct expression of the user request: "if primary and fallback
    // both fail, go down the chain to the third harness if configured."
    // Independent of cooldown; just verifies the loop handles N>=3.
    const cooldown = new CooldownStore(() => 0.5);
    const a = new FakeHarness("a", [
      { type: "error", error: "down", recoverable: true },
    ]);
    const b = new FakeHarness("b", [
      { type: "error", error: "also down", recoverable: true, httpStatus: 429 },
    ]);
    const c = new FakeHarness("c", [
      { type: "text", text: "saved" },
      { type: "done", finalText: "saved" },
    ]);
    const chunks = await collect(
      runWithFallback([a, b, c], newRequest(), { cooldown }),
    );
    expect(a.invocations).toBe(1);
    expect(b.invocations).toBe(1);
    expect(c.invocations).toBe(1);
    const types = chunks.map((c) => c.type);
    expect(types).toEqual(["text", "done"]);
    // First two are now cooled; third is clean.
    expect(cooldown.isCooledDown("a").cooled).toBe(true);
    expect(cooldown.isCooledDown("b").cooled).toBe(true);
    expect(cooldown.isCooledDown("c").cooled).toBe(false);
  });

  test("cooldown snapshot is taken at turn start; mid-turn failures don't cause same-turn skips", async () => {
    // Subtle: if we re-polled the store on every chain index, a
    // failure on harness[0] could mark it cooled and then the loop
    // could decide harness[1] should also be skipped because it's
    // ALSO suddenly considered cooled (it isn't — only harness[0] was
    // marked). The snapshot guarantees the chain marches forward
    // regardless of in-flight failures.
    const cooldown = new CooldownStore(() => 0.5);
    const a = new FakeHarness("a", [
      { type: "error", error: "down", recoverable: true },
    ]);
    const b = new FakeHarness("b", [
      { type: "text", text: "hi" },
      { type: "done", finalText: "hi" },
    ]);
    await collect(runWithFallback([a, b], newRequest(), { cooldown }));
    expect(a.invocations).toBe(1);
    expect(b.invocations).toBe(1);
  });
});
