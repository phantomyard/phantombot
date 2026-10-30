/**
 * The chat prompt box, as a pure module — no React, no Ink, no I/O.
 *
 * Two problems this solves, one root cause each:
 *
 *  1. **Cursor position.** The box used to hold a bare string with the caret
 *     glued to the end: typing and backspace worked, arrows did nothing.
 *     The cursor is now a grapheme index into the text, and every edit
 *     (insert, backspace, delete, left, right) is a pure function here.
 *  2. **The deformed frame.** The box used to render `{input}` as one Text
 *     node inside a bordered row next to the `› ` prefix glyph, and let Ink
 *     wrap it. Ink measures the text node WITHOUT the prefix (and the caret),
 *     while the terminal wraps what was actually drawn — the two disagree by
 *     the prefix width, and the border shears exactly when a line fills the
 *     box. Here we do the wrapping OURSELF, grapheme by grapheme with the
 *     transcript's width measure (`markdown.ts`), so what is measured is
 *     what is drawn.
 *
 * The cursor is drawn ON a cell in inverse video, never as a cell of its own
 * (issue #677), so the layout does not depend on where the cursor is: moving
 * it never shifts or re-wraps the text.
 *
 * Rows come back pre-wrapped and capped (`MAX_PROMPT_ROWS`), with the window
 * following the cursor: a long paste grows the box to the cap, not the screen.
 */

import { textWidth, type Span } from "./markdown.ts";

/** The prompt prefix, drawn on the first row only. Two columns wide. */
const PREFIX = "› ";
/** Continuation rows indent to align under the prefix. */
const CONTINUATION_INDENT = "  ";

/** The most input rows the box will show at once. The window follows the cursor. */
export const MAX_PROMPT_ROWS = 6;

/** Editable text plus the cursor, as a grapheme index (0 ≤ cursor ≤ graphemes). */
export interface PromptState {
  text: string;
  cursor: number;
}

export function promptState(text: string): PromptState {
  return { text, cursor: graphemeCount(text) };
}

const SEGMENTER = new Intl.Segmenter(undefined, { granularity: "grapheme" });

function graphemes(text: string): string[] {
  const out: string[] = [];
  for (const { segment } of SEGMENTER.segment(text)) out.push(segment);
  return out;
}

export function graphemeCount(text: string): number {
  return graphemes(text).length;
}

function clamp(state: PromptState): PromptState {
  return { text: state.text, cursor: Math.max(0, Math.min(state.cursor, graphemeCount(state.text))) };
}

/** Insert a chunk at the cursor. Newlines are CHARACTERS, never submits. */
export function insertAtCursor(state: PromptState, chunk: string): PromptState {
  if (chunk === "") return state;
  const gs = graphemes(state.text);
  const chunkGs = graphemes(chunk);
  const next = [...gs.slice(0, state.cursor), ...chunkGs, ...gs.slice(state.cursor)];
  return clamp({ text: next.join(""), cursor: state.cursor + chunkGs.length });
}

/** Delete the grapheme BEFORE the cursor (backspace). No-op at the start. */
export function backspaceAtCursor(state: PromptState): PromptState {
  if (state.cursor === 0) return state;
  const gs = graphemes(state.text);
  const next = [...gs.slice(0, state.cursor - 1), ...gs.slice(state.cursor)];
  return clamp({ text: next.join(""), cursor: state.cursor - 1 });
}

/** Delete the grapheme AT the cursor (forward delete). No-op at the end. */
export function deleteAtCursor(state: PromptState): PromptState {
  const gs = graphemes(state.text);
  if (state.cursor >= gs.length) return state;
  const next = [...gs.slice(0, state.cursor), ...gs.slice(state.cursor + 1)];
  return clamp({ text: next.join(""), cursor: state.cursor });
}

/** Move the cursor one grapheme left (← / ^b). Clamps at the start. */
export function cursorLeft(state: PromptState): PromptState {
  return clamp({ ...state, cursor: state.cursor - 1 });
}

/** Move the cursor one grapheme right (→ / ^f). Clamps at the end. */
export function cursorRight(state: PromptState): PromptState {
  return clamp({ ...state, cursor: state.cursor + 1 });
}

/** Cursor to the start of the whole text (a second ^a). */
export function cursorHome(state: PromptState): PromptState {
  return { ...state, cursor: 0 };
}

/** Cursor to the end of the whole text (a second ^e). */
export function cursorEnd(state: PromptState): PromptState {
  return { ...state, cursor: graphemeCount(state.text) };
}

/**
 * A word character, readline-style: letters, digits and their combining
 * marks. Everything else — whitespace, punctuation, "\n", emoji — separates
 * words, so word moves cross line boundaries on their own.
 */
