/**
 * Emacs/readline cursor movement in the chat prompt box (issue #677):
 * character, word and line moves, and the inverse-video cursor that no
 * longer takes a column of its own.
 */

import { describe, expect, it } from "bun:test";

import {
  cursorLeft,
  cursorLineEnd,
  cursorLineStart,
  cursorRight,
  cursorWordLeft,
  cursorWordRight,
  graphemeCount,
  MAX_PROMPT_ROWS,
  promptRows,
  type PromptSeg,
  type PromptState,
} from "../src/tui/promptBox.ts";
import { textWidth } from "../src/tui/markdown.ts";

const s = (text: string, cursor: number): PromptState => ({ text, cursor });

/** Walk a move until it stops changing the cursor. */
function walk(move: (st: PromptState) => PromptState, start: PromptState): number[] {
  const seen = [start.cursor];
  let st = start;
  for (;;) {
    const next = move(st);
    if (next.cursor === st.cursor) return seen;
    st = next;
    seen.push(st.cursor);
  }
}

describe("character moves (^b / ^f)", () => {
  it("step one grapheme and clamp at both ends", () => {
    expect(cursorLeft(s("ab", 0)).cursor).toBe(0);
    expect(cursorRight(s("ab", 2)).cursor).toBe(2);
  });

  it("an emoji or ZWJ family is one step", () => {
    const t = "a👨‍👩‍👧b";
    expect(walk(cursorRight, s(t, 0))).toEqual([0, 1, 2, 3]);
  });
});

describe("word moves (Alt-b / Alt-f, Alt-← / Alt-→)", () => {
  const t = "hello, big  world";
  it("Alt-f lands on the end of each word", () => {
    expect(walk(cursorWordRight, s(t, 0))).toEqual([0, 5, 10, 17]);
  });

  it("Alt-b lands on the start of each word", () => {
    expect(walk(cursorWordLeft, s(t, t.length))).toEqual([17, 12, 7, 0]);
  });

  it("from mid-word, moves to that word's own edge", () => {
    expect(cursorWordRight(s(t, 2)).cursor).toBe(5);
    expect(cursorWordLeft(s(t, 9)).cursor).toBe(7);
  });

  it("crosses line boundaries", () => {
    const ml = "one\n\n  two";
    expect(cursorWordRight(s(ml, 3)).cursor).toBe(10);
    expect(cursorWordLeft(s(ml, 7)).cursor).toBe(0);
  });

  it("emoji and punctuation separate words; accents and digits do not", () => {
    expect(cursorWordRight(s("café🎉naïve2", 0)).cursor).toBe(4);
    expect(cursorWordRight(s("café🎉naïve2", 4)).cursor).toBe(11);
  });

  it("no words: runs to the end / start", () => {
    expect(cursorWordRight(s("  ,, ", 0)).cursor).toBe(5);
    expect(cursorWordLeft(s("  ,, ", 5)).cursor).toBe(0);
    expect(cursorWordRight(s("", 0)).cursor).toBe(0);
  });
});

describe("line moves (^a / ^e)", () => {
  const t = "first\nsecond line\nthird";
  it("^a goes to the start of the CURRENT line", () => {
    expect(cursorLineStart(s(t, 10)).cursor).toBe(6);
  });

  it("^a pressed again goes to the start of the whole input", () => {
    const once = cursorLineStart(s(t, 10));
    expect(cursorLineStart(once).cursor).toBe(0);
  });

  it("^e goes to the end of the current line, then the whole input", () => {
    const once = cursorLineEnd(s(t, 8));
    expect(once.cursor).toBe(17);
    expect(cursorLineEnd(once).cursor).toBe(graphemeCount(t));
  });

  it("first / last line: already at the input edge, a second press is a no-op", () => {
    expect(cursorLineStart(s(t, 3)).cursor).toBe(0);
    expect(cursorLineStart(s(t, 0)).cursor).toBe(0);
    expect(cursorLineEnd(s(t, 20)).cursor).toBe(graphemeCount(t));
  });

  it("an empty line is its own start and end", () => {
    const e = "ab\n\ncd";
    // On the empty line (cursor 3) both are 'already there' → whole input.
    expect(cursorLineStart(s(e, 3)).cursor).toBe(0);
    expect(cursorLineEnd(s(e, 3)).cursor).toBe(6);
  });

  it("wide graphemes count as one cursor step", () => {
    const w = "x\n🎉👨‍👩‍👧y";
    expect(cursorLineEnd(s(w, 2)).cursor).toBe(5);
    expect(cursorLineStart(s(w, 5)).cursor).toBe(2);
  });
});

/** The drawn text of every row with the prefix and cursor cell stripped. */
function plain(rows: PromptSeg[][]): string[] {
  return rows.map((row) =>
    row
      .slice(1)
      .map((seg) => (seg.caret ? "\u0000" + seg.text : seg.text))
      .join(""),
  );
}

describe("inverse-video cursor", () => {
  it("inverts the grapheme it sits on, adding no column", () => {
    const rows = promptRows("hello", 1, 40);
    const caret = rows[0]!.find((seg) => seg.caret);
    expect(caret?.text).toBe("e");
    expect(rows[0]!.slice(1).map((seg) => seg.text).join("")).toBe("hello");
  });

  it("at the end of a line it is a solid cell", () => {
    const rows = promptRows("ab\ncd", 2, 40);
    expect(rows[0]!.at(-1)).toEqual({ text: " ", caret: true });
  });

  it("inverts a wide glyph whole", () => {
    const rows = promptRows("a🎉b", 1, 40);
    expect(rows[0]!.find((seg) => seg.caret)?.text).toBe("🎉");
  });

  it("moving the cursor never shifts or re-wraps the text", () => {
    const samples = [
      "aaaa bbbb cccc dddd eeee",
      "🎉🎉 wide 🎉 glyphs 🎉🎉\nand\n\nmore",
      "a  b   c    d     e      f",
      "supercalifragilisticexpialidocious word",
    ];
    let checked = 0;
    for (const text of samples) {
      for (const width of [10, 14, 23]) {
        // Busy = no cursor at all: the reference layout.
        const ref = plain(promptRows(text, 0, width, { busy: true }));
        if (ref.length >= MAX_PROMPT_ROWS) continue; // windowed: rows differ by design
        checked++;
        for (let c = 0; c <= graphemeCount(text); c++) {
          const rows = promptRows(text, c, width);
          expect(rows.length).toBe(ref.length);
          for (const row of rows) {
            expect(row.reduce((acc, seg) => acc + textWidth(seg.text), 0)).toBeLessThanOrEqual(width);
          }
          plain(rows).forEach((drawn, r) => {
            const at = drawn.indexOf("\u0000");
            if (at < 0) return void expect(drawn).toBe(ref[r]!);
            // Before the cursor: unchanged. The cursor cell: the grapheme
            // that was there, or the reserved cell past the text.
            expect(ref[r]!.startsWith(drawn.slice(0, at))).toBe(true);
            const after = drawn.slice(at + 1);
            expect(ref[r]!.slice(at) === after || (ref[r]!.length === at && after === " ") || /^\s/.test(ref[r]!.slice(at))).toBe(true);
          });
        }
      }
    }
    expect(checked).toBeGreaterThan(6);
  });

  it("leading spaces on the first row are drawn (and reachable)", () => {
    const rows = promptRows("  indented", 0, 40);
    expect(rows[0]!.find((seg) => seg.caret)?.text).toBe(" ");
    expect(rows[0]!.slice(1).map((seg) => seg.text).join("")).toBe("  indented");
  });
});
