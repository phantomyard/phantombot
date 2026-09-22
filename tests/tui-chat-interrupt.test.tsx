/**
 * Stopping or interrupting a TUI turn (2026-09-16).
 *
 * Two halves, each at its call site:
 *   - the SESSION keeps the user's message in history when a turn is aborted
 *     (runTurn only writes on success), via the shared core/interrupted.ts
 *     helper every channel uses, and skips "reset" like the others do;
 *   - the SCREEN aborts with the reason the other channels use: ^c is "stop",
 *     a prompt typed mid-turn is "interrupt" and is then sent, in order.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { TranscriptStore } from "../src/tui/transcriptStore.ts";
import { EventEmitter } from "node:events";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { render } from "ink";

import type { Config } from "../src/config.ts";
import type {
  Harness,
  HarnessChunk,
  HarnessRequest,
} from "../src/harnesses/types.ts";
import { type MemoryStore, openMemoryStore } from "../src/memory/store.ts";
import { ChatScreen } from "../src/tui/screens/Chat.tsx";
import {
  openChat,
  type ChatEvent,
  type ChatSession,
} from "../src/tui/chatSession.ts";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const CTRL_C = String.fromCharCode(3);
const ESC = String.fromCharCode(27);

let store: MemoryStore;
let dir: string;

beforeEach(async () => {
  store = await openMemoryStore(":memory:");
  dir = await mkdtemp(join(tmpdir(), "tui-interrupt-"));
  await mkdir(join(dir, "lab"), { recursive: true });
  await writeFile(join(dir, "lab", "SOUL.md"), "You are lab.\n");
});

afterEach(async () => {
  await store.close();
  await rm(dir, { recursive: true, force: true });
});

function config(): Config {
  return {
    personasDir: dir,
    harnessIdleTimeoutMs: 5000,
    harnessHardTimeoutMs: 5000,
    embeddings: { provider: "none" },
    harnesses: {
      chain: [],
      claude: { bin: "claude", model: "" },
      pi: { bin: "pi", model: "" },
    },
  } as unknown as Config;
}

/** Streams a little text, blocks until aborted, then errors like a killed harness. */
function blockingHarness(): Harness {
  return {
    id: "block",
    available: async () => true,
    async *invoke(req: HarnessRequest): AsyncGenerator<HarnessChunk> {
      yield { type: "text", text: "working on it" };
      await new Promise<void>((resolve) => {
        if (req.signal?.aborted) return resolve();
        req.signal?.addEventListener("abort", () => resolve(), { once: true });
      });
      yield { type: "error", error: "aborted", recoverable: false };
    },
  };
}

function answeringHarness(): Harness {
  return {
    id: "ok",
    available: async () => true,
    async *invoke(): AsyncGenerator<HarnessChunk> {
      yield { type: "text", text: "done it" };
      yield { type: "done", finalText: "done it" };
    },
  };
}

async function runAborted(reason: string) {
  const chat = await openChat({
    config: config(),
    persona: "lab",
    memory: store,
    harnesses: [blockingHarness()],
  });
  const controller = new AbortController();
  const events: ChatEvent[] = [];
  for await (const e of chat.send("yes, apply it to all 7", controller.signal)) {
    events.push(e);
    if (e.type === "text") controller.abort(reason);
  }
  const turns = await store.recentTurns("lab", chat.conversation, 10);
  await chat.close();
  return { events, turns };
}

describe("TUI session: an aborted turn", () => {
  for (const reason of ["stop", "interrupt"]) {
    test(`keeps the user's message in history (${reason})`, async () => {
      const { events, turns } = await runAborted(reason);
      expect(turns.map((t) => [t.role, t.text])).toEqual([
        ["user", "yes, apply it to all 7"],
        ["assistant", "working on it\n\n[interrupted before reply]"],
      ]);
      // A stop is not a failure: no red error under the bubble.
      expect(events.some((e) => e.type === "error")).toBe(false);
    });
  }

  test("writes nothing on /reset, whose watermark it would sit above", async () => {
    const { turns } = await runAborted("reset");
    expect(turns).toEqual([]);
  });

  test("a finished turn is not written twice", async () => {
    const chat = await openChat({
      config: config(),
      persona: "lab",
      memory: store,
      harnesses: [answeringHarness()],
    });
    for await (const _ of chat.send("hi")) void _;
    const turns = await store.recentTurns("lab", chat.conversation, 10);
    await chat.close();
    expect(turns.map((t) => t.text)).toEqual(["hi", "done it"]);
  });
});

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
  const s = new EventEmitter() as EventEmitter & {
    columns: number;
    rows: number;
    write: (c: string) => void;
    frames: string[];
  };
  s.columns = 100;
  s.rows = 30;
  s.frames = [];
  s.write = (c: string) => void s.frames.push(c);
  return s;
}

const lastFrame = (frames: string[]) =>
  (frames.at(-1) ?? "").replace(new RegExp(`${ESC}\\[[0-9;]*m`, "g"), "");

/** Records sends and the abort reason each turn ended with. */
function abortableSession() {
  const sent: string[] = [];
  const reasons: unknown[] = [];
  const session: ChatSession = {
    persona: "lab",
    conversation: "cli:tui:lab",
    transcript: new TranscriptStore([]),
    async *send(text: string, signal?: AbortSignal) {
      sent.push(text);
      yield { type: "thinking" as const };
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
      yield { type: "done" as const, text: "" };
    },
    async command() {
      return null;
    },
    async reloadHarnesses() {
      return [];
    },
    async close() {},
  };
  return { session, sent, reasons };
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

describe("TUI screen: interrupting a turn", () => {
  test("a prompt typed mid-turn interrupts it, then is sent", async () => {
    const spy = abortableSession();
    const { stdin, stdout, instance } = await mount(spy.session);
    try {
      stdin.write("first");
      stdin.write("\r");
      await sleep(150);
      stdin.write("actually, second");
      await sleep(50);
      stdin.write("\r");
      await sleep(200);
      expect(spy.reasons).toEqual(["interrupt"]);
      expect(spy.sent).toEqual(["first", "actually, second"]);
      expect(lastFrame(stdout.frames)).toContain("(interrupted)");
    } finally {
      instance.unmount();
    }
  });

  test("^c stops with the same reason /stop uses", async () => {
    const spy = abortableSession();
    const { stdin, instance } = await mount(spy.session);
    try {
      stdin.write("first");
      stdin.write("\r");
      await sleep(150);
      stdin.write(CTRL_C);
      await sleep(150);
      expect(spy.reasons).toEqual(["stop"]);
      expect(spy.sent).toEqual(["first"]);
    } finally {
      instance.unmount();
    }
  });
});
