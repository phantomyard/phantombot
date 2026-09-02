import { describe, expect, test } from "bun:test";
import type { Config } from "../src/config.ts";
import {
  buildHarnessChain,
  harnessChainIds,
} from "../src/harnesses/buildChain.ts";

class CaptureStream {
  chunks: string[] = [];
  write(value: string | Uint8Array): boolean {
    this.chunks.push(
      typeof value === "string" ? value : new TextDecoder().decode(value),
    );
    return true;
  }
}

const config = {
  harnesses: {
    chain: ["codex", "pi"],
    personas: {
      amanda: { chain: ["claude", "codex"] },
    },
    claude: { bin: "claude", model: "opus", fallbackModel: "sonnet" },
    pi: { bin: "pi" },
    codex: { bin: "codex", model: "" },
  },
} as unknown as Config;

describe("per-persona harness chains", () => {
  test("uses the persona override when present", () => {
    expect(harnessChainIds(config, "amanda")).toEqual(["claude", "codex"]);
    expect(
      buildHarnessChain(config, new CaptureStream(), "amanda").map((h) => h.id),
    ).toEqual(["claude", "codex"]);
  });

  test("uses the global chain when the persona has no override", () => {
    expect(harnessChainIds(config, "miles")).toEqual(["codex", "pi"]);
    expect(
      buildHarnessChain(config, new CaptureStream(), "miles").map((h) => h.id),
    ).toEqual(["codex", "pi"]);
  });

  test("builds independent named Pi instances with distinct identities", () => {
    const named = {
      ...config,
      harnesses: {
        ...config.harnesses,
        chain: ["pi-primary", "pi-fallback"],
        instances: {
          "pi-primary": { type: "pi", bin: "pi", routing: { provider: "openrouter", primaryModel: "model-a" } },
          "pi-fallback": { type: "pi", bin: "pi", routing: { provider: "google", primaryModel: "model-b" } },
        },
      },
    } as unknown as Config;
    const chain = buildHarnessChain(named, new CaptureStream());
    expect(chain.map((h) => h.id)).toEqual(["pi-primary", "pi-fallback"]);
    expect(chain.map((h) => h.modelInfo?.())).toEqual([
      expect.objectContaining({ provider: "openrouter", model: "model-a" }),
      expect.objectContaining({ provider: "google", model: "model-b" }),
    ]);
  });
});
