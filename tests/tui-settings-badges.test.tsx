/**
 * The settings table's badge column: one data source, three states.
 *
 * Reported as "pretty ugly": testbot's voice was configured as provider
 * `none`, /status printed `voice: none`, and the badge read that as green
 * "configured"; the Chat Channels badge read the persona snapshot's channel
 * list while its description read the /status lines, so the screen showed a
 * green badge over "none configured". The badge must speak the same source
 * as the description, and "not set up" must be yellow `optional`, never
 * green. Also pinned here: only SOUL.md / IDENTITY.md are load-bearing —
 * a missing AGENTS.md (an optional tools-hints file) must not trip red.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { render } from "ink";

import { PersonaDetailScreen } from "../src/tui/screens/PersonaDetail.tsx";
import type { PersonaSnapshot } from "../src/tui/snapshot.ts";
import type { StatusRows } from "../src/tui/status.ts";
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

function fakeStdout(rows = 44, columns = 100) {
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
  // Deliberately non-empty: the badge must ignore this and read /status.
  channels: ["telegram"],
  voiceProvider: "none",
  voiceName: "none",
  voiceHears: false,
  identity: {
    files: [
      { name: "SOUL.md", path: "/x/SOUL.md", present: true },
      { name: "IDENTITY.md", path: "/x/IDENTITY.md", present: true },
      { name: "AGENTS.md", path: "/x/AGENTS.md", present: false },
    ],
    description: "a test phantom",
  },
  channelDetails: [],
  nightly: { status: "ok", detail: "no backlog", lastRun: "today 03:14" },
  secretNames: [],
  memory: {
    dbPath: "/x/db",
    dbBytes: 1,
    journalRows: 1,
    kbNotes: 1,
    indexedInSpace: 1,
    indexedTotal: 1,
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

const noop = () => {};

let mounted: Array<() => void> = [];
afterEach(() => {
  for (const c of mounted) c();
  mounted = [];
});

async function renderSettings(status: StatusRows) {
  const stdout = fakeStdout();
  const instance = render(
    <PersonaDetailScreen
      persona={ALICE}
      status={status}
      onOpen={noop}
      onEditIdentity={noop}
      onChangeBrain={noop}
      onChangeChannels={noop}
      onToggleAutostart={noop}
      onMakeDefault={noop}
      releaseChannel="stable"
      onToggleRelease={noop}
      canSetDefault
      canSetRelease
      onBack={noop}
    />,
    {
      stdin: fakeStdin() as never,
      stdout: stdout as never,
      exitOnCtrlC: false,
      patchConsole: false,
      debug: true,
    },
  );
  mounted.push(() => instance.unmount());
  await new Promise((r) => setTimeout(r, 50));
  return stdout.frames.map(stripAnsi).join("\n");
}

const rowOf = (lines: string, label: string) =>
  lines
    .split("\n")
    .find((l) => l.includes(label))!
    .trimEnd();

describe("settings badge semantics", () => {
  test("voice provider `none` is optional, not configured", async () => {
    const text = await renderSettings([["voice", "none"]]);
    const row = rowOf(text, "Voice");
    expect(row.endsWith("optional")).toBe(true);
    expect(row).not.toContain("✓");
  });

  test("an omitted voice line is optional too", async () => {
    const text = await renderSettings([]);
    const row = rowOf(text, "Voice");
    expect(row.endsWith("optional")).toBe(true);
  });

  test("voice configured but keyless is a warning, not healthy", async () => {
    const text = await renderSettings([["voice", "openai nova — no key"]]);
    expect(rowOf(text, "Voice").endsWith("no key")).toBe(true);
    expect(rowOf(text, "Voice")).not.toContain("✓");
  });

  test("chat channels badge reads /status, not the persona snapshot", async () => {
    // p.channels is non-empty, but /status has no channel lines: the badge
    // must agree with the /status reading, i.e. yellow optional. The
    // description column is a static one-liner, not the probe output.
    const text = await renderSettings([]);
    const row = rowOf(text, "Chat Channels");
    expect(row.endsWith("optional")).toBe(true);
    expect(row).toContain("the chat surfaces this phantom answers on");
  });

  test("a failing channel probe is an error badge, not green", async () => {
    const text = await renderSettings([
      ["telegram", "telegram ERR (401 Unauthorized)"],
    ]);
    const row = rowOf(text, "Chat Channels");
    expect(row).toContain("error");
    expect(row).not.toContain("✓");
  });

  test("a missing AGENTS.md does not trip the identity badge", async () => {
    const text = await renderSettings([]);
    const row = rowOf(text, "Identity");
    expect(row.endsWith("✓ configured")).toBe(true);
    // The description column is the static one-liner — the missing-file
    // detail lives in the /status rows (STATUS block), not in the row.
    expect(row).toContain("the persona files that define who this phantom is");
  });

  test("a missing SOUL.md is required", async () => {
    const lonely: PersonaSnapshot = {
      ...ALICE,
      identity: {
        files: [
          { name: "SOUL.md", path: "/x/SOUL.md", present: false },
          { name: "IDENTITY.md", path: "/x/IDENTITY.md", present: true },
          { name: "AGENTS.md", path: "/x/AGENTS.md", present: true },
        ],
        description: "a test phantom",
      },
    };
    const stdout = fakeStdout();
    const instance = render(
      <PersonaDetailScreen
        persona={lonely}
        status={[]}
        onOpen={noop}
        onEditIdentity={noop}
        onChangeBrain={noop}
        onChangeChannels={noop}
        onToggleAutostart={noop}
        onMakeDefault={noop}
        releaseChannel="stable"
        onToggleRelease={noop}
        canSetDefault={false}
        canSetRelease
        onBack={noop}
      />,
      {
        stdin: fakeStdin() as never,
        stdout: stdout as never,
        exitOnCtrlC: false,
        patchConsole: false,
        debug: true,
      },
    );
    mounted.push(() => instance.unmount());
    await new Promise((r) => setTimeout(r, 50));
    const row = stdout.frames
      .map(stripAnsi)
      .join("\n")
      .split("\n")
      .find((l) => l.includes("Identity"))!
      .trimEnd();
    expect(row.endsWith("required")).toBe(true);
  });
});
