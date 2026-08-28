/**
 * Terminal ownership: the alternate screen, the window size, and the gate that
 * lets a line-mode prompt borrow the terminal back.
 *
 * ## Why the app was not full-screen
 *
 * `render()` on its own draws INLINE: Ink emits a frame as tall as its content
 * and leaves it sitting in the shell's scrollback, under whatever was on screen
 * before. A terminal app is expected to take the window, so this module enters
 * the alternate screen buffer (`?1049h`) — the same thing `less`, `vim` and
 * `htop` do — and restores the user's shell, scrollback intact, on exit.
 *
 * Entering the alternate screen is only half of it: the root box must also be
 * given the window's HEIGHT, or a flex column still lays out to its content and
 * the frame floats at the top of an empty screen.
 *
 * ## The one place geometry is allowed
 *
 * The border rule (see `components/Frame.tsx`) still holds — no component reads
 * `stdout.columns`. This module is the single exception, and it exports the
 * size as a value the ROOT applies: `App` puts it in a context, the root box
 * gets `height`, and the transcript asks how many rows it may use. Nothing
 * downstream does column arithmetic, which is what actually shears borders.
 */

import { createContext, useContext } from "react";

/** Enter the alternate screen buffer and park the cursor at home. */
export const ALT_SCREEN_ON = "\x1b[?1049h\x1b[H";
/** Leave it again, restoring the shell exactly as it was. */
export const ALT_SCREEN_OFF = "\x1b[?1049l";

export interface TerminalSize {
  rows: number;
  columns: number;
}

/** Conservative fallbacks: a pipe reports neither. */
export const DEFAULT_SIZE: TerminalSize = { rows: 24, columns: 80 };

export function terminalSize(
  stdout: { rows?: number; columns?: number } = process.stdout,
): TerminalSize {
  return {
    rows: stdout.rows && stdout.rows > 0 ? stdout.rows : DEFAULT_SIZE.rows,
    columns:
      stdout.columns && stdout.columns > 0
        ? stdout.columns
        : DEFAULT_SIZE.columns,
  };
}

export const TerminalSizeContext = createContext<TerminalSize>(DEFAULT_SIZE);

/** Window size, as measured by the root. Never `process.stdout` directly. */
export function useTerminalSize(): TerminalSize {
  return useContext(TerminalSizeContext);
}

/**
 * One row of the window is deliberately left unpainted.
 *
 * ## Why the app flickered
 *
 * Ink has two ways to put a frame on the screen. Normally it rewrites only the
 * lines that changed. But when a frame is as tall as the window it decides the
 * app is "fullscreen" and switches to CLEAR THE WHOLE TERMINAL AND REDRAW
 * (`ink/build/ink.js`, the `lastOutputHeight >= rows` branch) — on EVERY
 * render. With a spinner ticking at 12 fps and a keystroke repainting on every
 * character, that is a full erase-and-repaint of the window several times a
 * second, which is exactly what a flicker is.
 *
 * Measured on a 24-row fake TTY, 400ms of a ticking app:
 *
 *     height = rows      7317 bytes, 2 whole-terminal clears
 *     height = rows - 1  3472 bytes, 0 clears
 *
 * So the root asks for one row less than the window. The frame still fills the
 * screen visually (the alternate screen is empty underneath and the cursor
 * parks on the spare line); what changes is that Ink stays on its incremental
 * path and writes only the lines that actually differ.
 *
 * This has to be subtracted in ONE place, not at the call sites: if the root
 * shrinks but a scrolling region still budgets for the full window, the content
 * is one row too tall and Yoga compresses it — the border shearing we already
 * fixed once. Hence `renderRows` below, which both the root and `viewportRows`
 * are built on.
 */
export const RESERVED_ROWS = 1;

/** Height the root box paints: the window, less the reserved row. */
export function renderRows(size: TerminalSize): number {
  return Math.max(1, size.rows - RESERVED_ROWS);
}

/**
 * How many rows a scrolling region may use: the painted height minus the
 * chrome drawn around it. Clamped to at least one row so a tiny window renders
 * something rather than throwing at the layout engine.
 */
export function viewportRows(size: TerminalSize, chromeRows: number): number {
  return Math.max(1, renderRows(size) - chromeRows);
}

export interface FullScreen {
  /** Idempotent; safe to call from an exit handler that also ran already. */
  restore: () => void;
  /** Re-enter after a suspension (see `gateStdout`). */
  enter: () => void;
}

export function enterFullScreen(
  stdout: NodeJS.WriteStream = process.stdout,
): FullScreen {
  let active = false;
  const enter = () => {
    if (active) return;
    active = true;
    stdout.write(ALT_SCREEN_ON);
  };
  const restore = () => {
    if (!active) return;
    active = false;
    stdout.write(ALT_SCREEN_OFF);
  };
  enter();
  return { enter, restore };
}

export interface GatedStdout {
  /** Hand this to `render()` in place of `process.stdout`. */
  stream: NodeJS.WriteStream;
  /** Drop Ink's writes on the floor (something else owns the terminal). */
  suspend: () => void;
  resume: () => void;
  suspended: () => boolean;
  /**
   * Lie about the terminal width to Ink, or stop lying (`undefined`).
   *
   * Used by `forceRepaint` — Ink only forgets the frame it thinks is on the
   * screen when the width SHRINKS.
   */
  setColumns: (columns: number | undefined) => void;
}

