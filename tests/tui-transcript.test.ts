/**
 * Transcript clipping.
 *
 * In a full-screen app the window height is fixed, so an unclipped transcript
 * pushes the frame's bottom border off the screen and the terminal scrolls the
 * alternate buffer — the "frame deforms" failure. Clipping happens BEFORE
 * layout, and always keeps the newest messages.
 */

import { describe, expect, test } from "bun:test";

import { messageHeight, visibleMessages } from "../src/tui/transcript.ts";
import type { ChatMessage } from "../src/tui/chatSession.ts";

const msg = (text: string, tools: string[] = []): ChatMessage => ({
  role: "assistant",
  text,
  at: 0,
  tools: tools.map((title) => ({ title, startedAt: 0 })),
});

describe("messageHeight", () => {
  test("counts the header, the wrapped body and the gap", () => {
    // header + one body row + gap
    expect(messageHeight(msg("short"), 80)).toBe(3);
    // 200 chars at an effective width of 74 wraps to three rows
    expect(messageHeight(msg("x".repeat(200)), 80)).toBe(5);
    // Explicit newlines count as rows of their own.
    expect(messageHeight(msg("a\nb\nc"), 80)).toBe(5);
  });

  test("collapsed tool calls are one row each, expanded ones are as tall as they are", () => {
    const m = msg("done", ["one\ntwo\nthree"]);
    expect(messageHeight(m, 80)).toBe(4);
    expect(messageHeight(m, 80, { showTools: true })).toBe(6);
  });
});

describe("visibleMessages", () => {
  test("keeps the tail, because a chat is read at the bottom", () => {
    const messages = [msg("one"), msg("two"), msg("three"), msg("four")];
    // 3 rows each; 7 rows fits two.
    expect(visibleMessages(messages, 7, 80).map((m) => m.text)).toEqual([
      "three",
      "four",
    ]);
  });

  test("always shows the newest message even when it does not fit", () => {
    // A long streaming answer must not blank the screen on its way in.
    const messages = [msg("older"), msg("y".repeat(4000))];
    const shown = visibleMessages(messages, 5, 80);
    expect(shown).toHaveLength(1);
    expect(shown[0]!.text.startsWith("y")).toBe(true);
  });

  test("an empty conversation clips to nothing rather than throwing", () => {
    expect(visibleMessages([], 20, 80)).toEqual([]);
  });
});
