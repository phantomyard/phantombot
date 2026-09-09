/**
 * Configuring the brain must repoint the OPEN chat session at it.
 *
 * The bug this pins: the chat session resolves its harness chain once, when it
 * opens, and then deliberately outlives every screen switch so a trip to
 * settings does not lose the thread. Nothing re-read config.toml afterwards —
 * so a user who opened chat, went to Configure, set up a brain and was told
 * "brain verified" came back to a chat still driving the chain from BEFORE the
 * write. On a fresh install that is the default `claude`, which is not
 * installed, and every reply came back empty.
 *
 * Driven through the real Configure screen's Brain row rather than by calling
 * the callback, because the defect was in the WIRING, not in the reload.
 */

import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { render } from "ink";

import { App } from "../src/tui/App.tsx";
import type { ChatSession } from "../src/tui/chatSession.ts";
import type { HostSnapshot } from "../src/tui/snapshot.ts";

/** What the terminal sends for ctrl+s. */
const CTRL_S = String.fromCharCode(19);

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

const tick = () => new Promise((r) => setTimeout(r, 30));

let tmpRoot: string;
const saved: Record<string, string | undefined> = {};
const ENV = [
  "PHANTOMBOT_CONFIG",
  "PHANTOMBOT_STATE",
  "PHANTOMBOT_PERSONAS_DIR",
  "PHANTOMBOT_PERSONA",
] as const;

beforeAll(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), "phantombot-brain-reload-"));
  for (const k of ENV) saved[k] = process.env[k];
  process.env.PHANTOMBOT_CONFIG = join(tmpRoot, "config.toml");
  process.env.PHANTOMBOT_STATE = join(tmpRoot, "state.json");
  process.env.PHANTOMBOT_PERSONAS_DIR = join(tmpRoot, "personas");
  delete process.env.PHANTOMBOT_PERSONA;
  const dir = join(tmpRoot, "personas", "alice");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "identity.json"), "{}", "utf8");
  writeFileSync(join(dir, "SOUL.md"), "You are alice.\n", "utf8");
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

const HOST: HostSnapshot = {
  version: "0.0.0-test",
  updateChannel: "stable",
  defaultPersona: "alice",
  personasDir: join(tmpdir(), "does-not-exist"),
  personas: [
    {
      name: "alice",
      dir: join(tmpdir(), "does-not-exist", "alice"),
      isDefault: true,
      autostart: false,
      chain: [],
      brainConfigured: false,
      channels: [],
      identity: { files: [] } as never,
      channelDetails: [],
      memory: { drawers: [], journalDays: 0 } as never,
      completeness: { complete: false, missing: [] } as never,
    } as unknown as HostSnapshot["personas"][number],
  ],
};

describe("the Configure screen's Brain row", () => {
  test("repoints the open chat session at the brain it just configured", async () => {
    const reloads: string[] = [];
    const session: ChatSession = {
      persona: "alice",
      conversation: "cli:tui:alice",
      history: [],
      // eslint-disable-next-line require-yield
      async *send() {
        return;
      },
      async command() {
        return null;
      },
      async reloadHarnesses() {
        reloads.push("alice");
        return ["pi"];
      },
      async close() {},
    };

    const stdin = fakeStdin();
    const stdout = fakeStdout();
    const instance = render(
      <App
        host={HOST}
        startPersona="alice"
        onCreatePersona={async () => {}}
        openSession={async () => session}
        // The brain flow itself is not under test — only what happens around
        // it. Reports a verified brain, exactly like a passing test-and-apply.
        onWizardBrain={async () => ({
          landing: "chat" as const,
          notice: "brain verified: pi",
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
    cleanup.push(() => instance.unmount());

    const lastFrame = () => stdout.frames[stdout.frames.length - 1] ?? "";
    const waitFor = async (p: (f: string) => boolean, ms = 3000) => {
      const deadline = Date.now() + ms;
      while (Date.now() < deadline) {
        if (p(lastFrame())) return;
        await tick();
      }
      throw new Error(`waitFor timed out; last frame:\n${lastFrame()}`);
    };

    // Chat first: the session must be OPEN, which is the whole precondition.
    await waitFor((f) => f.includes("alice") && f.includes("Settings"));
    // ctrl+s → the phantoms list → `c` → alice's Configure screen.
    stdin.write(CTRL_S);
    await waitFor((f) => f.includes("PHANTOMS"));
    stdin.write("c");
    await waitFor((f) => f.includes("Brain"));
    // The cursor does not start on Brain. Walk to the top, then step down to
    // it: Autostart, Default, Release Channel, Identity, Brain.
    const UP = "\u001B[A";
    const DOWN = "\u001B[B";
    for (let i = 0; i < 12; i++) {
      stdin.write(UP);
      await tick();
    }
    for (let i = 0; i < 4; i++) {
      stdin.write(DOWN);
      await tick();
    }
    await waitFor((f) => /▸.*Brain/.test(f));
    stdin.write("\r");
    await waitFor(() => reloads.length > 0);

    expect(reloads).toEqual(["alice"]);
  });
});
