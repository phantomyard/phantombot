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
import { Database } from "bun:sqlite";
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
import { TaskStore } from "../src/lib/tasks.ts";
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

describe("tasks source against the PRODUCTION task_runs schema", () => {
  // The bug this guards: the source was written against a `detail` column that
  // does not exist. `TaskStore` writes `output_excerpt`. SQLite raises
  // `no such column` only at query time, so a fixture that invents its own
  // table proves nothing — this one builds the schema through TaskStore itself,
  // exactly as production does, so a column rename breaks the test first.
  test("renders real fires written by TaskStore.logRun", async () => {
    const { host, dir } = await hostWithPersona();
    const dbPath = join(dir, "memory.sqlite");
    const db = new Database(dbPath);
    const store = new TaskStore(db);
    const added = store.add({
      persona: "kai",
      description: "fixture",
      schedule: "*/5 * * * *",
      prompt: "check something",
    });
    expect(added.ok).toBe(true);
    const taskId = (added as { ok: true; id: number }).id;
    store.logRun({
      taskId,
      firedAt: new Date("2026-09-01T12:00:00Z"),
      status: "ok",
      exitCode: 0,
      outputExcerpt: "all quiet",
      delivered: true,
    });
    store.logRun({
      taskId,
      firedAt: new Date("2026-09-01T12:05:00Z"),
      status: "error",
      exitCode: 2,
      outputExcerpt: "boom",
      delivered: false,
    });
    db.close();

    const tasks = logSources({ host }).find((s) => s.id === "tasks");
    expect(tasks?.available).toBe(true);
    const lines = await tasks!.read(DEFAULT_SOURCE_LIMIT);
    const text = lines.map((l) => l.msg).join("\n");
    // Not the "no task fires recorded" placeholder the broken query produced.
    expect(text).not.toContain("no task fires recorded");
    expect(text).not.toContain("could not read task_runs");
    expect(text).toContain("all quiet");
    expect(text).toContain("boom");
    expect(text).toContain("exit 2");
    expect(lines.some((l) => l.level === "error")).toBe(true);
  });

  test("a database whose task_runs cannot be read explains itself, never renders empty", async () => {
    const { host, dir } = await hostWithPersona();
    // A file that is a valid DB but has no task_runs table at all.
    const db = new Database(join(dir, "memory.sqlite"));
    db.exec("CREATE TABLE unrelated (id INTEGER)");
    db.close();
    const tasks = logSources({ host }).find((s) => s.id === "tasks");
    const lines = await tasks!.read(DEFAULT_SOURCE_LIMIT);
    expect(lines.length).toBeGreaterThan(0);
    expect(lines[0]!.msg).toContain("task_runs");
  });
});
