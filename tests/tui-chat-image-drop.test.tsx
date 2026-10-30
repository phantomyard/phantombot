/**
 * Dropping an image into the chat box (#729): the screen half.
 *
 * Reported: "Claude Code says [Image #1] when I drag an image in." Here a drop
 * pasted the raw, backslash-escaped path. These feed the chat screen the bytes
 * Terminal.app types for a drop, whole and cut across reads, and check what the
 * box shows and what the harness is sent.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import { existsSync, readFileSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { render } from "ink";

import { ChatScreen } from "../src/tui/screens/Chat.tsx";
import { DROP_SETTLE_MS } from "../src/tui/imageDrop.ts";
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
  s.columns = 120;
  s.rows = 20;
  s.frames = frames;
  s.write = (c: string) => void frames.push(c);
  return s;
}

const lastFrame = (frames: string[]) => frames.at(-1) ?? "";
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const BACKSPACE = "\x7f";

let dir: string;
let savedDataHome: string | undefined;
let shot: string;
let sent: string[];

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "tui-chat-image-drop-"));
  // The inbox lives under XDG_DATA_HOME, never the real one.
  savedDataHome = process.env.XDG_DATA_HOME;
  process.env.XDG_DATA_HOME = join(dir, "data");
  await mkdir(join(dir, "Desk top"));
  shot = join(dir, "Desk top", "Screenshot 1.png");
  await writeFile(shot, "png-bytes");
  sent = [];
});

afterEach(async () => {
  if (savedDataHome === undefined) delete process.env.XDG_DATA_HOME;
  else process.env.XDG_DATA_HOME = savedDataHome;
  await rm(dir, { recursive: true, force: true });
});

/** What Terminal.app types for a dropped file; Windows Terminal quotes it. */
function dropped(path: string): string {
  return process.platform === "win32"
    ? `"${path}" `
    : `${path.replaceAll(" ", "\\ ")} `;
}

function inbox(): string {
  return join(dir, "data", "phantombot", "inbox", "cli_tui_lab");
}

