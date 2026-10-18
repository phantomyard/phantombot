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
 *     box. Here we do the wrapping OURSELF, with the same grapheme-safe
 *     primitives the transcript uses (`markdown.ts`), so what is measured is
 *     what is drawn — and the caret is part of the wrap stream, so it can
 *     never overflow a row either.
 *
 * Rows come back pre-wrapped and capped (`MAX_PROMPT_ROWS`), with the window
 * following the cursor: a long paste grows the box to the cap, not the screen.
 */

import {
  textWidth,
  wrapSpans,
  type Span,
} from "./markdown.ts";

/** The caret glyph. Width 1 by `string-width`, so it wraps like a character. */
const CARET = "▌";
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

/** Move the cursor one grapheme left. Clamps at the start. */
export function cursorLeft(state: PromptState): PromptState {
  return clamp({ ...state, cursor: state.cursor - 1 });
}

/** Move the cursor one grapheme right. Clamps at the end. */
export function cursorRight(state: PromptState): PromptState {
  return clamp({ ...state, cursor: state.cursor + 1 });
}

/** Cursor to the start of the text (^a). */
export function cursorHome(state: PromptState): PromptState {
  return { ...state, cursor: 0 };
}

/** Cursor to the end of the text (^e). */
export function cursorEnd(state: PromptState): PromptState {
  return { ...state, cursor: graphemeCount(state.text) };
}

/** One drawn segment of a prompt row. */
export interface PromptSeg {
  text: string;
  /** The caret cell. */
  caret?: boolean;
  tone?: Span["tone"];
}

/** Spans for one logical line: runs of whitespace / non-whitespace, with the
 *  caret span dropped in at grapheme offset `caret` (-1 = no caret). */
function buildLine(line: string, caret: number): { spans: Span[]; caretAt: number } {
  const lgs = graphemes(line);
  const spans: Span[] = [];
  let caretAt = -1;
  let run = "";
  let runSpace = false;
  const flush = () => {
    if (run) spans.push({ text: run });
    run = "";
  };
  for (let i = 0; i <= lgs.length; i++) {
    if (i === caret) {
      flush();
      caretAt = spans.length;
    }
    if (i === lgs.length) break;
    const g = lgs[i]!;
    const isSpace = /\s/.test(g);
    if (run && isSpace !== runSpace) flush();
    runSpace = isSpace;
    run += g;
  }
  flush();
  return { spans, caretAt };
}

/**
 * One logical line wrapped to `budget` columns, WITHOUT the prefix/indent.
 *
 * This is the single wrap both the renderer and vertical cursor movement use,
 * so ↑↓ land on the rows exactly as drawn. Each logical line wraps on its own:
 * the caret only ever shifts the layout of the line it sits in.
 */
