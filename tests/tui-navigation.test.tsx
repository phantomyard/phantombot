/**
 * Two keys, two screens (issue #471 follow-up).
 *
 * Reported: "s settings and p phantom take me to the same screen", and "t
 * tools does not work". Both were real and both were invisible to the suite:
 *
 *   - `^s` and `^p` were wired to the SAME callback target, so the settings
 *     key for the phantom you are talking to answered with a host-wide table.
 *   - `^t` toggled a flag that changed nothing on screen: collapsed and
 *     expanded both rendered `tool.title.split("\n")[0]`, and a progress note
 *     is one line long. The key was handled, the state changed, and the user
 *     correctly reported it as broken.
 *
 * So these assert what is ON SCREEN after the keypress, never that a handler
 * ran — a handler firing was exactly the state the broken build was in.
 */

import { describe, expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { render } from "ink";

import { ChatScreen } from "../src/tui/screens/Chat.tsx";
import type { ChatSession } from "../src/tui/chatSession.ts";

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
/** `debug: true` rewrites the whole screen on every render: only the last write is it. */
const last = (frames: string[]) => frames.at(-1) ?? "";

function sessionWithTools(): ChatSession {
  return {
    persona: "alice",
    conversation: "cli:tui:alice",
    history: [
      { role: "user", text: "ship it", at: 0 },
      {
        role: "assistant",
        text: "done",
        at: 0,
        tools: [
          { title: "gh release view", startedAt: 0, durationMs: 1200 },
          { title: "bun test", startedAt: 0, durationMs: 3400 },
        ],
      },
    ],
    async *send() {},
    async close() {},
  };
}

async function mountChat() {
  const stdin = fakeStdin();
  const stdout = fakeStdout();
  const pressed: string[] = [];
  const instance = render(
    <ChatScreen
      session={sessionWithTools()}
      status="claude"
      onSettings={() => pressed.push("settings")}
      onQuit={() => pressed.push("quit")}
    />,
    {
      stdin: stdin as never,
      stdout: stdout as never,
      debug: true,
      exitOnCtrlC: false,
    },
  );
  await sleep(50);
  return {
    instance,
    pressed,
    frame: () => last(stdout.frames),
    press: async (bytes: string) => {
      stdin.write(bytes);
      await sleep(60);
    },
    /** Write without waiting — for asserting behaviour under batched input. */
    write: (bytes: string) => void stdin.write(bytes),
  };
}

describe("chat keys", () => {
  test("tool calls are always listed, with no key needed to reveal them", async () => {
    // The `^t` collapse is gone: the steps ARE the answer to "what is it
    // doing", so they are on screen from the first frame and there is no
    // summary row standing in for them. Pressing the old key must be inert
    // rather than toggling a state that no longer exists.
    const app = await mountChat();
    const frame = app.frame();
    expect(frame).toContain("gh release view");
    expect(frame).toContain("bun test");
    expect(frame).not.toContain("2 steps");

    await app.press("\x14"); // ^t — no longer bound
    expect(app.frame()).toContain("gh release view");
    expect(app.frame()).not.toContain("2 steps");
    app.instance.unmount();
  });

  test("a burst of keystrokes keeps every character", async () => {
    // Two chunks can arrive before React re-renders. Reading the field's value
    // out of the render closure then loses the earlier one — the wizard's name
    // box ate everything but the last letters, and a persona was created with
    // an empty name. Both text fields read from a ref for this reason.
    const app = await mountChat();
    // Separate reads, no render in between: `sleep(0)` yields to the stream
    // (so Ink reads three distinct chunks) without giving React a chance to
    // commit — which is exactly the window the stale closure lived in.
    app.write("h");
    await sleep(0);
    app.write("i");
    await sleep(0);
    app.write(" there");
    await sleep(150);
    expect(app.frame()).toContain("hi there");
    app.instance.unmount();
  });

  test("^s is the only way out of chat; ^p is no longer bound here", async () => {
    // The phantom list moved BEHIND settings, so chat must not keep a stale
    // second exit: a key that silently does nothing is better than one that
    // still routes somewhere after the destination moved.
    const app = await mountChat();
    await app.press("\x13"); // ^s
    await app.press("\x10"); // ^p — inert now
    expect(app.pressed).toEqual(["settings"]);
    expect(app.frame()).not.toContain("phantoms");
    app.instance.unmount();
  });
});

// ---------------------------------------------------------------------------
// The same route, at the App level: it is the ROUTER that owns where a key
// lands, so a ChatScreen test alone would not have caught it.
// ---------------------------------------------------------------------------

import { afterAll, afterEach, beforeAll } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { App } from "../src/tui/App.tsx";
import type { HostSnapshot, PersonaSnapshot } from "../src/tui/snapshot.ts";

const ALICE: PersonaSnapshot = {
  name: "alice",
  dir: "/tmp/does-not-exist/alice",
  isDefault: true,
  autostart: true,
  chain: ["claude"],
  channels: ["cli only"],
  identity: { files: [] },
  channelDetails: [],
  memory: { dbPath: "/tmp/does-not-exist/alice/memory.sqlite" },
  completeness: {
    persona: "alice",
    complete: true,
    resumeAt: "done",
    requirements: [],
  },
};

const HOST: HostSnapshot = {
  version: "0.0.0-test",
  updateChannel: "stable",
  defaultPersona: "alice",
  personasDir: "/tmp/does-not-exist",
  personas: [ALICE],
};

const saved: Record<string, string | undefined> = {};
const ENV = [
  "PHANTOMBOT_CONFIG",
  "PHANTOMBOT_STATE",
  "PHANTOMBOT_PERSONAS_DIR",
  "PHANTOMBOT_PERSONA",
] as const;

beforeAll(() => {
  // Never let a mounted App reach the developer's real personas.
  const root = mkdtempSync(join(tmpdir(), "phantombot-tui-nav-"));
  for (const k of ENV) saved[k] = process.env[k];
  process.env.PHANTOMBOT_CONFIG = join(root, "config.toml");
  process.env.PHANTOMBOT_STATE = join(root, "state.json");
  process.env.PHANTOMBOT_PERSONAS_DIR = join(root, "personas");
  delete process.env.PHANTOMBOT_PERSONA;
});

afterAll(() => {
  for (const k of ENV) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k]!;
  }
});

