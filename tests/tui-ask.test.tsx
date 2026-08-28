/**
 * A typed value and a list choice are SCREENS, not a drop back to the shell.
 *
 * These were the last two questions drawn by `@clack`: setting a credential,
 * and picking which identity file to open. Both suspended Ink and drew on the
 * user's normal terminal with no header, no footer and no `esc` — the break in
 * the design language the confirm screen already closed for yes/no.
 *
 * The assertions that matter are about SAFETY, not looks: a masked field must
 * never render the value it is protecting, and cancelling must resolve
 * `undefined` rather than `""` — an empty string reaches `setSecret` and
 * erases a credential the user only meant to look at.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { render } from "ink";

import { AskScreen } from "../src/tui/screens/Ask.tsx";
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
  stdout.columns = 100;
  stdout.rows = 40;
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
      await sleep(40);
    },
  };
}

describe("the value question is an app screen", () => {
  test("it wears the frame's chrome and never echoes a masked value", async () => {
    const answers: Array<string | undefined> = [];
    const app = mount(
      <AskScreen
        request={{
          title: "Set OPENAI_API_KEY for alice",
          hint: "written straight to the persona vault",
          masked: true,
        }}
        onAnswer={(v) => answers.push(v)}
      />,
    );
    await app.press("sk-secret");
    const frame = app.frame();
    expect(frame).toContain("Set OPENAI_API_KEY for alice");
    expect(frame).toContain("Save");
    expect(frame).toContain("Back");
    // The whole point of masking: the value is not in the frame, only its
    // length. A frame that echoes it puts the secret in the scrollback the
    // vault exists to keep it out of.
    expect(frame).not.toContain("sk-secret");
    expect(frame).toContain("•".repeat("sk-secret".length));
    await app.press("\r");
    expect(answers).toEqual(["sk-secret"]);
  });

  test("esc cancels as undefined, never as an empty string", async () => {
    const answers: Array<string | undefined> = [];
    const app = mount(
      <AskScreen
        request={{ title: "Set TOKEN", masked: true }}
        onAnswer={(v) => answers.push(v)}
      />,
    );
    await app.press("abc");
    await app.press("\x1b");
    expect(answers).toEqual([undefined]);
  });

  test("an empty box is not an answer", async () => {
    // Enter on nothing must not write "" over a credential that is already set.
    const answers: Array<string | undefined> = [];
    const app = mount(
      <AskScreen request={{ title: "Set TOKEN" }} onAnswer={(v) => answers.push(v)} />,
    );
    await app.press("\r");
    expect(answers).toEqual([]);
  });
});

describe("the list question is an app screen", () => {
  const request = {
    title: "Which file for alice?",
    options: [
      { value: "/p/SOUL.md", label: "SOUL.md" },
      { value: "/p/USER.md", label: "USER.md", hint: "does not exist yet" },
    ],
  };

  test("it moves with ↑↓ and answers with the row under the cursor", async () => {
    const answers: Array<string | undefined> = [];
    const app = mount(
      <ChooseScreen request={request} onAnswer={(v) => answers.push(v)} />,
    );
    const frame = app.frame();
    expect(frame).toContain("Which file for alice?");
    expect(frame).toContain("SOUL.md");
    expect(frame).toContain("does not exist yet");
    expect(frame).toContain("Back");
    await app.press("\x1b[B");
    await app.press("\r");
    // Answering the SECOND row is the assertion: with one option, a hardcoded
    // answer would pass.
    expect(answers).toEqual(["/p/USER.md"]);
  });

  test("esc picks nothing at all", async () => {
    const answers: Array<string | undefined> = [];
    const app = mount(
      <ChooseScreen request={request} onAnswer={(v) => answers.push(v)} />,
    );
    await app.press("\x1b");
    expect(answers).toEqual([undefined]);
  });
});
