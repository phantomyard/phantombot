/**
 * The editing core of the file editor, as a pure reducer.
 *
 * The identity files are multi-kilobyte markdown, and the external `$EDITOR`
 * handover was where the cross-platform flakiness lived — alternate-screen
 * restore, stdin races, Windows console differences. So the editor is now a
 * native Ink screen, and all of its actual behaviour lives here, in a module
 * with no React, no Ink and no I/O: text in, next state out.
 *
 * Paste shares one rule with the rest of the app (`textInput.ts`): a chunk is
 * whatever the terminal delivered — a keystroke, a bracketed paste, a batch of
 * both — and newlines inside it are CHARACTERS, never submit signals. There is
 * no submit here, so a chunk is simply inserted, newlines and all.
 */

export interface EditorBuffer {
  lines: string[];
  /** Cursor row, 0-based, always a valid index into `lines`. */
  row: number;
  /** Cursor column, 0-based, always ≤ the current line's length. */
  col: number;
  /**
   * The column the cursor is TRYING to hold when moving vertically across
   * shorter lines — the standard goal-column behaviour of every editor.
   */
  goal: number;
}

export function editorFromText(text: string): EditorBuffer {
  const lines = (text === "" ? [""] : text.split(/\r\n|\r|\n/)).map((l) =>
    l.replace(/\t/g, "  "),
  );
  return { lines, row: 0, col: 0, goal: 0 };
}

export function editorText(buf: EditorBuffer): string {
  return buf.lines.join("\n");
}

/** Build the next buffer state from the (already mutated) `lines`. */
function at(lines: string[], row: number, col: number): EditorBuffer {
  const line = lines[row] ?? "";
  const c = Math.min(col, line.length);
  return { lines, row, col: c, goal: c };
}

/**
 * A VERTICAL move: `col` follows the goal column, clamped to the line, but the
 * goal itself is kept — crossing a shorter line must not shrink it, so moving
 * back out lands where you were heading, like every real editor.
 */
function vmove(buf: EditorBuffer, row: number): EditorBuffer {
  const line = buf.lines[row] ?? "";
  return {
    lines: buf.lines,
    row,
    col: Math.min(buf.goal, line.length),
    goal: buf.goal,
  };
}

/**
 * Insert a chunk of text at the cursor — a keystroke, a paste, or anything in
 * between. Tabs become two spaces on load and on input alike: markdown does
 * not want literal tabs, and a tab character's width is whatever the terminal
 * feels like today.
 */
export function editorInsert(buf: EditorBuffer, chunk: string): EditorBuffer {
  const normalized = chunk.replace(/\r\n|\r/g, "\n").replace(/\t/g, "  ");
  if (normalized === "") return buf;
  const parts = normalized.split("\n");
  const lines = [...buf.lines];
  const before = lines[buf.row]!.slice(0, buf.col);
  const after = lines[buf.row]!.slice(buf.col);
  if (parts.length === 1) {
    lines[buf.row] = before + normalized + after;
    return at(lines, buf.row, buf.col + normalized.length);
  }
  const inserted = parts.map((p) => p);
  lines.splice(
    buf.row,
    1,
    before + inserted[0]!,
    ...inserted.slice(1, -1),
    inserted.at(-1)! + after,
  );
  return at(lines, buf.row + inserted.length - 1, inserted.at(-1)!.length);
}

export function editorInsertNewline(buf: EditorBuffer): EditorBuffer {
  return editorInsert(buf, "\n");
}

export function editorBackspace(buf: EditorBuffer): EditorBuffer {
  if (buf.row === 0 && buf.col === 0) return buf;
  const lines = [...buf.lines];
  if (buf.col === 0) {
    // Join with the previous line, landing at the seam.
    const prev = lines[buf.row - 1]!;
    const seam = prev.length;
    lines[buf.row - 1] = prev + lines[buf.row]!;
    lines.splice(buf.row, 1);
    return at(lines, buf.row - 1, seam);
  }
  const line = lines[buf.row]!;
  lines[buf.row] = line.slice(0, buf.col - 1) + line.slice(buf.col);
  return at(lines, buf.row, buf.col - 1);
}

export function editorDelete(buf: EditorBuffer): EditorBuffer {
  const line = buf.lines[buf.row]!;
  if (buf.col < line.length) {
    const lines = [...buf.lines];
    lines[buf.row] = line.slice(0, buf.col) + line.slice(buf.col + 1);
    return at(lines, buf.row, buf.col);
  }
  if (buf.row === buf.lines.length - 1) return buf;
  const lines = [...buf.lines];
  lines[buf.row] = line + lines[buf.row + 1]!;
  lines.splice(buf.row + 1, 1);
  return at(lines, buf.row, buf.col);
}

