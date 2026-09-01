/**
 * The log pane's sources (#478).
 *
 * The regression these guard is the one Andrew hit: the pane showed `0/0`
 * because the ONLY source was a process-local ring, and the daemon — the
 * process that actually logs — is somewhere else entirely. So the assertions
 * here are about (a) every source naming WHERE its bytes live, and (b) a
 * source that cannot be read saying so in a row rather than returning empty,
 * because an empty pane is indistinguishable from a quiet host.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  DEFAULT_SOURCE_LIMIT,
  EMPTY_SOURCE,
  LOG_SOURCE_IDS,
  logSources,
} from "../src/tui/logSources.ts";
import { configuredBufferLimit, LogBuffer } from "../src/tui/logBuffer.ts";
import type { HostSnapshot } from "../src/tui/snapshot.ts";

const temps: string[] = [];
afterEach(async () => {
  for (const dir of temps.splice(0)) await rm(dir, { recursive: true, force: true });
});

async function hostWithPersona(): Promise<{ host: HostSnapshot; dir: string }> {
  const root = await mkdtemp(join(tmpdir(), "pb478-"));
  temps.push(root);
  const dir = join(root, "kai");
  await mkdir(join(dir, "audit"), { recursive: true });
  const host = {
    version: "test",
    updateChannel: "stable",
    defaultPersona: "kai",
    personasDir: root,
    personas: [
      {
        name: "kai",
        dir,
        isDefault: true,
        autostart: true,
        chain: ["claude"],
        memory: { dbPath: join(dir, "memory.sqlite") },
      },
    ],
  } as unknown as HostSnapshot;
  return { host, dir };
}

describe("logSources", () => {
  test("offers every source, in cycle order, each naming where its bytes live", async () => {
    const { host } = await hostWithPersona();
    const sources = logSources({ host });
    expect(sources.map((s) => s.id)).toEqual(LOG_SOURCE_IDS);
    // The whole point of the issue: no source may be anonymous.
    for (const source of sources) {
      expect(source.location.length).toBeGreaterThan(0);
      expect(source.label.length).toBeGreaterThan(0);
    }
  });

  test("the audit source points at the persona's own audit file", async () => {
    const { host, dir } = await hostWithPersona();
    const audit = logSources({ host }).find((s) => s.id === "audit")!;
    expect(audit.location).toContain(join(dir, "audit"));
    expect(audit.location).toMatch(/\d{4}-\d{2}-\d{2}\.log$/);
    expect(audit.available).toBe(true);
  });

  test("audit reads the JSON lines auditLog.ts writes, with tool locations", async () => {
    const { host, dir } = await hostWithPersona();
    const day = new Date().toISOString().slice(0, 10);
    await writeFile(
      join(dir, "audit", `${day}.log`),
      JSON.stringify({
        ts: "2026-09-01T10:00:00.000Z",
        kind: "bash",
        note: "list the vault",
        locations: ["/home/kai/.config"],
      }) + "\n",
    );
    const audit = logSources({ host }).find((s) => s.id === "audit")!;
    const lines = await audit.read(DEFAULT_SOURCE_LIMIT);
    expect(lines).toHaveLength(1);
    expect(lines[0]!.msg).toContain("bash: list the vault");
    expect(lines[0]!.msg).toContain("/home/kai/.config");
    expect(lines[0]!.persona).toBe("kai");
    expect(lines[0]!.at).toBe(Date.parse("2026-09-01T10:00:00.000Z"));
  });

  test("an empty audit trail explains itself rather than returning nothing", async () => {
    const { host } = await hostWithPersona();
    const audit = logSources({ host }).find((s) => s.id === "audit")!;
    const lines = await audit.read(10);
    // Not [] — an empty pane is what made the old design unreadable.
    expect(lines).toHaveLength(1);
    expect(lines[0]!.msg).toContain("no tool calls recorded");
  });

  test("a host with no personas still lists audit/tasks, marked unavailable", async () => {
    const host = {
      version: "test",
      updateChannel: "stable",
      defaultPersona: "none",
      personasDir: "/tmp/none",
      personas: [],
    } as unknown as HostSnapshot;
    const sources = logSources({ host });
    const audit = sources.find((s) => s.id === "audit")!;
    const tasks = sources.find((s) => s.id === "tasks")!;
    expect(audit.available).toBe(false);
    expect(audit.note).toBeTruthy();
    expect(tasks.available).toBe(false);
    // Still LISTED: hiding it makes "no source" look like "no logs".
    expect(sources.map((s) => s.id)).toEqual(LOG_SOURCE_IDS);
  });

  test("the service source names the platform's real sink and a full-stream command", async () => {
    const { host } = await hostWithPersona();
    const service = logSources({ host }).find((s) => s.id === "service")!;
    expect(service.command.length).toBeGreaterThan(0);
    if (process.platform === "linux") {
      expect(service.location).toContain("journald");
      expect(service.command).toContain("journalctl");
    } else {
      expect(service.location).toContain("phantombot");
    }
  });

  test("the session source is honest that it is this process only", async () => {
    const { host } = await hostWithPersona();
    const session = logSources({ host }).find((s) => s.id === "session")!;
    expect(session.location).toContain("in-memory");
    const lines = await session.read(10);
    // The old pane's silent `0/0`, now a row that points at `service`.
    expect(lines[0]!.msg).toContain("service");
  });

  test("EMPTY_SOURCE reads clean so an empty source list cannot crash the pane", async () => {
    expect(await EMPTY_SOURCE.read(10)).toEqual([]);
    expect(EMPTY_SOURCE.available).toBe(false);
  });
});

describe("log buffer capacity", () => {
  test("defaults far above the old 100 lines and honours the env override", () => {
    expect(configuredBufferLimit({})).toBe(5000);
    expect(configuredBufferLimit({ PHANTOMBOT_TUI_LOG_LINES: "42" })).toBe(42);
    // Garbage must not silently produce a zero-length buffer.
    expect(configuredBufferLimit({ PHANTOMBOT_TUI_LOG_LINES: "nope" })).toBe(5000);
    expect(configuredBufferLimit({ PHANTOMBOT_TUI_LOG_LINES: "-1" })).toBe(5000);
  });

  test("the ring still evicts oldest-first at its limit", () => {
    const buffer = new LogBuffer(3);
    for (const n of [1, 2, 3, 4]) buffer.push(`line ${n}`);
    expect(buffer.all().map((l) => l.msg)).toEqual(["line 2", "line 3", "line 4"]);
  });
});
