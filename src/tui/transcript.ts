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
import { markdownLines, type Span } from "./markdown.ts";

export type TranscriptLine =
  | { kind: "header"; role: "user" | "assistant"; name: string; time: string }
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

/** Hard-wrap one logical line to `width`, keeping at least one row. */
function wrap(text: string, width: number): string[] {
  const out: string[] = [];
  for (const line of text.split("\n")) {
    if (line.length <= width) {
      out.push(line);
      continue;
    }
    for (let i = 0; i < line.length; i += width) out.push(line.slice(i, i + width));
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
    for (const tool of message.tools ?? []) {
      for (const title of tool.title.split("\n")) {
        lines.push({
          kind: "tool",
          title,
          duration: options.formatDuration(tool.durationMs),
        });
      }
    }
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
    } else {
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