/**
 * Swallow the line advance Ink puts after the LAST line of a frame.
 *
 * ## Why a frame full of stale rows appeared
 *
 * Ink decides a frame is "fullscreen" with `outputHeight >= stdout.rows`
 * (`ink/build/ink.js`), and ONLY a fullscreen frame is written without a
 * trailing newline. We deliberately paint one row less than the window
 * (`RESERVED_ROWS`, so Ink stays off its clear-the-whole-terminal path), which
 * means every frame arrives with that trailing `\n` — and the incremental
 * writer's cursor arithmetic assumes it did not.
 *
 * It positions the next frame with `cursorUp(previousVisible - 1)` from where
 * it thinks the cursor is: the LAST line of the block. The trailing newline
 * leaves it one row lower, so each frame is written one row further down. When
 * the block already reaches the bottom of the window, that final newline
 * SCROLLS the screen instead, which cancels the drift for the lines Ink
 * rewrites — and moves every line it skipped as unchanged one row up. That is
 * the reported failure exactly: a screen of correct-looking rows at wrong
 * positions, duplicated headers and timestamps, no footer.
 *
 * So the gate drops one trailing advance per frame: a `\n`, or the
 * `cursorNextLine` Ink emits instead when the last line did not change. The
 * cursor then sits where the arithmetic expects it, and no frame ever pushes
 * the window. Verified by replaying a streaming session through a terminal
 * emulator and diffing the resulting SCREEN against the non-incremental
 * renderer's (`tests/tui-frame-drift.test.tsx`).
 *
 * Scoped to the stream handed to `render()`, so it can only ever affect Ink's
 * own frames — not the alternate-screen escapes, not a borrowed prompt.
 */
export function trimFrameAdvance(chunk: string): string {
  if (chunk.endsWith("\n")) return chunk.slice(0, -1);
  if (chunk.endsWith(CURSOR_NEXT_LINE)) {
    return chunk.slice(0, -CURSOR_NEXT_LINE.length);
  }
  return chunk;
}

/** `cursorNextLine` — what Ink emits to step over an unchanged line. */
const CURSOR_NEXT_LINE = "\x1b[E";

/**
 * A write gate in front of stdout.
 *
 * Settings prompts are `@clack/prompts`, which are line-mode and draw on the
 * terminal themselves. Ink cannot be paused, and an Ink re-render landing
 * mid-prompt would interleave two applications' output on one screen. So while
 * a prompt runs, Ink's writes are discarded; when it ends, the caller clears
 * and repaints a full frame.
 *
 * A facade rather than a subclass: `columns`/`rows` are read through to the
 * real stream (so a resize during a prompt is still seen), and the listener
 * methods are delegated so Ink's resize handling keeps working.
 */
export function gateStdout(
  stdout: NodeJS.WriteStream = process.stdout,
): GatedStdout {
  let suspended = false;
  let columnsOverride: number | undefined;
  const facade = {
    write(chunk: string | Uint8Array, ...rest: unknown[]): boolean {
      if (suspended) return true;
      if (typeof chunk === "string") {
        return (stdout.write as (...args: unknown[]) => boolean)(
          trimFrameAdvance(chunk),
          ...rest,
        );
      }
      return (stdout.write as (...args: unknown[]) => boolean)(chunk, ...rest);
    },
    get columns() {
      return columnsOverride ?? stdout.columns;
    },
    get rows() {
      return stdout.rows;
    },
    get isTTY() {
      return stdout.isTTY;
    },
    on: (...args: Parameters<NodeJS.WriteStream["on"]>) =>
      (stdout.on as (...a: unknown[]) => unknown)(...args) && facade,
    off: (...args: Parameters<NodeJS.WriteStream["off"]>) =>
      (stdout.off as (...a: unknown[]) => unknown)(...args) && facade,
    once: (...args: Parameters<NodeJS.WriteStream["once"]>) =>
      (stdout.once as (...a: unknown[]) => unknown)(...args) && facade,
    removeListener: (...args: Parameters<NodeJS.WriteStream["removeListener"]>) =>
      (stdout.removeListener as (...a: unknown[]) => unknown)(...args) && facade,
    emit: (...args: Parameters<NodeJS.WriteStream["emit"]>) =>
      (stdout.emit as (...a: unknown[]) => boolean)(...args),
  };
  return {
    stream: facade as unknown as NodeJS.WriteStream,
    suspend: () => {
      suspended = true;
    },
    resume: () => {
      suspended = false;
    },
    suspended: () => suspended,
    setColumns: (columns: number | undefined) => {
      columnsOverride = columns;
    },
  };
}

/**
 * Force Ink to repaint the WHOLE frame after something else owned the screen.
 *
 * Ink keeps the frame it believes is on the screen and writes only the diff, so
 * after `$EDITOR` (or any borrower) has wiped the alternate screen the next
 * render matches byte for byte and writes NOTHING — a black window with only
 * the one line that happened to change on it.
 *
 * `instance.clear()` is not the fix and is in fact the trap: it erases the
 * lines and then SYNCS log-update's belief back to the frame it just erased.
 *
 * The one supported path that drops that belief is Ink's own resize handler —
 * but only on the branch where the terminal got NARROWER (`log.clear()` plus
 * `lastOutput = ""`). So take exactly that branch: claim one column less,
 * resize (clears, repaints narrow), then hand the real width back and resize
 * again. The second frame differs from the narrow one, so it is written in
 * full. No Ink internals are touched.
 *
 * The listener lives on the REAL stdout (the gate delegates `on`), so the
 * event has to be emitted there.
 */
export function forceRepaint(
  gate: Pick<GatedStdout, "setColumns">,
  stdout: NodeJS.WriteStream = process.stdout,
): void {
  const width = stdout.columns ?? 80;
  gate.setColumns(Math.max(1, width - 1));
  stdout.emit("resize");
  gate.setColumns(undefined);
  stdout.emit("resize");
}
