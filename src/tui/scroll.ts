/**
 * Which blocks of a tall screen fit in the window.
 *
 * The transcript learned this the hard way (`transcript.ts`); the settings
 * screens need it too. A screen whose content is taller than the window does
 * NOT simply get cut off by the layout engine: Yoga shrinks the children to
 * make them fit, so rows overwrite each other — the memory block came out as
 * `indexedngs   12,904 / 12,904  ✓ in sync001 · 1536`, two rows printed on
 * top of one another — and, without a clip on the frame body, the bottom
 * border is drawn through as well.
 *
 * So a screen taller than its window has to render FEWER BLOCKS, not smaller
 * ones. This module decides which.
 *
 * Deliberately pure: no React, no `process.stdout`. The root measures the
 * window (`terminal.ts`) and the caller passes the row budget in — the border
 * rule holds, nothing here draws anything.
 */

export interface ScrollWindow {
  /** First block index to render, inclusive. */
  start: number;
  /** Last block index to render, exclusive. */
  end: number;
  /** Blocks hidden above and below, for the "▲ 3 more" markers. */
  above: number;
  below: number;
}

/**
 * The window of blocks that fits in `rows`, always containing `cursor`.
 *
 * Grows from the cursor outward — DOWNWARD first, so moving into a list from
 * the top keeps the natural reading order — and always returns at least the
 * cursor's own block even when that block is taller than the whole window. A
 * screen showing one over-tall row beats a screen showing nothing, and it is
 * the only honest answer at that size.
 */
export function scrollWindow(
  heights: readonly number[],
  rows: number,
  cursor: number,
): ScrollWindow {
  const n = heights.length;
  if (n === 0) return { start: 0, end: 0, above: 0, below: 0 };
  const at = Math.min(Math.max(cursor, 0), n - 1);
  let start = at;
  let end = at + 1;
  let used = heights[at] ?? 0;
  // Alternate outward so the cursor stays roughly where the eye expects it,
  // rather than pinned to an edge.
  let grewDown = true;
  let grewUp = true;
  while (grewDown || grewUp) {
    grewDown = false;
    grewUp = false;
    if (end < n) {
      const h = heights[end] ?? 0;
      if (used + h <= rows) {
        used += h;
        end++;
        grewDown = true;
      }
    }
    if (start > 0) {
      const h = heights[start - 1] ?? 0;
      if (used + h <= rows) {
        used += h;
        start--;
        grewUp = true;
      }
    }
  }
  return { start, end, above: start, below: n - end };
}