const WORD_CHAR = /^[\p{L}\p{N}\p{M}]+$/u;
const isWord = (g: string) => WORD_CHAR.test(g);
/** Whitespace, "\n" included: what ^w deletes back to, and where wrap breaks. */
const isSpace = (g: string) => /^\s+$/.test(g);

/** Cursor to the start of the previous word (Alt-b / Alt-←), across lines. */
export function cursorWordLeft(state: PromptState): PromptState {
  const gs = graphemes(state.text);
  let i = Math.max(0, Math.min(state.cursor, gs.length));
  while (i > 0 && !isWord(gs[i - 1]!)) i--;
  while (i > 0 && isWord(gs[i - 1]!)) i--;
  return { text: state.text, cursor: i };
}

/** Cursor to the end of the next word (Alt-f / Alt-→), across lines. */
export function cursorWordRight(state: PromptState): PromptState {
  const gs = graphemes(state.text);
  let i = Math.max(0, Math.min(state.cursor, gs.length));
  while (i < gs.length && !isWord(gs[i]!)) i++;
  while (i < gs.length && isWord(gs[i]!)) i++;
  return { text: state.text, cursor: i };
}

/**
 * Cursor to the start of the current LOGICAL line (^a). Already there, it
 * goes to the start of the whole input — the old ^a, one press further.
 */
export function cursorLineStart(state: PromptState): PromptState {
  const gs = graphemes(state.text);
  const cur = Math.max(0, Math.min(state.cursor, gs.length));
  let i = cur;
  while (i > 0 && gs[i - 1] !== "\n") i--;
  return { text: state.text, cursor: i === cur ? 0 : i };
}

/**
 * Cursor to the end of the current LOGICAL line (^e). Already there, it goes
 * to the end of the whole input.
 */
export function cursorLineEnd(state: PromptState): PromptState {
  const gs = graphemes(state.text);
  const cur = Math.max(0, Math.min(state.cursor, gs.length));
  let i = cur;
  while (i < gs.length && gs[i] !== "\n") i++;
  return { text: state.text, cursor: i === cur ? gs.length : i };
}

/**
 * Delete graphemes [from, to) and leave the cursor at `from`. Nothing to
 * delete returns the state untouched.
 *
 * The word and line deletes below are a cursor move plus this (issue #725),
 * so they can never disagree with the move they mirror; only ^w has a rule
 * of its own. There is no kill ring: deleted text is gone, and nothing
 * binds ^y.
 */
function deleteRange(state: PromptState, from: number, to: number): PromptState {
  if (from >= to) return state;
  const gs = graphemes(state.text);
  return { text: [...gs.slice(0, from), ...gs.slice(to)].join(""), cursor: from };
}

/** The cursor clamped into the text. */
function cursorIn(state: PromptState): number {
  return Math.max(0, Math.min(state.cursor, graphemeCount(state.text)));
}

/** Delete back to where Alt-b lands (Alt-Backspace, readline `backward-kill-word`). */
export function deleteWordLeft(state: PromptState): PromptState {
  return deleteRange(state, cursorWordLeft(state).cursor, cursorIn(state));
}

/** Delete forward to where Alt-f lands (Alt-d, readline `kill-word`). */
export function deleteWordRight(state: PromptState): PromptState {
  return deleteRange(state, cursorIn(state), cursorWordRight(state).cursor);
}

/**
 * Delete back to the previous whitespace (^w, readline `unix-word-rubout`):
 * any spaces just before the cursor, then the run of non-space before them,
 * so a path or URL goes in one press where Alt-Backspace stops at each `/`.
 * "\n" is whitespace, so it crosses lines like the word moves do.
 */
export function deleteWhitespaceWordLeft(state: PromptState): PromptState {
  const gs = graphemes(state.text);
  const cur = Math.max(0, Math.min(state.cursor, gs.length));
  let i = cur;
  while (i > 0 && isSpace(gs[i - 1]!)) i--;
  while (i > 0 && !isSpace(gs[i - 1]!)) i--;
  return deleteRange(state, i, cur);
}

/**
 * Delete back to where ^a lands (^u, readline `unix-line-discard`): the start
 * of the current line, and — already there — everything before the cursor,
 * the same double press as ^a.
 */
export function deleteToLineStart(state: PromptState): PromptState {
  return deleteRange(state, cursorLineStart(state).cursor, cursorIn(state));
}

/** One drawn segment of a prompt row. */
export interface PromptSeg {
  text: string;
  /** The cursor cell: drawn in inverse video. */
  caret?: boolean;
  tone?: Span["tone"];
}

/** Columns available for text on the rows of logical line `index`. */
function lineBudget(width: number, index: number): number {
  return Math.max(1, width - textWidth(index === 0 ? PREFIX : CONTINUATION_INDENT));
}

