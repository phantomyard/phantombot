import { describe, expect, test } from "bun:test";

import {
  coalesceTrailingFragment,
  hasTextSubstance,
  splitIntoSegments,
  StreamSegmenter,
} from "../src/channels/streamSegmenter.ts";

// Production sizing (src/config.ts DEFAULT_TELEGRAM_STREAMING). The trailing
// sign-off bug only reproduces at real bubble sizes — the reply has to be long
// enough to get cut before the emoji — so the regression tests below pin these
// rather than the toy values the older cases use.
const PROD = { maxSentences: 4, maxChars: 700 };

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

describe("hasTextSubstance", () => {
  test("letters and digits count as substance", () => {
    expect(hasTextSubstance("Done.")).toBe(true);
    expect(hasTextSubstance("286")).toBe(true);
    expect(hasTextSubstance("ok 👍")).toBe(true);
    // Non-Latin scripts are letters too — \p{L}, not [a-z].
    expect(hasTextSubstance("готово")).toBe(true);
    expect(hasTextSubstance("完了")).toBe(true);
  });

  test("emoji and punctuation alone do not", () => {
    expect(hasTextSubstance("⚡")).toBe(false);
    expect(hasTextSubstance("👍")).toBe(false);
    expect(hasTextSubstance("🎉🔧")).toBe(false);
    expect(hasTextSubstance(" — ")).toBe(false);
    expect(hasTextSubstance("!!!")).toBe(false);
  });
});

describe("coalesceTrailingFragment", () => {
  test("folds an orphaned sign-off back into the previous bubble", () => {
    expect(coalesceTrailingFragment(["All merged. ", "⚡"])).toEqual([
      "All merged. ⚡",
    ]);
  });

  test("leaves a trailing bubble that says something alone", () => {
    expect(coalesceTrailingFragment(["First. ", "Second."])).toEqual([
      "First. ",
      "Second.",
    ]);
  });

  test("never swallows a reply that is ONLY a sign-off", () => {
    // Nothing precedes it, so the emoji IS the whole answer.
    expect(coalesceTrailingFragment(["👍"])).toEqual(["👍"]);
    expect(coalesceTrailingFragment([])).toEqual([]);
  });
});

describe("trailing sign-off regression (turn 1936)", () => {
  // The shape that shipped a standalone "⚡" bubble to PhantomChat, where the
  // newest event becomes the push notification ("max: ⚡").
  //
  // What makes it bite is the SENTENCE cap, not the char cap: at exactly
  // maxSentences the splitter flushes the bubble, and the emoji — which the
  // sentence segmenter calls a sentence of its own, because it follows terminal
  // punctuation — lands after the cut with nothing to ride along with. So the
  // reply must be a multiple of maxSentences long. An earlier draft of this test
  // used a 9-sentence reply and passed with the fix reverted: the emoji simply
  // rode out on the short final bubble and never orphaned.
  const reply =
    "The gate was wrong on Windows and the fix has landed. " +
    "I checked the box rather than assuming it. " +
    "The extension now shows up in the editor list. " +
    "Everything is reconciled and #76 is merged. ⚡";

  test("the sign-off never ships as its own bubble", () => {
    const segments = splitIntoSegments(reply, PROD);
    expect(segments.length).toBeGreaterThan(0);
    for (const segment of segments) {
      expect(hasTextSubstance(segment)).toBe(true);
    }
  });

  test("the sign-off is preserved, attached to the real answer", () => {
    const segments = splitIntoSegments(reply, PROD);
    expect(segments.at(-1)!.trimEnd().endsWith("⚡")).toBe(true);
    // Nothing dropped: the bubbles still reconstruct the reply exactly.
    expect(segments.join("")).toBe(reply);
  });

  test("a reply that is only a sign-off still sends", () => {
    expect(splitIntoSegments("⚡", PROD)).toEqual(["⚡"]);
  });
});
