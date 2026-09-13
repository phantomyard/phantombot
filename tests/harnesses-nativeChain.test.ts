/**
 * Chain ids → harnesses after the native split. native runs the embedded
 * engine with phantombot routing; pi-host runs the host pi and ignores
 * phantombot routing (its owner configured it); the delegate spawner in the
 * managed extension re-enters the embedded engine only when told to.
 */

import { describe, expect, test } from "bun:test";
import type { Config } from "../src/config.ts";
import { buildHarness, buildHarnessChain } from "../src/harnesses/buildChain.ts";
import { PiHarness } from "../src/harnesses/pi.ts";
import { parseEmbeddedPiCommand } from "../pi-extension/capability-routing/spawnPi.ts";

function config(harnesses: Partial<Config["harnesses"]>): Config {
  return {
    harnesses: {
      chain: [],
      claude: { bin: "claude", model: "opus", fallbackModel: "sonnet" },
      pi: {
        bin: "/usr/bin/pi",
        routing: { provider: "openrouter", primaryModel: "deepseek-v3" },
      },
      codex: { bin: "codex", model: "" },
      ...harnesses,
    },
  } as unknown as Config;
}

describe("buildHarness", () => {
  test("native: embedded engine, phantombot routing, always available", async () => {
    const h = buildHarness(config({}), "native")!;
    expect(h).toBeInstanceOf(PiHarness);
    expect(h.id).toBe("native");
    expect(h.modelInfo?.()).toMatchObject({ model: "deepseek-v3", provider: "openrouter" });
    expect(await h.available()).toBe(true);
  });

  test("pi-host: host binary, and phantombot routing is NOT applied", async () => {
    const h = buildHarness(config({ pi: { bin: "/no/such/pi", routing: { primaryModel: "x" } } }), "pi-host")!;
    expect(h.id).toBe("pi-host");
    expect(h.modelInfo?.()).toEqual({ model: "(host pi configuration)" });
    expect(await h.available()).toBe(false);
  });

  test("named instances take their engine from `type`", () => {
    const c = config({
      instances: {
        "pi-primary": { type: "native", bin: "pi", routing: { primaryModel: "a" } },
        "pi-fallback": { type: "pi-host", bin: "/usr/bin/pi" },
      },
    });
    expect(buildHarness(c, "pi-primary")!.modelInfo?.()).toMatchObject({ model: "a" });
    expect(buildHarness(c, "pi-fallback")!.modelInfo?.()).toEqual({ model: "(host pi configuration)" });
  });

  test("a legacy `pi` in a hand-built config goes through the same decision as read time", () => {
    expect(buildHarness(config({}), "pi")!.modelInfo?.()).toMatchObject({ model: "deepseek-v3" });
    expect(buildHarness(config({ pi: { bin: "pi" } }), "pi")!.modelInfo?.()).toEqual({
      model: "(host pi configuration)",
    });
  });

  test("claude and codex are untouched; an unknown id warns and is skipped", () => {
    const writes: string[] = [];
    const chain = buildHarnessChain(
      config({ chain: ["claude", "mystery", "codex"] }),
      { write: (s: string) => void writes.push(s) } as never,
    );
    expect(chain.map((h) => h.id)).toEqual(["claude", "codex"]);
    expect(writes.join("")).toContain("unknown harness 'mystery'");
  });
});

describe("parseEmbeddedPiCommand (delegate re-entry)", () => {
  test("a JSON argv array of non-empty strings is the embedded invocation", () => {
    expect(parseEmbeddedPiCommand('["/usr/local/bin/phantombot","__pi"]')).toEqual([
      "/usr/local/bin/phantombot",
      "__pi",
    ]);
  });

  test("blank, malformed or wrongly-shaped values mean 'not native'", () => {
    for (const raw of [undefined, "", "   ", "not json", "{}", "[]", '[""]', "[1,2]", '"phantombot"']) {
      expect(parseEmbeddedPiCommand(raw)).toBeUndefined();
    }
  });
});
