/**
 * Tests for the fallback attribution reply tag (issue #559). Pure string
 * logic — no subprocess, no channel.
 */

import { describe, expect, test } from "bun:test";
import {
  appendFallbackReplyTag,
  buildFallbackReplyTag,
  coarseFallbackReason,
} from "../src/channels/core/fallbackTag.ts";

describe("coarseFallbackReason (#559, review on #561)", () => {
  // The tag renders in front of third parties (group chats, peer
  // conversations), so the raw harness error — paths, provider internals,
  // request ids — must never reach it. Coarse classes only.
  test("rate-limit failures render as 'rate limit'", () => {
    expect(coarseFallbackReason("claude api error: rate_limit")).toBe(
      "rate limit",
    );
  });

  test("real provider prose classifies too (the widened markers)", () => {
    expect(coarseFallbackReason("pi exited with code 1\n429 Too Many Requests"))
      .toBe("rate limit");
    expect(
      coarseFallbackReason("pi exited with code 1\nRate limit exceeded, retry later"),
    ).toBe("rate limit");
  });

  test("auth failures render as 'auth failure'", () => {
    expect(
      coarseFallbackReason("claude api error: authentication_failed"),
    ).toBe("auth failure");
  });

  test("timeouts and empty replies keep their coarse classes", () => {
    expect(coarseFallbackReason("claude timed out after 300000ms")).toBe(
      "timeout",
    );
    expect(coarseFallbackReason("empty reply")).toBe("no output");
  });

  test("the orchestrator's own skip stamps render coarsely", () => {
    expect(
      coarseFallbackReason("primary in cooldown (128.4s remain)"),
    ).toBe("cooldown");
    expect(
      coarseFallbackReason("primary payload cap exceeded (9000 > 4096 bytes)"),
    ).toBe("payload cap");
  });

  test("unclassifiable errors stay vague, not raw", () => {
    expect(coarseFallbackReason("/usr/local/bin/pi: something exploded 0xDEAD"))
      .toBe("unavailable");
  });
});

describe("buildFallbackReplyTag (#559)", () => {
  test("a fallback-served turn produces a tag naming who answered and why", () => {
    const tag = buildFallbackReplyTag({
      harnessId: "pi",
      fallbackFor: "claude",
      fallbackReason: "claude api error: rate_limit",
    });
    expect(tag).toContain("pi");
    expect(tag).toContain("claude");
    expect(tag).toContain("rate limit");
    expect(tag).toMatch(/^— answered by/);
  });

  test("the raw error never appears in the tag — coarse class only", () => {
    const raw = "/usr/local/bin/pi: provider 429 request id 9f8e7d6c exploded";
    const tag = buildFallbackReplyTag({
      harnessId: "pi",
      fallbackFor: "claude",
      fallbackReason: raw,
    })!;
    expect(tag).not.toContain("/usr/local/bin");
    expect(tag).not.toContain("9f8e7d6c");
    // The 429 still drives the coarse class — only the internals are hidden.
    expect(tag).toContain("rate limit");
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
});

describe("appendFallbackReplyTag (#559)", () => {
  test("appends on its own line after the reply", () => {
    const out = appendFallbackReplyTag(
      "here is your answer",
      { harnessId: "pi", fallbackFor: "claude", fallbackReason: "claude api error: rate_limit" },
    );
    expect(out).toBe(
      "here is your answer\n\n— answered by pi fallback (claude: rate limit)",
    );
  });

  test("no tag → text unchanged", () => {
    const out = appendFallbackReplyTag(
      "primary answer",
      { harnessId: "claude" },
    );
    expect(out).toBe("primary answer");
  });

  test("empty outgoing text → tag skipped, no lone tag bubble (review on #561)", () => {
    // On the streaming transports an empty outgoing suffix means the reply
    // already went out as live final bubbles — the old code returned the
    // bare tag, which shipped as a bubble containing nothing but metadata.
    const out = appendFallbackReplyTag(
      "",
      { harnessId: "pi", fallbackFor: "claude", fallbackReason: "claude api error: rate_limit" },
    );
    expect(out).toBe("");
  });
});

describe("the CAUSE the orchestrator classified wins over the reason string", () => {
  // The whole reason this exists: a CLI harness dies with "codex exited with
  // code 1". Re-classifying that string here yields `other` → "unavailable",
  // so a rate limit was reported to the user as an unexplained outage. The
  // orchestrator had the stderr tail and knew better; it now stamps what it
  // knew.
  test("an uninformative exit line + a stamped cause renders the cause", () => {
    expect(
      buildFallbackReplyTag({
        harnessId: "pi",
        fallbackFor: "codex",
        fallbackReason: "codex exited with code 1",
        fallbackCause: "rate_limit",
      }),
    ).toContain("rate limit");
  });

  test("without the stamp the same line degrades to 'unavailable'", () => {
    expect(
      buildFallbackReplyTag({
        harnessId: "pi",
        fallbackFor: "codex",
        fallbackReason: "codex exited with code 1",
      }),
    ).toContain("unavailable");
  });

  test("a skip stamp still reads from the reason (no cause to stamp)", () => {
    expect(
      buildFallbackReplyTag({
        harnessId: "pi",
        fallbackFor: "codex",
        fallbackReason: "primary in cooldown (240s remaining)",
      }),
    ).toContain("cooldown");
  });

  test("an unknown cause value degrades safely rather than leaking it", () => {
    const tag = buildFallbackReplyTag({
      harnessId: "pi",
      fallbackFor: "codex",
      fallbackReason: "codex exited with code 1",
      fallbackCause: "something_new",
    })!;
    expect(tag).toContain("unavailable");
    expect(tag).not.toContain("something_new");
  });
});
