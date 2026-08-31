/**
 * The app must not repaint the whole window on every render.
 *
 * Reported as "it flickers a lot when I type and when the thinking seconds get
 * updated". It was not a React problem: Ink switches to CLEARING THE TERMINAL
 * AND REDRAWING when a frame is as tall as the window, so a spinner tick and a
 * keystroke each cost a full erase-and-repaint. Two things together fix it —
 * the root reserving a row (`renderRows`) so Ink stays off that path, and
 * `incrementalRendering` so it writes only the lines that differ.
 *
 * The assertion is on BYTES AND CLEARS, not on the frame's content: a test that
 * only checked what the frame says would pass while the screen strobed.
 */

import React, { useEffect, useState } from "react";
import { describe, expect, test } from "bun:test";
import { Box, Text, render } from "ink";
import { EventEmitter } from "node:events";

import { renderRows, RESERVED_ROWS } from "../src/tui/terminal.ts";

const CLEAR_TERMINAL = "[2J";
const WINDOW_ROWS = 24;

function fakeTty(): NodeJS.WriteStream & { chunks: string[] } {
  const stream = new EventEmitter() as unknown as NodeJS.WriteStream & {
    chunks: string[];
  };
  stream.chunks = [];
  stream.write = ((chunk: string) => {
    stream.chunks.push(String(chunk));
    return true;
  }) as NodeJS.WriteStream["write"];
  Object.assign(stream, {
    rows: WINDOW_ROWS,
    columns: 80,
    isTTY: true,
    setRawMode: () => stream,
    ref: () => stream,
    unref: () => stream,
    read: () => null,
    resume: () => stream,
    pause: () => stream,
  });
  return stream;
}

/** A frame that changes one line per tick, like the activity spinner. */
function Ticking(props: { height: number }): React.ReactElement {
  const [tick, setTick] = useState(0);
  useEffect(() => {
    const timer = setInterval(() => setTick((n) => n + 1), 20);
    return () => clearInterval(timer);
  }, []);
  return (
    <Box flexDirection="column" height={props.height} borderStyle="round">
      <Text>tick {tick}</Text>
      <Box flexGrow={1} />
      <Text>footer</Text>
    </Box>
  );
}

async function paint(height: number, incrementalRendering: boolean) {
  const stdout = fakeTty();
  const instance = render(<Ticking height={height} />, {
    stdout,
    stdin: fakeTty() as unknown as NodeJS.ReadStream,
    exitOnCtrlC: false,
    patchConsole: false,
    incrementalRendering,
  });
  await new Promise((resolve) => setTimeout(resolve, 400));
  instance.unmount();
  const written = stdout.chunks.join("");
  return {
    bytes: written.length,
    clears: written.split(CLEAR_TERMINAL).length - 1,
  };
}

describe("full-screen repaint", () => {
  test("the root reserves a row so the frame is shorter than the window", () => {
    expect(renderRows({ rows: WINDOW_ROWS, columns: 80 })).toBe(
      WINDOW_ROWS - RESERVED_ROWS,
    );
    // Never zero or negative on a degenerate size, or Yoga throws.
    expect(renderRows({ rows: 1, columns: 80 })).toBeGreaterThan(0);
  });

  test("a ticking app repaints incrementally, not by clearing the screen", async () => {
    const good = await paint(renderRows({ rows: WINDOW_ROWS, columns: 80 }), true);
    expect(good.clears).toBe(0);

    // The two halves of the fix, each reverted on its own. A frame as tall as
    // the window puts Ink back on the clear-and-redraw path...
    const fullHeight = await paint(WINDOW_ROWS, true);
    expect(fullHeight.clears).toBeGreaterThan(0);

    // ...and without incremental rendering every frame is rewritten whole,
    // which is the same flicker even though no clear escape is emitted.
    const wholeFrames = await paint(
      renderRows({ rows: WINDOW_ROWS, columns: 80 }),
      false,
    );
    expect(wholeFrames.bytes).toBeGreaterThan(good.bytes * 3);
  });
});
