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
      onSwitchPersona={() => pressed.push("phantoms")}
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
  test("^t changes what the transcript shows", async () => {
    const app = await mountChat();
    const collapsed = app.frame();
    // Collapsed is a SUMMARY, not the first line of the first call.
    expect(collapsed).toContain("2 steps");
    expect(collapsed).not.toContain("gh release view");

    await app.press("\x14"); // ^t
    const expanded = app.frame();
    expect(expanded).toContain("gh release view");
    expect(expanded).toContain("bun test");
    expect(expanded).not.toContain("2 steps");

    await app.press("\x14");
    expect(app.frame()).toContain("2 steps");
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

  test("^s and ^p are different destinations", async () => {
    const app = await mountChat();
    await app.press("\x13"); // ^s
    await app.press("\x10"); // ^p
    expect(app.pressed).toEqual(["settings", "phantoms"]);
    app.instance.unmount();
  });
});

// ---------------------------------------------------------------------------
// The same two keys, at the App level: it is the ROUTER that had them wired to
// one destination, so a ChatScreen test alone would not have caught it.
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

describe("^s and ^p from chat", () => {
  test("^s opens THIS phantom's settings, not the host table", async () => {
    const app = await mountApp();
    await app.press("\x13"); // ^s
    const frame = app.frame();
    expect(frame).toContain("phantombot ▸ alice");
    // The tell: the settings screen has this phantom's own sections…
    expect(frame).toContain("Identity");
    expect(frame).toContain("Brain");
    // …and not the host-wide phantom table.
    expect(frame).not.toContain("PHANTOMS");
  });

  test("^p opens the host table, and esc returns to the conversation", async () => {
    const app = await mountApp();
    await app.press("\x10"); // ^p
    const frame = app.frame();
    expect(frame).toContain("PHANTOMS");
    expect(frame).toContain("phantombot ▸ settings");

    await app.press("\x1b"); // esc
    expect(app.frame()).toContain("^s");
  });

  test("esc from settings reached via ^s goes back to the conversation", async () => {
    // Not to the dashboard: arriving from a conversation and being returned to
    // a host-wide table is a dead end the user has to navigate out of.
    const app = await mountApp();
    await app.press("\x13");
    await app.press("\x1b");
    const frame = app.frame();
    expect(frame).not.toContain("PHANTOMS");
    expect(frame).toContain("send");
  });
});
