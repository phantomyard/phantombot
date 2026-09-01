import { describe, expect, it } from "bun:test";

import {
  backspaceAtCursor,
  cursorLeft,
  cursorRight,
  cursorHome,
  cursorEnd,
  deleteAtCursor,
  insertAtCursor,
  promptRows,
  promptState,
  MAX_PROMPT_ROWS,
} from "../src/tui/promptBox.ts";
import { textWidth } from "../src/tui/markdown.ts";

describe("promptBox cursor ops", () => {
  it("inserts at the cursor, not just at the end", () => {
    const s = insertAtCursor({ text: "helo", cursor: 3 }, "l");
    expect(s.text).toBe("hello");
    expect(s.cursor).toBe(4);
  });

  it("backspace deletes before the cursor only", () => {
    const s = backspaceAtCursor({ text: "hello", cursor: 3 });
    expect(s.text).toBe("helo");
    expect(s.cursor).toBe(2);
  });

  it("backspace at the start is a no-op", () => {
    const s = backspaceAtCursor({ text: "hello", cursor: 0 });
    expect(s.text).toBe("hello");
    expect(s.cursor).toBe(0);
  });

  it("forward delete removes the grapheme at the cursor", () => {
    const s = deleteAtCursor({ text: "hello", cursor: 1 });
    expect(s.text).toBe("hllo");
    expect(s.cursor).toBe(1);
  });

  it("forward delete at the end is a no-op", () => {
    const s = deleteAtCursor({ text: "hello", cursor: 5 });
    expect(s.text).toBe("hello");
    expect(s.cursor).toBe(5);
  });

  it("left/right clamp at the edges", () => {
    expect(cursorLeft({ text: "ab", cursor: 0 }).cursor).toBe(0);
    expect(cursorRight({ text: "ab", cursor: 2 }).cursor).toBe(2);
    expect(cursorLeft({ text: "ab", cursor: 2 }).cursor).toBe(1);
    expect(cursorRight({ text: "ab", cursor: 0 }).cursor).toBe(1);
  });

  it("cursor is a GRAPHEME index: an emoji is one unit, never split", () => {
    // "🎉x" — the emoji is 2 UTF-16 units but ONE grapheme.
    const s = promptState("🎉x");
    expect(s.cursor).toBe(2);
    const left = cursorLeft(s);
    expect(left.cursor).toBe(1);
    // backspace at cursor 1 removes the whole emoji, not half of it.
    const bs = backspaceAtCursor({ text: "🎉x", cursor: 1 });
    expect(bs.text).toBe("x");
  });

  it("inserting an emoji lands the cursor past it whole", () => {
    const s = insertAtCursor(promptState(""), "🎉x");
    expect(s.text).toBe("🎉x");
    expect(s.cursor).toBe(2);
    const more = insertAtCursor(s, "!");
    expect(more.text).toBe("🎉x!");
    expect(more.cursor).toBe(3);
  });

  it("newlines are characters", () => {
    const s = insertAtCursor(promptState("ab"), "\nc");
    expect(s.text).toBe("ab\nc");
    expect(s.cursor).toBe(4);
  });

  it("home and end", () => {
    expect(cursorHome(promptState("abc")).cursor).toBe(0);
    expect(cursorEnd(promptState("abc")).cursor).toBe(3);
  });
});

describe("promptBox rendering", () => {
  const W = 20; // inner width for tests

  it("empty box draws the prefix and caret", () => {
    const rows = promptRows("", 0, W);
    expect(rows).toHaveLength(1);
    const flat = rows[0]!.map((s) => s.text).join("");
    expect(flat).toContain("›");
    expect(rows[0]!.some((s) => s.caret)).toBe(true);
  });

  it("prefix on the first row only; continuation rows indent", () => {
    const text = "aaaa bbbb cccc dddd eeee ffff gggg";
    const rows = promptRows(text, text.length, W);
    expect(rows.length).toBeGreaterThan(1);
    expect(rows[0]![0]!.text).toBe("› ");
    expect(rows[1]![0]!.text).toBe("  ");
  });

  it("no row exceeds the width budget — the no-shear invariant", () => {
    const text = "word ".repeat(40) + "🎉🎉🎉 supercalifragilisticexpialidocious";
    const rows = promptRows(text, text.length, W);
    for (const row of rows) {
      expect(row.length).toBeGreaterThan(0);
      // THE assertion the no-shear claim rests on: what is measured here is
      // exactly what the terminal draws, so a row must fit its budget.
      // (PREFIX/CONTINUATION_INDENT pad the row to full width, so budget = W.)
      const lineWidth = row.reduce((acc, s) => acc + textWidth(s.text), 0);
      expect(lineWidth).toBeLessThanOrEqual(W);
    }
    expect(rows.length).toBe(MAX_PROMPT_ROWS); // capped, windowed
  });

  it("caret is part of the wrap stream: past a full row it opens the next", () => {
    // 17 chars + caret fit after the 2-col prefix at width 20.
    const text = "x".repeat(17);
    const rows = promptRows(text, text.length, W);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.some((s) => s.caret)).toBe(true);
    // an 18th char pushes the caret to its own second row.
    const rows2 = promptRows(text + "x", text.length + 1, W);
    expect(rows2.length).toBe(2);
    expect(rows2[1]!.some((s) => s.caret)).toBe(true);
  });

  it("caret renders mid-text when the cursor moves left", () => {
    const rows = promptRows("hello", 2, W);
    const flat = rows.flatMap((r) => r);
    const caretIdx = flat.findIndex((s) => s.caret);
    const before = flat.slice(0, caretIdx).map((s) => s.text).join("");
    expect(before).toContain("he");
    expect(before).not.toContain("llo");
  });

  it("multi-line input: caret after a newline opens a new row", () => {
    const rows = promptRows("ab\ncd", 5, W);
    const last = rows[rows.length - 1]!;
    expect(last.some((s) => s.caret)).toBe(true);
    const joined = last.map((s) => s.text).join("");
    expect(joined).toContain("cd");
  });

  it("windowing follows the cursor: the caret row stays visible", () => {
    const text = Array.from({ length: 20 }, (_, i) => `line ${i}`).join("\n");
    const atStart = promptRows(text, 0, W);
    expect(atStart[0]!.some((s) => s.caret)).toBe(true);
    const atEnd = promptRows(text, text.length, W);
    expect(atEnd[atEnd.length - 1]!.some((s) => s.caret)).toBe(true);
    expect(atEnd.length).toBe(MAX_PROMPT_ROWS);
  });

  it("busy hides the caret but keeps the rows", () => {
    const rows = promptRows("hello", 2, W, { busy: true });
    expect(rows.flatMap((r) => r).some((s) => s.caret)).toBe(false);
  });
});
