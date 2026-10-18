/**
 * ↑↓ inside the chat prompt box (issue #667): the cursor moves between the
 * box's VISUAL rows — wrapped rows count, not only "\n" — keeps its goal
 * column across short rows, and reports the first/last row so Chat can fall
 * through to scrolling the transcript.
 *
 * Expectations are read off `promptRows` itself (where the caret is DRAWN),
 * so these tests pin "↑↓ walk the rows you see", not an independent model of
 * wrapping that could drift from the renderer.
 */

import { describe, expect, it } from "bun:test";

import {
  cursorDown,
  cursorUp,
  MAX_PROMPT_ROWS,
  promptRows,
  type PromptState,
} from "../src/tui/promptBox.ts";
import { textWidth } from "../src/tui/markdown.ts";

/** Row index and display column (after the 2-col prefix) of the drawn caret. */
function drawn(state: PromptState, width: number): { row: number; col: number } {
  // Reads the drawn (windowed) rows: callers keep texts under the cap.
  const rows = promptRows(state.text, state.cursor, width);
  for (let r = 0; r < rows.length; r++) {
    let col = 0;
    for (const seg of rows[r]!.slice(1)) {
      if (seg.caret) return { row: r, col };
      col += textWidth(seg.text);
    }
  }
  throw new Error("no caret drawn");
}

const s = (text: string, cursor: number): PromptState => ({ text, cursor });

describe("↑↓ across logical lines", () => {
  it("↑ from the second line lands on the first, same column", () => {
    const m = cursorUp(s("hello\nworld", 9), 40); // "wor|ld"
    expect(m?.state.cursor).toBe(3); // "hel|lo"
  });

  it("↓ from the first line lands on the second, same column", () => {
    const m = cursorDown(s("hello\nworld", 2), 40);
    expect(m?.state.cursor).toBe(8);
  });

  it("first row: ↑ returns undefined (caller scrolls)", () => {
    expect(cursorUp(s("hello\nworld", 3), 40)).toBeUndefined();
  });

  it("last row: ↓ returns undefined (caller scrolls)", () => {
    expect(cursorDown(s("hello\nworld", 8), 40)).toBeUndefined();
  });

  it("single-row box: both directions fall through", () => {
    expect(cursorUp(s("hi", 1), 40)).toBeUndefined();
    expect(cursorDown(s("hi", 1), 40)).toBeUndefined();
    expect(cursorUp(s("", 0), 40)).toBeUndefined();
    expect(cursorDown(s("", 0), 40)).toBeUndefined();
  });

  it("a shorter target line clamps the cursor to its end", () => {
    const m = cursorUp(s("ab\nabcdef", 8), 40); // col 5 → "ab|"
    expect(m?.state.cursor).toBe(2);
  });
});

describe("empty lines", () => {
  it("↑↓ step onto and off an empty line", () => {
    const text = "abc\n\nxyz";
    const onEmpty = cursorDown(s(text, 2), 40);
    expect(onEmpty?.state.cursor).toBe(4); // the empty line
    const below = cursorDown(onEmpty!.state, 40, onEmpty!.goal);
    expect(below?.state.cursor).toBe(7); // "xy|z": goal 2 survived
  });

  it("a trailing empty line is a real row", () => {
    const m = cursorDown(s("abc\n", 1), 40);
    expect(m?.state.cursor).toBe(4);
    expect(cursorDown(m!.state, 40)).toBeUndefined();
  });
});

describe("goal column", () => {
  it("is kept across a short line and restored on the next long one", () => {
    const text = "abcdefgh\nab\nabcdefgh";
    const up1 = cursorUp(s(text, 9 + 3 + 6), 40); // col 6 on line 3
    expect(up1?.state.cursor).toBe(11); // clamped to "ab|"
    expect(up1?.goal).toBe(6);
    const up2 = cursorUp(up1!.state, 40, up1!.goal);
    expect(up2?.state.cursor).toBe(6); // back to col 6, not col 2
  });

  it("without a carried goal the cursor's own column is the goal", () => {
    const up1 = cursorUp(s("abcdefgh\nab\nabcdefgh", 18), 40)!;
    const up2 = cursorUp(up1.state, 40); // goal dropped
    expect(up2?.state.cursor).toBe(2);
  });
});

describe("wrapped rows", () => {
  // width 12 → 10 text columns per row.
  const W = 12;
  const para = "aaaa bbbb cccc dddd eeee";

  it("one long paragraph wraps to several rows", () => {
    expect(promptRows(para, 0, W).length).toBeGreaterThan(1);
  });

  it("↑↓ move by visual row inside ONE logical line", () => {
    const start = s(para, 0);
    const down = cursorDown(start, W);
    expect(down).toBeDefined();
    expect(drawn(down!.state, W).row).toBe(1);
    expect(drawn(down!.state, W).col).toBe(0);
    const back = cursorUp(down!.state, W, down!.goal);
    expect(back?.state.cursor).toBe(0);
  });

  it("walks every row of a wrapped paragraph and falls through at both ends", () => {
    const rows = promptRows(para, para.length, W).length;
    let state = s(para, 2);
    let goal: number | undefined;
    const seen = [drawn(state, W).row];
    for (;;) {
      const m = cursorDown(state, W, goal);
      if (!m) break;
      ({ state, goal } = m);
      seen.push(drawn(state, W).row);
    }
    expect(seen).toEqual(Array.from({ length: rows }, (_, i) => i));
    for (let i = rows - 1; i > 0; i--) {
      const m = cursorUp(state, W, goal)!;
      ({ state, goal } = m);
      expect(drawn(state, W).row).toBe(i - 1);
    }
    expect(cursorUp(state, W, goal)).toBeUndefined();
  });

  it("the column is preserved between wrapped rows", () => {
    const at = s(para, 2); // "aa|aa", col 2
    const m = cursorDown(at, W)!;
    expect(drawn(m.state, W).col).toBe(2);
  });

  it("crosses from a wrapped line's last row into the next logical line", () => {
    const text = `${para}\nxyz`;
    const lastRow = promptRows(para, para.length, W).length - 1;
    const onLast = s(text, para.length - 2);
    expect(drawn(onLast, W).row).toBe(lastRow);
    const m = cursorDown(onLast, W)!;
    expect(drawn(m.state, W).row).toBe(lastRow + 1);
    // ↑ from the next line lands on the wrapped line's LAST row, not its first.
    const back = cursorUp(m.state, W, m.goal)!;
    expect(drawn(back.state, W).row).toBe(lastRow);
  });
});

