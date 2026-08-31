/**
 * The new-phantom wizard must speak the same language as every other screen
 * (issue #471 follow-up).
 *
 * Reported from a screenshot of `settings ▸ New`: the wizard was the one
 * screen still on its own dialect. Three concrete divergences, each of which
 * renders and typechecks perfectly:
 *
 *   1. Its status read `0.1.0-dev · setup` while the header bar was already
 *      printing `phantombot v0.1.0-dev` two columns to the left — the same
 *      duplication the phantom table dropped.
 *   2. Quit was `^c` here and `^q` everywhere else.
 *   3. There was no `Back` at all on the first step, so a wizard opened with
 *      `n New` from the table was a one-way door: esc did nothing, and the
 *      only way out was quitting the whole app.
 *
 * These assert the SCREEN after real keystrokes, not that a prop was passed:
 * the first-step esc bug was a missing handler, which no prop assertion sees.
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
import type { HostSnapshot, PersonaSnapshot } from "../src/tui/snapshot.ts";
import { VERSION } from "../src/version.ts";
import { stripAnsi } from "./helpers/ansi.ts";

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

const tick = () => new Promise((r) => setTimeout(r, 30));

const strip = stripAnsi;

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

const ALICE: PersonaSnapshot = {
  name: "alice",
  dir: "/tmp/does-not-exist/alice",
  isDefault: true,
  autostart: true,
  chain: ["claude"],
  resolvedHarness: { id: "claude", path: "/usr/local/bin/claude" },
  channels: ["cli"],
  voiceProvider: "none",
  voiceName: undefined,
  voiceHears: false,
  identity: { files: [], description: "a test phantom" },
  channelDetails: [],
  nightly: { status: "ok", detail: "no backlog", lastRun: "today 03:14" },
  secretNames: [],
  memory: {
    dbPath: "/x/db",
    dbBytes: 1024,
    journalRows: 1,
    kbNotes: 1,
    indexedInSpace: 1,
    indexedTotal: 1,
    embedding: undefined,
  },
  completeness: {
    persona: "alice",
    complete: true,
    resumeAt: "done",
    requirements: [],
  },
};

const HOST: HostSnapshot = {
  version: "9.9.9-test",
  updateChannel: "stable",
  defaultPersona: "alice",
  personasDir: "/tmp/does-not-exist",
  personas: [ALICE],
};

/**
 * Point every path at a temp root. Without this the app reads the DEVELOPER'S
 * own personas — and it is not hypothetical: this file passed in isolation and
 * failed in the full run, because a sibling suite had left PHANTOMBOT_* env
 * pointing at its own fixtures.
 */
const saved: Record<string, string | undefined> = {};
const ENV = [
  "PHANTOMBOT_CONFIG",
  "PHANTOMBOT_STATE",
  "PHANTOMBOT_PERSONAS_DIR",
  "PHANTOMBOT_PERSONA",
] as const;

beforeAll(() => {
  const root = mkdtempSync(join(tmpdir(), "phantombot-tui-wizard-"));
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
  const instance = render(
    <App
      host={HOST}
      onCreatePersona={async () => {}}
      openSession={async ({ persona }) => fakeSession(persona)}
      {...props}
    />,
    {
      stdin: stdin as never,
      stdout: stdout as never,
      exitOnCtrlC: false,
      patchConsole: false,
      debug: true,
    },
  );
  cleanup.push(() => instance.unmount());
  return {
    instance,
    lastFrame: () => strip(stdout.frames[stdout.frames.length - 1] ?? ""),
    press: async (bytes: string) => {
      stdin.write(bytes);
      await tick();
    },
    pressUntil: async (
      bytes: string,
      predicate: (frame: string) => boolean,
      tries = 20,
    ) => {
      for (let i = 0; i < tries; i++) {
        if (predicate(strip(stdout.frames[stdout.frames.length - 1] ?? ""))) return;
        stdin.write(bytes);
        await tick();
      }
      throw new Error(
        `pressUntil gave up; last frame:\n${stdout.frames[stdout.frames.length - 1] ?? "(nothing)"}`,
      );
    },
    waitFor: async (predicate: (frame: string) => boolean, ms = 3000) => {
      const deadline = Date.now() + ms;
      while (Date.now() < deadline) {
        if (predicate(strip(stdout.frames[stdout.frames.length - 1] ?? ""))) return;
        await tick();
      }
      throw new Error(
        `waitFor timed out; last frame:\n${stdout.frames[stdout.frames.length - 1] ?? "(nothing)"}`,
      );
    },
  };
}

/**
 * `^s` then `n` — the route a user walks to reach the wizard from chat.
 *
 * Each key is RESENT until the screen changes. Ink mounts its input handler a
 * tick after the frame it belongs to is painted, so a single keystroke sent
 * the moment the chat footer appears is sometimes written to a stdin nobody
 * is reading yet — a flake that looks exactly like a broken key binding.
 */
async function openWizard() {
  const app = mount({ startPersona: "alice" });
  await app.waitFor((f) => f.includes("Send"));
  await app.pressUntil("\x13", (f) => f.includes("PHANTOMS")); // ^s
  await app.pressUntil("n", (f) => f.includes("What should it be called?"));
  return app;
}

describe("the wizard speaks the app's menu language", () => {
  test("the version appears once, in the header bar", async () => {
    const app = await openWizard();
    const frame = app.lastFrame();
    // The bar prints it; the status must not print it again. Counted rather
    // than `not.toContain`, because the header's own copy is correct.
    const occurrences = frame.split(VERSION).length - 1;
    expect(occurrences).toBe(1);
    // And the crumb, not a status, says which screen this is.
    expect(frame).toContain("\u25b8 new");
  });

  test("opened from settings, the wizard offers no Quit at all", async () => {
    const app = await openWizard();
    const frame = app.lastFrame();
    // Leaving a wizard that lives inside the app means going back a screen,
    // not killing the process. Neither spelling of quit is advertised.
    expect(frame).not.toContain("Quit");
    expect(frame).toContain("esc Back");
  });

  test("^q still quits from the wizard, unadvertised", async () => {
    const app = await openWizard();
    let exited = false;
    void app.instance.waitUntilExit().then(() => void (exited = true));
    await app.press("\x11"); // ^q
    await tick();
    expect(exited).toBe(true);
  });

  test("esc on the first step returns to the screen it was opened from", async () => {
    const app = await openWizard();
    expect(app.lastFrame()).toContain("esc Back");
    await app.press("\x1b");
    await app.waitFor((f) => f.includes("PHANTOMS"));
    // And not merely "left the wizard": the name question is gone.
    expect(app.lastFrame()).not.toContain("What should it be called?");
  });

  test("esc inside the wizard walks back one step, not out", async () => {
    const app = await openWizard();
    await app.press("lab");
    await app.press("\r");
    await app.waitFor((f) => f.includes("Claude Code CLI"));
    await app.press("\x1b");
    await app.waitFor((f) => f.includes("What should it be called?"));
    // The typed name survives the round trip — back is a step, not a reset.
    expect(app.lastFrame()).toContain("lab");
  });

  test("on first run the first step offers no Back, because there is none", async () => {
    const app = mount({
      host: { ...HOST, personas: [] },
      startPersona: undefined,
    });
    await app.waitFor((f) => f.includes("What should it be called?"));
    const frame = app.lastFrame();
    expect(frame).not.toContain("esc Back");
    // A footer key that does nothing is worse than no key — and on first run
    // quit is the ONLY way out, so this is the one screen that advertises it.
    expect(frame).toContain("^q Quit");
  });
});
