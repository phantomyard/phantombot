/**
 * Scrolling back through the conversation.
 *
 * Reported symptom: "older turns get lost when they reach past the top". A
 * full-screen app has no terminal scrollback to fall back on — the alternate
 * screen buffer has none by design — so anything clipped off the top is
 * unreachable unless the app scrolls itself.
 *
 * Assertions here are on CONTENT REACHABILITY (can I get an old turn back on
 * screen, and can I get back to the live end), not on an offset number: an
 * offset can change while the screen shows exactly the same thing.
 */

import { describe, expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { render } from "ink";

import { ChatScreen } from "../src/tui/screens/Chat.tsx";
import type { ChatMessage, ChatSession } from "../src/tui/chatSession.ts";

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

function fakeStdout(rows = 20) {
  const frames: string[] = [];
  const s = new EventEmitter() as EventEmitter & {
    columns: number;
    rows: number;
    write: (c: string) => void;
    frames: string[];
  };
  s.columns = 100;
  s.rows = rows;
  s.frames = frames;
  s.write = (c: string) => void frames.push(c);
  return s;
}

const lastFrame = (frames: string[]) => frames.at(-1) ?? "";
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Twenty short turns: far more than a 20-row window can hold. */
const history: ChatMessage[] = Array.from({ length: 20 }, (_, i) => ({
  role: i % 2 === 0 ? "user" : "assistant",
  text: `turn-${String(i).padStart(2, "0")}`,
  at: 0,
}));

const session: ChatSession = {
  persona: "lab",
  conversation: "cli:tui:lab",
  history,
  async *send() {},
  async close() {},
};

async function mount() {
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
  return { stdin, stdout, instance };
}

// Written as escapes, not literals: a raw ESC byte in a source file is
// invisible in review and in a diff.
const ESC = "\x1b";
const PAGE_UP = `${ESC}[5~`;
const PAGE_DOWN = `${ESC}[6~`;
const HOME = `${ESC}[1~`;
const END = `${ESC}[4~`;

describe("chat scrollback", () => {
  test("opens at the live end of the conversation", async () => {
    const { stdout, instance } = await mount();
    try {
      const frame = lastFrame(stdout.frames);
      expect(frame).toContain("turn-19");
      expect(frame).not.toContain("turn-00");
    } finally {
      instance.unmount();
    }
  });

  test("PgUp reveals turns that had scrolled off the top", async () => {
    const { stdin, stdout, instance } = await mount();
    try {
      const atBottom = lastFrame(stdout.frames);
      stdin.write(PAGE_UP);
      await sleep(80);
      const frame = lastFrame(stdout.frames);
      // The marker names what is hidden in BOTH directions once you leave the
      // live end — "below" is the only cue that you are not seeing the reply.
      expect(frame).toContain("below");
      // A turn that was NOT reachable at the live end now is. Asserting on a
      // fixed turn number would just be asserting the page size.
      const older = history
        .map((m) => m.text)
        .filter((t) => !atBottom.includes(t) && frame.includes(t));
      expect(older.length).toBeGreaterThan(0);
    } finally {
      instance.unmount();
    }
  });

  test("Home reaches the very first turn, and End comes back to the live end", async () => {
    const { stdin, stdout, instance } = await mount();
    try {
      stdin.write(HOME);
      await sleep(80);
      expect(lastFrame(stdout.frames)).toContain("turn-00");
      stdin.write(END);
      await sleep(80);
      const frame = lastFrame(stdout.frames);
      expect(frame).toContain("turn-19");
      expect(frame).not.toContain("below");
    } finally {
      instance.unmount();
    }
  });

  test("PgDn from the bottom does not scroll past the live end", async () => {
    // Over-scrolling downward used to be a way to blank the transcript.
    const { stdin, stdout, instance } = await mount();
    try {
      stdin.write(PAGE_DOWN);
      stdin.write(PAGE_DOWN);
      await sleep(80);
      const frame = lastFrame(stdout.frames);
      expect(frame).toContain("turn-19");
      expect(frame).not.toContain("below");
    } finally {
      instance.unmount();
    }
  });

  test("typing still works after scrolling — the keys are not swallowed", async () => {
    const { stdin, stdout, instance } = await mount();
    try {
      stdin.write(PAGE_UP);
      await sleep(40);
      stdin.write("still typing");
      await sleep(80);
      expect(lastFrame(stdout.frames)).toContain("still typing");
    } finally {
      instance.unmount();
    }
  });
});
