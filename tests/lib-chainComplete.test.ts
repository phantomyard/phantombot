/**
 * One-shot completions over the whole harness chain.
 *
 * Two features used to call `harnesses[0]` and stop there — durable-facts
 * extraction and the threat judge. When the primary was out of quota, facts
 * stopped being written (silently, once per turn, for hours) and the judge
 * FAILED OPEN, which switches off the screener in front of every untrusted
 * input. Chat turns meanwhile failed over and looked perfectly healthy.
 */

import { describe, expect, test } from "bun:test";

import {
  completeOverChain,
  HarnessCompletionError,
} from "../src/lib/chainComplete.ts";
import { CooldownStore } from "../src/lib/cooldown.ts";
import { setLogSink } from "../src/lib/logSink.ts";
import type { Harness, HarnessChunk } from "../src/harnesses/types.ts";

function fake(id: string): Harness {
  return { id, available: async () => true, async *invoke() {} };
}

const LABEL = { label: "test" };

describe("completeOverChain", () => {
  test("the primary answering is the whole story", async () => {
    const tried: string[] = [];
    const out = await completeOverChain(
      [fake("codex"), fake("pi")],
      async (h) => {
        tried.push(h.id);
        return "answer";
      },
      { ...LABEL, cooldown: new CooldownStore() },
    );
    expect(out).toBe("answer");
    expect(tried).toEqual(["codex"]);
  });

  test("a FAILING primary falls over to the next harness", async () => {
    const out = await completeOverChain(
      [fake("codex"), fake("pi")],
      async (h) => {
        if (h.id === "codex") throw new Error("codex exited with code 1");
        return "from-pi";
      },
      { ...LABEL, cooldown: new CooldownStore() },
    );
    expect(out).toBe("from-pi");
  });

  test("a failing attempt COOLS that harness for the orchestrator too", async () => {
    const cooldown = new CooldownStore();
    await completeOverChain(
      [fake("codex"), fake("pi")],
      async (h) => {
        if (h.id === "codex") throw new Error("boom");
        return "ok";
      },
      { ...LABEL, cooldown },
    );
    expect(cooldown.isCooledDown("codex").cooled).toBe(true);
    // And the harness that WORKED is cleared, not left cooling.
    expect(cooldown.isCooledDown("pi").cooled).toBe(false);
  });

  test("an already-cooled harness is skipped without being invoked", async () => {
    const cooldown = new CooldownStore();
    cooldown.markFailure("codex");
    const tried: string[] = [];
    const out = await completeOverChain(
      [fake("codex"), fake("pi")],
      async (h) => {
        tried.push(h.id);
        return "from-" + h.id;
      },
      { ...LABEL, cooldown },
    );
    expect(tried).toEqual(["pi"]);
    expect(out).toBe("from-pi");
  });

  test("when EVERY harness is cooled it runs anyway — never a silent no-op", async () => {
    // For the judge this is the load-bearing case: refusing to run is
    // failing open, which is worse than a slow screen.
    const cooldown = new CooldownStore();
    cooldown.markFailure("codex");
    cooldown.markFailure("pi");
    const tried: string[] = [];
    const out = await completeOverChain(
      [fake("codex"), fake("pi")],
      async (h) => {
        tried.push(h.id);
        if (h.id === "codex") throw new Error("still out of quota");
        return "from-pi";
      },
      { ...LABEL, cooldown },
    );
    expect(tried).toEqual(["codex", "pi"]);
    expect(out).toBe("from-pi");
  });

  test("an EMPTY completion falls through but does NOT cool (#499)", async () => {
    const cooldown = new CooldownStore();
    const out = await completeOverChain(
      [fake("codex"), fake("pi")],
      async (h) => (h.id === "codex" ? "" : "from-pi"),
      { ...LABEL, cooldown },
    );
    expect(out).toBe("from-pi");
    expect(cooldown.isCooledDown("codex").cooled).toBe(false);
  });

  test("everyone failing rethrows the LAST error, not a generic one", async () => {
    await expect(
      completeOverChain(
        [fake("codex"), fake("pi")],
        async (h) => {
          throw new Error(`${h.id} is down`);
        },
        { ...LABEL, cooldown: new CooldownStore() },
      ),
    ).rejects.toThrow("pi is down");
  });

  test("an empty chain throws rather than returning an empty answer", async () => {
    await expect(
      completeOverChain([], async () => "x", LABEL),
    ).rejects.toThrow("no harnesses configured");
  });

  test("an ABORT stops the chain and never cools a harness", async () => {
    // A cancelled turn is the caller's doing. Cooling for it would bench a
    // healthy binary, and harnesses surface an abort as an ordinary error
    // chunk, so the message alone cannot tell the two apart.
    const cooldown = new CooldownStore();
    const controller = new AbortController();
    const tried: string[] = [];
    await expect(
      completeOverChain(
        [fake("codex"), fake("pi")],
        async (h) => {
          tried.push(h.id);
          controller.abort();
          throw new Error("stopped");
        },
        { ...LABEL, cooldown, signal: controller.signal },
      ),
    ).rejects.toThrow("stopped");
    expect(tried).toEqual(["codex"]);
    expect(cooldown.isCooledDown("codex").cooled).toBe(false);
  });
});

