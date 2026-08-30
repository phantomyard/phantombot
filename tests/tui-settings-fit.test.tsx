/**
 * A screen taller than the window must SHOW FEWER ROWS, not squeezed ones.
 *
 * Reported as "it deforms": on a 20-row terminal the settings screen drew all
 * ten of its sections regardless, and Yoga made them fit by compressing —
 * two readings printed on the same line (`indexedngs  12,904 … in sync001 ·
 * 1536`) and the bottom border came out as `╰─ ─ ─✚─Doctor────────run the
 * checks───────╯`. Clipping the frame body stops the border tearing; only
 * windowing the content stops the rows colliding, so this test asserts BOTH.
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

function fakeStdout(rows: number, columns = 100) {
  const frames: string[] = [];
  const s = new EventEmitter() as EventEmitter & {
    columns: number;
    rows: number;
    write: (c: string) => void;
    frames: string[];
  };
  s.columns = columns;
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

async function openSettings(rows: number, columns = 100) {
  const stdin = fakeStdin();
  const stdout = fakeStdout(rows, columns);
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
  stdin.write("\x13"); // ^s — the phantom table
  await sleep(80);
  stdin.write("c"); // Configure the selected phantom
  await sleep(80);
  // Colour codes out: chalk is on in CI (and a sibling suite forces it on
  // the shared singleton), so assert on the text a user reads.
  return stripAnsi(stdout.frames.at(-1) ?? "").split("\n");
}

describe("settings screen in a short window", () => {
  // Since the screen became a single squared table (one row per setting, no
  // detail blocks), the whole thing fits a 20-row window. The original
  // shearing regression is still worth pinning — the frame must survive —
  // but the expected shape changed: every row visible, no scrolling.
  test("the boxed frame survives and every row fits", async () => {
    process.env.PHANTOMBOT_TUI_FRAME = "boxed";
    const lines = await openSettings(20);
    delete process.env.PHANTOMBOT_TUI_FRAME;

    const text = lines.join("\n");

    // The bottom border is a border: nothing from a row may be drawn INTO it.
    const bottom = lines.find((l) => l.trimStart().startsWith("╰"))!;
    expect(bottom).toBeDefined();
    expect(/^╰─+╯$/.test(bottom.trim())).toBe(true);

    // All eight settings fit — first and last row both painted.
    expect(text).toContain("Identity");
    expect(text).toContain("Doctor");
    expect(text).not.toContain("more below");
  });

  test("the bare frame keeps its footer below the table", async () => {
    const lines = await openSettings(20);

    // The footer is the last thing on screen — if the body overflowed it
    // would be pushed out of the window entirely, which is how you lose the
    // only visible way back.
    const last = lines.filter((l) => l.trim().length > 0).at(-1) ?? "";
    expect(last).toContain("Back");

    // The collision signature of the original bug: two readings sharing a
    // line. Still asserted even though the layout that caused it is gone.
    expect(lines.join("\n")).not.toContain("indexedngs");
  });

  test("a narrow window wraps descriptions and windowing returns", async () => {
    // At 60 columns the identity marks and probe lines no longer fit on one
    // line — descriptions wrap, rows grow, and the screen is taller than 20
    // rows again. Windowing must drop rows (announced) rather than compress.
    process.env.PHANTOMBOT_TUI_FRAME = "boxed";
    const lines = await openSettings(20, 60);
    delete process.env.PHANTOMBOT_TUI_FRAME;

    const bottom = lines.find((l) => l.trimStart().startsWith("╰"))!;
    expect(bottom).toBeDefined();
    expect(/^╰─+╯$/.test(bottom.trim())).toBe(true);
    expect(lines.join("\n")).toContain("more below");
  });

  test("a tall window needs no marker", async () => {
    const lines = await openSettings(44);
    expect(lines.join("\n")).toContain("Doctor");
    expect(lines.join("\n")).not.toContain("more below");
  });

  test("the table reads as name · what /status says · state", async () => {
    const lines = await openSettings(44);
    const text = lines.join("\n");

    // The channels row is "Chat Channels" now, and its description is the
    // /status probe output — not the old config-source diagnostics.
    expect(text).toContain("Chat Channels");
    expect(text).not.toContain("harness_bins");
    expect(text).not.toContain("env > config.toml");
    expect(text).not.toContain("persona override");

    // The fixture's identity is missing only AGENTS.md, which is an optional
    // tools-hints file (loader.ts) — so the badge must NOT say required.
    expect(text).toContain("configured");
    expect(text).not.toContain("required");

    // Brain shows the chain and the per-harness models, as /status prints them.
    expect(text).toContain("models:");

    // Badges sit in one right-aligned column: the autostart row's state is
    // flush against the frame border, not wherever its description ended.
    const autostart = lines.find((l) => l.includes("Autostart"))!;
    expect(autostart.trimEnd().endsWith("✓ on")).toBe(true);
  });
});
