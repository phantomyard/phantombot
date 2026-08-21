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
});
