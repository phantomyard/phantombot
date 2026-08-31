/**
 * A tall screen must render fewer blocks, not smaller ones (issue #471).
 *
 * The bug this pins: the settings screen drew every section unconditionally,
 * so in a 20-row window Yoga compressed the rows and printed two of them on
 * the same line — and the frame's bottom border came out as
 * `╰─ ─ ─✚─Doctor────`. Clipping the frame body stopped the border tearing;
 * only windowing stops the rows colliding.
 */

import { describe, expect, test } from "bun:test";

import { scrollWindow } from "../src/tui/scroll.ts";

describe("scrollWindow", () => {
  test("everything fits when the window is big enough", () => {
    const w = scrollWindow([2, 2, 2], 100, 0);
    expect(w).toEqual({ start: 0, end: 3, above: 0, below: 0 });
  });

  test("drops blocks rather than shrinking them", () => {
    // Ten 3-row blocks in a 10-row window: at most three can be shown.
    const heights = Array.from({ length: 10 }, () => 3);
    const w = scrollWindow(heights, 10, 0);
    const shown = w.end - w.start;
    expect(shown).toBeLessThanOrEqual(3);
    const used = heights
      .slice(w.start, w.end)
      .reduce((sum, h) => sum + h, 0);
    expect(used).toBeLessThanOrEqual(10);
  });

  test("the cursor is always inside the window", () => {
    const heights = Array.from({ length: 20 }, (_, i) => (i % 3) + 1);
    for (let cursor = 0; cursor < heights.length; cursor++) {
      const w = scrollWindow(heights, 8, cursor);
      expect(cursor).toBeGreaterThanOrEqual(w.start);
      expect(cursor).toBeLessThan(w.end);
    }
  });

  test("counts what it hid, so the screen can say so", () => {
    const heights = Array.from({ length: 10 }, () => 4);
    const w = scrollWindow(heights, 8, 5);
    expect(w.above).toBe(w.start);
    expect(w.below).toBe(10 - w.end);
    expect(w.above + w.below).toBeGreaterThan(0);
  });

  test("a block taller than the window is still shown", () => {
    const w = scrollWindow([2, 50, 2], 10, 1);
    expect(w.start).toBe(1);
    expect(w.end).toBe(2);
  });

  test("an empty list is not a crash", () => {
    expect(scrollWindow([], 10, 0)).toEqual({
      start: 0,
      end: 0,
      above: 0,
      below: 0,
    });
  });
});