async function mount() {
  const session: ChatSession = {
    persona: "lab",
    conversation: "cli:tui:lab",
    transcript: new TranscriptStore([]),
    turn: new TurnStore(),
    submit: async (text: string) => void sent.push(text),
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
  const stdin = fakeStdin();
  const stdout = fakeStdout();
  const instance = render(
    <ChatScreen
      session={session}
      status="channel: stable"
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
  const type = async (bytes: string) => {
    stdin.write(bytes);
    await sleep(40);
  };
  /** Write without waiting for the screen: the next write is a separate read. */
  const write = async (bytes: string, gapMs: number) => {
    stdin.write(bytes);
    await sleep(gapMs);
  };
  return { stdout, instance, type, write };
}

/** Long enough for the input to count as quiet, so a typed run is judged. */
const settle = () => sleep(DROP_SETTLE_MS + 60);

/** `bytes` cut at each offset in `at`, in order. */
function cut(bytes: string, at: number[]): string[] {
  const parts: string[] = [];
  let from = 0;
  for (const i of at) {
    parts.push(bytes.slice(from, i));
    from = i;
  }
  parts.push(bytes.slice(from));
  return parts;
}

function attachedCopies(message: string): string[] {
  return [...message.matchAll(/^\[attached: (.+)\]$/gm)].map((m) => m[1]!);
}

describe("dropping an image into the chat box (#729)", () => {
  test("shows [Image #1], not the path, and attaches the inbox copy on Enter", async () => {
    const { stdout, instance, type } = await mount();
    try {
      await type(dropped(shot));
      await settle();
      const frame = lastFrame(stdout.frames);
      expect(frame).toContain("[Image #1]");
      expect(frame).not.toContain("Screenshot");
      await type("what is this?");
      await type("\r");
      expect(sent).toHaveLength(1);
      const match = /^\[Image #1\] what is this\?\n\n\[attached: (.+)\]$/.exec(sent[0]!);
      expect(match).not.toBeNull();
      const copy = match![1]!;
      expect(copy.startsWith(inbox())).toBe(true);
      expect(readFileSync(copy, "utf8")).toBe("png-bytes");
    } finally {
      instance.unmount();
    }
  });

  test("two drops are #1 and #2; numbering starts over after a send", async () => {
    const other = join(dir, "b.jpg");
    await writeFile(other, "jpg-bytes");
    const { instance, type } = await mount();
    try {
      await type(dropped(shot));
      await type(dropped(other));
      await type("\r");
      expect(sent[0]).toMatch(
        /^\[Image #1\] \[Image #2\]\n\n\[attached: .+\.png\]\n\[attached: .+\.jpg\]$/,
      );
      await type(dropped(other));
      await type("\r");
      expect(sent[1]).toMatch(/^\[Image #1\]\n\n\[attached: .+\.jpg\]$/);
    } finally {
      instance.unmount();
    }
  });

  test("deleting the token drops the image", async () => {
    const { instance, type } = await mount();
    try {
      await type(dropped(shot));
      // One read per press, as a terminal sends them.
      for (let i = 0; i < "[Image #1] ".length; i++) await type(BACKSPACE);
      await type("never mind\r");
      expect(sent).toEqual(["never mind"]);
    } finally {
      instance.unmount();
    }
  });

  test("a slash command empties the box, and its images go with it", async () => {
    const { stdout, instance, type } = await mount();
    try {
      await type(dropped(shot));
      for (let i = 0; i < "[Image #1] ".length; i++) await type(BACKSPACE);
      await type("/status\r");
      await type(dropped(shot));
      await settle();
      expect(lastFrame(stdout.frames)).toContain("[Image #1]");
      expect(lastFrame(stdout.frames)).not.toContain("[Image #2]");
    } finally {
      instance.unmount();
    }
  });

  test("a non-image or missing file is pasted as text, as before", async () => {
    const notes = join(dir, "notes.txt");
    await writeFile(notes, "x");
    const { stdout, instance, type } = await mount();
    try {
      await type(notes);
      expect(lastFrame(stdout.frames)).toContain("notes.txt");
      await type("\r");
      expect(sent).toEqual([notes]);
      expect(existsSync(inbox())).toBe(false);
    } finally {
      instance.unmount();
    }
  });

  test("typed text shows at once, without waiting for the input to go quiet", async () => {
    const { stdout, instance, write } = await mount();
    try {
      await write("hello there", 20);
      expect(lastFrame(stdout.frames)).toContain("hello there");
    } finally {
      instance.unmount();
    }
  });
});

describe("a drop split over several reads is still one drop (#729 review)", () => {
  test("cut in half, 40 ms apart: the reviewers' reproduction", async () => {
    const { stdout, instance, type } = await mount();
    try {
      const bytes = dropped(shot);
      const i = Math.floor(bytes.length / 2);
      await type(bytes.slice(0, i));
      await type(bytes.slice(i));
      await settle();
      expect(lastFrame(stdout.frames)).toContain("[Image #1]");
      expect(lastFrame(stdout.frames)).not.toContain("Screenshot");
      await type("\r");
      expect(sent).toHaveLength(1);
      expect(sent[0]).toStartWith("[Image #1]");
      const copies = attachedCopies(sent[0]!);
      expect(copies).toHaveLength(1);
      expect(readFileSync(copies[0]!, "utf8")).toBe("png-bytes");
    } finally {
      instance.unmount();
    }
  });

  test("the first half names a directory that exists: that is 'not yet', not 'no'", async () => {
    const { stdout, instance, write } = await mount();
    try {
      const bytes = dropped(shot);
      const dirEnd = bytes.indexOf("Screenshot");
      expect(dirEnd).toBeGreaterThan(0);
      for (const part of cut(bytes, [dirEnd])) await write(part, 5);
      await settle();
      expect(lastFrame(stdout.frames)).toContain("[Image #1]");
    } finally {
      instance.unmount();
    }
  });

  test("two drops in one read are #1 and #2", async () => {
    const other = join(dir, "b.jpg");
    await writeFile(other, "jpg-bytes");
    const { instance, type } = await mount();
    try {
      await type(dropped(shot) + dropped(other));
      await settle();
      await type("\r");
      expect(sent[0]).toMatch(
        /^\[Image #1\] \[Image #2\]\n\n\[attached: .+\.png\]\n\[attached: .+\.jpg\]$/,
      );
    } finally {
      instance.unmount();
    }
  });

  test("two drops cut across three reads, at points that split both paths", async () => {
    const other = join(dir, "b.jpg");
    await writeFile(other, "jpg-bytes");
    const { instance, write, type } = await mount();
    try {
      const first = dropped(shot);
      const bytes = first + dropped(other);
      for (const part of cut(bytes, [first.length - 4, first.length + 3])) {
        await write(part, 5);
      }
      await settle();
      await type("\r");
      expect(sent[0]).toMatch(
        /^\[Image #1\] \[Image #2\]\n\n\[attached: .+\.png\]\n\[attached: .+\.jpg\]$/,
      );
    } finally {
      instance.unmount();
    }
  });

  test("Enter before the input has gone quiet still sends the image", async () => {
    const { instance, write, type } = await mount();
    try {
      await write(dropped(shot), 5);
      await type("\r");
      expect(sent).toHaveLength(1);
      expect(sent[0]).toStartWith("[Image #1]");
      expect(attachedCopies(sent[0]!)).toHaveLength(1);
    } finally {
      instance.unmount();
    }
  });

  test("a drop still settling when the screen closes copies nothing", async () => {
    const { instance, write } = await mount();
    await write(dropped(shot), 5);
    instance.unmount();
    await settle();
    expect(existsSync(inbox())).toBe(false);
  });

  test("a drop into the middle of a line keeps the text on both sides", async () => {
    const { instance, write, type } = await mount();
    try {
      await type("look  please");
      // Back to between the two spaces, one press per read.
      for (let i = 0; i < " please".length; i++) await type("\x1b[D");
      const bytes = dropped(shot);
      for (const part of cut(bytes, [7])) await write(part, 5);
      await settle();
      await type("\r");
      expect(sent[0]).toMatch(/^look \[Image #1\]  please\n\n\[attached: .+\.png\]$/);
    } finally {
      instance.unmount();
    }
  });
});
