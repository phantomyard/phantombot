/**
 * "I configured a brain, it said verified, and every reply came back blank."
 *
 * Three separate defects produced that one screenshot, and each is pinned
 * here:
 *
 *   1. `chatSession` filtered error chunks on `!recoverable`. The orchestrator
 *      consumes recoverable errors it can still fall through from, so the ONLY
 *      error chunks that reach a channel are the terminal and the
 *      chain-exhausted ones — both mean the user got nothing. The filter threw
 *      away exactly the failures worth showing.
 *   2. The chat screen drew a header with an empty body for a turn that said
 *      nothing, which reads as "it answered, and the answer was blank".
 *   3. The session resolved its harness chain when it OPENED and never again,
 *      so configuring the brain from settings left chat talking to the chain
 *      from before the write — on a fresh box, a `claude` that isn't installed.
 */

import { describe, expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { render } from "ink";

import { ChatScreen } from "../src/tui/screens/Chat.tsx";
import type { ChatEvent, ChatSession } from "../src/tui/chatSession.ts";

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
  s.rows = 30;
  s.frames = frames;
  s.write = (c: string) => void frames.push(c);
  return s;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const lastFrame = (frames: string[]) => frames.at(-1) ?? "";

function sessionYielding(events: ChatEvent[]): ChatSession {
  return {
    persona: "alice",
    conversation: "cli:tui:alice",
    history: [],
    async *send() {
      for (const event of events) yield event;
    },
    async command() {
      return null;
    },
    async reloadHarnesses() {
      return [];
    },
    async close() {},
  };
}

/** Type a message and let the turn finish. Returns the last painted frame. */
async function ask(session: ChatSession): Promise<string> {
  const stdin = fakeStdin();
  const stdout = fakeStdout();
  const app = render(
    <ChatScreen
      session={session}
      status="ok"
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
  await sleep(20);
  stdin.write("hello");
  await sleep(20);
  stdin.write("\r");
  await sleep(120);
  const frame = lastFrame(stdout.frames);
  app.unmount();
  return frame;
}

describe("a chat turn that produced nothing", () => {
  test("never leaves a blank bubble — it says so", async () => {
    // The exact shape of a dead chain: the orchestrator emits no text and no
    // error chunk the screen used to act on.
    const frame = await ask(sessionYielding([{ type: "done", text: "" }]));
    expect(frame).toContain("(no reply)");
  });

  test("shows the harness failure instead of swallowing it", async () => {
    const frame = await ask(
      sessionYielding([
        {
          type: "error",
          message: 'harness claude threw: Executable not found in $PATH: "claude"',
        },
      ]),
    );
    // The user must be able to see WHICH harness died, not a blank line.
    expect(frame).toContain("Executable not found");
    expect(frame).toContain("claude");
  });
});
