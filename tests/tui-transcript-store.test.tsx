/**
 * The transcript lives on the session, not the screen (phantombot#604).
 *
 * A session used to carry a one-shot `history` snapshot, and `ChatScreen`
 * kept the live transcript in screen-local state. Every navigation away from
 * chat (`^l`, `^s`, …) unmounted the screen and destroyed it; coming back
 * re-seeded from the stale snapshot, and the current session vanished from
 * the screen. These pin the new contract: the session's `transcript` store
 * IS the visible history, and a remounted screen renders whatever it holds.
 */

import { describe, expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { render } from "ink";

import { ChatScreen } from "../src/tui/screens/Chat.tsx";
import type { ChatEvent, ChatMessage, ChatSession } from "../src/tui/chatSession.ts";
import { createTurnRunner } from "../src/tui/turnRunner.ts";
import { TranscriptStore } from "../src/tui/transcriptStore.ts";

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

// eslint-disable-next-line no-control-regex
const lastFrame = (frames: string[]) =>
  (frames.at(-1) ?? "").replace(/\u001b\[[0-9;]*m/g, "");

/** A session whose harness answers with one streamed line. */
function echoSession(prior: ChatSession["transcript"]): ChatSession {
  async function* send(text: string): AsyncGenerator<ChatEvent> {
    yield { type: "text", text: `echo: ${text}` };
    yield { type: "done", text: `echo: ${text}` };
  }
  const runner = createTurnRunner(send, prior);
  return {
    persona: "lab",
    conversation: "cli:tui:lab",
    transcript: prior,
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

describe("the session transcript store", () => {
  test("snapshot identity is stable between mutations and new on each", () => {
    const user = (text: string): ChatMessage => ({ role: "user", text, at: 0 });
    const store = new TranscriptStore();
    const before = store.getSnapshot();
    expect(before).toBe(store.getSnapshot());
    store.append(user("hi"));
    const after = store.getSnapshot();
    expect(after).not.toBe(before);
    expect(after.map((m) => m.text)).toEqual(["hi"]);
    expect(store.getSnapshot()).toBe(after);
  });

  test("append notifies exactly the live subscribers", () => {
    const store = new TranscriptStore();
    const seen: number[] = [];
    const user = (text: string): ChatMessage => ({ role: "user", text, at: 0 });
    const a = () => void seen.push(1);
    const b = () => void seen.push(2);
    const offA = store.subscribe(a);
    store.subscribe(b);
    store.append(user("hi"));
    offA();
    store.append({ role: "assistant", text: "hello", at: 0 });
    expect(seen).toEqual([1, 2, 2]);
  });

  test("patch rebinds the caller's slot to the replacement", () => {
    const store = new TranscriptStore();
    const slot: ChatMessage = { role: "assistant", text: "", at: 0 };
    const user = (text: string): ChatMessage => ({ role: "user", text, at: 0 });
    store.append(user("hi"), slot);
    const next = store.patch(slot, (m) => ({ ...m, text: "hello" }));
    expect(next).not.toBe(slot);
    // The caller keeps patching `next`, exactly like the streaming loop.
    const stillThere = store.patch(next, (m) => ({ ...m, error: "boom" }));
    expect(stillThere.text).toBe("hello");
    expect(store.getSnapshot().map((m) => [m.role, m.text, m.error])).toEqual([
      ["user", "hi", undefined],
      ["assistant", "hello", "boom"],
    ]);
  });

  test("a stale slot (racing a session switch) patches nothing, throws never", () => {
    const store = new TranscriptStore();
    const orphan: ChatMessage = { role: "assistant", text: "", at: 0 };
    expect(store.patch(orphan, (m) => ({ ...m, text: "x" }))).toBe(orphan);
    expect(store.getSnapshot()).toEqual([]);
  });
});

describe("a screen that unmounts and comes back (phantombot#604)", () => {
  test("keeps the whole session's exchanges — the transcript is the session's", async () => {
    const session = echoSession(new TranscriptStore());
    const first = await mount(session);
    try {
      first.stdin.write("still there?\r");
      await sleep(150);
      expect(lastFrame(first.stdout.frames)).toContain("still there?");
      expect(lastFrame(first.stdout.frames)).toContain("echo: still there?");
    } finally {
      first.instance.unmount();
    }
    // Navigation away (^l, ^s, …) unmounted the screen; this is coming back.
    // On the old code this remount re-seeded from the stale open-time
    // snapshot and BOTH exchanges were missing from the frame.
    const second = await mount(session);
    try {
      const frame = lastFrame(second.stdout.frames);
      expect(frame).toContain("still there?");
      expect(frame).toContain("echo: still there?");
    } finally {
      second.instance.unmount();
    }
  });

  test("a remounted screen also shows what existed before it opened", async () => {
    const prior = new TranscriptStore([
      { role: "user", text: "from yesterday", at: 0 },
      { role: "assistant", text: "welcome back", at: 0 },
    ]);
    const session = echoSession(prior);
    const { stdin, stdout, instance } = await mount(session);
    try {
      stdin.write("today's question\r");
      await sleep(150);
      const frame = lastFrame(stdout.frames);
      expect(frame).toContain("from yesterday");
      expect(frame).toContain("today's question");
    } finally {
      instance.unmount();
    }
  });
});