/**
 * Everything below is #595: this path used to cool a harness with no
 * classification and no provider hint, which matters MORE here than in the
 * orchestrator — on an untrusted turn the threat judge runs first, so the
 * window IT stamps is the one `fallback.ts` inherits, and a harness already
 * cooled is skipped without ever being classified.
 */
function errChunk(
  over: Partial<Extract<HarnessChunk, { type: "error" }>> = {},
): Extract<HarnessChunk, { type: "error" }> {
  return {
    type: "error",
    error: "codex exited with code 1",
    recoverable: true,
    ...over,
  };
}

const QUOTA_STDERR = [
  "ERROR: You've hit your usage limit. Upgrade to Pro or try again at 8:58 PM.",
];

function failThroughLines(lines: string[], label = "test") {
  return lines
    .map((line) => JSON.parse(line))
    .filter((line) => line.msg === `${label}: harness failed — falling through`);
}

describe("completeOverChain failure diagnostics (#595)", () => {
  test("classifies on the harness STDERR, not just the exit line", async () => {
    const lines: string[] = [];
    const restore = setLogSink((line) => lines.push(line));
    try {
      const out = await completeOverChain(
        [fake("codex"), fake("pi")],
        async (h) => {
          if (h.id === "codex") {
            throw new HarnessCompletionError(
              errChunk({ stderrTail: QUOTA_STDERR }),
            );
          }
          return "from-pi";
        },
        { ...LABEL, cooldown: new CooldownStore() },
      );
      expect(out).toBe("from-pi");
      const logged = failThroughLines(lines);
      expect(logged).toHaveLength(1);
      expect(logged[0]).toMatchObject({
        harnessId: "codex",
        cause: "rate_limit",
        nextHarnessId: "pi",
      });
    } finally {
      restore();
    }
  });

  test("a crash with the SAME error line is distinguishable from a quota", async () => {
    // The pair that made v1.1.389 look broken: byte-identical `error`, and
    // only `cause` tells an operator which one they are looking at.
    const lines: string[] = [];
    const restore = setLogSink((line) => lines.push(line));
    try {
      await completeOverChain(
        [fake("codex"), fake("pi")],
        async (h) => {
          if (h.id === "codex") {
            throw new HarnessCompletionError(
              errChunk({ stderrTail: ["panic: runtime error: index out of range"] }),
            );
          }
          return "from-pi";
        },
        { ...LABEL, cooldown: new CooldownStore() },
      );
      const logged = failThroughLines(lines);
      expect(logged[0].error).toBe("codex exited with code 1");
      expect(logged[0].cause).toBe("other");
    } finally {
      restore();
    }
  });

  test("honours the provider's deadline instead of the generic ladder", async () => {
    // The whole point: a four-hour quota must not be benched for ~150 s and
    // re-probed all afternoon — and must not pre-empt the orchestrator's own
    // sighted classification by cooling the harness blind first.
    const cooldown = new CooldownStore();
    const fourHours = 4 * 60 * 60 * 1000;
    await completeOverChain(
      [fake("codex"), fake("pi")],
      async (h) => {
        if (h.id === "codex") {
          throw new HarnessCompletionError(
            errChunk({ stderrTail: QUOTA_STDERR, retryAfterMs: fourHours }),
          );
        }
        return "from-pi";
      },
      { ...LABEL, cooldown },
    );
    const status = cooldown.isCooledDown("codex");
    expect(status.cooled).toBe(true);
    const remaining = status.untilMs - Date.now();
    expect(remaining).toBeGreaterThan(fourHours - 5_000);
    expect(remaining).toBeLessThanOrEqual(fourHours);
  });

  test("the logged cooldown is the window the store actually holds", async () => {
    const lines: string[] = [];
    const restore = setLogSink((line) => lines.push(line));
    const cooldown = new CooldownStore();
    try {
      await completeOverChain(
        [fake("codex"), fake("pi")],
        async (h) => {
          if (h.id === "codex") {
            throw new HarnessCompletionError(
              errChunk({ stderrTail: QUOTA_STDERR, retryAfterMs: 90 * 60_000 }),
            );
          }
          return "from-pi";
        },
        { ...LABEL, cooldown },
      );
      const logged = failThroughLines(lines);
      expect(logged[0].retryAfterMs).toBe(90 * 60_000);
      // A journal that claims a bench the process is not honouring is worse
      // than no journal at all.
      expect(logged[0].cooldownUntilMs).toBe(cooldown.isCooledDown("codex").untilMs);
    } finally {
      restore();
    }
  });

  test("nextHarnessId names the next ELIGIBLE harness, skipping a cooled one", async () => {
    const lines: string[] = [];
    const restore = setLogSink((line) => lines.push(line));
    const cooldown = new CooldownStore();
    cooldown.markFailure("claude");
    try {
      await completeOverChain(
        [fake("codex"), fake("claude"), fake("pi")],
        async (h) => {
          if (h.id === "codex") throw new HarnessCompletionError(errChunk());
          return "from-" + h.id;
        },
        { ...LABEL, cooldown },
      );
      // Pointing an operator at `claude` would send them to a journal where
      // the work never landed: it is benched, so `pi` takes the turn.
      expect(failThroughLines(lines)[0].nextHarnessId).toBe("pi");
    } finally {
      restore();
    }
  });

  test("a bare Error still cools and still classifies on its message", async () => {
    // Not every caller carries a chunk; the old shape must not regress into
    // a crash or a silent un-cooled failure.
    const lines: string[] = [];
    const restore = setLogSink((line) => lines.push(line));
    const cooldown = new CooldownStore();
    try {
      await completeOverChain(
        [fake("codex"), fake("pi")],
        async (h) => {
          if (h.id === "codex") throw new Error("429 too many requests");
          return "from-pi";
        },
        { ...LABEL, cooldown },
      );
      expect(failThroughLines(lines)[0].cause).toBe("rate_limit");
      expect(cooldown.isCooledDown("codex").cooled).toBe(true);
    } finally {
      restore();
    }
  });

  test("an exhausted chain logs WHY each harness declined", async () => {
    // For the judge this line is the only record of a fail-open: every
    // untrusted input during the outage goes unscreened.
    const lines: string[] = [];
    const restore = setLogSink((line) => lines.push(line));
    try {
      await expect(
        completeOverChain(
          [fake("codex"), fake("pi")],
          async (h) => {
            throw new HarnessCompletionError(
              errChunk({
                error: `${h.id} exited with code 1`,
                stderrTail:
                  h.id === "codex" ? QUOTA_STDERR : ["401 unauthorized"],
              }),
            );
          },
          { ...LABEL, cooldown: new CooldownStore() },
        ),
      ).rejects.toThrow("pi exited with code 1");
      const exhausted = lines
        .map((l) => JSON.parse(l))
        .filter((l) => l.msg === "test: no harness completed — chain exhausted");
      expect(exhausted).toHaveLength(1);
      expect(exhausted[0].attempted).toBe(2);
      expect(exhausted[0].causes).toEqual([
        { harnessId: "codex", cause: "rate_limit" },
        { harnessId: "pi", cause: "auth" },
      ]);
    } finally {
      restore();
    }
  });

  test("the exhaustion line names SKIPPED and EMPTY harnesses too", async () => {
    // A chain can come up empty without a single throw: benched harnesses
    // plus one that answered nothing. If only thrown failures were recorded,
    // the judge's fail-open would leave no line at all here.
    const lines: string[] = [];
    const restore = setLogSink((line) => lines.push(line));
    const cooldown = new CooldownStore();
    cooldown.markFailure("codex");
    try {
      await expect(
        completeOverChain(
          [fake("codex"), fake("pi"), fake("claude")],
          async (h) => {
            if (h.id === "pi") return "";
            throw new HarnessCompletionError(
              errChunk({ error: "claude exited with code 1" }),
            );
          },
          { ...LABEL, cooldown },
        ),
      ).rejects.toThrow("claude exited with code 1");
      const exhausted = lines
        .map((l) => JSON.parse(l))
        .filter((l) => l.msg === "test: no harness completed — chain exhausted");
      expect(exhausted).toHaveLength(1);
      // Only two harnesses were actually invoked; all three are accounted for.
      expect(exhausted[0].attempted).toBe(2);
      expect(exhausted[0].causes).toEqual([
        { harnessId: "codex", cause: "cooldown_skipped" },
        { harnessId: "pi", cause: "empty_completion" },
        { harnessId: "claude", cause: "other" },
      ]);
    } finally {
      restore();
    }
  });

  test("an ABORTED chain logs no exhaustion line — nobody declined", async () => {
    const lines: string[] = [];
    const restore = setLogSink((line) => lines.push(line));
    const controller = new AbortController();
    try {
      await expect(
        completeOverChain(
          [fake("codex"), fake("pi")],
          async () => {
            controller.abort();
            throw new Error("stopped");
          },
          { ...LABEL, cooldown: new CooldownStore(), signal: controller.signal },
        ),
      ).rejects.toThrow("stopped");
      expect(
        lines
          .map((l) => JSON.parse(l))
          .filter((l) => l.msg === "test: no harness completed — chain exhausted"),
      ).toHaveLength(0);
    } finally {
      restore();
    }
  });
});
