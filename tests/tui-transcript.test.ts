/**
 * Transcript rows and scrolling.
 *
 * In a full-screen app the window height is fixed, so an unclipped transcript
 * pushes the frame's bottom border off the screen and the terminal scrolls the
 * alternate buffer — the "frame deforms" failure. Clipping happens BEFORE
 * layout, on a flat list of ROWS: the screen draws exactly the lines produced
 * here, so what is measured and what is drawn cannot drift apart (they did,
 * when height was guessed separately), and one row of scroll is one row on
 * screen even inside a message taller than the window.
 */

import { describe, expect, test } from "bun:test";

import {
  transcriptLines,
  transcriptWindow,
  type TranscriptLine,
} from "../src/tui/transcript.ts";
import type { ChatMessage } from "../src/tui/chatSession.ts";

const options = {
  personaName: "lab",
  formatDuration: (ms: number | undefined) => (ms === undefined ? "…" : `${ms}ms`),
};

const msg = (text: string, tools: string[] = []): ChatMessage => ({
  role: "assistant",
  text,
  at: 0,
  tools: tools.map((title) => ({ title, startedAt: 0 })),
});

const kinds = (lines: readonly TranscriptLine[]) => lines.map((l) => l.kind);
const texts = (lines: readonly TranscriptLine[]) =>
  lines.filter((l) => l.kind === "text").map((l) => (l as { text: string }).text);

describe("transcriptLines", () => {
  test("a message is a header, its tools, its wrapped body and a gap", () => {
    expect(kinds(transcriptLines([msg("short")], 80, options))).toEqual([
      "header",
      "text",
      "gap",
    ]);
    // 200 chars at an effective width of 74 wraps to three rows.
    expect(texts(transcriptLines([msg("x".repeat(200))], 80, options))).toHaveLength(3);
    // Explicit newlines are rows of their own.
    expect(texts(transcriptLines([msg("a\nb\nc")], 80, options))).toEqual(["a", "b", "c"]);
  });

  test("every tool call gets a row, one per line of its title", () => {
    const lines = transcriptLines([msg("done", ["one\ntwo", "b"])], 80, options);
    expect(lines.filter((l) => l.kind === "tool")).toHaveLength(3);
  });

  test("history without a timestamp is not stamped with the current time", () => {
    // `at: 0` is a row loaded from the memory store. Labelling yesterday's
    // conversation with this minute is a lie the user cannot detect.
    const [header] = transcriptLines([msg("x")], 80, options);
    expect(header).toMatchObject({ kind: "header", time: "" });
  });
});

describe("transcriptWindow", () => {
  const lines = transcriptLines(
    [msg("one"), msg("two"), msg("three"), msg("four")],
    80,
    options,
  );

  test("offset 0 is the live bottom of the conversation", () => {
    const view = transcriptWindow(lines, 6, 0);
    expect(texts(view.lines)).toEqual(["three", "four"]);
    expect(view.below).toBe(0);
    expect(view.above).toBe(6);
  });

  test("scrolling up by rows reveals older turns", () => {
    expect(texts(transcriptWindow(lines, 6, 3).lines)).toEqual(["two", "three"]);
    expect(texts(transcriptWindow(lines, 6, 6).lines)).toEqual(["one", "two"]);
  });

  test("scrolling past the top clamps instead of blanking the screen", () => {
    // An empty window looks exactly like a crash, so the top is a wall.
    const view = transcriptWindow(lines, 6, 9999);
    expect(view.offset).toBe(view.maxOffset);
    expect(view.lines).toHaveLength(6);
    expect(view.above).toBe(0);
  });

  test("a message taller than the window can be scrolled THROUGH", () => {
    // The old message-granularity clipper could only show this all or nothing:
    // a long reply was unreadable above the first screenful.
    const tall = transcriptLines([msg("y\n".repeat(50).trim())], 80, options);
    const top = transcriptWindow(tall, 10, tall.length);
    const bottom = transcriptWindow(tall, 10, 0);
    expect(top.lines).toHaveLength(10);
    expect(bottom.lines).toHaveLength(10);
    expect(top.above).toBe(0);
    expect(bottom.below).toBe(0);
  });

  test("a window taller than the conversation shows all of it, once", () => {
    const view = transcriptWindow(lines, 100, 0);
    expect(view.lines).toHaveLength(lines.length);
    expect(view.maxOffset).toBe(0);
  });
});
