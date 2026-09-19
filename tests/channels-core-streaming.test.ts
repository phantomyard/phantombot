import { describe, expect, test } from "bun:test";

import { DEFAULT_TELEGRAM_STREAMING } from "../src/config.ts";
import {
  createNarrationController,
  resolveOutgoingSuffix,
  segmenterOptionsFor,
} from "../src/channels/core/streaming.ts";

const streamingWith = (narrationFlushMs: number) => ({
  ...DEFAULT_TELEGRAM_STREAMING,
  narrationFlushMs,
});

describe("segmenterOptionsFor", () => {
  test("maps bubble sizing from the streaming config", () => {
    expect(
      segmenterOptionsFor({
        ...DEFAULT_TELEGRAM_STREAMING,
        bubbleMaxSentences: 3,
        bubbleMaxChars: 512,
      }),
    ).toEqual({ maxSentences: 3, maxChars: 512 });
  });
});

describe("resolveOutgoingSuffix", () => {
  test("returns only the un-sent suffix when the consumed prefix matches", () => {
    const streamed = "Hello there. ";
    const full = "Hello there. And the rest.";
    expect(resolveOutgoingSuffix(full, streamed, streamed.length)).toBe(
      "And the rest.",
    );
  });

  test("returns the full reply when nothing was consumed", () => {
    const full = "Hello there. And the rest.";
    expect(resolveOutgoingSuffix(full, "Hello there. ", 0)).toBe(full);
  });

  test("returns the full reply when the harness reformatted the prefix", () => {
    // The done.finalText diverges from what streamed live (reformatted), so the
    // consumed prefix no longer matches — we resend the whole thing rather than
    // silently truncate.
    const streamed = "hello there";
    const full = "Hello there — reformatted.";
    expect(resolveOutgoingSuffix(full, streamed, streamed.length)).toBe(full);
  });

  test("empty full reply yields empty output", () => {
    expect(resolveOutgoingSuffix("", "", 0)).toBe("");
  });
});

describe("createNarrationController", () => {
  test("flush emits the buffered narration as a single bubble", async () => {
    const sent: string[] = [];
    const narration = createNarrationController({
      streaming: streamingWith(0),
      enabled: true,
      send: async (t) => void sent.push(t),
    });
    narration.append("checking ");
    narration.append("your calendar…");
    await narration.flush();
    expect(sent).toEqual(["checking your calendar…"]);
  });

  test("buffer is cleared after a flush", async () => {
    const sent: string[] = [];
    const narration = createNarrationController({
      streaming: streamingWith(0),
      enabled: true,
      send: async (t) => void sent.push(t),
    });
    narration.append("first");
    await narration.flush();
    await narration.flush(); // nothing new buffered
    expect(sent).toEqual(["first"]);
  });

  test("empty / whitespace-only buffer never sends", async () => {
    const sent: string[] = [];
    const narration = createNarrationController({
      streaming: streamingWith(0),
      enabled: true,
      send: async (t) => void sent.push(t),
    });
    await narration.flush(true);
    narration.append("   \n  ");
    await narration.flush(true);
    expect(sent).toEqual([]);
  });

  test("disabled controller drops narration entirely", async () => {
    const sent: string[] = [];
    const narration = createNarrationController({
      streaming: streamingWith(0),
      enabled: false,
      send: async (t) => void sent.push(t),
    });
    narration.append("should never appear");
    await narration.flush(true);
    expect(sent).toEqual([]);
  });

  test("suppress() gates the flush even when enabled", async () => {
    const sent: string[] = [];
    let suppressed = true;
    const narration = createNarrationController({
      streaming: streamingWith(0),
      enabled: true,
      send: async (t) => void sent.push(t),
      suppress: () => suppressed,
    });
    narration.append("hidden while suppressed");
    await narration.flush(true);
    expect(sent).toEqual([]);
    // suppress is evaluated live on each flush — lift it and the buffered
    // narration surfaces on the next flush.
    suppressed = false;
    await narration.flush(true);
    expect(sent).toEqual(["hidden while suppressed"]);
  });

  test("throttles to at most one bubble per narrationFlushMs", async () => {
    const sent: string[] = [];
    // Large window: the initial flush clock is set at construction, so an
    // immediate non-forced flush is inside the window and stays quiet.
    const narration = createNarrationController({
      streaming: streamingWith(60_000),
      enabled: true,
      send: async (t) => void sent.push(t),
    });
    narration.append("too soon");
    await narration.flush();
    expect(sent).toEqual([]);
    // force bypasses the throttle window.
    await narration.flush(true);
    expect(sent).toEqual(["too soon"]);
  });
});