/** Logical lines as grapheme ranges [start, end), split on "\n". */
function logicalLines(gs: readonly string[]): { start: number; end: number }[] {
  const lines: { start: number; end: number }[] = [];
  let start = 0;
  for (let i = 0; i <= gs.length; i++) {
    if (i === gs.length || gs[i] === "\n") {
      lines.push({ start, end: i });
      start = i + 1;
    }
  }
  return lines;
}

/**
 * One logical line laid out on rows of `budget` columns — independent of the
 * cursor, which is the whole point: the cursor is drawn ON a cell, never as a
 * cell of its own, so moving it can never shift or re-wrap the text.
 *
 * Greedy word wrap. The text gets `budget - 1` columns; the last column is
 * kept free for the cursor cell when it sits past the text (end of the line,
 * or on whitespace that hangs past the edge). Whitespace never starts a
 * wrapped row: at a break it HANGS on the row before it, undrawn beyond the
 * text columns. A word longer than a row is split between graphemes.
 *
 * `rowOf[o]` / `colOf[o]` give the row and display column of a cursor at
 * grapheme offset `o` (0 ≤ o ≤ length), so drawing and ↑↓ read the same map.
 */
interface LineLayout {
  gs: string[];
  /** Grapheme offset where each row starts. */
  starts: number[];
  rowOf: number[];
  colOf: number[];
  /** Columns for text (the cursor may use one more). */
  textCols: number;
}

function layoutLine(gs: string[], budget: number): LineLayout {
  const textCols = Math.max(1, budget - 1);
  const starts = [0];
  const rowOf: number[] = [];
  const colOf: number[] = [];
  let row = 0;
  let used = 0;
  const newRow = (at: number) => {
    row++;
    used = 0;
    starts.push(at);
  };
  let i = 0;
  while (i < gs.length) {
    if (isSpace(gs[i]!)) {
      rowOf[i] = row;
      colOf[i] = Math.min(used, textCols);
      used += textWidth(gs[i]!);
      i++;
      continue;
    }
    let j = i;
    let wordW = 0;
    while (j < gs.length && !isSpace(gs[j]!)) wordW += textWidth(gs[j++]!);
    if (used > 0 && used + wordW > textCols) newRow(i);
    for (let k = i; k < j; k++) {
      const w = textWidth(gs[k]!);
      // Hard split; a lone cluster wider than a whole row is taken anyway.
      if (used > 0 && used + w > textCols) newRow(k);
      rowOf[k] = row;
      colOf[k] = used;
      used += w;
    }
    i = j;
  }
  rowOf[gs.length] = row;
  colOf[gs.length] = Math.min(used, textCols);
  return { gs, starts, rowOf, colOf, textCols };
}

/** Offsets a cursor can take on row `r`: [first, last]. */
function rowSpan(layout: LineLayout, r: number): [number, number] {
  const first = layout.starts[r]!;
  const last = r + 1 < layout.starts.length ? layout.starts[r + 1]! - 1 : layout.gs.length;
  return [first, last];
}

/** Draw row `r` of a line; `caret` is a grapheme offset in the line, or -1. */
function drawRow(layout: LineLayout, r: number, caret: number): PromptSeg[] {
  const [first, last] = rowSpan(layout, r);
  const end = r + 1 < layout.starts.length ? last + 1 : last;
  let drawnEnd = first;
  let used = 0;
  while (drawnEnd < end) {
    const w = textWidth(layout.gs[drawnEnd]!);
    if (used > 0 && used + w > layout.textCols) break;
    used += w;
    drawnEnd++;
  }
  const text = (a: number, b: number) => layout.gs.slice(a, b).join("");
  const segs: PromptSeg[] = [];
  const push = (seg: PromptSeg) => {
    if (seg.text) segs.push(seg);
  };
  if (caret < first || caret > last) {
    push({ text: text(first, drawnEnd) });
  } else if (caret < drawnEnd) {
    // On a drawn grapheme: invert it. Whitespace (a tab, say) shows as one
    // plain cell so the cursor never changes a row's width.
    const g = layout.gs[caret]!;
    push({ text: text(first, caret) });
    segs.push({ text: isSpace(g) ? " " : g, caret: true });
    push({ text: text(caret + 1, drawnEnd) });
  } else {
    // Past the drawn text (end of line, or hanging whitespace): a solid cell
    // in the column reserved for it.
    push({ text: text(first, drawnEnd) });
    segs.push({ text: " ", caret: true });
  }
  return segs;
}

/**
 * The rows to draw for the input box, pre-wrapped to `width` columns.
 *
 * The prefix sits on the first row only; continuation rows align under the
 * text. The layout ignores the cursor; the cursor inverts the cell it sits on.
 * More rows than `MAX_PROMPT_ROWS` are windowed so the cursor's row (or, when
 * idle, the last row) stays visible.
 */
