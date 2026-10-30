/**
 * Emacs/readline cursor movement in the chat prompt box (issue #677):
 * character, word and line moves, and the inverse-video cursor that no
 * longer takes a column of its own. Plus the deletes that mirror those
 * moves (issue #725).
 */

import { describe, expect, it } from "bun:test";

import {
  cursorLeft,
  cursorLineEnd,
  cursorLineStart,
  cursorRight,
  cursorWordLeft,
  cursorWordRight,
  deleteToLineStart,
  deleteWhitespaceWordLeft,
  deleteWordLeft,
  deleteWordRight,
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

/** Press a delete until the text stops changing; return each text seen. */
function press(del: (st: PromptState) => PromptState, start: PromptState): string[] {
  const seen = [start.text];
  let st = start;
  for (;;) {
    const next = del(st);
    if (next.text === st.text) return seen;
    st = next;
    seen.push(st.text);
  }
}

describe("deletes (^w, Alt-Backspace, Alt-d, ^u) — issue #725", () => {
  const t = "hello, big  world";

  it("Alt-Backspace deletes back to where Alt-b lands", () => {
    expect(press(deleteWordLeft, s(t, t.length))).toEqual(["hello, big  world", "hello, big  ", "hello, ", ""]);
    expect(deleteWordLeft(s("hello world", 8))).toEqual(s("hello rld", 6));
  });

  it("Alt-d deletes forward to where Alt-f lands", () => {
    expect(press(deleteWordRight, s(t, 0))).toEqual(["hello, big  world", ", big  world", "  world", ""]);
    expect(deleteWordRight(s("hello world", 2))).toEqual(s("he world", 2));
  });

  it("^w deletes back to the previous whitespace: a path or URL goes in one press", () => {
    expect(deleteWhitespaceWordLeft(s("cat ~/a/b.txt  ", 15))).toEqual(s("cat ", 4));
    expect(deleteWhitespaceWordLeft(s("see https://x.io/a?b=c", 22))).toEqual(s("see ", 4));
    // Alt-Backspace stops at punctuation; ^w does not.
    expect(deleteWordLeft(s("foo-bar baz", 7))).toEqual(s("foo- baz", 4));
    expect(deleteWhitespaceWordLeft(s("foo-bar baz", 7))).toEqual(s(" baz", 0));
  });

  it("^u deletes back to where ^a lands: the line start, then everything before the cursor", () => {
    const ml = "one\ntwo three";
    expect(press(deleteToLineStart, s(ml, ml.length))).toEqual(["one\ntwo three", "one\n", ""]);
    // Text after the cursor stays, and so does the cursor's line.
    expect(deleteToLineStart(s("one\ntwo", 6))).toEqual(s("one\no", 4));
    expect(deleteToLineStart(s("one\no", 4))).toEqual(s("o", 0));
  });

  it("word deletes cross lines, like the word moves", () => {
    expect(deleteWordLeft(s("one\ntwo", 4))).toEqual(s("two", 0));
    expect(deleteWordRight(s("one\ntwo", 3))).toEqual(s("one", 3));
    expect(deleteWhitespaceWordLeft(s("one\n", 4))).toEqual(s("", 0));
  });

  it("never splits a grapheme: accents, ZWJ emoji", () => {
    const accent = "café";
    expect(graphemeCount(accent)).toBe(4);
    expect(deleteWordLeft(s(accent, 4))).toEqual(s("", 0));
    expect(deleteWhitespaceWordLeft(s("a 👨‍👩‍👧", 3))).toEqual(s("a ", 2));
    expect(deleteToLineStart(s("👨‍👩‍👧x", 1))).toEqual(s("x", 0));
  });

  it("at the edge there is nothing to delete: the state comes back unchanged", () => {
    expect(deleteWordLeft(s("abc", 0))).toEqual(s("abc", 0));
    expect(deleteWhitespaceWordLeft(s("abc", 0))).toEqual(s("abc", 0));
    expect(deleteToLineStart(s("abc", 0))).toEqual(s("abc", 0));
    expect(deleteWordRight(s("abc", 3))).toEqual(s("abc", 3));
    expect(deleteWordLeft(s("", 0))).toEqual(s("", 0));
  });

  it("a delete removes exactly the span its move covers, and nothing else (every position)", () => {
    const texts = [t, "one\n\n  two", "café🎉naïve2", "  ,, ", "x\n🎉👨‍👩‍👧y", "a-b c\td"];
    const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });
    const gs = (text: string) => [...segmenter.segment(text)].map((x) => x.segment);
    for (const text of texts) {
      const g = gs(text);
      for (let c = 0; c <= g.length; c++) {
        const st = s(text, c);
        const back = (del: (st: PromptState) => PromptState, to: number) => {
          const r = del(st);
          expect(r.cursor).toBe(to);
          expect(r.text).toBe(g.slice(0, to).join("") + g.slice(c).join(""));
        };
        back(deleteWordLeft, cursorWordLeft(st).cursor);
        back(deleteToLineStart, cursorLineStart(st).cursor);
        // ^w has no move of its own: it drops a run of non-space then the
        // spaces after it, and stops at a space or the start.
        const w = deleteWhitespaceWordLeft(st);
        expect(w.text).toBe(g.slice(0, w.cursor).join("") + g.slice(c).join(""));
        expect(g.slice(w.cursor, c).join("")).toMatch(/^\S*\s*$/u);
        if (w.cursor > 0) expect(g[w.cursor - 1]!).toMatch(/^\s+$/);
        if (c > 0) expect(w.cursor).toBeLessThan(c);
        const fwd = deleteWordRight(st);
        expect(fwd.cursor).toBe(c);
        expect(fwd.text).toBe(g.slice(0, c).join("") + g.slice(cursorWordRight(st).cursor).join(""));
      }
    }
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
