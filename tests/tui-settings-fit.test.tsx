/**
 * A screen taller than the window must SHOW FEWER ROWS, not squeezed ones.
 *
 * Reported as "it deforms": on a 20-row terminal the settings screen drew all
 * of its sections regardless, and Yoga made them fit by compressing — two
 * readings printed on the same line (`indexedngs  12,904 … in sync001 ·
 * 1536`) and the bottom border came out as `╰─ ─ ─✚─Doctor────────run the
 * checks───────╯`. Clipping the frame body stops the border tearing; only
 * windowing the content stops the rows colliding, so this test asserts BOTH.
 *
 * Since the Dashboard re-skin the table also gained a framed header (rule,
 * dim `setting · configured · state` row, rule), a rule under the rows, and
 * the DOCTOR telemetry block where the Doctor menu row used to be — so the
 * screen is taller and windowing returns in short windows.
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
  s.write = (c: string) => void frames.push(c);
  s.frames = frames;
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

// The settings screen runs the doctor when it opens (the DOCTOR telemetry
// block under the table). The fixture persona has no directory, so the real
// checks would fail — inject a well-formed report instead, via App's
// `runDoctorImpl` seam (a module-level mock would leak into every other
// test file in the suite's process).
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
  nightly: {
    age_hours: 2,
    health: "ok",
    detail: "no backlog",
    backlog: 0,
  },
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
  stdin.write("\x13"); // ^s — the phantom table
  await sleep(80);
  stdin.write("c"); // Configure the selected phantom
  // The configure screen opens async, and its /status probes gather off-render.
  // Poll for the settled frame instead of sleeping a fixed interval — a loaded
  // runner can easily miss a fixed sleep and the STATUS block would still read
  // `gathering…` (or the screen not have opened at all).
  for (let i = 0; i < 120; i++) {
    const frame = stripAnsi(stdout.frames.at(-1) ?? "");
    if (frame.includes("description") && !frame.includes("gathering…")) break;
    await sleep(50);
  }
  // Colour codes out: chalk is on in CI (and a sibling suite forces it on
  // the shared singleton), so assert on the text a user reads.
  return stripAnsi(stdout.frames.at(-1) ?? "").split("\n");
}

describe("settings screen in a short window", () => {
  // The framed header + DOCTOR block make the screen taller than it was, so
  // a 20-row boxed window windows the rows. The frame must survive that.
  test("the boxed frame survives, windowing announced", async () => {
    process.env.PHANTOMBOT_TUI_FRAME = "boxed";
    const lines = await openSettings(20);
    delete process.env.PHANTOMBOT_TUI_FRAME;

    const text = lines.join("\n");

    // The bottom border is a border: nothing from a row may be drawn INTO it.
    const bottom = lines.find((l) => l.trimStart().startsWith("╰"))!;
    expect(bottom).toBeDefined();
    expect(/^╰─+╯$/.test(bottom.trim())).toBe(true);

    // Rows are dropped, not squeezed — and the screen says so.
    expect(text).toContain("more below");
    // No collision signature: a row's label must never share a line with
    // another row's (the Brainity / chainel shear the budget math once
    // under-counted the bottom block).
    expect(text).not.toContain("Brainity");
    expect(text).not.toContain("chainel");
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

  test("a narrow window wraps descriptions and keeps the frame intact", async () => {
    // At 60 columns the identity marks and probe lines no longer fit on one
    // line — descriptions wrap, rows grow, and the screen is taller again.
    process.env.PHANTOMBOT_TUI_FRAME = "boxed";
    const lines = await openSettings(30, 60);
    delete process.env.PHANTOMBOT_TUI_FRAME;

    const bottom = lines.find((l) => l.trimStart().startsWith("╰"))!;
    expect(bottom).toBeDefined();
    expect(/^╰─+╯$/.test(bottom.trim())).toBe(true);
  });

  test("a tall window shows the whole screen, status included", async () => {
    const lines = await openSettings(44);
    const text = lines.join("\n");

    expect(text).not.toContain("more below");

    // The Dashboard skeleton: dim header row between two rules, a rule under
    // the rows, and the STATUS telemetry block below that. The doctor is NOT
    // on this screen — its full report is a `d` away on the phantoms list.
    expect(text).toContain("setting");
    expect(text).toContain("description");
    expect(text).toContain("state");
    expect(text).toContain("STATUS");
    expect(text).toContain("phantom");
    expect(text).toContain("chain");
    expect(text).toContain("memory");
    expect(text).not.toContain("DOCTOR");

    // The Doctor menu row is gone — no old description, no leading ✚.
    expect(text).not.toContain("run the checks");
  });

  test("the table reads as name · description · state", async () => {
    const lines = await openSettings(44);
    const text = lines.join("\n");

    // The channels row is "Chat Channels" now, and the description column is
    // a STATIC one-liner on what the setting is for — the live /status output
    // lives in the STATUS block below, not in the table.
    expect(text).toContain("Chat Channels");
    expect(text).toContain("the chat surfaces this phantom answers on");
    expect(text).not.toContain("harness_bins");
    expect(text).not.toContain("env > config.toml");
    expect(text).not.toContain("persona override");

    // The fixture's identity is missing only AGENTS.md, which is an optional
    // tools-hints file (loader.ts) — so the badge must NOT say required.
    expect(text).toContain("configured");
    expect(text).not.toContain("required");

    // The informational group shows VALUES where badges sit: on|off, yes|no,
    // stable|preview — dim, no glyph, no red/green.
    const autostart = lines.find((l) => l.includes("Autostart"))!;
    expect(autostart.trimEnd().endsWith("on")).toBe(true);
    const release = lines.find((l) => l.includes("Release Channel"))!;
    expect(release).toContain("stable");
  });
});
