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
import { TranscriptStore } from "../src/tui/transcriptStore.ts";
import { TurnStore } from "../src/tui/turnRunner.ts";
import { TerminalSizeContext } from "../src/tui/terminal.ts";

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

/**
 * `ready` is text the settled frame must contain. It defaults to the user's
 * line, but a reply taller than the window scrolls that out of view, and
 * waiting for it would time out and hand back whatever frame came last.
 */
async function frameFor(
  text: string,
  ready = "go on then",
  columns = COLUMNS,
): Promise<string> {
  const frames: string[] = [];
  const stdout = new EventEmitter() as EventEmitter & {
    columns: number;
    rows: number;
    write: (c: string) => void;
  };
  stdout.columns = columns;
  stdout.rows = ROWS;
  stdout.write = (c: string) => void frames.push(c);
  const history: ChatMessage[] = [
    { role: "user", text: "go on then", at: 0 },
    { role: "assistant", text, at: 0 },
  ];
  const session: ChatSession = {
    persona: "lab",
    conversation: "cli:tui:lab",
    transcript: new TranscriptStore(history),
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
  // The transcript MEASURES with the size from context and Ink DRAWS at
  // `stdout.columns`; without the provider the first is the 80-column default
  // and the second is COLUMNS, so every width assertion here compared a
  // layout against a screen it was never computed for.
  const instance = render(
    <TerminalSizeContext.Provider value={{ rows: ROWS, columns }}>
      <ChatScreen
        session={session}
        status="claude"
        onSettings={() => {}}
        onQuit={() => {}}
      />
    </TerminalSizeContext.Provider>,
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
  for (let i = 0; i < 40 && !plain(frames.at(-1) ?? "").includes(ready); i += 1) {
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

  /**
   * The row invariant on the SCREEN: a list nested deeper than the window is
   * wide used to keep a four-column body on top of its indent, so Ink wrapped
   * each overhanging row onto extra physical rows the transcript had not
   * counted — the frame grew past the terminal and the footer went with it.
   */
  test("a list nested past the window width does not grow the frame", async () => {
    const deep = Array.from(
      { length: 35 },
      (_, d) => `${"  ".repeat(d)}- level ${d}`,
    ).join("\n") + "\n- end";
    const frame = await frameFor(deep, "• end");
    expect(frame).toContain("• end");
    // trimEnd: under the full suite Ink pads the frame with a trailing row of
    // spaces, which is not a drawn row.
    const rows = frame.trimEnd().split("\n");
    for (const row of rows) expect(row.length).toBeLessThanOrEqual(COLUMNS);
    expect(rows.length).toBeLessThanOrEqual(ROWS);
    const nonEmpty = rows.filter((l) => l.trim().length > 0);
    expect(nonEmpty.slice(-2).join(" ")).toContain("Send");
  });

  test("a table wider than the window does not shear the frame", async () => {
    const frame = await frameFor(
      "| a | b |\n| --- | --- |\n| " + "x".repeat(80) + " | y |",
    );
    for (const row of frame.split("\n")) {
      expect(row.length).toBeLessThanOrEqual(COLUMNS);
    }
    // The bottom rule is still the bottom rule: it is drawn by
    // `borderStyle`, and a compressed row is what used to push the bottom
    // chrome off screen — the footer must still be the last thing rendered.
    const nonEmpty = frame.split("\n").filter((l) => l.trim().length > 0);
    expect(nonEmpty.slice(-2).join(" ")).toContain("Send");
  });

  /**
   * Below the width a body can be wrapped to, rows would have to overhang the
   * window. The screen says so instead of drawing a transcript it cannot fit.
   */
  test("a terminal narrower than the minimum shows a notice, not rows", async () => {
    const frame = await frameFor("a reply nobody can read here", "narrow", 22);
    expect(frame).toContain("narrow");
    expect(frame).not.toContain("a reply");
    expect(frame).not.toContain("go on then");
  });
});