export function promptRows(
  text: string,
  cursor: number,
  width: number,
  opts: { busy?: boolean } = {},
): PromptSeg[][] {
  const gs = graphemes(text);
  const cur = Math.max(0, Math.min(cursor, gs.length));
  const rows: PromptSeg[][] = [];
  let caretRow = -1;

  logicalLines(gs).forEach(({ start, end }, index) => {
    const layout = layoutLine(gs.slice(start, end), lineBudget(width, index));
    const caret = !opts.busy && cur >= start && cur <= end ? cur - start : -1;
    for (let r = 0; r < layout.starts.length; r++) {
      if (caret >= 0 && layout.rowOf[caret] === r) caretRow = rows.length;
      // Only the FIRST row overall carries the prefix; later rows indent.
      const lead: PromptSeg =
        rows.length === 0 ? { text: PREFIX, tone: "accent" } : { text: CONTINUATION_INDENT };
      rows.push([lead, ...drawRow(layout, r, layout.rowOf[caret] === r ? caret : -1)]);
    }
  });

  if (rows.length > MAX_PROMPT_ROWS) {
    const focus = caretRow >= 0 ? caretRow : rows.length - 1;
    const start = Math.max(0, Math.min(focus - (MAX_PROMPT_ROWS - 1), rows.length - MAX_PROMPT_ROWS));
    return rows.slice(start, start + MAX_PROMPT_ROWS);
  }
  return rows;
}

/** A vertical move: the new state plus the goal column to carry into the next ↑↓. */
export interface VerticalMove {
  state: PromptState;
  /** Display column the user is aiming for; kept across short rows. */
  goal: number;
}

/**
 * Move the cursor one VISUAL row up or down — wrapped rows count, not just
 * "\n" — keeping the goal column (Emacs' goal column / `line-move-visual`).
 *
 * Returns `undefined` when the cursor is already on the first (↑) or last (↓)
 * row: that is the caller's cue to scroll the transcript instead.
 *
 * `width` is the SAME width given to `promptRows`, so the rows walked are the
 * rows drawn. `goal` is the column carried over from the previous vertical
 * move; omit it to start from the cursor's own column. Columns are display
 * columns, so an emoji counts 2 and the cursor never lands inside one.
 */
export function cursorVertical(
  state: PromptState,
  width: number,
  dir: -1 | 1,
  goal?: number,
): VerticalMove | undefined {
  const gs = graphemes(state.text);
  const cur = Math.max(0, Math.min(state.cursor, gs.length));
  const lines = logicalLines(gs);
  const li = lines.findIndex(({ start, end }) => cur >= start && cur <= end);
  const layoutOf = (i: number) =>
    layoutLine(gs.slice(lines[i]!.start, lines[i]!.end), lineBudget(width, i));

  const here = layoutOf(li);
  const off = cur - lines[li]!.start;
  const row = here.rowOf[off]!;
  const want = goal ?? here.colOf[off]!;

  let ti: number;
  let target: LineLayout;
  let targetRow: number;
  if (dir < 0) {
    if (row > 0) [ti, target, targetRow] = [li, here, row - 1];
    else if (li > 0) {
      ti = li - 1;
      target = layoutOf(ti);
      targetRow = target.starts.length - 1;
    } else return undefined;
  } else {
    if (row < here.starts.length - 1) [ti, target, targetRow] = [li, here, row + 1];
    else if (li < lines.length - 1) [ti, target, targetRow] = [li + 1, layoutOf(li + 1), 0];
    else return undefined;
  }

  // Nearest offset first (↑ walks the row right-to-left, ↓ left-to-right);
  // prefer the rightmost column not past the goal, else — the whole row
  // starts past it, a wide glyph — the leftmost. Ties keep the nearest.
  const [first, last] = rowSpan(target, targetRow);
  let best: { offset: number; col: number } | undefined;
  for (let o = dir < 0 ? last : first; o >= first && o <= last; o -= dir < 0 ? 1 : -1) {
    const col = target.colOf[o]!;
    const better =
      !best ||
      (col <= want && (best.col > want || col > best.col)) ||
      (col > want && best.col > want && col < best.col);
    if (better) best = { offset: o, col };
  }
  return { state: { text: state.text, cursor: lines[ti]!.start + best!.offset }, goal: want };
}

/** One visual row up (↑ / ^p). `undefined` = already on the first row. */
export function cursorUp(state: PromptState, width: number, goal?: number): VerticalMove | undefined {
  return cursorVertical(state, width, -1, goal);
}

/** One visual row down (↓ / ^n). `undefined` = already on the last row. */
export function cursorDown(state: PromptState, width: number, goal?: number): VerticalMove | undefined {
  return cursorVertical(state, width, 1, goal);
}
