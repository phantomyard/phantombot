import { describe, expect, test } from "bun:test";

import { configSourcesOf, sourceOf } from "../src/tui/snapshot.ts";

describe("TUI config provenance", () => {
  test("absence inherits and a persona value wins", () => {
    const global = { voice: { provider: "openai" } };
    expect(sourceOf({}, global, ["voice", "provider"])).toBe("global");
    expect(
      sourceOf({ voice: { provider: "elevenlabs" } }, global, [
        "voice",
        "provider",
      ]),
    ).toBe("persona");
    expect(sourceOf({}, {}, ["voice", "provider"])).toBe("default");
  });

  test("an explicit empty value remains a persona override", () => {
    expect(
      sourceOf(
        { harnesses: { chain: [] } },
        { harnesses: { chain: ["claude"] } },
        ["harnesses", "chain"],
      ),
    ).toBe("persona");
  });

  test("embedding provenance follows the embeddings key", () => {
    const persona = { retrieval: { scope: "memory" } };
    const global = { embeddings: { provider: "openai" } };
    expect(configSourcesOf(persona, global)!.embeddings).toBe("global");
  });
});
