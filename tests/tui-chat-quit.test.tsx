/**
 * `/quit`, `/q` and `/exit` leave the terminal chat (#731).
 *
 * Reported: "/q to quit phantombot tui" answered "unknown command /q". These
 * go through a REAL session (`openChat`), so the command is recognised where
 * every other command is, and then check that each surface acts on it: the
 * full-screen chat as `Ctrl-Q` does, line mode as `Ctrl-D` does. The model
 * must never see the text.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { render } from "ink";

import type { Config } from "../src/config.ts";
import type { Harness, HarnessChunk } from "../src/harnesses/types.ts";
import { type MemoryStore, openMemoryStore } from "../src/memory/store.ts";
import { type ChatSession, openChat } from "../src/tui/chatSession.ts";
import { replLoop } from "../src/tui/index.tsx";
import { ChatScreen } from "../src/tui/screens/Chat.tsx";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
// eslint-disable-next-line no-control-regex
const plain = (s: string) => s.replace(/\u001b\[[0-9;]*m/g, "");

let store: MemoryStore;
let dir: string;
let prompts: string[];

beforeEach(async () => {
  store = await openMemoryStore(":memory:");
  dir = await mkdtemp(join(tmpdir(), "tui-chat-quit-"));
  await mkdir(join(dir, "lab"), { recursive: true });
  await writeFile(join(dir, "lab", "SOUL.md"), "You are lab.\n");
  prompts = [];
});

afterEach(async () => {
  await store.close();
  await rm(dir, { recursive: true, force: true });
});

function config(): Config {
  return {
    personasDir: dir,
    harnesses: {
      chain: [],
      claude: { bin: "claude", model: "" },
      pi: { bin: "pi", model: "" },
    },
  } as unknown as Config;
}

/** A harness that records every prompt it is asked to answer. */
function spyHarness(): Harness {
  return {
    id: "claude",
    available: async () => true,
    async *invoke(req): AsyncGenerator<HarnessChunk> {
      prompts.push(String((req as { userMessage?: unknown }).userMessage ?? req));
      yield { type: "text", text: "an answer" };
    },
  } as Harness;
}

function session(): Promise<ChatSession> {
  return openChat({
    config: config(),
    persona: "lab",
    memory: store,
    harnesses: [spyHarness()],
  });
}

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
  s.columns = 120;
  s.rows = 30;
  s.frames = frames;
  s.write = (c: string) => void frames.push(c);
  return s;
}

async function mount(chat: ChatSession) {
  let quits = 0;
  const stdin = fakeStdin();
  const stdout = fakeStdout();
  const instance = render(
    <ChatScreen
      session={chat}
      status="claude"
      onSettings={() => {}}
      onQuit={() => void quits++}
    />,
    {
      stdin: stdin as unknown as NodeJS.ReadStream,
      stdout: stdout as unknown as NodeJS.WriteStream,
      debug: true,
      exitOnCtrlC: false,
    },
  );
  await sleep(50);
  const type = async (bytes: string) => {
    stdin.write(bytes);
    await sleep(150);
  };
  return { stdout, instance, type, quits: () => quits };
}

async function* lines(...items: string[]): AsyncGenerator<string> {
  for (const item of items) yield item;
}

describe("the session answers /quit (#731)", () => {
  test("/quit, /q and /exit ask the surface to quit, and never reach the model", async () => {
    const chat = await session();
    try {
      for (const text of ["/quit", "/q", "/exit", "/QUIT"]) {
        const result = await chat.command(text);
        expect(result?.quit).toBe(true);
      }
      expect(prompts).toEqual([]);
    } finally {
      await chat.close();
    }
  });

  test("/help in the terminal lists /quit, after the shared commands", async () => {
    const chat = await session();
    try {
      const reply = (await chat.command("/help"))?.reply ?? "";
      expect(reply).toContain("/status — ");
      expect(reply).toMatch(/\n\/quit — .*service keeps running/);
      expect(reply.indexOf("/quit")).toBeGreaterThan(reply.indexOf("/help"));
      expect((await chat.command("/help"))?.quit).toBeUndefined();
    } finally {
      await chat.close();
    }
  });

  test("a near miss is still an unknown command, not a quit", async () => {
    const chat = await session();
    try {
      const result = await chat.command("/quiet");
      expect(result?.quit).toBeUndefined();
      expect(result?.reply).toContain("unknown command /quiet");
    } finally {
      await chat.close();
    }
  });
});

describe("the full-screen chat quits on /quit, as Ctrl-Q does (#731)", () => {
  for (const typed of ["/quit", "/q", "/exit"]) {
    test(`${typed} + Enter quits`, async () => {
      const chat = await session();
      const { instance, type, quits } = await mount(chat);
      try {
        await type(`${typed}\r`);
        expect(quits()).toBe(1);
        expect(prompts).toEqual([]);
      } finally {
        instance.unmount();
        await chat.close();
      }
    });
  }

  test("/q in the box offers /quit in the type-ahead", async () => {
    const chat = await session();
    const { stdout, instance, type, quits } = await mount(chat);
    try {
      await type("/q");
      expect(plain(stdout.frames.at(-1) ?? "")).toContain("/quit");
      expect(quits()).toBe(0);
    } finally {
      instance.unmount();
      await chat.close();
    }
  });
});

describe("--no-tui line mode ends on /quit, as Ctrl-D does (#731)", () => {
  test("control: a plain line does reach the model, so the checks below can fail", async () => {
    const chat = await session();
    let out = "";
    try {
      await replLoop(chat, lines("hello"), { write: (c) => void (out += c) });
      expect(prompts).toHaveLength(1);
      expect(out).toContain("an answer");
    } finally {
      await chat.close();
    }
  });

  test("stops reading: the line after /q never reaches the model", async () => {
    const chat = await session();
    let out = "";
    try {
      const code = await replLoop(chat, lines("/q", "hello"), {
        write: (c) => void (out += c),
      });
      expect(code).toBe(0);
      expect(prompts).toEqual([]);
      expect(out).toBe("");
    } finally {
      await chat.close();
    }
  });

  test("/help there lists /quit too, so it never advertises a command it lacks", async () => {
    const chat = await session();
    let out = "";
    try {
      await replLoop(chat, lines("/help"), { write: (c) => void (out += c) });
      expect(out).toContain("/quit — ");
    } finally {
      await chat.close();
    }
  });
});
