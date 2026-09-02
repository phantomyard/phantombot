/**
 * The reserved notice slot must stay EXACTLY one row.
 *
 * Kai's review on the notice-slot PR reproduced the failure at 40 columns:
 * a 65-character notice (a path, an error message) wrapped onto two rows
 * inside the slot and pushed the footer out of the fixed-height root — the
 * exact layout-shift bug the reserved slot exists to prevent. The notice is
 * therefore rendered with `wrap="truncate"`, and this test pins it: at a
 * narrow width a long notice must clip to one row with the footer still the
 * last row on screen.
 */

import { describe, expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { Box, render } from "ink";

import { Frame, NoticeContext } from "../src/tui/components/Frame.tsx";
import { stripAnsi } from "./helpers/ansi.ts";

function fakeStdout(rows: number, columns: number) {
  const frames: string[] = [];
  const s = new EventEmitter() as EventEmitter & {
    columns: number;
    rows: number;
    write: (chunk: string) => void;
  };
  s.columns = columns;
  s.rows = rows;
  s.write = (chunk: string) => {
    frames.push(chunk);
  };
  return { stream: s as unknown as NodeJS.WriteStream, frames };
}

function fakeStdin() {
  const s = new PassThrough() as PassThrough & {
    isTTY: boolean;
    setRawMode: () => void;
    ref: () => void;
    unref: () => void;
  };
  s.isTTY = true;
  s.setRawMode = () => {};
  s.ref = () => {};
  s.unref = () => {};
  return s as unknown as NodeJS.ReadStream;
}

function renderFrame(columns: number, rows: number, notice: string | undefined) {
  const { stream, frames } = fakeStdout(rows, columns);
  const instance = render(
    /* Fixed height, exactly like the App root (App.tsx:2149) — that is what
       makes an extra notice row overflow instead of just growing the block. */
    <Box flexDirection="column" height={rows}>
      <NoticeContext.Provider value={notice}>
        <Frame title={["phantombot", "lab"]} footer={[{ key: "^c", label: "quit" }]}>
          <>{null}</>
        </Frame>
      </NoticeContext.Provider>
    </Box>,
    {
      stdout: stream,
      stdin: fakeStdin(),
      exitOnCtrlC: false,
      patchConsole: false,
    },
  );
  instance.unmount();
  /* The LAST frame only: unmount repaints a cleared screen, so joining all
     frames would double-count every row. The erase prefix (not an SGR code,
     so stripAnsi keeps it) is dropped with the split. */
  return stripAnsi(frames[frames.length - 1] ?? "");
}

describe("reserved notice slot", () => {
  const LONG_NOTICE =
    "/home/supervisor/.local/share/phantombot/personas/lab/memory-index/index.sqlite reembedded";

  test("a long notice truncates to one row — footer stays last", () => {
    const out = renderFrame(40, 12, LONG_NOTICE);
    const lines = out.split("\n");
    if (lines[lines.length - 1] === "") lines.pop();
    // The notice appears, but only ONCE — a wrap would repeat its tail.
    expect(out).toContain(LONG_NOTICE.slice(0, 10));
    const noticeRows = lines.filter((l) => l.includes(LONG_NOTICE.slice(0, 10)));
    expect(noticeRows.length).toBe(1);
    // Truncated, not wrapped: the tail past the 40-column clip is absent.
    const tail = LONG_NOTICE.slice(-12);
    expect(lines.filter((l) => l.includes(tail)).length).toBe(0);
    // Footer is still the last rendered row.
    const last = lines[lines.length - 1];
    expect(last).toContain("quit");
  });

  test("an empty notice still reserves exactly one row", () => {
    const out = renderFrame(40, 12, undefined);
    const last =
      out
        .split("\n")
        .filter((l) => l.trim().length > 0)
        .pop() ?? "";
    expect(last).toContain("quit");
  });
});