describe("multi-byte graphemes", () => {
  it("an emoji is one cursor step but two columns", () => {
    // col 4 on line 2; line 1 "🎉🎉🎉" has caret slots at cols 0,2,4,6.
    const m = cursorUp(s("🎉🎉🎉\nabcd", 4 + 4), 40);
    expect(m?.state.cursor).toBe(2); // after two emoji = col 4
  });

  it("an odd goal column never lands inside a wide glyph", () => {
    const m = cursorUp(s("🎉🎉🎉\nabc", 4 + 3), 40); // col 3
    // Rightmost slot not past col 3 is col 2 = cursor 1.
    expect(m?.state.cursor).toBe(1);
  });

  it("combining sequences and ZWJ emoji count as one grapheme", () => {
    const family = "👨‍👩‍👧"; // one grapheme, several code points
    const text = `${family}x\nabcd`;
    const m = cursorUp(s(text, 3 + 4), 40); // end of "abcd" ("\n" is a grapheme too), col 4
    // family is 2 cols; slots at cols 0, 2, 3 → col 3 = after "x" = cursor 2.
    expect(m?.state.cursor).toBe(2);
    const down = cursorDown(m!.state, 40, m!.goal);
    expect(down?.state.cursor).toBe(3 + 4); // goal 4 restored on "abcd"
  });
});

describe("oracle: ↑↓ agree with an exhaustive search over drawn carets", () => {
  // The scan in cursorVertical stops early (a caret further along never lands
  // on an earlier row). Check that against brute force: every cursor position,
  // rendered, picked by the same rule.
  /** Every cursor position rendered once: where its caret is drawn, and how
   *  many rows the box has with the caret there. */
  function layoutAll(text: string, width: number) {
    const n = [...new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(text)].length;
    return [...Array(n + 1).keys()].map((c) => ({
      ...drawn(s(text, c), width),
      rows: promptRows(text, c, width).length,
    }));
  }

  function oracle(all: ReturnType<typeof layoutAll>, cursor: number, dir: -1 | 1): number | undefined {
    const here = all[cursor]!;
    const target = here.row + dir;
    // The edge is judged on the rows drawn NOW. (The ▌ caret can split a word
    // and change the row count, so another cursor position may well have a
    // row this one does not show — ↓ must not jump to a row you can't see.)
    if (target < 0 || target >= here.rows) return undefined;
    let best: { c: number; col: number } | undefined;
    const order = [...all.keys()].sort((a, b) => Math.abs(a - cursor) - Math.abs(b - cursor) || a - b);
    for (const c of order) {
      const d = all[c]!;
      if (d.row !== target) continue;
      const better =
        !best ||
        (d.col <= here.col && (best.col > here.col || d.col > best.col)) ||
        (d.col > here.col && best.col > here.col && d.col < best.col);
      if (better) best = { c, col: d.col };
    }
    return best?.c;
  }

  /** Assert ↑↓ from every cursor position; false = skipped (box would window). */
  function checkAll(text: string, width: number): boolean {
    const all = layoutAll(text, width);
    // `drawn` reads the WINDOWED rows; fewer rows than the cap at every
    // cursor position means nothing is ever cut, so the oracle is sound.
    if (all.some((d) => d.rows >= MAX_PROMPT_ROWS)) return false;
    for (let c = 0; c < all.length; c++) {
      for (const dir of [-1, 1] as const) {
        const got = (dir < 0 ? cursorUp : cursorDown)(s(text, c), width)?.state.cursor;
        expect({ text, width, c, dir, got }).toEqual({ text, width, c, dir, got: oracle(all, c, dir) });
      }
    }
    return true;
  }

  const samples = [
    "aaaa bbbb cccc dddd eeee",
    "x\n\nlonger line that wraps\nend",
    "🎉🎉 wide 🎉 glyphs 🎉🎉🎉 wrap too",
    "supercalifragilisticexpialidocious word",
    "a  b   c    d     e      f",
  ];
  for (const text of samples) {
    for (const width of [14, 17, 23]) {
      it(`${JSON.stringify(text)} @${width}`, () => {
        expect(checkAll(text, width)).toBe(true);
      });
    }
  }

  it("seeded random texts: words, runs of spaces, long words, emoji, newlines", () => {
    let seed = 667;
    const rnd = (n: number) => {
      seed = (seed * 1103515245 + 12345) % 2147483648;
      return seed % n;
    };
    const atoms = ["a", "bb", "ccc", "dddd", "supercalifragilistic", "🎉", "é", "👨‍👩‍👧", " ", "  ", "   ", "\n"];
    let checked = 0;
    for (let t = 0; t < 300; t++) {
      const width = 9 + rnd(14);
      let text = "";
      const parts = 1 + rnd(12);
      for (let p = 0; p < parts; p++) text += atoms[rnd(atoms.length)];
      if (!checkAll(text, width)) continue;
      checked++;
    }
    expect(checked).toBeGreaterThan(150);
  });
});