function wrapLine(line: string, caret: number, budget: number): PromptSeg[][] {
  const { spans, caretAt } = buildLine(line, caret);
  const withCaret: Span[] =
    caretAt >= 0
      ? [...spans.slice(0, caretAt), { text: CARET, tone: "accent" }, ...spans.slice(caretAt)]
      : spans;
  // wrapSpans rebuilds spans and drops unknown props, so the caret is
  // recognised by glyph + tone rather than a carried flag. A user-typed ▌
  // would at worst confuse the windowing row-detection — cosmetic.
  return wrapSpans(withCaret, budget).map((row) =>
    row.map((span) =>
      span.text === CARET && span.tone === "accent" ? { text: span.text, caret: true } : span,
    ),
  );
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
 * The rows to draw for the input box, pre-wrapped to `width` columns.
 *
 * The prefix sits on the first row only; continuation rows align under the
 * text. The caret is part of the wrap stream, so a row never overflows —
 * when the cursor sits past a full row's end, the caret opens the next row.
 * More rows than `MAX_PROMPT_ROWS` are windowed so the row holding the caret
 * (or, when idle, the last row) stays visible.
 */
export function promptRows(
  text: string,
  cursor: number,
  width: number,
  opts: { busy?: boolean } = {},
): PromptSeg[][] {
  const count = graphemeCount(text);
  const cur = Math.max(0, Math.min(cursor, count));
  const gs = graphemes(text);
  const rows: PromptSeg[][] = [];

  // Walk the text one logical line at a time; the caret offset is per line.
  logicalLines(gs).forEach(({ start, end }, index) => {
    const line = gs.slice(start, end).join("");
    const caretInLine = !opts.busy && cur >= start && cur <= end ? cur - start : -1;
    for (const row of wrapLine(line, caretInLine, lineBudget(width, index))) {
      // Only the FIRST row overall carries the prefix; later rows indent.
      const lead: PromptSeg =
        rows.length === 0 ? { text: PREFIX, tone: "accent" } : { text: CONTINUATION_INDENT };
      rows.push([lead, ...row]);
    }
  });

  // A busy box with empty input still draws one row — the box never collapses
  // to a bare border pair.
  if (rows.length === 0) rows.push([{ text: PREFIX, tone: "accent" }]);

  // Cap: window so the caret's row (or the last row) stays visible.
  if (rows.length > MAX_PROMPT_ROWS) {
    let caretRow = rows.length - 1;
    if (!opts.busy) {
      outer: for (let r = 0; r < rows.length; r++) {
        for (const seg of rows[r]!) {
          if (seg.caret) {
            caretRow = r;
            break outer;
          }
        }
      }
    }
    const start = Math.max(0, Math.min(caretRow - (MAX_PROMPT_ROWS - 1), rows.length - MAX_PROMPT_ROWS));
    return rows.slice(start, start + MAX_PROMPT_ROWS);
  }
  return rows;
}

/**
 * Caret positions within ONE logical line, computed cheaply.
 *
 * Placing the caret and re-wrapping the whole line per candidate is exact but
 * O(line) each — a pasted paragraph made every ↑↓ cost half a second. The
 * wrap is GREEDY, so everything before the caret lays out the same wherever
 * the caret goes, as long as no word before it is cut short: a row of the
 * caret-less layout that starts strictly before the caret's own word starts
 * the same row with the caret in place. So each candidate is wrapped only
 * from the nearest such row start — a couple of rows of work, not the line.
 */
class LineCarets {
  private readonly gs: string[];
  /** Grapheme offset where each row of the caret-less layout starts. */
  private readonly starts: number[];

  constructor(
    line: string,
    private readonly budget: number,
  ) {
    this.gs = graphemes(line);
    this.starts = rowStarts(this.gs, wrapLine(line, -1, budget));
  }

  get length(): number {
    return this.gs.length;
  }

  /** Visual row (within the line) and display column of a caret at `offset`. */
  spot(offset: number): { row: number; col: number } {
    const k = this.restartFor(offset);
    const from = k < 0 ? 0 : this.starts[k]!;
    const head = this.gs.slice(from, offset).join("");
    const rows = wrapLine(head, offset - from, this.budget);
    const last = rows.length - 1;
    let col = 0;
    for (const seg of rows[last]!) {
      if (seg.caret) break;
      col += textWidth(seg.text);
    }
    // The caret is the last thing laid out, so it sits on the last row.
    return { row: Math.max(0, k) + last, col };
  }

  /** Total visual rows of the line with the caret at `offset`. */
  rowCount(offset: number): number {
    const k = this.restartFor(offset);
    const from = k < 0 ? 0 : this.starts[k]!;
    const rest = this.gs.slice(from).join("");
    return Math.max(0, k) + wrapLine(rest, offset - from, this.budget).length;
  }

  /** Index of the latest caret-less row start safely before `offset`'s word. */
  private restartFor(offset: number): number {
    let word = offset;
    while (word > 0 && !/\s/.test(this.gs[word - 1]!)) word--;
    let k = -1;
    for (let i = 1; i < this.starts.length && this.starts[i]! < word; i++) k = i;
    return k;
  }
}

/**
 * Recover where each wrapped row starts in the line. `wrapSpans` drops the
 * whitespace at a break (and never starts a row with it) but keeps a row's
 * interior verbatim, so each row is the next run of graphemes after skipping
 * whitespace. Row 0 always starts at 0. Should a row ever not match — a wrap
 * rule this does not model — only row 0 is returned, which is still exact,
 * just slower.
 */
function rowStarts(gs: readonly string[], rows: PromptSeg[][]): number[] {
  const starts = [0];
  let at = 0;
  for (let r = 0; r < rows.length; r++) {
    while (at < gs.length && /\s/.test(gs[at]!)) at++;
    if (r > 0) starts.push(at);
    const text = graphemes(rows[r]!.map((seg) => seg.text).join(""));
    for (const g of text) {
      if (gs[at] !== g) return [0];
      at++;
    }
  }
  return starts;
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
  const { start } = lines[li]!;
  const lineText = (i: number) => gs.slice(lines[i]!.start, lines[i]!.end).join("");

  const curLine = new LineCarets(lineText(li), lineBudget(width, li));
  const here = curLine.spot(cur - start);
  const want = goal ?? here.col;

  // Which logical line holds the target row, and which row of it.
  let ti: number;
  let targetRow: number | "last";
  if (dir < 0) {
    if (here.row > 0) [ti, targetRow] = [li, here.row - 1];
    else if (li > 0) [ti, targetRow] = [li - 1, "last"];
    else return undefined;
  } else {
    if (here.row < curLine.rowCount(cur - start) - 1) [ti, targetRow] = [li, here.row + 1];
    else if (li < lines.length - 1) [ti, targetRow] = [li + 1, 0];
    else return undefined;
  }

  // Scan caret positions outward from where we are (nearest first), placing
  // the caret at each so its OWN width shifts the wrap exactly as it will be
  // drawn. A caret further along never lands on an earlier row, so the scan
  // stops as soon as it has passed the target row.
  const line = ti === li ? curLine : new LineCarets(lineText(ti), lineBudget(width, ti));
  const len = line.length;
  const from = ti === li ? cur - start + dir : dir < 0 ? len : 0;
  if (targetRow === "last") targetRow = line.spot(len).row;

  let best: { offset: number; col: number } | undefined;
  for (let o = from; o >= 0 && o <= len; o += dir) {
    const spot = line.spot(o);
    if (dir < 0 ? spot.row < targetRow : spot.row > targetRow) break;
    if (spot.row !== targetRow) continue;
    // Prefer the rightmost column not past the goal; if the whole row starts
    // past it (a wide glyph), the leftmost. Ties keep the nearest offset.
    const better =
      !best ||
      (spot.col <= want && (best.col > want || spot.col > best.col)) ||
      (spot.col > want && best.col > want && spot.col < best.col);
    if (better) best = { offset: o, col: spot.col };
  }
  if (!best) return undefined; // defensive: a target row always has a caret slot

  return { state: { text: state.text, cursor: lines[ti]!.start + best.offset }, goal: want };
}

/** One visual row up (↑). `undefined` = already on the first row. */
export function cursorUp(state: PromptState, width: number, goal?: number): VerticalMove | undefined {
  return cursorVertical(state, width, -1, goal);
}

/** One visual row down (↓). `undefined` = already on the last row. */
export function cursorDown(state: PromptState, width: number, goal?: number): VerticalMove | undefined {
  return cursorVertical(state, width, 1, goal);
}
