/**
 * The searchable list screen.
 *
 * Pi's provider catalogue and OpenRouter's model list are long enough that a
 * plain picker both lags and buries the row you want. This screen's contract:
 * typing filters, only a 50-row window ever renders, pasting a whole id works
 * in one chunk, an empty match degrades to free-text (never a dead end), and
 * esc cancels to `undefined`.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { render } from "ink";

import { SearchListScreen } from "../src/tui/screens/SearchList.tsx";
import { ChooseScreen } from "../src/tui/screens/Choose.tsx";
import { stripAnsi } from "./helpers/ansi.ts";

let mounted: Array<() => void> = [];
afterEach(() => {
  for (const c of mounted) c();
  mounted = [];
});

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function mount(node: React.ReactElement) {
  const stdin = new PassThrough() as PassThrough & {
    isTTY: boolean;
    setRawMode: () => void;
    ref: () => void;
    unref: () => void;
  };
  stdin.isTTY = true;
  stdin.setRawMode = () => {};
  stdin.ref = () => {};
  stdin.unref = () => {};
  const frames: string[] = [];
  const stdout = new EventEmitter() as EventEmitter & {
    columns: number;
    rows: number;
    write: (c: string) => void;
  };
  stdout.columns = 120;
  stdout.rows = 60;
  stdout.write = (c: string) => void frames.push(c);
  const instance = render(node, {
    stdin: stdin as never,
    stdout: stdout as never,
    exitOnCtrlC: false,
    patchConsole: false,
    debug: true,
  });
  mounted.push(() => instance.unmount());
  return {
    frame: () => stripAnsi(frames.at(-1) ?? ""),
    press: async (bytes: string) => {
      stdin.write(bytes);
      await sleep(60);
    },
  };
}

const MANY = Array.from({ length: 300 }, (_, i) => ({
  value: `model-${i}`,
  label: `org/model-${i}`,
  hint: i === 7 ? "vision" : undefined,
}));

describe("the searchable list screen", () => {
  test("typing filters the list and reports the count", async () => {
    const answers: Array<string | undefined> = [];
    const app = mount(
      <SearchListScreen
        request={{ title: "Pi model", banner: "Selecting the PRIMARY model", options: MANY }}
        onAnswer={(v) => answers.push(v)}
      />,
    );
    await app.press("model-29");
    const frame = app.frame();
    // Substring match: model-29 itself plus model-290…299.
    expect(frame).toContain("11/300");
    expect(frame).toContain("org/model-29");
    expect(frame).not.toContain("org/model-30 ");
  });

  test("a 300-option list renders at most a 50-row window", async () => {
    const answers: Array<string | undefined> = [];
    const app = mount(
      <SearchListScreen
        request={{ title: "Pi model", options: MANY }}
        onAnswer={(v) => answers.push(v)}
      />,
    );
    await sleep(60);
    const frame = app.frame();
    expect(frame).toContain("300/300");
    const renderedRows = frame.split("\n").filter((l) => l.includes("org/model-")).length;
    expect(renderedRows).toBeLessThanOrEqual(50);
    expect(renderedRows).toBeGreaterThan(10);
    // The window is centred on the cursor — row 0 is in the first window.
    expect(frame).toContain("org/model-0");
  });

  test("pasting a whole model id filters in one chunk", async () => {
    const answers: Array<string | undefined> = [];
    const app = mount(
      <SearchListScreen
        request={{ title: "Pi model", options: MANY }}
        onAnswer={(v) => answers.push(v)}
      />,
    );
    // One write, many characters: what a terminal paste looks like.
    await app.press("model-123");
    expect(app.frame()).toContain("org/model-123");
    await app.press("\r");
    expect(answers).toEqual(["model-123"]);
  });

  test("a newline inside a pasted chunk is not a submit", async () => {
    const answers: Array<string | undefined> = [];
    const app = mount(
      <SearchListScreen
        request={{ title: "Pi model", options: MANY }}
        onAnswer={(v) => answers.push(v)}
      />,
    );
    await app.press("model-4\ntrailing");
    // The newline is whitespace inside the query, NOT a submit — the screen
    // filters, it does not answer.
    expect(answers).toEqual([]);
    expect(app.frame()).toContain('use "model-4 trailing" as typed');
  });

  test("no match degrades to a free-text row that answers the query", async () => {
    const answers: Array<string | undefined> = [];
    const app = mount(
      <SearchListScreen
        request={{ title: "Pi model", options: MANY }}
        onAnswer={(v) => answers.push(v)}
      />,
    );
    await app.press("gpt-5.2");
    expect(app.frame()).toContain('use "gpt-5.2" as typed');
    await app.press("\r");
    expect(answers).toEqual(["gpt-5.2"]);
  });

  test("esc cancels to undefined, even mid-search", async () => {
    const answers: Array<string | undefined> = [];
    const app = mount(
      <SearchListScreen
        request={{ title: "Pi model", options: MANY }}
        onAnswer={(v) => answers.push(v)}
      />,
    );
    await app.press("model-9");
    await app.press("\x1b");
    expect(answers).toEqual([undefined]);
  });

  test("backspace narrows the query again", async () => {
    const answers: Array<string | undefined> = [];
    const app = mount(
      <SearchListScreen
        request={{ title: "Pi model", options: MANY }}
        onAnswer={(v) => answers.push(v)}
      />,
    );
    await app.press("model-29");
    await app.press("\x7f");
    expect(app.frame()).toContain("111/300");
  });
});

describe("the choose screen's description", () => {
  test("renders the description under the title", async () => {
    const answers: Array<string | undefined> = [];
    const app = mount(
      <ChooseScreen
        request={{
          title: "Primary brain",
          description: "The primary brain answers every turn first.",
          options: [{ value: "pi", label: "Pi", hint: "recommended" }],
          initial: "pi",
        }}
        onAnswer={(v) => answers.push(v)}
      />,
    );
    await sleep(60);
    expect(app.frame()).toContain("The primary brain answers every turn first.");
    await app.press("\r");
    expect(answers).toEqual(["pi"]);
  });
});
