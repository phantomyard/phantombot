/**
 * The first-run flow must never dead-end (issue #471).
 *
 * REGRESSION test for two bugs that shipped in the first cut of the TUI, both
 * caused by deriving navigation state from a CONSTANT prop:
 *
 *   1. The chat session effect was gated on `props.startPersona`. `<App>` is
 *      rendered exactly once, so on a fresh box that prop is `undefined`
 *      forever — finishing the wizard landed on `screen: "chat"` with no
 *      session, which rendered a bare `opening alice…` with no Frame, no
 *      footer, and no `useInput` mounted. With `exitOnCtrlC: false`, `^q`,
 *      `^c` and `esc` were all inert: the only way out was killing the
 *      terminal, with mouse reporting still on.
 *
 *   2. The opening screen was chosen on `startPersona` alone, so an INCOMPLETE
 *      persona — which arrives with a name AND a resume point — opened chat
 *      instead of the wizard, and `wizardStartAt` was unreachable on every
 *      path.
 *
 * These are asserted by mounting the real `<App>` and driving real keystrokes,
 * because both bugs typecheck, render, and pass every unit test around them.
 */

import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { render } from "ink";
import React from "react";

import { App } from "../src/tui/App.tsx";
import type { ChatSession } from "../src/tui/chatSession.ts";
import type { HostSnapshot } from "../src/tui/snapshot.ts";

/**
 * A stdin Ink accepts. It must be a REAL readable stream: Ink 6 pulls input
 * with `stdin.on("readable")` + `stdin.read()`, so an EventEmitter emitting
 * "data" renders fine and silently receives no keystrokes at all.
 */
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
  s.rows = 40;
  s.frames = frames;
  s.write = (c: string) => void frames.push(c);
  return s;
}

/**
 * A `ChatSession` that opens instantly and needs nothing on disk. The real
 * opener is injected in production; here it is stubbed so the session-gate
 * bug is OBSERVABLE. With `openChat`, a temp persona that does not exist
 * rejects on both the fixed and the broken gate, so the frame reads
 * `opening alice…` either way and the regression passes a green suite.
 */
function fakeSession(persona: string): ChatSession {
  return {
    persona,
    conversation: `cli:tui:${persona}`,
    history: [],
    // eslint-disable-next-line require-yield
    async *send() {
      return;
    },
    close: async () => {},
  } as unknown as ChatSession;
}

const HOST: HostSnapshot = {
  version: "0.0.0-test",
  updateChannel: "stable",
  defaultPersona: "alice",
  personasDir: "/tmp/does-not-exist",
  personas: [],
};

const tick = () => new Promise((r) => setTimeout(r, 30));

/**
 * Point every path at a temp root. Without this the test opens a chat session
 * against the DEVELOPER'S OWN personas and can write their state.json.
 */
const saved: Record<string, string | undefined> = {};
const ENV = [
  "PHANTOMBOT_CONFIG",
  "PHANTOMBOT_STATE",
  "PHANTOMBOT_PERSONAS_DIR",
  "PHANTOMBOT_PERSONA",
] as const;

beforeAll(() => {
  const root = mkdtempSync(join(tmpdir(), "phantombot-tui-firstrun-"));
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

let cleanup: Array<() => void> = [];
afterEach(() => {
  for (const c of cleanup) c();
  cleanup = [];
});

function mount(props: Partial<React.ComponentProps<typeof App>> = {}) {
  const stdin = fakeStdin();
  const stdout = fakeStdout();
  const created: string[] = [];
  const instance = render(
    <App
      host={HOST}
      onCreatePersona={async (a) => void created.push(a.name)}
      {...props}
    />,
    {
      stdin: stdin as never,
      stdout: stdout as never,
      exitOnCtrlC: false,
      patchConsole: false,
      // Ink writes NOTHING to stdout until unmount when `is-in-ci` says it is
      // in CI (ink/build/ink.js buffers into `lastOutput`), so a frame
      // assertion passes locally and fails on every runner. `debug` makes each
      // render write its full output on both paths.
      debug: true,
    },
  );
  cleanup.push(() => instance.unmount());
  return {
    instance,
    created,
    frame: () => stdout.frames.join(""),
    // `debug: true` rewrites the WHOLE screen on every render, so the last
    // write is the current frame. Needed wherever a test asserts what a screen
    // is NOT showing — `frame()` still holds every earlier screen.
    lastFrame: () => stdout.frames[stdout.frames.length - 1] ?? "",
    press: async (bytes: string) => {
      stdin.write(bytes);
      await tick();
    },
  };
}

describe("first run", () => {
  test("completing the wizard leaves an app that can still be quit", async () => {
    const app = mount({ startPersona: undefined });
    await tick();

    // name → brain → channel → memory → voice → done, accepting each step's
    // default. Bounded rather than exact so the test asserts "the wizard
    // completes", not "the wizard has exactly six steps" — the step list is
    // expected to grow.
    await app.press("alice");
    for (let i = 0; i < 12 && app.created.length === 0; i++) {
      await app.press("\r");
    }

    expect(app.created).toEqual(["alice"]);

    // The persona does not exist on disk, so the session never opens — which
    // is exactly the window the bug lived in. It must still be a real screen.
    const frame = app.frame();
    expect(frame).toContain("alice");
    expect(frame).toContain("quit");

    let exited = false;
    void app.instance.waitUntilExit().then(() => void (exited = true));
    await app.press("\x11"); // ^q
    await tick();
    expect(exited).toBe(true);
  });

  test("completing the wizard opens a chat session for the name typed", async () => {
    // The pinning test for bug 1. `<App>` renders ONCE, so the broken gate
    // (`if (!props.startPersona) return`) can never fire on this path: the
    // prop is `undefined` for the whole life of the app. With a working
    // opener injected, the difference is visible — the fixed gate mounts the
    // chat screen, the broken one sits on the placeholder forever.
    const opened: string[] = [];
    const app = mount({
      startPersona: undefined,
      openSession: async ({ persona }) => {
        opened.push(persona);
        return fakeSession(persona);
      },
    });
    await tick();

    await app.press("alice");
    for (let i = 0; i < 12 && app.created.length === 0; i++) {
      await app.press("\r");
    }
    expect(app.created).toEqual(["alice"]);
    await tick();

    // Opened for the name the USER typed, not the host default — the wizard
    // builds a persona that did not exist when `<App>` was constructed.
    expect(opened).toEqual(["alice"]);

    // And the chat screen is actually mounted, not the placeholder.
    const frame = app.lastFrame();
    expect(frame).not.toContain("opening alice");
    expect(frame).toContain("interrupt");
    expect(frame).toContain("settings");
  });

  test("an incomplete persona opens the wizard, not chat", async () => {
    const app = mount({ startPersona: "alice", wizardStartAt: "brain" });
    await tick();
    // The wizard's brain step, resumed — not a chat box wired to a brain that
    // is not installed.
    expect(app.frame()).toContain("Claude Code CLI");
  });

  test("a complete persona opens chat", async () => {
    const app = mount({ startPersona: "alice" });
    await tick();
    expect(app.frame()).not.toContain("Claude Code CLI");
  });
});
