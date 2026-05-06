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
    } as Record<HarnessId, string | undefined>,
  };
}

function makeDeps(overrides: Partial<InitFlowDeps> = {}): {
  deps: InitFlowDeps;
  calls: string[];
} {
  const calls: string[] = [];
  const deps: InitFlowDeps = {
    runHarness: async () => {
      calls.push("harness");
      return 0;
    },
    runPersona: async () => {
      calls.push("persona");
      return 0;
    },
    runTelegram: async () => {
      calls.push("telegram");
      return 0;
    },
    ...overrides,
  };
  return { deps, calls };
}

describe("runInitFlow", () => {
  test("happy path: runs harness → persona → telegram in order", async () => {
    const { deps, calls } = makeDeps();
    const code = await runInitFlow(fakeInput(), deps);
    expect(code).toBe(0);
    expect(calls).toEqual(["harness", "persona", "telegram"]);
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

  test("short-circuits on harness failure: persona + telegram NOT called", async () => {
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

  test("short-circuits on persona failure: telegram NOT called", async () => {
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

  test("propagates telegram failure exit code", async () => {
    const { deps, calls } = makeDeps({
      runTelegram: async () => {
        calls.push("telegram");
        return 9;
      },
    });
    const code = await runInitFlow(fakeInput(), deps);
    expect(code).toBe(9);
    expect(calls).toEqual(["harness", "persona", "telegram"]);
  });
});
