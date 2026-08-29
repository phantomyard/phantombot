/**
 * The window furniture: a bare header by default, the old border on request.
 *
 * A border is the one thing on screen whose correctness depends on the layout
 * engine agreeing with the font about every glyph's width — it is what sheared
 * twice already. `bare` draws none, prints the version and release ring on one
 * plain header line, and hands the two reclaimed rows to the screen's content.
 * `PHANTOMBOT_TUI_FRAME=boxed` brings the border back for comparison.
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
      { name: "USER.md", path: "/x/USER.md", present: false },
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
  const root = mkdtempSync(join(tmpdir(), "phantombot-tui-fit-"));
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

async function openChat(rows: number) {
  const stdin = fakeStdin();
  const stdout = fakeStdout(rows);
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
  // Colour codes out: chalk is on in CI (and a sibling suite forces it on
  // the shared singleton), so assert on the text a user reads.
  return stripAnsi(stdout.frames.at(-1) ?? "").split("\n");
}

describe("frame variants", () => {
  afterEach(() => {
    delete process.env.PHANTOMBOT_TUI_FRAME;
  });

  test("bare is the default: version header, no border", async () => {
    const frame = (await openChat(24)).join("\n");
    expect(frame).toContain("phantombot v");
    expect(frame).toContain("channel: stable");
    // The chat input keeps its own little box, so count corners rather than
    // looking for any: bare = the input box only, boxed = that plus the frame.
    expect((frame.match(/╭/g) ?? []).length).toBe(1);
    // The first line is the header itself, not a border.
    expect(frame.split("\n")[0]).toContain("phantombot v");
  });

  test("boxed still draws the border", async () => {
    process.env.PHANTOMBOT_TUI_FRAME = "boxed";
    const frame = (await openChat(24)).join("\n");
    expect((frame.match(/╭/g) ?? []).length).toBe(2);
    expect(frame.split("\n")[0]).toContain("╭");
  });
});
