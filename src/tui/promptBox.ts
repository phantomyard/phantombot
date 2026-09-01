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

  /** Spans for one logical line: runs of whitespace / non-whitespace, with
   *  the caret span dropped in at grapheme offset `caret` (-1 = no caret). */
  const buildLine = (line: string, caret: number): { spans: Span[]; caretAt: number } => {
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
  };

  const flushRow = (lineSpans: Span[], lineCursor: number) => {
    const budget = Math.max(1, width - textWidth(rows.length === 0 ? PREFIX : CONTINUATION_INDENT));
    const withCaret: Span[] =
      lineCursor >= 0
        ? [...lineSpans.slice(0, lineCursor), { text: CARET, tone: "accent" }, ...lineSpans.slice(lineCursor)]
        : lineSpans;
    for (const row of wrapSpans(withCaret, budget)) {
      const segs: PromptSeg[] = [];
      // Only the FIRST row overall carries the prefix; later rows indent.
      if (rows.length === 0) segs.push({ text: PREFIX, tone: "accent" });
      else segs.push({ text: CONTINUATION_INDENT });
      for (const span of row) {
        // wrapSpans rebuilds spans and drops unknown props, so the caret is
        // recognised by glyph + tone rather than a carried flag. A user-typed
        // ▌ would at worst confuse the windowing row-detection — cosmetic.
        segs.push(span.text === CARET && span.tone === "accent" ? { text: span.text, caret: true } : span);
      }
      rows.push(segs);
    }
  };

  // Walk the text one logical line at a time; the caret offset is per line.
  let lineStart = 0;
  for (let i = 0; i <= gs.length; i++) {
    const atEnd = i === gs.length;
    if (atEnd || gs[i] === "\n") {
      const line = gs.slice(lineStart, i).join("");
      const caretInLine = !opts.busy && cur >= lineStart && cur <= i ? cur - lineStart : -1;
      const { spans, caretAt } = buildLine(line, caretInLine);
      flushRow(spans, caretAt);
      lineStart = i + 1;
    }
  }

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
