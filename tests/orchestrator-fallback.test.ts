/**
 * Tests for the runWithFallback orchestrator — focused on the
 * maxPayloadBytes precheck added in phase 10. Existing fallback
 * behavior (recoverable error → next harness, terminal error stops)
 * is exercised indirectly by tests/orchestrator-turn.test.ts.
 */

import { describe, expect, test } from "bun:test";
import {
  describeInvokeThrow,
  estimatePayloadBytes,
  runWithFallback,
} from "../src/orchestrator/fallback.ts";
import { CooldownStore } from "../src/lib/cooldown.ts";
import {
  DEGRADE_AFTER_FAILURES,
  HarnessAlerter,
} from "../src/lib/harnessAlert.ts";
import type {
  Harness,
  HarnessChunk,
  HarnessRequest,
} from "../src/harnesses/types.ts";

class FakeHarness implements Harness {
  invocations = 0;
  constructor(
    public readonly id: string,
    public script: HarnessChunk[],
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

/**
 * A harness whose `invoke()` THROWS instead of yielding an error chunk —
 * the shape of a spawn failure (`Bun.spawn` throws E2BIG/ENOENT/EACCES
 * before the generator produces anything).
 */
class ThrowingHarness implements Harness {
  invocations = 0;
  constructor(
    public readonly id: string,
    private readonly error: Error,
    /** Chunks to emit before throwing, to model a mid-stream failure. */
    private readonly before: HarnessChunk[] = [],
  ) {}
  async available(): Promise<boolean> {
    return true;
  }
  async *invoke(_req: HarnessRequest): AsyncGenerator<HarnessChunk> {
    this.invocations++;
    for (const c of this.before) yield c;
    throw this.error;
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

describe("runWithFallback — silent rate-limit failover", () => {
  test("claude rate-limit (recoverable error, no text) → pi answers, nothing leaks", async () => {
    // Mirrors the real chain: claude stamps `error:"rate_limit"` on the
    // assistant envelope, and parseStreamJson converts that to a recoverable
    // error BEFORE any text is yielded — so at the orchestrator level claude
    // produces only a recoverable error. Pi must answer, and the user must see
    // ONLY pi's text + done — no error chunk, no rate-limit notice.
    const claude = new FakeHarness("claude", [
      { type: "error", error: "claude api error: rate_limit", recoverable: true },
    ]);
    const pi = new FakeHarness("pi", [
      { type: "text", text: "answered by pi" },
      { type: "done", finalText: "answered by pi" },
    ]);
    const chunks = await collect(
      runWithFallback([claude, pi], newRequest(), {
        cooldown: new CooldownStore(),
      }),
    );
    expect(claude.invocations).toBe(1);
    expect(pi.invocations).toBe(1);
    // No error chunk reaches the user, and no rate-limit text does either.
    expect(chunks.some((c) => c.type === "error")).toBe(false);
    expect(
      chunks.some(
        (c) => c.type === "text" && /session limit/i.test((c as { text: string }).text),
      ),
    ).toBe(false);
    expect(chunks.map((c) => c.type)).toEqual(["text", "done"]);
    expect(chunks.at(-1)).toMatchObject({ type: "done", finalText: "answered by pi" });
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

  test("empty done does NOT put the harness into cooldown (#499)", async () => {
    // An empty `done` means the process ran cleanly — a model-output
    // flake, not a harness-health failure. Cooling it would bench the
    // one healthy fallback behind a dead primary on the next turn.
    const cooldown = new CooldownStore(() => 0.5);
    const empty = new FakeHarness("pi", [{ type: "done", finalText: "" }]);
    const filler = new FakeHarness("claude", [
      { type: "text", text: "real reply" },
      { type: "done", finalText: "real reply" },
    ]);
    await collect(runWithFallback([empty, filler], newRequest(), { cooldown }));
    expect(empty.invocations).toBe(1);
    expect(filler.invocations).toBe(1);
    expect(cooldown.isCooledDown("pi").cooled).toBe(false);
    expect(cooldown.isCooledDown("pi").consecutiveFailures).toBe(0);
  });

  test("a harness that emitted an empty reply last turn is tried again next turn (#499)", async () => {
    // Regression for the kw-phantombot 2026-08-29 incident: one empty
    // reply from pi (the only healthy harness, primary dead on usage
    // limit) cooled it, so the NEXT turn skipped pi, hit the dead
    // primary, and served recovery text. Here: turn 1 pi flakes empty
    // and claude covers; turn 2 pi must be tried again — and this time
    // it answers.
    const cooldown = new CooldownStore(() => 0.5);
    const flaky = new FakeHarness("pi", [{ type: "done", finalText: "" }]);
    const cover = new FakeHarness("claude", [
      { type: "text", text: "cover" },
      { type: "done", finalText: "cover" },
    ]);
    await collect(runWithFallback([flaky, cover], newRequest(), { cooldown }));
    expect(flaky.invocations).toBe(1);
    expect(cover.invocations).toBe(1);

    // Turn 2: pi is healthy again (no cooldown from the empty), so it
    // is invoked first and its real answer is served.
    flaky.script = [
      { type: "text", text: "real reply" },
      { type: "done", finalText: "real reply" },
    ];
    const chunks = await collect(
      runWithFallback([flaky, cover], newRequest(), { cooldown }),
    );
    expect(flaky.invocations).toBe(2);
    expect(cover.invocations).toBe(1); // never reached
    const last = chunks[chunks.length - 1];
    expect(last && last.type === "done" ? last.finalText : "").toBe(
      "real reply",
    );
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

describe("runWithFallback onToolCall audit hook (#282)", () => {
  test("fires once per tool-call progress chunk, in order", async () => {
    const tool = (title: string) => ({
      title,
      kind: "execute" as const,
      locations: [],
    });
    const h = new FakeHarness("h", [
      { type: "progress", note: "Bash: a", tool: tool("Bash: a") },
      { type: "progress", note: "no-tool narration" }, // no `tool` → skipped
      { type: "progress", note: "Bash: b", tool: tool("Bash: b") },
      { type: "text", text: "ok" },
      { type: "done", finalText: "ok" },
    ]);
    const seen: string[] = [];
    await collect(
      runWithFallback([h], newRequest(), {
        onToolCall: (d) => seen.push(d.title),
      }),
    );
    expect(seen).toEqual(["Bash: a", "Bash: b"]);
  });

  test("a throwing sink never breaks the turn", async () => {
    const h = new FakeHarness("h", [
      {
        type: "progress",
        note: "Bash: x",
        tool: { title: "Bash: x", kind: "execute", locations: [] },
      },
      { type: "done", finalText: "done" },
    ]);
    const chunks = await collect(
      runWithFallback([h], newRequest(), {
        onToolCall: () => {
          throw new Error("sink boom");
        },
      }),
    );
    expect(chunks.at(-1)).toEqual({ type: "done", finalText: "done" });
  });
});

describe("health alerting", () => {
  function recordingAlerter() {
    const sent: string[] = [];
    return {
      sent,
      alerter: new HarnessAlerter({
        send: (m) => {
          sent.push(m);
        },
      }),
    };
  }

  const authError: HarnessChunk = {
    type: "error",
    error: "claude api error: authentication_failed",
    recoverable: true,
  };

  test("a fallback covering a dead primary alerts the owner", async () => {
    const { alerter, sent } = recordingAlerter();
    for (let i = 0; i < DEGRADE_AFTER_FAILURES; i++) {
      const primary = new FakeHarness("claude", [authError]);
      const backup = new FakeHarness("pi", [
        { type: "done", finalText: "answered", meta: {} },
      ]);
      const chunks = await collect(
        runWithFallback([primary, backup], newRequest(), {
          cooldown: new CooldownStore(), // fresh: cooldown is not what's under test
          alerter,
        }),
      );
      // The turn still succeeds — alerting must not change the reply path.
      expect(chunks.at(-1)?.type).toBe("done");
    }
    expect(sent.length).toBe(1);
    expect(sent[0]).toContain("auth failure");
  });

  test("the primary answering clears the run — no alert", async () => {
    const { alerter, sent } = recordingAlerter();
    for (let i = 0; i < DEGRADE_AFTER_FAILURES + 2; i++) {
      const primary = new FakeHarness("claude", [
        { type: "done", finalText: "hi", meta: {} },
      ]);
      await collect(
        runWithFallback([primary], newRequest(), {
          cooldown: new CooldownStore(),
          alerter,
        }),
      );
    }
    expect(sent).toEqual([]);
  });

  test("a rate limit with no fallback left alerts as an outage", async () => {
    const { alerter, sent } = recordingAlerter();
    const only = new FakeHarness("claude", [
      {
        type: "error",
        error: "claude api error: rate_limit",
        recoverable: true,
        httpStatus: 429,
      },
    ]);
    const chunks = await collect(
      runWithFallback([only], newRequest(), {
        cooldown: new CooldownStore(),
        alerter,
      }),
    );
    expect(chunks.at(-1)?.type).toBe("error");
    expect(sent.length).toBe(1);
    expect(sent[0]).toContain("rate limited 429");
  });

  test("a single-harness chain going empty every turn alerts (#501)", async () => {
    // The kw-phantombot 2026-08-29 shape: pi is the ONLY harness, its
    // per-user model catalogue is empty, so every turn comes back with no
    // text. Before #501 the empty done on the last harness was reported to
    // the alerter as a success, which closed the incident every turn — the
    // consecutive-empty counter never reached the threshold and the owner
    // saw "(no reply)" forever with no signal anywhere.
    const { alerter, sent } = recordingAlerter();
    for (let i = 0; i < DEGRADE_AFTER_FAILURES; i++) {
      const only = new FakeHarness("pi", [{ type: "done", finalText: "" }]);
      const chunks = await collect(
        runWithFallback([only], newRequest(), {
          cooldown: new CooldownStore(),
          alerter,
        }),
      );
      // The reply path is untouched: the empty done still reaches the
      // channel so the user gets "(no reply)" rather than silence.
      expect(chunks).toEqual([{ type: "done", finalText: "" }]);
    }
    expect(sent.length).toBe(1);
    expect(sent[0]).toContain("empty reply");
    expect(sent[0]).toContain("\u00d73");
    // Nothing covered the turn, so the alert must not claim a fallback did.
    expect(sent[0]).toContain("no fallback left");
    expect(sent[0]).not.toContain("serving");
  });

  test("one empty reply on a single-harness chain stays quiet (#499)", async () => {
    // The flake case #499 protects: below the threshold, and a real reply
    // afterwards closes the incident so the run starts over.
    const { alerter, sent } = recordingAlerter();
    const cooldown = new CooldownStore();
    const only = new FakeHarness("pi", [{ type: "done", finalText: "" }]);
    await collect(runWithFallback([only], newRequest(), { cooldown, alerter }));
    expect(sent).toEqual([]);

    only.script = [{ type: "done", finalText: "back" }];
    await collect(runWithFallback([only], newRequest(), { cooldown, alerter }));

    // Two more empties would be 3 in total but only 2 consecutive.
    only.script = [{ type: "done", finalText: "" }];
    for (let i = 0; i < DEGRADE_AFTER_FAILURES - 1; i++) {
      await collect(
        runWithFallback([only], newRequest(), { cooldown, alerter }),
      );
    }
    expect(sent).toEqual([]);
  });

  test("an empty reply from the last harness does not cool it (#499/#501)", async () => {
    // Counting the empty for the ALERTER must not leak into the scheduler:
    // the harness is still the only one we have, so it must be tried first
    // again next turn rather than benched behind a backoff.
    const cooldown = new CooldownStore(() => 0.5);
    const { alerter } = recordingAlerter();
    const only = new FakeHarness("pi", [{ type: "done", finalText: "" }]);
    await collect(runWithFallback([only], newRequest(), { cooldown, alerter }));
    expect(cooldown.isCooledDown("pi").cooled).toBe(false);
    expect(cooldown.isCooledDown("pi").consecutiveFailures).toBe(0);
  });

  test("a terminal (non-recoverable) error does not alert", async () => {
    const { alerter, sent } = recordingAlerter();
    const only = new FakeHarness("claude", [
      { type: "error", error: "claude not found", recoverable: false },
    ]);
    await collect(
      runWithFallback([only], newRequest(), {
        cooldown: new CooldownStore(),
        alerter,
      }),
    );
    expect(sent).toEqual([]);
  });
});

describe("a harness that throws instead of yielding (#426)", () => {
  const e2big = () =>
    new Error(
      "E2BIG: argument list too long, posix_spawn '/home/robbie/.local/bin/claude'",
    );

  test("falls through to the next harness instead of killing the turn", async () => {
    // The wedge: a spawn failure propagated straight out of runWithFallback,
    // so the chain never advanced. An unspawnable primary silently disabled
    // every fallback behind it and the persona answered nothing at all.
    const bad = new ThrowingHarness("claude", e2big());
    const good = new FakeHarness("pi", [
      { type: "done", finalText: "served by pi" },
    ]);
    const chunks = await collect(
      runWithFallback([bad, good], newRequest(), {
        cooldown: new CooldownStore(),
      }),
    );
    expect(good.invocations).toBe(1);
    expect(chunks.at(-1)).toMatchObject({
      type: "done",
      finalText: "served by pi",
    });
  });

  test("cools the thrower off so the next turn does not retry it first", async () => {
    const cooldown = new CooldownStore();
    const sent: string[] = [];
    const alerter = new HarnessAlerter({
      send: (m) => {
        sent.push(m);
      },
    });
    const bad = new ThrowingHarness("claude", e2big());
    const good = new FakeHarness("pi", [{ type: "done", finalText: "ok" }]);
    await collect(
      runWithFallback([bad, good], newRequest(), { cooldown, alerter }),
    );
    expect(cooldown.isCooledDown("claude").consecutiveFailures).toBe(1);
    // A one-off failure a fallback absorbed stays quiet — same policy as any
    // other non-auth cause (#284). The cooldown, not an alert, is the effect.
    expect(sent).toEqual([]);
  });

  test("a throw on the LAST harness wakes the owner — nothing else would", async () => {
    const sent: string[] = [];
    const alerter = new HarnessAlerter({
      send: (m) => {
        sent.push(m);
      },
    });
    const bad = new ThrowingHarness("claude", e2big());
    await collect(
      runWithFallback([bad], newRequest(), {
        cooldown: new CooldownStore(),
        alerter,
      }),
    );
    expect(sent.join("\n")).toContain("claude");
  });

  test("the last harness throwing yields an error chunk, it does not reject", async () => {
    const bad = new ThrowingHarness("claude", e2big());
    const chunks = await collect(
      runWithFallback([bad], newRequest(), { cooldown: new CooldownStore() }),
    );
    const last = chunks.at(-1);
    expect(last?.type).toBe("error");
    expect((last as { error: string }).error).toContain("claude");
    expect((last as { error: string }).error).toContain("E2BIG");
  });

  test("text already streamed is kept, then the next harness takes over", async () => {
    // Same streaming-first trade-off as a mid-stream recoverable error: the
    // partial text is already on the user's screen, so we do not try to
    // retract it.
    const bad = new ThrowingHarness("claude", new Error("boom"), [
      { type: "text", text: "half a sen" },
    ]);
    const good = new FakeHarness("pi", [
      { type: "done", finalText: "a whole reply" },
    ]);
    const chunks = await collect(
      runWithFallback([bad, good], newRequest(), {
        cooldown: new CooldownStore(),
      }),
    );
    expect(chunks[0]).toMatchObject({ type: "text", text: "half a sen" });
    expect(chunks.at(-1)).toMatchObject({ type: "done" });
  });

  test("a non-Error throw is still handled", async () => {
    const bad = new ThrowingHarness("claude", "just a string" as never);
    const good = new FakeHarness("pi", [{ type: "done", finalText: "ok" }]);
    const chunks = await collect(
      runWithFallback([bad, good], newRequest(), {
        cooldown: new CooldownStore(),
      }),
    );
    expect(chunks.at(-1)).toMatchObject({ type: "done", finalText: "ok" });
  });
});

describe("describeInvokeThrow", () => {
  test("names the harness and keeps the original message", () => {
    const out = describeInvokeThrow("claude", new Error("ENOENT: no such file"));
    expect(out).toContain("claude");
    expect(out).toContain("ENOENT: no such file");
  });

  test("E2BIG gets the gloss that points at the RIGHT limit", () => {
    // The raw message says "argument list too long", which sends operators to
    // `getconf ARG_MAX` (~2MB) and a dead end. The limit that actually bit is
    // the per-string MAX_ARG_STRLEN, which no ulimit can raise.
    const out = describeInvokeThrow("claude", new Error("E2BIG: argument list too long"));
    expect(out).toContain("131,071");
    expect(out).not.toContain("ARG_MAX ");
  });

  test("an unrelated failure gets no misleading argv hint", () => {
    const out = describeInvokeThrow("pi", new Error("EACCES: permission denied"));
    expect(out).not.toContain("131,071");
  });

  test("survives a thrown non-Error", () => {
    expect(describeInvokeThrow("pi", { weird: true })).toContain("pi");
  });
});
