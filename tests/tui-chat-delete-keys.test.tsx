/**
 * The chat prompt's delete keys (issue #725), driven through the REAL chat
 * screen with the bytes a terminal sends: the pure functions are pinned in
 * `tui-prompt-emacs.test.ts`; this pins that each key reaches them.
 *
 * Before #725, ^w/^u/^d fell through the input handler and did nothing, and
 * Alt-Backspace deleted one character because the Backspace branch ignored
 * `meta`.
 */

import { describe, expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { render } from "ink";

import { ChatScreen } from "../src/tui/screens/Chat.tsx";
import type { ChatSession } from "../src/tui/chatSession.ts";
import { TranscriptStore } from "../src/tui/transcriptStore.ts";
import { TurnStore } from "../src/tui/turnRunner.ts";

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

function fakeStdout() {
  const frames: string[] = [];
  const s = new EventEmitter() as EventEmitter & {
    columns: number;
    rows: number;
    write: (c: string) => void;
    frames: string[];
  };
  s.columns = 100;
  s.rows = 20;
  s.frames = frames;
  s.write = (c: string) => void frames.push(c);
  return s;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const session: ChatSession = {
  persona: "lab",
  conversation: "cli:tui:lab",
  transcript: new TranscriptStore([]),
  turn: new TurnStore(),
  submit: async () => {},
  abortTurn: () => {},
  async *send() {},
  async command() {
    return null;
  },
  async reloadHarnesses() {
    return [];
  },
  async close() {},
};

// Written as escapes, not literals: a raw control byte in a source file is
// invisible in review and in a diff.
const ESC = "\x1b";
const KEY = {
  ctrlA: "\x01",
  ctrlB: "\x02",
  ctrlD: "\x04",
  ctrlU: "\x15",
  ctrlW: "\x17",
  backspace: "\x7f",
  deleteKey: `${ESC}[3~`,
  altBackspace: `${ESC}\x7f`,
  altD: `${ESC}d`,
  // Kitty protocol (flag 1 is pushed by the TUI): CSI codepoint ; mods u,
  // where mods = 1 + 2 (alt) or 1 + 4 (ctrl).
  kittyCtrlW: `${ESC}[119;5u`,
  kittyCtrlU: `${ESC}[117;5u`,
  kittyAltBackspace: `${ESC}[127;3u`,
  kittyAltD: `${ESC}[100;3u`,
};

/** The prompt row of the latest frame, ANSI and border stripped. */
function promptText(frames: string[]): string {
  // eslint-disable-next-line no-control-regex
  const frame = (frames.at(-1) ?? "").replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "");
  const row = frame.split("\n").find((line) => line.includes("› "));
  if (row === undefined) throw new Error(`no prompt row in frame:\n${frame}`);
  return row.slice(row.indexOf("› ") + 2).replace(/[│\s]+$/u, "");
}

/** Mount the chat screen, type `text`, then send each key as its own chunk. */
async function typeThen(text: string, keys: string[]): Promise<string> {
  const stdin = fakeStdin();
  const stdout = fakeStdout();
  const instance = render(
    <ChatScreen session={session} status="channel: stable" onSettings={() => {}} onQuit={() => {}} />,
    {
      stdin: stdin as unknown as NodeJS.ReadStream,
      stdout: stdout as unknown as NodeJS.WriteStream,
      debug: true,
      exitOnCtrlC: false,
    },
  );
  try {
    await sleep(60);
    stdin.write(text);
    await sleep(40);
    for (const key of keys) {
      stdin.write(key);
      await sleep(40);
    }
    await sleep(40);
    return promptText(stdout.frames);
  } finally {
    instance.unmount();
  }
}

describe("chat prompt delete keys (#725)", () => {
  test("^w deletes back to the previous space", async () => {
    expect(await typeThen("alpha beta/gamma", [KEY.ctrlW])).toBe("alpha");
    expect(await typeThen("alpha beta/gamma", [KEY.kittyCtrlW])).toBe("alpha");
  });

  test("Alt-Backspace deletes back to the start of the word", async () => {
    expect(await typeThen("alpha beta/gamma", [KEY.altBackspace])).toBe("alpha beta/");
    expect(await typeThen("alpha beta/gamma", [KEY.kittyAltBackspace])).toBe("alpha beta/");
  });

  test("plain Backspace still deletes one character, and so does the Delete key", async () => {
    expect(await typeThen("alpha", [KEY.backspace])).toBe("alph");
    // Ink names ESC[3~ `delete` like 0x7f, so it stays a backspace (docs/reference/tui-keys.md).
    expect(await typeThen("alpha", [KEY.deleteKey])).toBe("alph");
  });

  test("Alt-d deletes forward to the end of the word", async () => {
    // Readline's kill-word: the word goes, the space after it stays.
    expect(await typeThen("alpha beta", [KEY.ctrlA, KEY.altD])).toBe(" beta");
    expect(await typeThen("alpha beta", [KEY.ctrlA, KEY.kittyAltD])).toBe(" beta");
  });

  test("^u deletes back to the start of the line; text after the cursor stays", async () => {
    expect(await typeThen("one two", [KEY.ctrlB, KEY.ctrlB, KEY.ctrlU])).toBe("wo");
    expect(await typeThen("one two", [KEY.ctrlB, KEY.ctrlB, KEY.kittyCtrlU])).toBe("wo");
  });

  test("^d deletes the character under the cursor", async () => {
    expect(await typeThen("abc", [KEY.ctrlA, KEY.ctrlD])).toBe("bc");
  });
});
