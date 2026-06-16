/**
 * Tests for the orchestrated init flow (`runInitFlow`).
 *
 * These exercise the call ordering and short-circuit behavior of the three
 * configuration wizards (harness → persona → telegram). The fully-interactive
 * `run()` exported as default is *not* tested here — it requires a TTY and
 * touches @clack/prompts, sudo, and the install wizard. The orchestration
 * function is the right unit boundary: it captures the "flow ordering"
 * regression risk Kai called out in review without dragging clack into tests.
 */

import { describe, expect, test } from "bun:test";

import type { Config } from "../src/config.ts";
import type { HarnessId } from "../src/cli/harness.ts";
import {
  type InitFlowDeps,
  type InitFlowInput,
  resolveSkipTelegram,
  runInitFlow,
} from "../src/cli/init.ts";

function fakeInput(): InitFlowInput {
  // Only the references matter — runInitFlow forwards them to deps.runHarness
  // and never reads the inner shape itself.
  return {
    config: {} as Config,
    availability: {
      claude: undefined,
      pi: undefined,
      gemini: undefined,
      codex: undefined,
    } as Record<HarnessId, string | undefined>,
  };
}

function makeDeps(overrides: Partial<InitFlowDeps> = {}): {
  deps: InitFlowDeps;
  calls: string[];
  personaArgs: Array<string | undefined>;
} {
  const calls: string[] = [];
  // Records the persona forwarded to each channel configurator, as
  // ["phantomchat:<persona>", "telegram:<persona>"].
  const personaArgs: Array<string | undefined> = [];
  const deps: InitFlowDeps = {
    runHarness: async () => {
      calls.push("harness");
      return 0;
    },
    runPersona: async () => {
      calls.push("persona");
      return 0;
    },
    resolvePersona: async () => "lena",
    runPhantomchat: async (persona) => {
      calls.push("phantomchat");
      personaArgs.push(`phantomchat:${persona}`);
      return 0;
    },
    runTelegram: async (persona) => {
      calls.push("telegram");
      personaArgs.push(`telegram:${persona}`);
      return 0;
    },
    ...overrides,
  };
  return { deps, calls, personaArgs };
}

describe("runInitFlow", () => {
  test("happy path: harness → persona → phantomchat → telegram in order", async () => {
    const { deps, calls } = makeDeps();
    const code = await runInitFlow(fakeInput(), deps);
    expect(code).toBe(0);
    expect(calls).toEqual(["harness", "persona", "phantomchat", "telegram"]);
  });

  test("default is to SET UP telegram, not skip (unset skipTelegram → telegram runs)", async () => {
    // The wizard's opt-out must default to setup: with no explicit skip, the
    // telegram configurator runs.
    const { deps, calls } = makeDeps();
    const code = await runInitFlow(fakeInput(), deps);
    expect(code).toBe(0);
    expect(calls).toContain("telegram");
  });

  test("skipTelegram: phantomchat runs, telegram skipped", async () => {
    const { deps, calls } = makeDeps();
    const code = await runInitFlow({ ...fakeInput(), skipTelegram: true }, deps);
    expect(code).toBe(0);
    expect(calls).toEqual(["harness", "persona", "phantomchat"]);
  });

  test("threads the resolved persona into BOTH phantomchat and telegram", async () => {
    // Regression: the wizard must bind both channels to the persona just set up
    // (telegram now writes a persona-bound block). Pre-fix it called them with
    // no persona, so telegram fell back to the default block.
    const { deps, personaArgs } = makeDeps({ resolvePersona: async () => "lena" });
    const code = await runInitFlow(fakeInput(), deps);
    expect(code).toBe(0);
    expect(personaArgs).toEqual(["phantomchat:lena", "telegram:lena"]);
  });

  test("resolvePersona runs AFTER runPersona (so it sees the newly-set default)", async () => {
    const order: string[] = [];
    const { deps } = makeDeps({
      runPersona: async () => {
        order.push("persona");
        return 0;
      },
      resolvePersona: async () => {
        order.push("resolve");
        return "lena";
      },
    });
    await runInitFlow(fakeInput(), deps);
    expect(order).toEqual(["persona", "resolve"]);
  });

  test("forwards config + availability to runHarness", async () => {
    const seen: Array<{ config: unknown; availability: unknown }> = [];
    const input = fakeInput();
    const { deps } = makeDeps({
      runHarness: async (i) => {
        seen.push(i);
        return 0;
      },
    });
    await runInitFlow(input, deps);
    expect(seen).toHaveLength(1);
    expect(seen[0]?.config).toBe(input.config);
    expect(seen[0]?.availability).toBe(input.availability);
  });

  test("short-circuits on harness failure: nothing else called", async () => {
    const { deps, calls } = makeDeps({
      runHarness: async () => {
        calls.push("harness");
        return 7;
      },
    });
    const code = await runInitFlow(fakeInput(), deps);
    expect(code).toBe(7);
    expect(calls).toEqual(["harness"]);
  });

  test("short-circuits on persona failure: phantomchat + telegram NOT called", async () => {
    const { deps, calls } = makeDeps({
      runPersona: async () => {
        calls.push("persona");
        return 3;
      },
    });
    const code = await runInitFlow(fakeInput(), deps);
    expect(code).toBe(3);
    expect(calls).toEqual(["harness", "persona"]);
  });

  test("short-circuits on phantomchat failure: telegram NOT called", async () => {
    const { deps, calls } = makeDeps({
      runPhantomchat: async () => {
        calls.push("phantomchat");
        return 5;
      },
    });
    const code = await runInitFlow(fakeInput(), deps);
    expect(code).toBe(5);
    expect(calls).toEqual(["harness", "persona", "phantomchat"]);
  });

  test("propagates telegram failure exit code", async () => {
    const { deps, calls } = makeDeps({
      runTelegram: async () => {
        calls.push("telegram");
        return 9;
      },
    });
    const code = await runInitFlow(fakeInput(), deps);
    expect(code).toBe(9);
    expect(calls).toEqual(["harness", "persona", "phantomchat", "telegram"]);
  });
});

describe("resolveSkipTelegram (opt-out defaults to set up)", () => {
  test("default answer (Yes) → does NOT skip", () => {
    expect(resolveSkipTelegram(true)).toBe(false);
  });

  test("explicit No → skips", () => {
    expect(resolveSkipTelegram(false)).toBe(true);
  });

  test("cancel / any non-No value → does NOT skip (defaults to set up)", () => {
    // A clack cancel (or any non-false sentinel) must keep Telegram in the flow.
    expect(resolveSkipTelegram(Symbol("clack-cancel"))).toBe(false);
  });
});
