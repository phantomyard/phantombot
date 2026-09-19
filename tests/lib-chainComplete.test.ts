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

import { completeOverChain } from "../src/lib/chainComplete.ts";
import { CooldownStore } from "../src/lib/cooldown.ts";
import type { Harness } from "../src/harnesses/types.ts";

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
