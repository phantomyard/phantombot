/**
 * A yes/no question is a SCREEN, not a drop back to the shell.
 *
 * Five settings — autostart, default persona, unsetting a key, the embedding
 * change and voice — all confirmed through `@clack`, which meant suspending
 * Ink, leaving the alternate screen and drawing a panel with no header, no
 * footer and no `esc`. That is the app's design language breaking at exactly
 * the moment the user is deciding whether to change something, and it was the
 * surface that could wedge the terminal.
 *
 * These assert what is ON SCREEN: the frame's own chrome around the question,
 * the app's own keys answering it, and — the one that matters most — that a
 * `danger` question does not apply on a mis-tapped Enter.
 */

import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { render } from "ink";

import { App } from "../src/tui/App.tsx";
import { stripAnsi } from "./helpers/ansi.ts";
import type { HostSnapshot, PersonaSnapshot } from "../src/tui/snapshot.ts";

const ALICE: PersonaSnapshot = {
  name: "alice",
  dir: "/tmp/does-not-exist/alice",
  isDefault: false,
  autostart: false,
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

// A second persona that HOLDS the default, so "make alice the default" is a
// real change rather than the no-op `PersonaDetail` declines to confirm.
const BOB: PersonaSnapshot = { ...ALICE, name: "bob", isDefault: true };

const HOST: HostSnapshot = {
  version: "0.0.0-test",
  updateChannel: "stable",
  defaultPersona: "bob",
  personasDir: "/tmp/does-not-exist",
  personas: [ALICE, BOB],
};

const saved: Record<string, string | undefined> = {};
const ENV = [
  "PHANTOMBOT_CONFIG",
  "PHANTOMBOT_STATE",
  "PHANTOMBOT_PERSONAS_DIR",
  "PHANTOMBOT_PERSONA",
] as const;

beforeAll(() => {
  const root = mkdtempSync(join(tmpdir(), "phantombot-tui-confirm-"));
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

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function mountApp() {
  const stdin = fakeStdin();
  const stdout = fakeStdout();
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
    // Stripped, never raw: these assert on text a user READS, and chalk turns
    // colour on from $GITHUB_ACTIONS — a style change lands mid-string and an
    // adjacency assertion on raw bytes then fails only in CI.
    frame: () => stripAnsi(stdout.frames.at(-1) ?? ""),
    press: async (bytes: string) => {
      stdin.write(bytes);
      await sleep(80);
    },
  };
}

/** ^s → c (configure alice) → down to a row → ↵. */
async function openRow(down: number) {
  const app = await mountApp();
  await app.press("\x13"); // ^s: the phantom table
  await app.press("c"); // configure alice
  for (let i = 0; i < down; i++) await app.press("\x1b[B");
  await app.press("\r");
  return app;
}

const AUTOSTART = 5; // identity, brain, channels, memory, voice, autostart
const DEFAULT = 6;

describe("the confirmation is an app screen", () => {
  test("it keeps the frame's chrome and the app's own keys", async () => {
    const app = await openRow(AUTOSTART);
    const frame = app.frame();
    expect(frame).toContain("Start alice with the daemon?");
    // The chrome is the point: a clack panel had none of this.
    expect(frame).toContain("phantombot");
    expect(frame).toContain("confirm");
    expect(frame).toContain("Continue");
    expect(frame).toContain("Back");
  });

  test("esc answers no and returns to the screen that asked", async () => {
    const app = await openRow(AUTOSTART);
    expect(app.frame()).toContain("Start alice with the daemon?");
    await app.press("\x1b");
    const frame = app.frame();
    expect(frame).not.toContain("Start alice with the daemon?");
    // Back on alice's own settings, not a level further out.
    expect(frame).toContain("Identity");
    expect(frame).toContain("Brain");
  });

  test("a danger question does not apply on a mis-tapped Enter", async () => {
    // Making a phantom the default reassigns /update and /restart. The cursor
    // starts on "No", so the reflex keystroke declines rather than hands over
    // control of the box.
    const app = await openRow(DEFAULT);
    expect(app.frame()).toContain("Make alice the default persona?");
    await app.press("\r");
    const frame = app.frame();
    expect(frame).not.toContain("Make alice the default persona?");
    // A "default_persona: bob → alice" notice is what applying looks like.
    expect(frame).not.toContain("bob → alice");
  });
});
