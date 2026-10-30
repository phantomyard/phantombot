/**
 * The terminal layer: alternate screen, size, and the write gate.
 *
 * These are the mechanics behind "it does not act like a terminal app". The
 * app was drawing INLINE — a frame the height of its content, left in the
 * shell's scrollback — because `render()` was called without the alternate
 * screen and the root had no height.
 */

import { describe, expect, test } from "bun:test";

import {
  DEFAULT_SIZE,
  enterFullScreen,
  FULL_SCREEN_OFF,
  FULL_SCREEN_ON,
  gateStdout,
  RESERVED_ROWS,
  terminalSize,
  viewportRows,
} from "../src/tui/terminal.ts";

function fakeStdout() {
  const writes: string[] = [];
  return {
    writes,
    stream: {
      write: (chunk: string) => {
        writes.push(chunk);
        return true;
      },
      columns: 100,
      rows: 40,
      isTTY: true,
      on: () => {},
      off: () => {},
      once: () => {},
      removeListener: () => {},
      emit: () => true,
    } as unknown as NodeJS.WriteStream,
  };
}

describe("terminalSize", () => {
  test("reads the window, and falls back when there is no TTY to ask", () => {
    expect(terminalSize({ rows: 51, columns: 137 })).toEqual({
      rows: 51,
      columns: 137,
    });
    // A pipe reports neither; zero is as useless as undefined and must not
    // reach the layout engine as a height.
    expect(terminalSize({})).toEqual(DEFAULT_SIZE);
    expect(terminalSize({ rows: 0, columns: 0 })).toEqual(DEFAULT_SIZE);
  });
});

describe("viewportRows", () => {
  test("subtracts the chrome AND the reserved row", () => {
    // The reserved row is what keeps Ink off its clear-the-terminal repaint
    // path (see tui-repaint.test.tsx). It has to come off here too: if a
    // scrolling region budgeted for the full window while the root painted one
    // row less, the content would be a row too tall and Yoga would compress it
    // rather than clip — the sheared border we already fixed once.
    expect(viewportRows({ rows: 40, columns: 80 }, 10)).toBe(
      40 - RESERVED_ROWS - 10,
    );
    // A 6-row terminal is absurd but must still render something rather than
    // handing Yoga a negative height.
    expect(viewportRows({ rows: 6, columns: 80 }, 10)).toBe(1);
  });
});

describe("enterFullScreen", () => {
  test("enters on construction and restores exactly once", () => {
    const { writes, stream } = fakeStdout();
    const screen = enterFullScreen(stream);
    expect(writes).toEqual([FULL_SCREEN_ON]);
    screen.restore();
    screen.restore();
    // Idempotent: exit handlers overlap (`exit`, `SIGINT`, and the `finally`
    // all call it), and a second `?1049l` would pop the user's shell out of a
    // screen buffer it never entered.
    expect(writes).toEqual([FULL_SCREEN_ON, FULL_SCREEN_OFF]);
    screen.enter();
    expect(writes.at(-1)).toBe(FULL_SCREEN_ON);
  });

  // macOS Terminal.app turns the scroll wheel into ↑/↓ on the alternate screen
  // ONLY in application cursor-key mode (DECCKM, `?1h`), which is what `less`
  // and `vim` switch on. Without it the wheel sends nothing at all: a byte log
  // of a trackpad scroll in Terminal.app captured zero bytes on `?1049h` alone
  // and a stream of `ESC O A` / `ESC O B` once `?1h` was added (#727).
  // Literal escapes here, not the module's constants, so a wrong constant
  // cannot make this pass.
  test("switches the cursor keys to application mode, and back on restore (#727)", () => {
    const { writes, stream } = fakeStdout();
    const screen = enterFullScreen(stream);
    const entered = writes.join("");
    expect(entered).toContain("\x1b[?1049h");
    expect(entered).toContain("\x1b[?1h");
    // After the buffer switch, so the mode is set on the screen the app uses.
    expect(entered.indexOf("\x1b[?1h")).toBeGreaterThan(
      entered.indexOf("\x1b[?1049h"),
    );
    writes.length = 0;
    screen.restore();
    const left = writes.join("");
    // `?1049l` does not restore DECCKM, so the shell would otherwise get
    // `ESC O A` for every ↑ after the app exits.
    expect(left).toContain("\x1b[?1l");
    expect(left.indexOf("\x1b[?1l")).toBeLessThan(left.indexOf("\x1b[?1049l"));
    screen.restore();
    expect(writes.join("")).toBe(left);
  });
});

describe("gateStdout", () => {
  test("drops writes while suspended and passes them again after", () => {
    const { writes, stream } = fakeStdout();
    const gate = gateStdout(stream);
    gate.stream.write("frame 1");
    gate.suspend();
    // This is the whole point: an Ink re-render arriving while a clack prompt
    // owns the terminal would interleave two applications on one screen.
    gate.stream.write("frame 2");
    expect(gate.suspended()).toBe(true);
    gate.resume();
    gate.stream.write("frame 3");
    expect(writes).toEqual(["frame 1", "frame 3"]);
  });

  test("reads size through to the real stream, so a resize during a prompt is seen", () => {
    const { stream } = fakeStdout();
    const gate = gateStdout(stream);
    expect(gate.stream.columns).toBe(100);
    (stream as unknown as { columns: number }).columns = 60;
    expect(gate.stream.columns).toBe(60);
  });
});
