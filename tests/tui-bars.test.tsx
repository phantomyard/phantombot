/**
 * The header and footer are BARS: a filled background band running the whole
 * width of the terminal, not a line of coloured text on the default canvas.
 *
 * Asserted on the ANSI the renderer actually emits, and on the FULL WIDTH of
 * the painted band - a "the line is coloured" check passes happily while the
 * fill stops at the end of the text, which is the failure mode you see as a
 * ragged half-bar. Chalk's colour level is forced here because a test process
 * has no TTY and would otherwise emit no escapes at all.
 */

import { describe, expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import chalk from "chalk";
import { render } from "ink";

import { ChatScreen } from "../src/tui/screens/Chat.tsx";
import { theme } from "../src/tui/theme.ts";
import type { ChatSession } from "../src/tui/chatSession.ts";

chalk.level = 3;

const ESC = "\u001b";
/** bgBlackBright, i.e. `theme.bar.bg`. */
const BG_OPEN = `${ESC}[100m`;
const strip = (s: string) => s.replace(new RegExp(`${ESC}\\[[0-9;]*m`, "g"), "");
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

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
  return s;
}

function fakeStdout(columns: number, rows: number) {
  const frames: string[] = [];
  const s = new EventEmitter() as EventEmitter & {
    columns: number;
    rows: number;
    write: (c: string) => void;
    frames: string[];
  };
  s.columns = columns;
  s.rows = rows;
  s.frames = frames;
  s.write = (c: string) => void frames.push(c);
  return s;
}

const idleSession: ChatSession = {
  persona: "alice",
  conversation: "cli:tui:alice",
  history: [],
  async *send() {},
  async command() {
    return null;
  },
  async close() {},
};

async function mount(columns = 80, rows = 24) {
  const stdin = fakeStdin();
  const stdout = fakeStdout(columns, rows);
  const instance = render(
    <ChatScreen
      session={idleSession}
      status="channel: preview"
      onSettings={() => {}}
      onQuit={() => {}}
    />,
    {
      stdin: stdin as unknown as NodeJS.ReadStream,
      stdout: stdout as unknown as NodeJS.WriteStream,
      debug: true,
      exitOnCtrlC: false,
    },
  );
  await sleep(60);
  const frame = stdout.frames.at(-1) ?? "";
  return { instance, lines: frame.split("\n") };
}

describe("header and footer bars", () => {
  test("bar text is dark, so it contrasts against the light-grey bar", () => {
    // The bar background is a LIGHT grey; light-on-light is the failure we are
    // guarding against, and `theme.dim` (gray) is the bar background itself.
    const dark = new Set(["black", "blue", "red", "green", "magenta"]);
    for (const key of ["fg", "accent", "dim"] as const) {
      expect(dark.has(theme.bar[key])).toBe(true);
      expect(theme.bar[key]).not.toBe(theme.bar.bg);
      expect(theme.bar[key]).not.toBe(theme.dim);
    }
  });

  test("the top row is a filled bar spanning the terminal width", async () => {
    expect(theme.bar.bg).toBe("blackBright");
    const { instance, lines } = await mount(80, 24);
    try {
      const top = lines[0] ?? "";
      expect(top).toContain(BG_OPEN);
      expect(strip(top).length).toBe(80);
      expect(strip(top)).toContain("phantombot");
      expect(strip(top)).toContain("channel: preview");
    } finally {
      instance.unmount();
    }
  });

  test("the footer row is a filled bar too, not just coloured text", async () => {
    const { instance, lines } = await mount(80, 24);
    try {
      const last = [...lines].reverse().find((l) => strip(l).trim() !== "");
      expect(last ?? "").toContain(BG_OPEN);
      expect(strip(last ?? "").length).toBe(80);
      expect(strip(last ?? "")).toContain("^q");
    } finally {
      instance.unmount();
    }
  });
});
