/**
 * The conversation, as ROWS.
 *
 * A full-screen app has a fixed height, so the transcript has to be clipped
 * before it is handed to the layout engine: letting Yoga overflow is what
 * tears a frame (the border is pushed off the bottom and the alternate screen
 * scrolls). This module decides which rows are on screen.
 *
 * It used to clip whole MESSAGES and separately GUESS how many rows each one
 * would occupy — two descriptions of the same thing, which drifted apart every
 * time the screen changed (the `^t` removal broke it once already). Now there
 * is one description: every message is flattened into typed lines here, the
 * screen draws exactly those lines, and a row of scroll is a row of this
 * array. Measurement and rendering cannot disagree, and a message taller than
 * the window can be scrolled THROUGH rather than being all-or-nothing.
 *
 * Deliberately pure: no React, no `process.stdout`. The root measures the
 * window (`terminal.ts`) and passes the numbers in. Columns are used to count
 * rows, never to draw — borders still come from `borderStyle`, so no glyph
 * width can shear them.
 */

import type { ChatMessage } from "./chatSession.ts";
import { graphemes, markdownLines, sliceToWidth, textWidth, type Span } from "./markdown.ts";

export type TranscriptLine =
  | { kind: "header"; role: "user" | "assistant"; name: string; time: string }
  /**
   * A tool call: `\u203a <title>` on the left, its duration flushed right.
   * The title is PRE-FITTED to the drawable width here (phantombot#556) —
   * see `fitToolTitle`, and the renderer truncates as a backstop.
   */
  | { kind: "tool"; title: string; duration: string }
  | { kind: "text"; text: string; error: boolean }
  /**
   * A rendered markdown row (phantombot#481): styled runs plus a left indent.
   * Still ONE row — the renderer is width-aware and wraps or truncates itself,
   * so measurement and drawing stay the same list they were before.
   */
  | { kind: "rich"; spans: Span[]; indent: number }
  | { kind: "gap" };

