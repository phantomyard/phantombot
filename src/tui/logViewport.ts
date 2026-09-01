/**
 * Which slice of a log stream is on screen, and how far it is from the tail.
 *
 * The System log pane used to render `filtered.slice(-rows)` — the newest
 * screenful and nothing else. After #478 the pane reads real sinks (a 5000
 * line ring, 2000 line file reads, whole task histories), so "newest
 * screenful only" quietly made almost everything it had just read
 * unreachable: the lines existed, the pane could not show them.
 *
 * This module is the missing viewport. It is anchored to the TAIL rather than
 * to a cursor, because that is how a log reader behaves: you sit at the
 * bottom watching new lines land, you scroll UP to read history, and you
 * expect a way back to live. `offset` is therefore "lines above the tail",
 * with 0 meaning "following".
 *
 * `scroll.ts` solves a different problem — a cursor moving through
 * variable-height blocks — so it is not reused here; every log row is one
 * line and there is no selection to keep visible.
 *
 * Deliberately pure: no React, no terminal. The caller measures the window
 * and passes the row budget in.
 */

export interface LogViewport {
  /** First line index to render, inclusive. */
  start: number;
  /** Last line index to render, exclusive. */
  end: number;
  /** Lines hidden above and below the window, for the scroll markers. */
  above: number;
  below: number;
  /** True when the window is pinned to the newest line. */
  following: boolean;
  /** `offset` clamped to what this many lines can actually offer. */
  offset: number;
}

/**
 * The window of `rows` lines sitting `offset` lines above the tail.
 *
 * The offset is clamped rather than rejected, so a viewport survives the
 * stream SHRINKING underneath it (a reload returning fewer lines, a filter
 * being tightened): the pane slides back toward the tail instead of showing
 * an empty window with a stale scroll position.
 */
export function tailViewport(
  total: number,
  rows: number,
  offset: number,
): LogViewport {
  const height = Math.max(1, Math.floor(rows));
  const count = Math.max(0, Math.floor(total));
  if (count === 0)
    return { start: 0, end: 0, above: 0, below: 0, following: true, offset: 0 };
  const clamped = clampOffset(offset, count, height);
  const end = count - clamped;
  const start = Math.max(0, end - height);
  return {
    start,
    end,
    above: start,
    below: count - end,
    following: clamped === 0,
    offset: clamped,
  };
}

/** The largest offset that still leaves the oldest line on screen. */
export function maxOffset(total: number, rows: number): number {
  return Math.max(0, Math.floor(total) - Math.max(1, Math.floor(rows)));
}

function clampOffset(offset: number, total: number, rows: number): number {
  if (!Number.isFinite(offset)) return 0;
  return Math.min(Math.max(Math.floor(offset), 0), maxOffset(total, rows));
}

/**
 * Move the viewport by `delta` lines (positive = back in time), clamped.
 *
 * Clamping HERE, not only at render time, is what keeps the keyboard honest:
 * if holding the up arrow past the oldest line inflated the offset, it would
 * then take exactly as many down presses to get back to live, and the pane
 * would look frozen while the user pressed a key that plainly does something.
 */
export function nudgeOffset(
  current: number,
  delta: number,
  total: number,
  rows: number,
): number {
  return clampOffset(current + delta, total, rows);
}
