/**
 * The log pane renders the SOURCE PATH (#478).
 *
 * Ronald's actual question was "where do I find the audit logs?", so the
 * screen has to answer it without anyone reading the source: the selected
 * source's location and its full-stream command are on screen, and `s` moves
 * between sources.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { PassThrough } from "node:stream";
import { render } from "ink";

import { SystemScreen } from "../src/tui/screens/System.tsx";
import type { SystemSnapshot } from "../src/tui/systemSnapshot.ts";
import type { LogSource } from "../src/tui/logSources.ts";
import type { HostSnapshot } from "../src/tui/snapshot.ts";
import { stripAnsi } from "./helpers/ansi.ts";

const HOST = {
  version: "test",
  updateChannel: "stable",
  defaultPersona: "kai",
  personasDir: "/tmp/none",
  personas: [],
} as unknown as HostSnapshot;

const SNAPSHOT: SystemSnapshot = {
  capturedAt: "2026-09-01T12:00:00Z",
  services: [],
};

const AUDIT: LogSource = {
  id: "audit",
  label: "audit (tool calls)",
  location: "/home/kai/.local/share/phantombot/personas/kai/audit/2026-09-01.log",
  command: "tail -f /home/kai/audit/*.log",
  available: true,
  read: async () => [
    {
      at: Date.parse("2026-09-01T12:00:00Z"),
      level: "info",
      msg: "bash: ran the doctor",
      type: "audit",
      persona: "kai",
      raw: "",
    },
  ],
};

const SERVICE: LogSource = {
  id: "service",
  label: "service (daemon)",
  location: "journald · systemd --user unit phantombot",
  command: "journalctl --user -u phantombot -f",
  available: true,
  read: async () => [],
};

const mounted: Array<() => void> = [];
afterEach(() => {
  while (mounted.length) mounted.pop()?.();
});

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function mount(sources: LogSource[]) {
  const stdin = new PassThrough() as PassThrough & {
    isTTY: boolean;
    setRawMode: () => void;
    ref: () => void;
    unref: () => void;
  };
  stdin.isTTY = true;
  stdin.setRawMode = () => {};
  stdin.ref = () => {};
  stdin.unref = () => {};
  const frames: string[] = [];
  const stdout = new PassThrough() as PassThrough & { columns: number; rows: number };
  stdout.columns = 140;
  stdout.rows = 40;
  stdout.write = (chunk) => {
    frames.push(chunk as string);
    return true;
  };
  const instance = render(
    <SystemScreen
      snapshot={SNAPSHOT}
      host={HOST}
      personas={["kai"]}
      onBack={() => {}}
      sources={sources}
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
  return {
    stdin,
    latest: () => stripAnsi(frames.at(-1) ?? ""),
  };
}

describe("system log pane", () => {
  test("shows the selected source's path and full-stream command", async () => {
    const ui = mount([AUDIT, SERVICE]);
    ui.stdin.write("l"); // overview -> logs
    await sleep(60);
    const frame = ui.latest();
    expect(frame).toContain("/audit/2026-09-01.log");
    expect(frame).toContain("tail -f /home/kai/audit/*.log");
    expect(frame).toContain("bash: ran the doctor");
  });

  test("'s' cycles to the next source and shows ITS location", async () => {
    const ui = mount([AUDIT, SERVICE]);
    ui.stdin.write("l");
    await sleep(60);
    ui.stdin.write("s");
    await sleep(60);
    const frame = ui.latest();
    expect(frame).toContain("journald");
    expect(frame).toContain("journalctl --user -u phantombot -f");
    // The previous source's path must be gone, not merely appended to.
    expect(frame).not.toContain("2026-09-01.log");
  });

  test("the time window defaults to 'all' so durable sources are not hidden", async () => {
    const ui = mount([AUDIT, SERVICE]);
    ui.stdin.write("l");
    await sleep(60);
    const frame = ui.latest();
    // A 1h default silently filtered out yesterday's audit file and read as
    // "no logs" — the exact symptom #478 was filed for.
    expect(frame).toContain("Time all");
    expect(frame).toContain("bash: ran the doctor");
  });

  test("switching source ABORTS the previous read, so its child is killed", async () => {
    // React cleanup alone only discards the result; the journalctl/tail/
    // PowerShell child a source spawned would keep running, and cycling
    // sources would pile them up. The pane passes an AbortSignal.
    let seen: AbortSignal | undefined;
    const slow: LogSource = {
      ...AUDIT,
      id: "state",
      read: async (_limit, signal) => {
        seen = signal;
        return [];
      },
    };
    const ui = mount([slow, SERVICE]);
    ui.stdin.write("l");
    await sleep(60);
    expect(seen).toBeDefined();
    expect(seen!.aborted).toBe(false);
    ui.stdin.write("s"); // move off it
    await sleep(60);
    expect(seen!.aborted).toBe(true);
  });

  test("an empty source still shows where it would have come from", async () => {
    const ui = mount([SERVICE]);
    ui.stdin.write("l");
    await sleep(60);
    const frame = ui.latest();
    expect(frame).toContain("journald");
    expect(frame).toContain("No lines from service");
  });
});
