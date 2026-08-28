/**
 * Which part of a conversation fits on screen.
 *
 * A full-screen app has a FIXED height, so the transcript has to be clipped
 * before it is handed to the layout engine. Letting Yoga overflow instead is
 * what tears a frame: the content grows past the window, the border is pushed
 * off the bottom, and the terminal scrolls the alternate screen — which is
 * precisely the deformation this rewrite exists to remove.
 *
 * Clipping keeps the NEWEST messages: a chat scrolled to the bottom is the
 * only sane default, since the thing you are waiting for is the reply being
 * written right now.
 *
 * This module is deliberately pure and free of React and of `process.stdout`.
 * The root measures the window (see `terminal.ts`) and passes the numbers in;
 * nothing here reaches for them. It is also the ONLY place a column count is
 * used for arithmetic, and it uses it to count rows, never to draw anything —
 * borders still come from `borderStyle`, so no glyph width can shear them.
 */

import type { ChatMessage } from "./chatSession.ts";

/** Rows one message occupies: a header, its tool lines, its wrapped body. */
export function messageHeight(
  message: ChatMessage,
  columns: number,
  options: { showTools?: boolean } = {},
): number {
  const width = Math.max(20, columns - 6);
  const body = message.error ?? message.text ?? "";
  const bodyRows = body
    .split("\n")
    .reduce((rows, line) => rows + Math.max(1, Math.ceil(line.length / width)), 0);
  // Collapsed, a message's tool calls are ONE summary row — not one row each.
  // Counting them per-call while the screen draws a single line made the
  // clipper reserve space that was never used, so a thread with tool calls
  // scrolled itself off the top early. Must stay in step with `Message` in
  // screens/Chat.tsx.
  const tools = message.tools ?? [];
  const toolRows = options.showTools
    ? tools.reduce((rows, tool) => rows + Math.max(1, tool.title.split("\n").length), 0)
    : tools.length > 0
      ? 1
      : 0;
  // header + tools + body + the blank line between messages
  return 1 + toolRows + Math.max(1, bodyRows) + 1;
}

/**
 * The tail of the transcript that fits in `rows`.
 *
 * Always returns at least one message when there is one, even if that message
 * is taller than the window: showing a truncated latest reply beats showing
 * nothing at all while a long answer streams in.
 */
export function visibleMessages(
  messages: readonly ChatMessage[],
  rows: number,
  columns: number,
  options: { showTools?: boolean } = {},
): ChatMessage[] {
  if (messages.length === 0) return [];
  const out: ChatMessage[] = [];
  let used = 0;
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i]!;
    const height = messageHeight(message, columns, options);
    if (out.length > 0 && used + height > rows) break;
    out.unshift(message);
    used += height;
  }
  return out;
}
