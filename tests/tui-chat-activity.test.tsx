/**
 * The chat screen must SHOW that it is working (issue #471 follow-up).
 *
 * Reported symptom: "when I chat I see logs below and no thinking… so I don't
 * know what it's doing". The first cut printed a static `thinking…` inside the
 * input box — nothing on screen moved, so a twenty-second turn and a hung
 * process looked identical, and the label was not noticed at all.
 *
 * So the assertions here are about MOTION and about naming the current step,
 * not about a string being present somewhere: a static indicator passes
 * "contains thinking" and fails a user.
 */

import { describe, expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { render } from "ink";

import { ChatScreen } from "../src/tui/screens/Chat.tsx";
import { SPINNER_FRAMES } from "../src/tui/components/Spinner.tsx";
import type { ChatEvent, ChatSession } from "../src/tui/chatSession.ts";
import { TranscriptStore } from "../src/tui/transcriptStore.ts";

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

/** With `debug: true` every render rewrites the whole screen, so only the LAST
 * frame is the screen. Joining frames asserts against history, not state. */
const lastFrame = (frames: string[]) => frames.at(-1) ?? "";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** A turn that stays in flight: the state the indicator exists for. */
function pendingSession(events: ChatEvent[]): ChatSession {
  return {
    persona: "alice",
    conversation: "cli:tui:alice",
    transcript: new TranscriptStore([]),
    async *send() {
      for (const event of events) yield event;
      // Never returns: the harness is still working.
      await new Promise(() => {});
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

/** A turn that stays in flight AND records what was submitted. */
function recordingSession(sent: string[]): ChatSession {
  return {
    persona: "alice",
    conversation: "cli:tui:alice",
    transcript: new TranscriptStore([]),
    async *send(text: string) {
      sent.push(text);
      await new Promise(() => {});
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

const spinnerIn = (frame: string) =>
  SPINNER_FRAMES.filter((f) => frame.includes(f));

describe("chat input", () => {
  test("a chunk carrying a newline sends the line rather than typing it", async () => {
    // A paste, or a terminal batching keystrokes, arrives as one chunk. Ink
    // reports `key.return` only for a chunk that is exactly "\r", so this used
    // to insert a literal CR and never send.
    const { stdin, stdout, instance } = await mount(
      pendingSession([{ type: "thinking" }]),
    );
    try {
      stdin.write("hello there\r");
      await sleep(150);
      const frame = lastFrame(stdout.frames);
      expect(frame).toContain("hello there");
      expect(spinnerIn(frame).length).toBeGreaterThan(0);
    } finally {
      instance.unmount();
    }
  });
  test("a chunk that arrives while busy interrupts the turn and is sent", async () => {
    // Ink coalesces back-to-back stdin writes into one chunk, so a fast
    // typist's second message can arrive as `hello\r` while the first turn
    // is still in flight. It used to be swallowed and kept in the box (review
    // of 19ff85a: never lose it). The TUI now follows every other channel: a
    // prompt typed mid-turn interrupts the running turn and is then sent, so
    // the text is still never lost.
    const sent: string[] = [];
    const reasons: unknown[] = [];
    const session: ChatSession = {
      ...recordingSession(sent),
      async *send(text: string, signal?: AbortSignal) {
        sent.push(text);
        await new Promise<void>((resolve) =>
          signal?.addEventListener(
            "abort",
            () => {
              reasons.push(signal.reason);
              resolve();
            },
            { once: true },
          ),
        );
      },
    };
    const { stdin, instance } = await mount(session);
    try {
      stdin.write("first\r"); // starts a turn; screen goes busy
      await sleep(150);
      stdin.write("hello\r"); // coalesced chunk, arrives while busy
      await sleep(150);
      expect(reasons).toEqual(["interrupt"]);
      expect(sent).toEqual(["first", "hello"]);
    } finally {
      instance.unmount();
    }
  });
});

describe("chat activity indicator", () => {
  test("animates while a turn is in flight", async () => {
    const { stdin, stdout, instance } = await mount(
      pendingSession([{ type: "thinking" }]),
    );
    try {
      stdin.write("hi");
      stdin.write("\r");
      await sleep(120);
      const first = spinnerIn(lastFrame(stdout.frames));
      expect(first.length).toBeGreaterThan(0);
      // The frame must CHANGE. A static glyph is the bug being fixed.
      await sleep(300);
      const second = spinnerIn(lastFrame(stdout.frames));
      expect(second.length).toBeGreaterThan(0);
      expect(second[0]).not.toBe(first[0]);
    } finally {
      instance.unmount();
    }
  });

  test("counts the seconds, so a long turn never looks like a hang", async () => {
    const { stdin, stdout, instance } = await mount(
      pendingSession([{ type: "thinking" }]),
    );
    try {
      stdin.write("hi");
      stdin.write("\r");
      await sleep(150);
      expect(lastFrame(stdout.frames)).toContain("· 0s");
      await sleep(1200);
      expect(lastFrame(stdout.frames)).toContain("· 1s");
    } finally {
      instance.unmount();
    }
  });

  test("names the current step, and says so when it is only thinking", async () => {
    const { stdin, stdout, instance } = await mount(
      pendingSession([
        { type: "thinking" },
        { type: "tool", index: 0, title: "gh release view" },
      ]),
    );
    try {
      stdin.write("hi");
      stdin.write("\r");
      await sleep(150);
      // The activity line tracks the live step rather than freezing on a word.
      expect(lastFrame(stdout.frames)).toContain("gh release view");
      expect(lastFrame(stdout.frames)).toContain("ctrl+c interrupts");
    } finally {
      instance.unmount();
    }
  });

  test("a reasoning replay shows on the activity line, never as a tool row (#551)", async () => {
    const { stdin, stdout, instance } = await mount(
      pendingSession([
        { type: "tool", index: 0, title: "gh release view" },
        { type: "reasoning", text: "reasoning: cross-checking the release notes" },
      ]),
    );
    try {
      stdin.write("hi");
      stdin.write("\r");
      await sleep(150);
      const frame = lastFrame(stdout.frames);
      // The replay text is the live activity label...
      expect(frame).toContain("reasoning: cross-checking the release");
      // ...but it NEVER becomes a transcript tool row (and the in-flight tool
      // row is not closed early — one tool row, still running).
      expect(frame.split("gh release view").length - 1).toBe(1);
    } finally {
      instance.unmount();
    }
  });

  test("the indicator is gone once the turn finishes", async () => {
    const session: ChatSession = {
      persona: "alice",
      conversation: "cli:tui:alice",
      transcript: new TranscriptStore([]),
      async *send() {
        yield { type: "text", text: "hello back" } as ChatEvent;
        yield { type: "done", text: "hello back" } as ChatEvent;
      },
      async command() {
        return null;
      },
      async reloadHarnesses() {
        return [];
      },
      async close() {},
    };
    const { stdin, stdout, instance } = await mount(session);
    try {
      stdin.write("hi");
      stdin.write("\r");
      await sleep(200);
      const frame = lastFrame(stdout.frames);
      expect(frame).toContain("hello back");
      expect(spinnerIn(frame)).toHaveLength(0);
    } finally {
      instance.unmount();
    }
  });
});

describe("message timestamps", () => {
  test("history with no stored time shows no time, rather than claiming now", async () => {
    // Turns loaded from the memory store arrive with `at: 0`. Stamping them
    // with `new Date()` labelled a thread from last week with this minute.
    const session: ChatSession = {
      persona: "alice",
      conversation: "cli:tui:alice",
      transcript: new TranscriptStore([{ role: "user", text: "from yesterday", at: 0 }]),
      async *send() {},
      async command() {
        return null;
      },
      async reloadHarnesses() {
        return [];
      },
      async close() {},
    };
    const { stdout, instance } = await mount(session);
    try {
      const frame = lastFrame(stdout.frames);
      expect(frame).toContain("from yesterday");
      expect(frame).not.toMatch(/from yesterday[\s\S]*?\d\d:\d\d/);
      expect(frame).not.toMatch(/you\s+\d\d:\d\d/);
    } finally {
      instance.unmount();
    }
  });
});
