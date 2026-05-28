import { describe, expect, test } from "bun:test";

import { splitIntoSegments, StreamSegmenter } from "../src/channels/streamSegmenter.ts";

describe("StreamSegmenter", () => {
  test("cuts prose after the configured sentence count", () => {
    expect(
      splitIntoSegments("One. Two. Three.", {
        maxSentences: 2,
        maxChars: 100,
      }),
    ).toEqual(["One. Two. ", "Three."]);
  });

  test("cuts prose at the char ceiling only on a sentence boundary", () => {
    expect(
      splitIntoSegments("A long first sentence. Short second.", {
        maxSentences: 10,
        maxChars: 12,
      }),
    ).toEqual(["A long first sentence. ", "Short second."]);
  });

  test("does not split an ordinary code fence", () => {
    const text = "Before.\n```ts\nconst x = 1;\n```\nAfter.";
    expect(
      splitIntoSegments(text, {
        maxSentences: 1,
        maxChars: 20,
      }),
    ).toEqual(["Before.\n", "```ts\nconst x = 1;\n```\n", "After."]);
  });

  test("keeps table rows together until the table ends", () => {
    const text = "| A | B |\n| - | - |\n| 1 | 2 |\nDone.";
    expect(
      splitIntoSegments(text, {
        maxSentences: 1,
        maxChars: 10,
      }),
    ).toEqual(["| A | B |\n| - | - |\n| 1 | 2 |\n", "Done."]);
  });

  test("closes and reopens oversized fences at the hard cap", () => {
    const s = new StreamSegmenter({
      maxSentences: 10,
      maxChars: 100,
      hardMaxChars: 30,
    });
    const first = s.push("```txt\n012345678901234567890123456789\n").segments;
    const rest = s.push("tail\n```\n").segments.concat(s.finish().segments);

    expect(first).toEqual(["```txt\n012345678901234567890123456789\n\n```\n"]);
    expect(rest.join("")).toContain("```");
    expect(rest.join("")).toContain("tail");
  });

  test("buffers incomplete lines before classifying markdown", () => {
    const s = new StreamSegmenter({ maxSentences: 1, maxChars: 10 });
    expect(s.push("```").segments).toEqual([]);
    expect(s.push("ts\nconst x = 1;\n```\n").segments).toEqual([
      "```ts\nconst x = 1;\n```\n",
    ]);
  });
});