/** `14:07`, or nothing at all — history from the store carries no timestamp. */
function timeOf(at: number): string {
  if (!at) return "";
  const d = new Date(at);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

const ELLIPSIS = "\u2026";

/**
 * A tool title cut to what the row can actually DRAW (phantombot#556).
 *
 * Every other row kind is fitted to `width` before it is counted; tool rows
 * used to be pushed through raw, so a title longer than the window measured
 * one row and drew two. The uncounted rows push the frame past the bottom of
 * the window, Yoga shrinks the children to compensate, and the transcript's
 * last rows overwrite each other — and Ink's cursor-up repaint math is left
 * out by that many rows, which is what leaves a prompt strip with no caret and
 * a TUI that looks frozen until it is restarted. Tool notes are capped at 160
 * columns (`MAX_TOOL_NOTE_LEN`), so every terminal under ~166 columns hit it.
 *
 * The row draws `\u203a ` then the title, then the duration flushed right, all
 * inside `width` (the same content width the text rows wrap to), so the title
 * is charged for both of those. Truncated rather than wrapped: a tool call is
 * a one-line note, and a second row of it would push the reply itself off the
 * screen.
 */
function fitToolTitle(title: string, duration: string, width: number): string {
  const budget = width - 2 - textWidth(duration);
  if (budget <= 0) return "";
  if (textWidth(title) <= budget) return title;
  // The ellipsis costs a column of its own, so the content budget is short.
  return `${sliceToWidth(title, budget - 1)}${ELLIPSIS}`;
}

/**
 * Hard-wrap one logical line to `width` COLUMNS, keeping at least one row.
 *
 * Measured in terminal columns and cut between grapheme clusters, for the
 * same reason tool titles are (phantombot#556): `String.length` counts a CJK
 * ideograph or an emoji as one unit where the terminal draws two, so a line
 * of wide glyphs measured one row here and drew two on screen. Those extra
 * rows are not in the count the window is clipped to, which pushes the frame
 * past the bottom of the terminal — the transcript's last rows overwrite each
 * other and Ink's repaint math is left out by that many rows, leaving a
 * caretless prompt strip that looks frozen until phantombot is restarted.
 * Slicing on code units had a second failure of its own: it could cut a
 * surrogate pair or a base+combining-mark in half and emit mojibake.
 *
 * This is the raw-text path (what the user typed, and error text), so it
 * wraps rather than truncating: nothing may be dropped from either. A single
 * grapheme wider than `width` gets a row to itself and overhangs — there is
 * nowhere narrower to put it, and dropping it would be worse.
 */
function wrap(text: string, width: number): string[] {
  const out: string[] = [];
  for (const line of text.split("\n")) {
    if (textWidth(line) <= width) {
      out.push(line);
      continue;
    }
    let row = "";
    let used = 0;
    for (const g of graphemes(line)) {
      const w = textWidth(g);
      // `row !== ""` keeps a too-wide grapheme on a row of its own instead of
      // looping forever on a cut that can never fit.
      if (used + w > width && row !== "") {
        out.push(row);
        row = "";
        used = 0;
      }
      row += g;
      used += w;
    }
    if (row !== "") out.push(row);
  }
  return out.length === 0 ? [""] : out;
}

export interface TranscriptOptions {
  /** Name shown on the assistant's header row. */
  personaName: string;
  /** Formats a tool's duration; `undefined` while the call is still running. */
  formatDuration: (ms: number | undefined) => string;
}

/** Every row of the conversation, oldest first. */
export function transcriptLines(
  messages: readonly ChatMessage[],
  columns: number,
  options: TranscriptOptions,
): TranscriptLine[] {
  const width = Math.max(20, columns - 6);
  const lines: TranscriptLine[] = [];
  for (const message of messages) {
    const isUser = message.role === "user";
    lines.push({
      kind: "header",
      role: isUser ? "user" : "assistant",
      name: isUser ? "you" : options.personaName,
      time: timeOf(message.at),
    });
    if (message.error !== undefined) {
      // An error is not markdown and must not be reinterpreted as any: a
      // stack trace full of `*` would come out italicised and half-eaten.
      for (const row of wrap(message.error, width)) {
        lines.push({ kind: "text", text: row, error: true });
      }
    } else if (isUser) {
      // What the user typed is shown back verbatim. Rendering their own
      // markdown would make the line they sent differ from the line they see,
      // and `**` in their message is usually them talking ABOUT markdown.
      for (const row of wrap(message.text ?? "", width)) {
        lines.push({ kind: "text", text: row, error: false });
      }
    } else if ((message.parts?.length ?? 0) > 0) {
      // The ordered timeline: narration text runs and tool calls in the order
      // they happened. A gap row between two consecutive text runs keeps
      // separate narration sentences from jamming into one block; a tool row
      // between two runs already separates them on its own.
      let prevWasText = false;
      for (const part of message.parts!) {
        if (part.kind === "tool") {
          const duration = options.formatDuration(part.durationMs);
          for (const title of part.title.split("\n")) {
            lines.push({
              kind: "tool",
              title: fitToolTitle(title, duration, width),
              duration,
            });
          }
          prevWasText = false;
        } else {
          if (prevWasText) lines.push({ kind: "gap" });
          for (const row of markdownLines(part.text, width)) {
            lines.push({ kind: "rich", spans: row.spans, indent: row.indent });
          }
          prevWasText = true;
        }
      }
    } else {
      // Legacy shape (history replayed from the store): tools above the body.
      for (const tool of message.tools ?? []) {
        const duration = options.formatDuration(tool.durationMs);
        for (const title of tool.title.split("\n")) {
          lines.push({
            kind: "tool",
            title: fitToolTitle(title, duration, width),
            duration,
          });
        }
      }
      for (const row of markdownLines(message.text ?? "", width)) {
        lines.push({ kind: "rich", spans: row.spans, indent: row.indent });
      }
    }
    lines.push({ kind: "gap" });
  }
  return lines;
}

export interface TranscriptWindow {
  lines: TranscriptLine[];
  /** Rows hidden above and below what is drawn. */
  above: number;
  below: number;
  /** The offset actually used, after clamping. */
  offset: number;
  /** The largest offset that still shows content — how far up you can go. */
  maxOffset: number;
}

/**
 * The `rows` of transcript on screen, `offset` rows up from the bottom.
 *
 * Offset 0 is the live bottom of the conversation, which is the only sane
 * default: the thing you are waiting for is the reply being written right now.
 * Scrolling past the top is clamped rather than wrapped or blanked — an empty
 * window would look exactly like a crash.
 */
export function transcriptWindow(
  lines: readonly TranscriptLine[],
  rows: number,
  offset: number,
): TranscriptWindow {
  const height = Math.max(1, rows);
  const maxOffset = Math.max(0, lines.length - height);
  const at = Math.min(Math.max(Math.round(offset), 0), maxOffset);
  const end = lines.length - at;
  const start = Math.max(0, end - height);
  return {
    lines: lines.slice(start, end),
    above: start,
    below: lines.length - end,
    offset: at,
    maxOffset,
  };
}
