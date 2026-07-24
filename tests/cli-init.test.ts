/**
 * Tests for the orchestrated init flow (`runInitFlow`).
 *
 * These exercise the call ordering and short-circuit behavior of the wizards
 * (harness → persona → phantomchat → telegram). The fully-interactive `run()`
 * exported as default is *not* tested here — it requires a TTY and touches
 * @clack/prompts. The orchestration function is the right unit boundary.
 *
 * Channel steps follow the `phantombot persona` pattern: each asks which
 * persona to bind the channel to (via `pickPersona`), or `null` to skip —
 * there is no separate skip confirm, and neither channel is mandatory.
 */

import { describe, expect, test } from "bun:test";

import type { Config } from "../src/config.ts";
import type { HarnessId } from "../src/cli/harness.ts";
import {
  type InitFlowDeps,
  type InitFlowInput,
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
      codex: undefined,
    } as Record<HarnessId, string | undefined>,
  };
}

function makeDeps(overrides: Partial<InitFlowDeps> = {}): {
  deps: InitFlowDeps;
  calls: string[];
  personaArgs: string[];
  picks: string[];
} {
  const calls: string[] = [];
  // The persona forwarded to each channel configurator: ["phantomchat:<p>", …].
  const personaArgs: string[] = [];
  // The channel labels pickPersona was asked for, in order.
  const picks: string[] = [];
  const deps: InitFlowDeps = {
    runHarness: async () => {
      calls.push("harness");
      return 0;
    },
    runPersona: async () => {
      calls.push("persona");
      return 0;
    },
    pickPersona: async (label) => {
      picks.push(label);
      return "lena"; // default: bind every channel to "lena"
    },
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
    onNoChannels: () => {
      calls.push("noChannels");
    },
    ...overrides,
  };
  return { deps, calls, personaArgs, picks };
}

describe("runInitFlow", () => {
  test("happy path: harness → persona → phantomchat → telegram in order", async () => {
    const { deps, calls } = makeDeps();
    const code = await runInitFlow(fakeInput(), deps);
    expect(code).toBe(0);
    expect(calls).toEqual(["harness", "persona", "phantomchat", "telegram"]);
  });

  test("asks pickPersona for PhantomChat then Telegram (after the persona step)", async () => {
    const { deps, calls, picks } = makeDeps();
    await runInitFlow(fakeInput(), deps);
    expect(picks).toEqual(["PhantomChat", "Telegram"]);
    // pickPersona is only reached after the persona step succeeds.
    expect(calls.indexOf("persona")).toBeLessThan(calls.indexOf("phantomchat"));
  });

  test("binds each channel to the persona the picker returned", async () => {
    const { deps, personaArgs } = makeDeps();
    await runInitFlow(fakeInput(), deps);
    expect(personaArgs).toEqual(["phantomchat:lena", "telegram:lena"]);
  });

  test("supports a different persona per channel", async () => {
    const { deps, personaArgs } = makeDeps({
      pickPersona: async (label) => (label === "Telegram" ? "kai" : "lena"),
    });
    await runInitFlow(fakeInput(), deps);
    expect(personaArgs).toEqual(["phantomchat:lena", "telegram:kai"]);
  });

  test("None for PhantomChat → it is skipped, Telegram still runs", async () => {
    const { deps, calls, personaArgs } = makeDeps({
      pickPersona: async (label) => (label === "PhantomChat" ? null : "kai"),
    });
    const code = await runInitFlow(fakeInput(), deps);
    expect(code).toBe(0);
    expect(calls).toEqual(["harness", "persona", "telegram"]);
    expect(personaArgs).toEqual(["telegram:kai"]);
  });

  test("None for BOTH channels → neither configurator runs, onNoChannels fires", async () => {
    const { deps, calls } = makeDeps({ pickPersona: async () => null });
    const code = await runInitFlow(fakeInput(), deps);
    expect(code).toBe(0);
    expect(calls).toEqual(["harness", "persona", "noChannels"]);
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

  test("short-circuits on persona failure: pickPersona + channels NOT reached", async () => {
    const { deps, calls, picks } = makeDeps({
      runPersona: async () => {
        calls.push("persona");
        return 3;
      },
    });
    const code = await runInitFlow(fakeInput(), deps);
    expect(code).toBe(3);
    expect(calls).toEqual(["harness", "persona"]);
    expect(picks).toEqual([]);
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
