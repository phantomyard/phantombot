/**
 * Tests for the fallback attribution reply tag (issue #559). Pure string
 * logic — no subprocess, no channel.
 */

import { describe, expect, test } from "bun:test";
import {
  appendFallbackReplyTag,
  buildFallbackReplyTag,
} from "../src/channels/core/fallbackTag.ts";

describe("buildFallbackReplyTag (#559)", () => {
  test("a fallback-served turn produces a tag naming who answered and why", () => {
    const tag = buildFallbackReplyTag({
      harnessId: "pi",
      fallbackFor: "claude",
      fallbackReason: "claude api error: rate_limit",
    });
    expect(tag).toContain("pi");
    expect(tag).toContain("claude");
    expect(tag).toContain("rate_limit");
    expect(tag).toMatch(/^— answered by/);
  });

  test("the head answering normally → no tag", () => {
    expect(
      buildFallbackReplyTag({ harnessId: "claude" }),
    ).toBeUndefined();
  });

  test("no meta → no tag", () => {
    expect(buildFallbackReplyTag(undefined)).toBeUndefined();
    expect(buildFallbackReplyTag({})).toBeUndefined();
  });

  test("missing fallbackFor → no tag (defensive: adapters without the stamp)", () => {
    expect(buildFallbackReplyTag({ harnessId: "pi" })).toBeUndefined();
  });

  test("the embedded reason is capped so a verbose error can't flood the tag", () => {
    const long = "x".repeat(500);
    const tag = buildFallbackReplyTag({
      harnessId: "pi",
      fallbackFor: "claude",
      fallbackReason: long,
    })!;
    expect(tag.length).toBeLessThan(long.length);
    expect(tag).toContain("x".repeat(80));
    expect(tag).not.toContain("x".repeat(81));
  });
});

describe("appendFallbackReplyTag (#559)", () => {
  test("appends on its own line after the reply", () => {
    const out = appendFallbackReplyTag(
      "here is your answer",
      { harnessId: "pi", fallbackFor: "claude", fallbackReason: "claude api error: rate_limit" },
    );
    expect(out).toBe(
      "here is your answer\n\n— answered by pi fallback (claude: claude api error: rate_limit)",
    );
  });

  test("no tag → text unchanged", () => {
    const out = appendFallbackReplyTag(
      "primary answer",
      { harnessId: "claude" },
    );
    expect(out).toBe("primary answer");
  });
});