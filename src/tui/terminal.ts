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
 * How many rows a scrolling region may use: the window minus the chrome drawn
 * around it. Clamped to at least one row so a tiny window renders something
 * rather than throwing at the layout engine.
 */
export function viewportRows(size: TerminalSize, chromeRows: number): number {
  return Math.max(1, size.rows - chromeRows);
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
}

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
  const facade = {
    write(chunk: string | Uint8Array, ...rest: unknown[]): boolean {
      if (suspended) return true;
      return (stdout.write as (...args: unknown[]) => boolean)(chunk, ...rest);
    },
    get columns() {
      return stdout.columns;
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
  };
}
