/**
 * Markdown on the chat screen (phantombot#481).
 *
 * `tui-markdown.test.ts` pins the renderer; this pins the half that only shows
 * up once Ink has laid it out — that a blank markdown row still DRAWS a row
 * (an empty box collapses to zero height, and a row that measures one and
 * draws none puts every scroll offset below it out by one), and that a table
 * wider than the window cannot shear the frame.
 */

import { describe, expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { render } from "ink";

import { ChatScreen } from "../src/tui/screens/Chat.tsx";
import type { ChatMessage, ChatSession } from "../src/tui/chatSession.ts";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Colour is on in some runs and off in others (it depends on what else the
 * suite has touched), and an escape sequence sitting between `•` and `alpha`
 * fails an assertion about markdown for no reason to do with markdown.
 */
// eslint-disable-next-line no-control-regex
const plain = (frame: string) => frame.replace(/\u001b\[[0-9;]*m/g, "");
const COLUMNS = 60;
const ROWS = 30;

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

async function frameFor(text: string): Promise<string> {
  const frames: string[] = [];
  const stdout = new EventEmitter() as EventEmitter & {
    columns: number;
    rows: number;
    write: (c: string) => void;
  };
  stdout.columns = COLUMNS;
  stdout.rows = ROWS;
  stdout.write = (c: string) => void frames.push(c);
  const history: ChatMessage[] = [
    { role: "user", text: "go on then", at: 0 },
    { role: "assistant", text, at: 0 },
  ];
  const session: ChatSession = {
    persona: "lab",
    conversation: "cli:tui:lab",
    history,
    async *send() {},
    async command() {
      return null;
    },
    async close() {},
  };
  const instance = render(
    <ChatScreen
      session={session}
      status="claude"
      onSettings={() => {}}
      onQuit={() => {}}
    />,
    {
      stdin: fakeStdin() as unknown as NodeJS.ReadStream,
      stdout: stdout as unknown as NodeJS.WriteStream,
      debug: true,
      exitOnCtrlC: false,
    },
  );
  // Wait for a frame that actually contains the transcript rather than for a
  // fixed delay: under a loaded suite the first paint can be the empty box,
  // and asserting on it fails for reasons that have nothing to do with
  // markdown.
  for (let i = 0; i < 40 && !plain(frames.at(-1) ?? "").includes("go on then"); i += 1) {
    await sleep(25);
  }
  instance.unmount();
  return plain(frames.at(-1) ?? "");
}

describe("a rendered reply", () => {
  test("keeps its blank lines as drawn rows", async () => {
    const frame = await frameFor("one\n\ntwo");
    expect(frame).toMatch(/one\n\s*\n\s*two/);
  });

  test("shows headings, bullets and code without their markup", async () => {
    const frame = await frameFor("## Title\n\n- alpha\n\n```sh\nls -la\n```");
    expect(frame).toContain("Title");
    expect(frame).not.toContain("## Title");
    expect(frame).toContain("• alpha");
    expect(frame).toContain("ls -la");
    expect(frame).not.toContain("```");
  });

  test("a table wider than the window does not shear the frame", async () => {
    const frame = await frameFor(
      "| a | b |\n| --- | --- |\n| " + "x".repeat(80) + " | y |",
    );
    for (const row of frame.split("\n")) {
      expect(row.length).toBeLessThanOrEqual(COLUMNS);
    }
    // The bottom border is still the bottom border: it is drawn by
    // `borderStyle`, and a compressed row is what used to push it off screen.
    expect(frame).toContain("╰");
  });
});
