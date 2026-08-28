/**
 * A frame must land where it was drawn.
 *
 * Reported as "lab/you/time rendering issues" with a screenshot showing three
 * different scroll markers stacked on consecutive rows, duplicated headers and
 * timestamps, and no footer at all. Every one of those rows was a CORRECT row
 * from an earlier frame, left at the wrong place: Ink's incremental writer
 * positions each frame relative to where it believes the cursor is, and the
 * trailing newline it adds to a non-fullscreen frame put it one row lower. The
 * app's own frame content was never wrong, which is why no content assertion
 * anywhere in this suite noticed.
 *
 * So the assertion here is on the SCREEN, not the frame: both renderers drive a
 * streaming conversation, the bytes each wrote are replayed through a terminal
 * emulator, and the incremental result must equal the non-incremental one —
 * that renderer erases and repaints, so it cannot drift.
 */

import React from "react";
import { describe, expect, test } from "bun:test";
import { Box, render } from "ink";
import { PassThrough } from "node:stream";

import { VT } from "./helpers/vt.ts";
import {
  TerminalSizeContext,
  renderRows,
  trimFrameAdvance,
} from "../src/tui/terminal.ts";
import { ChatScreen } from "../src/tui/screens/Chat.tsx";
import type {
  ChatEvent,
  ChatMessage,
  ChatSession,
} from "../src/tui/chatSession.ts";

const ROWS = 43;
const COLS = 155;

function fakeStdin(): PassThrough & NodeJS.ReadStream {
  const stream = new PassThrough();
  Object.assign(stream, {
    isTTY: true,
    setRawMode: () => stream,
    ref: () => stream,
    unref: () => stream,
  });
  return stream as unknown as PassThrough & NodeJS.ReadStream;
}

/** Enough prior turns that the transcript overflows and shows a marker. */
function history(turns: number): ChatMessage[] {
  const out: ChatMessage[] = [];
  for (let i = 0; i < turns; i++) {
    out.push({ role: "user", text: `cli test ${i}`, at: 1756000000000 });
    out.push({
      role: "assistant",
      text: "Nominal — cli channel, `cli:tui:lab`, trusted turn, tools responsive.",
      at: 1756000000000,
      tools: [],
    });
  }
  return out;
}

function session(turns: number): ChatSession {
  return {
    persona: "lab",
    conversation: "cli:tui:lab",
    history: history(turns),
    async *send(): AsyncGenerator<ChatEvent> {},
    async close() {},
  };
}

/** The screen, as a component, so a rerender is the only source of change. */
function Screen(props: { turns: number }): React.ReactElement {
  const size = { rows: ROWS, columns: COLS };
  return (
    <TerminalSizeContext.Provider value={size}>
      <Box flexDirection="column" height={renderRows(size)}>
        <ChatScreen
          session={session(props.turns)}
          status="channel: stable"
          onSettings={() => {}}
          onQuit={() => {}}
        />
      </Box>
    </TerminalSizeContext.Provider>
  );
}

/**
 * Grow the conversation a few turns and return the screen the user would see.
 *
 * Driven by `rerender`, not by keystrokes: two live runs racing a streaming
 * turn against a spinner produce different CONTENT, and a content difference
 * would be indistinguishable here from the placement fault under test.
 *
 * `trim` is the fix: the gate drops the frame's trailing line advance. Passing
 * `false` restores the old behaviour, which makes this a mutation check rather
 * than a snapshot.
 */
async function screenAfterTurns(options: {
  incremental: boolean;
  trim: boolean;
}): Promise<string[]> {
  const chunks: string[] = [];
  const sink = {
    write: (chunk: string) => {
      chunks.push(options.trim ? trimFrameAdvance(String(chunk)) : String(chunk));
      return true;
    },
    rows: ROWS,
    columns: COLS,
    isTTY: true,
    on: () => sink,
    off: () => sink,
    once: () => sink,
    removeListener: () => sink,
    emit: () => false,
  } as unknown as NodeJS.WriteStream;

  const instance = render(<Screen turns={4} />, {
    stdout: sink,
    stdin: fakeStdin(),
    exitOnCtrlC: false,
    patchConsole: false,
    incrementalRendering: options.incremental,
  });
  for (let turns = 5; turns <= 10; turns++) {
    await Bun.sleep(50);
    instance.rerender(<Screen turns={turns} />);
  }
  await Bun.sleep(50);
  instance.unmount();

  const vt = new VT(COLS, ROWS);
  vt.write(chunks.join(""));
  return vt.screen();
}

describe("incremental frames do not drift", () => {
  test("the screen matches the erase-and-repaint renderer", async () => {
    // The reference redraws the whole block every time, so it cannot drift.
    const reference = await screenAfterTurns({
      incremental: false,
      trim: false,
    });
    const incremental = await screenAfterTurns({
      incremental: true,
      trim: true,
    });
    expect(incremental).toEqual(reference);
    // Guard the reference itself: a screen of blank rows would pass the
    // comparison above while showing the user nothing.
    expect(reference.join("\n")).toContain("phantombot");
    expect(reference.filter((row) => row.trim().length > 0).length).toBeGreaterThan(10);
  }, 20000);

  test("without the fix the same session corrupts the screen", async () => {
    const reference = await screenAfterTurns({
      incremental: false,
      trim: false,
    });
    const drifted = await screenAfterTurns({ incremental: true, trim: false });
    expect(drifted).not.toEqual(reference);
  }, 20000);

  test("one trailing advance is dropped, and only one", () => {
    expect(trimFrameAdvance("a\nb\n")).toBe("a\nb");
    expect(trimFrameAdvance("a\nb\n\n")).toBe("a\nb\n");
    expect(trimFrameAdvance("a\nb[E")).toBe("a\nb");
    // A frame that already ends on its last line is left exactly as it is.
    expect(trimFrameAdvance("a\nb")).toBe("a\nb");
    expect(trimFrameAdvance("")).toBe("");
  });
});
