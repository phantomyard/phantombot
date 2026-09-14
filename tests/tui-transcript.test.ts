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
import { textWidth } from "../src/tui/markdown.ts";
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
/** The tool rows, narrowed — the width assertions below need title/duration. */
const toolRows = (lines: readonly TranscriptLine[]) =>
  lines.filter((l): l is Extract<TranscriptLine, { kind: "tool" }> => l.kind === "tool");
/** What `Line` actually DRAWS for a tool row: `\u203a ` + title + duration. */
const toolWidth = (row: { title: string; duration: string }) =>
  2 + textWidth(row.title) + textWidth(row.duration);
/**
 * The plain text of a body row, whichever kind it is: a user message is a
 * `text` row and an assistant message is a `rich` (rendered markdown) one
 * since phantombot#481, and the row arithmetic these tests pin is the same
 * for both.
 */
const texts = (lines: readonly TranscriptLine[]) =>
  lines
    .filter((l) => l.kind === "text" || l.kind === "rich")
    .map((l) =>
      l.kind === "text"
        ? l.text
        : l.spans.map((s) => s.text).join(""),
    );

describe("transcriptLines", () => {
  test("a message is a header, its tools, its wrapped body and a gap", () => {
    expect(kinds(transcriptLines([msg("short")], 80, options))).toEqual([
      "header",
      "rich",
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

  /**
   * phantombot#556. Tool rows were counted as one row and DRAWN as
   * `\u203a ` + title + duration, so a title wider than the window wrapped to
   * two physical rows that nothing had budgeted for. The frame then came out
   * taller than the terminal: Yoga shrank the children and the last transcript
   * rows overwrote each other, and Ink's cursor-up repaint went out by the
   * same number of rows — a prompt strip with no caret and a TUI that looked
   * frozen until it was restarted. Tool notes are capped at 160 columns
   * (`MAX_TOOL_NOTE_LEN`), so any terminal under ~166 columns reproduced it.
   *
   * The old test asserted the row COUNT and never the row WIDTH, which is
   * exactly the gap that let this ship, so these pin the width.
   */
  test("a tool row never draws wider than the window", () => {
    // A tool note is capped at 160 columns, so this is the row the TUI draws
    // on a real terminal — at every width, including ones wider than the cap.
    for (const columns of [40, 80, 100, 166, 200]) {
      const width = Math.max(20, columns - 6);
      const rows = toolRows(
        transcriptLines([msg("done", [`Bash(${"x".repeat(160)})`])], columns, options),
      );
      expect(rows).toHaveLength(1);
      expect(toolWidth(rows[0]!)).toBeLessThanOrEqual(width);
    }
  });

  test("a truncated tool title is marked with an ellipsis, a short one is untouched", () => {
    const [cut] = toolRows(transcriptLines([msg("done", ["y".repeat(200)])], 80, options));
    expect(cut!.title.endsWith("\u2026")).toBe(true);
    // Nothing is cut when it fits: truncating a title that already fits would
    // be a regression of its own — the row is the only trace of the call.
    const [kept] = toolRows(
      transcriptLines([msg("done", ["Read(AGENTS.md)"])], 80, options),
    );
    expect(kept!.title).toBe("Read(AGENTS.md)");
  });

  test("the duration is charged to the title's budget", () => {
    // A running call shows `\u2026` (one column) and a finished one its full
    // duration, so the same title must be cut harder once the call lands.
    // Measuring the title alone is how a row overflows only at the very end.
    const [finished] = toolRows(
      transcriptLines(
        [
          {
            ...msg("done"),
            tools: [{ title: "z".repeat(200), startedAt: 0, durationMs: 12345 }],
          },
        ],
        80,
        options,
      ),
    );
    const [running] = toolRows(
      transcriptLines([msg("done", ["z".repeat(200)])], 80, options),
    );
    expect(textWidth(finished!.title)).toBeLessThan(textWidth(running!.title));
    expect(toolWidth(finished!)).toBeLessThanOrEqual(74);
    expect(toolWidth(running!)).toBeLessThanOrEqual(74);
  });

  test("a wide-glyph tool title is measured in columns, not code units", () => {
    // `.length` is wrong in both directions for real titles: a CJK ideograph
    // is one code unit and two columns, so a title "fitted" by length comes
    // out twice the window wide. Cuts land between grapheme clusters.
    const [row] = toolRows(
      transcriptLines([msg("done", ["\u6f22".repeat(200)])], 80, options),
    );
    expect(toolWidth(row!)).toBeLessThanOrEqual(74);
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
