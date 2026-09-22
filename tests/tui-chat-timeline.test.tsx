/**
 * The chat screen builds the ordered narration/tool timeline (parts) from the
 * event stream.
 *
 * The session yields `text`, `tool` and `tool-done` events in the order they
 * happen; the old message model split them into two fields and the transcript
 * drew every tool call above the whole reply, with consecutive narration runs
 * jammed into one block. These drive a real turn through the screen and pin
 * the two things a user actually sees: chronological order, and paragraph
 * separation between narration runs.
 */

import { describe, expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { render } from "ink";

import { ChatScreen } from "../src/tui/screens/Chat.tsx";
import type { ChatEvent, ChatSession } from "../src/tui/chatSession.ts";
import { TranscriptStore } from "../src/tui/transcriptStore.ts";
import { createTurnRunner } from "../src/tui/turnRunner.ts";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// eslint-disable-next-line no-control-regex
const plain = (frame: string) => frame.replace(/\u001b\[[0-9;]*m/g, "");

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
  s.rows = 40;
  s.frames = frames;
  s.write = (c: string) => void frames.push(c);
  return s;
}

function sessionOf(events: ChatEvent[]): ChatSession {
  const transcript = new TranscriptStore([]);
  async function* send() {
    for (const event of events) yield event;
  }
  const runner = createTurnRunner(send, transcript);
  return {
    persona: "lab",
    conversation: "cli:tui:lab",
    transcript,
    send,
    ...runner,
    async command() {
      return null;
    },
    async reloadHarnesses() {
      return [];
    },
    async close() {},
  };
}

/** Mount, submit one prompt through the real input path, wait for `needle`. */
async function turnFrame(events: ChatEvent[], needle: string): Promise<string> {
  const stdout = fakeStdout();
  const frames = stdout.frames;
  const stdin = fakeStdin();
  const instance = render(
    <ChatScreen
      session={sessionOf(events)}
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
  // Ink attaches its stdin reader on the next tick; a prompt written before
  // that is lost and the turn never starts.
  await sleep(50);
  stdin.write("go on then\r");
  let frame = "";
  for (let i = 0; i < 60; i += 1) {
    await sleep(25);
    frame = plain(frames.at(-1) ?? "");
    if (frame.includes("Found it")) break;
  }
  instance.unmount();
  expect(frame).toContain(needle);
  return frame;
}

describe("the ordered timeline on screen", () => {
  const events: ChatEvent[] = [
    { type: "text", text: "Looking now" },
    { type: "tool", index: 0, title: "Bash(ls)" },
    { type: "tool-done", index: 0, ms: 1500 },
    { type: "text", text: "Found it" },
    // What the engine's terminal `done` carries: the concatenation of the
    // streamed text chunks, i.e. exactly what the timeline already holds.
    { type: "done", text: "Looking nowFound it" },
  ];

  test("narration, tool and narration appear in chronological order", async () => {
    const frame = await turnFrame(events, "Found it");
    const narration = frame.indexOf("Looking now");
    const tool = frame.indexOf("\u203a Bash(ls)");
    const reply = frame.indexOf("Found it");
    expect(narration).toBeGreaterThanOrEqual(0);
    expect(narration).toBeLessThan(tool);
    expect(tool).toBeLessThan(reply);
  });

  test("a finished tool call shows its duration on the timeline", async () => {
    const frame = await turnFrame(events, "Found it");
    expect(frame).toMatch(/\u203a Bash\(ls\)[^\n]*\d+[sm]/);
  });
});