/**
 * Map an Ink key event onto a move, so the screen stays a thin shell and the
 * reducer stays testable without a terminal.
 */
export function editorApplyKeys(
  key: Partial<Record<"upArrow" | "downArrow" | "leftArrow" | "rightArrow" | "home" | "end" | "pageUp" | "pageDown", boolean>>,
): EditorMoveKey | undefined {
  if (key.leftArrow) return "left";
  if (key.rightArrow) return "right";
  if (key.upArrow) return "up";
  if (key.downArrow) return "down";
  if (key.home) return "home";
  if (key.end) return "end";
  if (key.pageUp) return "pageUp";
  if (key.pageDown) return "pageDown";
  return undefined;
}

export type EditorMoveKey =
  | "left"
  | "right"
  | "up"
  | "down"
  | "home"
  | "end"
  | "pageUp"
  | "pageDown";

export function editorMove(
  buf: EditorBuffer,
  key: EditorMoveKey,
  pageRows = 10,
): EditorBuffer {
  const last = buf.lines.length - 1;
  switch (key) {
    case "left":
      if (buf.row === 0 && buf.col === 0) return buf;
      if (buf.col > 0) return at(buf.lines, buf.row, buf.col - 1);
      return at(buf.lines, buf.row - 1, (buf.lines[buf.row - 1] ?? "").length);
    case "right":
      if (buf.col < (buf.lines[buf.row] ?? "").length)
        return at(buf.lines, buf.row, buf.col + 1);
      if (buf.row < last) return at(buf.lines, buf.row + 1, 0);
      return buf;
    case "up":
      if (buf.row === 0) return vmove(buf, 0);
      return vmove(buf, buf.row - 1);
    case "down":
      if (buf.row === last) return vmove(buf, last);
      return vmove(buf, buf.row + 1);
    case "home":
      return at(buf.lines, buf.row, 0);
    case "end":
      return at(buf.lines, buf.row, (buf.lines[buf.row] ?? "").length);
    case "pageUp":
      return vmove(buf, Math.max(0, buf.row - pageRows));
    case "pageDown":
      return vmove(buf, Math.min(last, buf.row + pageRows));
  }
}

/**
 * Whether the buffer differs from the file it was loaded from.
 *
 * The original is run through the SAME normalisation the loader applies
 * (CRLF/CR → LF, tabs → two spaces), so a file the user only looked at —
 * one with tabs or Windows line endings — is not "dirty" with zero
 * keystrokes, and a bare save does not silently rewrite every line ending.
 */
export function editorIsDirty(buf: EditorBuffer, original: string): boolean {
  const baseline = original.split(/\r\n|\r|\n/)
    .map((l) => l.replace(/\t/g, "  "))
    .join("\n");
  return editorText(buf) !== baseline;
}

/**
 * The rows of the buffer to render, cursor kept on screen.
 *
 * Edge-following, like every editor: the window only moves when the cursor
 * would leave it, so typing near the top does not drag the view around.
 * Horizontal scrolling follows the same rule via `firstCol`.
 */
export function clampView(cursor: number, first: number, rows: number): number {
  if (cursor < first) return cursor;
  if (cursor >= first + rows) return cursor - rows + 1;
  return first;
}

export interface EditorViewport {
  /** First buffer row on screen. */
  firstRow: number;
  /** First rendered column of every row. */
  firstCol: number;
  /** At most `rows` entries; `text` is pre-sliced to `cols`. */
  rows: Array<{ text: string; isCursorRow: boolean }>;
}

export function editorViewport(
  buf: EditorBuffer,
  firstRow: number,
  firstCol: number,
  rows: number,
  cols: number,
): EditorViewport {
  // The stored window is clamped against the CURRENT cursor, so a stale
  // window can never leave the cursor off screen.
  const first = clampView(buf.row, firstRow, rows);
  const col = clampView(buf.col, firstCol, cols);
  const out: EditorViewport["rows"] = [];
  for (let r = first; r < Math.min(buf.lines.length, first + rows); r++) {
    out.push({ text: buf.lines[r]!.slice(col, col + cols), isCursorRow: r === buf.row });
  }
  return { firstRow: first, firstCol: col, rows: out };
}
