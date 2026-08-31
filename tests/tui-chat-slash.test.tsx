/**
 * Slash commands on screen 0, from the keyboard (phantombot#480).
 *
 * The session-level tests cover dispatch; these cover the half a user actually
 * touches — that `/status` never reaches `send`, that the type-ahead appears
 * and then gets out of the way, and that a command can be typed WHILE a turn
 * is running, which is the only time `/stop` is any use.
 */

import { describe, expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { render } from "ink";

import { ChatScreen } from "../src/tui/screens/Chat.tsx";
import type {
  ChatCommandResult,
  ChatMessage,
  ChatSession,
} from "../src/tui/chatSession.ts";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

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

/**
 * Colour is on in some runs and off in others depending on what else the suite
 * has touched, and an escape sequence in the middle of the string fails an
 * assertion for reasons that have nothing to do with commands.
 */
// eslint-disable-next-line no-control-regex
const lastFrame = (frames: string[]) =>
  (frames.at(-1) ?? "").replace(/\u001b\[[0-9;]*m/g, "");

interface Spy {
  session: ChatSession;
  sent: string[];
  commanded: string[];
}

function spySession(options: {
  reply?: string;
  afterSend?: () => Promise<void>;
  /** When true, `send` never returns: the screen stays busy. */
  hang?: boolean;
  /** Prior turns, to fill the window when the test needs a full screen. */
  history?: ChatMessage[];
} = {}): Spy {
  const sent: string[] = [];
  const commanded: string[] = [];
  const session: ChatSession = {
    persona: "lab",
    conversation: "cli:tui:lab",
    history: options.history ?? [],
    async *send(text: string) {
      sent.push(text);
      if (options.hang) {
        yield { type: "thinking" as const };
        await new Promise(() => {});
      }
    },
    async command(text: string): Promise<ChatCommandResult | null> {
      commanded.push(text);
      if (!text.startsWith("/") || text.includes(" is ")) return null;
      return { reply: options.reply ?? "pong", afterSend: options.afterSend };
    },
    async close() {},
  };
  return { session, sent, commanded };
}

async function mount(session: ChatSession) {
  const stdin = fakeStdin();
  const stdout = fakeStdout();
  const instance = render(
    <ChatScreen
      session={session}
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
  await sleep(50);
  return { stdin, stdout, instance };
}

describe("typing a slash command", () => {
  test("goes to the dispatcher, never to the harness, and shows the reply", async () => {
    const spy = spySession({ reply: "harness: claude · up 3m" });
    const { stdin, stdout, instance } = await mount(spy.session);
    try {
      stdin.write("/status\r");
      await sleep(150);
      expect(spy.commanded).toEqual(["/status"]);
      expect(spy.sent).toEqual([]);
      expect(lastFrame(stdout.frames)).toContain("up 3m");
    } finally {
      instance.unmount();
    }
  });

  test("ordinary text still goes to the harness", async () => {
    const spy = spySession();
    const { stdin, instance } = await mount(spy.session);
    try {
      stdin.write("hello there\r");
      await sleep(150);
      expect(spy.sent).toEqual(["hello there"]);
    } finally {
      instance.unmount();
    }
  });

  test("a path is typed at the phantom, not swallowed as a command", async () => {
    const spy = spySession();
    const { stdin, instance } = await mount(spy.session);
    try {
      stdin.write("/usr/bin/env is on PATH?\r");
      await sleep(150);
      expect(spy.commanded).toEqual([]);
      expect(spy.sent).toEqual(["/usr/bin/env is on PATH?"]);
    } finally {
      instance.unmount();
    }
  });

  test("works WHILE a turn is running — which is the only time /stop matters", async () => {
    const spy = spySession({ hang: true, reply: "stopped after 4.0s" });
    const { stdin, stdout, instance } = await mount(spy.session);
    try {
      stdin.write("something slow\r");
      await sleep(100);
      stdin.write("/stop\r");
      await sleep(150);
      expect(spy.commanded).toEqual(["/stop"]);
      expect(lastFrame(stdout.frames)).toContain("stopped after 4.0s");
    } finally {
      instance.unmount();
    }
  });

  test("the streaming reply is not overwritten by a command typed during it", async () => {
    // Both bubbles are appended to the same list; patching "the last message"
    // is what used to make the turn's text land in the command's bubble.
    const spy = spySession({ hang: true, reply: "no active turn to stop" });
    const { stdin, stdout, instance } = await mount(spy.session);
    try {
      stdin.write("first question\r");
      await sleep(100);
      stdin.write("/stop\r");
      await sleep(150);
      const frame = lastFrame(stdout.frames);
      expect(frame).toContain("first question");
      expect(frame).toContain("no active turn to stop");
    } finally {
      instance.unmount();
    }
  });

  test("afterSend runs only once the reply is on screen", async () => {
    const order: string[] = [];
    const spy = spySession({
      reply: "installed v9.9.9, restarting…",
      afterSend: async () => {
        order.push("afterSend");
      },
    });
    const { stdin, stdout, instance } = await mount(spy.session);
    try {
      stdin.write("/update\r");
      await sleep(200);
      expect(lastFrame(stdout.frames)).toContain("restarting");
      expect(order).toEqual(["afterSend"]);
    } finally {
      instance.unmount();
    }
  });
});

describe("the type-ahead", () => {
  test("appears as soon as the input opens with a slash", async () => {
    const spy = spySession();
    const { stdin, stdout, instance } = await mount(spy.session);
    try {
      stdin.write("/st");
      await sleep(100);
      const frame = lastFrame(stdout.frames);
      expect(frame).toContain("/status");
      expect(frame).toContain("/stop");
      expect(frame).not.toContain("/harness");
    } finally {
      instance.unmount();
    }
  });

  test("tab completes the command in the input box", async () => {
    const spy = spySession();
    const { stdin, stdout, instance } = await mount(spy.session);
    try {
      stdin.write("/sta");
      await sleep(60);
      stdin.write("\t");
      await sleep(100);
      expect(lastFrame(stdout.frames)).toContain("/status");
      // Completed, not sent: the user may still want an argument.
      expect(spy.commanded).toEqual([]);
    } finally {
      instance.unmount();
    }
  });

  test("does not push the frame off the bottom of a full screen", async () => {
    // On a screen that is already full the rows the menu takes come OUT of the
    // transcript, so the drawn height does not change — that is the invariant
    // the whole full-screen layout rests on, and a menu that simply grew the
    // column would scroll the alternate buffer and tear the frame.
    const history: ChatMessage[] = Array.from({ length: 40 }, (_, i) => ({
      role: i % 2 === 0 ? ("user" as const) : ("assistant" as const),
      text: `line ${i}`,
      at: 0,
    }));
    const spy = spySession({ history });
    const { stdin, stdout, instance } = await mount(spy.session);
    try {
    const rowsOf = (frame: string) => frame.split("\n").length;
    const transcriptRows = (frame: string) => frame.match(/line \d+/g)?.length ?? 0;
      const before = lastFrame(stdout.frames);
      expect(rowsOf(before)).toBeGreaterThan(20);
      stdin.write("/");
      await sleep(100);
      const after = lastFrame(stdout.frames);
      // Never taller than the terminal, and no taller than it already was —
      // within the one blank row Ink trims off the bottom of a frame.
      expect(rowsOf(after)).toBeLessThanOrEqual(30);
      expect(rowsOf(after) - rowsOf(before)).toBeLessThanOrEqual(1);
      // The rows came OUT of the transcript rather than being added to the box.
      expect(transcriptRows(after)).toBeLessThan(transcriptRows(before));
    } finally {
      instance.unmount();
    }
  });
});