let mounted: Array<() => void> = [];
afterEach(() => {
  for (const c of mounted) c();
  mounted = [];
});

async function mountApp() {
  const stdin = fakeStdin();
  const stdout = fakeStdout();
  stdout.rows = 40;
  const instance = render(
    <App
      host={HOST}
      startPersona="alice"
      onCreatePersona={async () => {}}
      openSession={async ({ persona }) => ({
        persona,
        conversation: `cli:tui:${persona}`,
        history: [],
        async *send() {},
        close: async () => {},
      })}
    />,
    {
      stdin: stdin as never,
      stdout: stdout as never,
      exitOnCtrlC: false,
      patchConsole: false,
      debug: true,
    },
  );
  mounted.push(() => instance.unmount());
  await sleep(80);
  return {
    frame: () => last(stdout.frames),
    press: async (bytes: string) => {
      stdin.write(bytes);
      await sleep(80);
    },
  };
}

describe("reaching settings and the phantom list", () => {
  test("^s opens the phantom TABLE — settings starts with 'which phantom'", async () => {
    const app = await mountApp();
    await app.press("\x13"); // ^s
    const frame = app.frame();
    expect(frame).toContain("PHANTOMS");
    expect(frame).toContain("▸ settings");
    // The tell: this is the host table, not one phantom's own sections.
    expect(frame).not.toContain("Identity");
  });

  test("a phantom's own settings are one level in from the table", async () => {
    // ^s (table) then ↵ (open the selected phantom). Chat has no second exit:
    // ^p there must leave you in the conversation.
    const app = await mountApp();
    await app.press("\x10"); // ^p from chat: inert
    expect(app.frame()).not.toContain("PHANTOMS");

    await app.press("\x13"); // ^s
    await app.press("\r"); // open alice
    const frame = app.frame();
    expect(frame).toContain("▸ alice");
    expect(frame).toContain("Identity");
    expect(frame).toContain("Brain");

    await app.press("\x1b"); // esc goes back to the table it was opened from
    expect(app.frame()).toContain("PHANTOMS");
  });

  test("esc from the settings table goes back to the conversation", async () => {
    // One esc out of settings, one more out of a phantom: the way back to the
    // chat is never more than the key you came in on.
    const app = await mountApp();
    await app.press("\x13");
    await app.press("\x1b");
    const frame = app.frame();
    expect(frame).not.toContain("PHANTOMS");
    expect(frame).toContain("Send");
  });
  test("esc goes back to the screen you came FROM, not to a fixed parent", async () => {
    // The logs pane is reachable two ways, and a hardcoded parent gets one of
    // them wrong: entered with ^l from the chat it must return to the chat,
    // entered with L from a phantom it must return to that phantom — same key,
    // same screen, different way back.
    const app = await mountApp();
    await app.press("\x0c"); // ^l from chat
    expect(app.frame()).toContain("logs");
    await app.press("\x1b");
    expect(app.frame()).toContain("Send");

    await app.press("\x13"); // ^s -> table
    await app.press("\r"); // open alice
    await app.press("L"); // logs, this time from the phantom
    expect(app.frame()).toContain("logs");
    await app.press("\x1b");
    const frame = app.frame();
    expect(frame).toContain("Identity"); // back at the phantom, not the chat
    expect(frame).not.toContain("Send");

    // And the walk unwinds one level per esc, all the way to the floor.
    await app.press("\x1b");
    expect(app.frame()).toContain("PHANTOMS");
    await app.press("\x1b");
    expect(app.frame()).toContain("Send");
  });
});
