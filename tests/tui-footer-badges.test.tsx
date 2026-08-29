/**
 * Every footer menu item carries a badge glyph, not just settings.
 *
 * Reported as: "we need to put badges on all menu items, not just on
 * settings". A footer of bare `^t ^c ^s ^p` is unreadable until you have
 * memorised it; the badge says what the key DOES, and is the same glyph for
 * the same action on every screen.
 *
 * The assertion is deliberately `badge + key` ADJACENT rather than "the glyph
 * appears somewhere": a glyph that renders in the body would satisfy the
 * looser check while the footer stayed bare.
 */

import { describe, expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { render } from "ink";

import { ChatScreen } from "../src/tui/screens/Chat.tsx";
import { badge } from "../src/tui/theme.ts";
import { stripAnsi } from "./helpers/ansi.ts";
import type { ChatSession } from "../src/tui/chatSession.ts";

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

function fakeStdout(columns: number) {
  const frames: string[] = [];
  const s = new EventEmitter() as EventEmitter & {
    columns: number;
    rows: number;
    write: (c: string) => void;
    frames: string[];
  };
  s.columns = columns;
  s.rows = 30;
  s.frames = frames;
  s.write = (c: string) => void frames.push(c);
  return s;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const lastFrame = (frames: string[]) => frames.at(-1) ?? "";

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

async function mount(columns = 200) {
  const stdin = fakeStdin();
  const stdout = fakeStdout(columns);
  const instance = render(
    <ChatScreen
      session={idleSession}
      status="claude"
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

describe("footer badges", () => {
  test("every chat footer item is badged, not only settings", async () => {
    const { stdout, instance } = await mount();
    try {
      // Colour codes out: CI turns chalk on, and the badge/key pair is
      // rendered with a style change BETWEEN the glyph and the key.
      const frame = stripAnsi(lastFrame(stdout.frames));
      const expected: Array<[string, string]> = [
        [badge.send, "↵"],
        [badge.history, "↑↓"],
        [badge.settings, "^s"],
        [badge.quit, "^q"],
      ];
      for (const [icon, key] of expected) {
        expect(frame).toContain(`${icon} ${key}`);
      }
    } finally {
      instance.unmount();
    }
  });

  test("badges are single-width, so the footer cannot shear", () => {
    // A double-width glyph (emoji) advances two columns in some fonts and one
    // in others; a footer built from them drifts against the border.
    for (const [name, g] of Object.entries(badge)) {
      expect(`${name}:${[...g].length}`).toBe(`${name}:1`);
      const cp = g.codePointAt(0) ?? 0;
      // No emoji presentation blocks.
      expect(`${name}:${cp > 0x1f000}`).toBe(`${name}:false`);
    }
  });
});
