/**
 * `r Restart` is GONE from the menus (issue #471 follow-up).
 *
 * Restarting the daemon from inside a TUI that the daemon hosts is a foot-gun,
 * and it sat on a bare `r` next to keys that only navigate. Removing the badge
 * alone would leave the key live and invisible — the exact drift this suite
 * exists to catch — so this asserts BOTH halves on BOTH screens that carried
 * it: no advertised label, and the keypress is INERT (the frame is unchanged).
 */

import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { render } from "ink";

import { App } from "../src/tui/App.tsx";
import type { HostSnapshot, PersonaSnapshot } from "../src/tui/snapshot.ts";
import type { DoctorReport } from "../src/cli/doctor.ts";

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

function fakeStdout(rows: number) {
  const frames: string[] = [];
  const s = new EventEmitter() as EventEmitter & {
    columns: number;
    rows: number;
    write: (c: string) => void;
    frames: string[];
  };
  s.columns = 100;
  s.rows = rows;
  s.frames = frames;
  s.write = (c: string) => void frames.push(c);
  return s;
}

const ALICE: PersonaSnapshot = {
  name: "alice",
  dir: "/tmp/does-not-exist/alice",
  isDefault: true,
  autostart: true,
  chain: ["claude", "pi"],
  resolvedHarness: { id: "claude", path: "/usr/local/bin/claude" },
  channels: ["telegram"],
  voiceProvider: "azure_edge",
  voiceName: "en-US-JennyNeural",
  voiceHears: false,
  identity: {
    files: [
      { name: "SOUL.md", path: "/x/SOUL.md", present: true },
      { name: "IDENTITY.md", path: "/x/IDENTITY.md", present: true },
      { name: "AGENTS.md", path: "/x/AGENTS.md", present: false },
    ],
    description: "a test phantom",
  },
  channelDetails: [
    {
      id: "telegram",
      label: "Telegram",
      state: "connected",
      detail: "allowed  1",
    },
    { id: "chat", label: "phantomchat", state: "off", detail: "not configured" },
  ],
  nightly: { status: "ok", detail: "no backlog", lastRun: "today 03:14" },
  secretNames: ["A", "B"],
  memory: {
    dbPath: "/x/db",
    dbBytes: 44040192,
    journalRows: 6412,
    kbNotes: 208,
    indexedInSpace: 12904,
    indexedTotal: 12904,
    embedding: {
      provider: "gemini",
      model: "gemini-embedding-001",
      dimensions: 1536,
      fingerprint: "x",
    },
  },
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
  const root = mkdtempSync(join(tmpdir(), "phantombot-tui-norestart-"));
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

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const strip = (s: string) => s.replace(/\u001B\[[0-9;]*m/g, "");

// The persona screen runs the doctor when it opens; the real checks need a
// real persona on disk and would fail late, shifting frames after settle().
// Inject an instant report so the screen reaches a stable frame quickly.
const FAKE_REPORT: DoctorReport = {
  persona: "alice",
  telegram: { healthy: true, listeners: 2, personas: [] },
  memory_db: {
    path: "/x/db",
    healthy: true,
    detail: "integrity ok",
    bytes: 44040192,
    restore_points: [],
    unretired_drawers: [],
  },
  nightly: { age_hours: 2, health: "ok", detail: "no backlog", backlog: 0 },
  capture: { window_hours: 24, user_turns: 10, captures: 9, dry_day: false },
  embeddings: { provider: "gemini", semantic_search: true },
  update: { channel: "stable", version: "0.0.0-test" },
  default_persona: {
    resolved: "alice",
    provenance: "config" as const,
    exists: true,
    served: true,
    defect: null,
    mcp_servers: 0,
    mcp_elsewhere: [],
    healthy: true,
    detail: "resolved from config.toml",
  },

};

async function open() {
  const stdin = fakeStdin();
  const stdout = fakeStdout(44);
  const instance = render(
    <App
      host={HOST}
      startPersona="alice"
      runDoctorImpl={async (opts) => {
        opts?.out?.write(JSON.stringify(FAKE_REPORT));
        return 0;
      }}
      onCreatePersona={async () => {}}
      openSession={async ({ persona }) => ({
        persona,
        conversation: `cli:tui:${persona}`,
        history: [],
        async *send() {},
        async command() {
          return null;
        },
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
  const frame = () => strip(stdout.frames.at(-1) ?? "");
  // Press until the screen actually changes: Ink attaches an input handler a
  // tick after the frame it belongs to, and losing that race looks exactly
  // like a dead key binding.
  const pressUntil = async (key: string, want: string) => {
    for (let i = 0; i < 25; i++) {
      if (frame().includes(want)) return;
      stdin.write(key);
      await sleep(40);
    }
  };
  await pressUntil("\x13", "PHANTOMS"); // ^s — the phantom table
  // The host probes the service asynchronously after mount, so an early
  // snapshot would differ from the next one for reasons that are not the
  // keypress. Settle on two identical consecutive frames first.
  const settle = async () => {
    for (let i = 0; i < 40; i++) {
      const a = frame();
      await sleep(120);
      if (frame() === a) return a;
    }
    return frame();
  };
  return { stdin, frame, pressUntil, settle };
}

describe("the restart key is removed", () => {
  test("the phantom table neither advertises nor handles r", async () => {
    const { stdin, frame, settle } = await open();
    expect(frame()).toContain("PHANTOMS");
    expect(frame()).not.toContain("Restart");

    const before = await settle();
    stdin.write("r");
    await sleep(120);
    // Still the table, unchanged — no notice line, no service call.
    expect(frame()).toContain("PHANTOMS");
    expect(frame()).toBe(before);
  });

  test("a phantom's own screen neither advertises nor handles r", async () => {
    const { stdin, frame, pressUntil, settle } = await open();
    await settle();
    await pressUntil("c", "Logs"); // Configure the selected phantom
    expect(frame()).toContain("Logs");
    expect(frame()).not.toContain("Restart");

    const before = await settle();
    stdin.write("r");
    await sleep(120);
    expect(frame()).toContain("Logs");
    expect(frame()).toBe(before);
  });
});
