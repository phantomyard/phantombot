import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ToolCallDetail } from "../src/harnesses/toolNote.ts";
import {
  auditEnabled,
  createAuditSink,
  flushAuditWritesForTest,
  recordToolCall,
} from "../src/lib/auditLog.ts";

function detail(over: Partial<ToolCallDetail> = {}): ToolCallDetail {
  return {
    title: "Bash: git status",
    kind: "execute",
    locations: [],
    ...over,
  };
}

async function readAuditLines(agentDir: string): Promise<
  Array<{ ts: string; kind: string; note: string; locations: string[] }>
> {
  const dir = join(agentDir, "audit");
  const files = await readdir(dir);
  expect(files.length).toBe(1); // one file, today's date
  const raw = await readFile(join(dir, files[0]!), "utf8");
  return raw
    .trim()
    .split("\n")
    .map((l) => JSON.parse(l));
}

describe("auditLog", () => {
  let agentDir: string;
  const prevEnv = process.env.PHANTOMBOT_AUDIT_TOOL_CALLS;

  beforeEach(async () => {
    agentDir = await mkdtemp(join(tmpdir(), "pb-audit-"));
    delete process.env.PHANTOMBOT_AUDIT_TOOL_CALLS;
  });

  afterEach(async () => {
    await flushAuditWritesForTest();
    await rm(agentDir, { recursive: true, force: true });
    if (prevEnv === undefined) delete process.env.PHANTOMBOT_AUDIT_TOOL_CALLS;
    else process.env.PHANTOMBOT_AUDIT_TOOL_CALLS = prevEnv;
  });

  test("records a tool call as one JSONL line with ts/kind/note", async () => {
    recordToolCall(agentDir, detail(), new Date("2026-07-09T12:00:00.000Z"));
    await flushAuditWritesForTest();

    const lines = await readAuditLines(agentDir);
    expect(lines.length).toBe(1);
    expect(lines[0]!.ts).toBe("2026-07-09T12:00:00.000Z");
    expect(lines[0]!.kind).toBe("execute");
    expect(lines[0]!.note).toBe("Bash: git status");
  });

  test("preserves order across serialized appends", async () => {
    for (let i = 0; i < 5; i++) {
      recordToolCall(agentDir, detail({ title: `Bash: step ${i}` }));
    }
    await flushAuditWritesForTest();

    const lines = await readAuditLines(agentDir);
    expect(lines.map((l) => l.note)).toEqual([
      "Bash: step 0",
      "Bash: step 1",
      "Bash: step 2",
      "Bash: step 3",
      "Bash: step 4",
    ]);
  });

  test("redacts secrets in the note before writing", async () => {
    recordToolCall(
      agentDir,
      detail({ title: "Bash: export GITHUB_TOKEN=ghp_abcdef0123456789abcd" }),
    );
    await flushAuditWritesForTest();

    const lines = await readAuditLines(agentDir);
    expect(lines[0]!.note).not.toContain("ghp_abcdef0123456789abcd");
    expect(lines[0]!.note).toContain("[REDACTED]");
  });

  test("redacts secrets embedded in file locations too", async () => {
    recordToolCall(
      agentDir,
      detail({
        title: "Read: config",
        kind: "read",
        locations: [{ path: "/home/user@example.com/notes.md" }],
      }),
    );
    await flushAuditWritesForTest();

    const lines = await readAuditLines(agentDir);
    expect(lines[0]!.locations[0]).toContain("[EMAIL_REDACTED]");
  });

  test("never throws on an unwritable agent dir", async () => {
    // Non-existent parent under a file (not a dir) → mkdir rejects; the call
    // must swallow it. We only assert it doesn't throw and doesn't reject.
    const bogus = join(agentDir, "afile");
    await Bun.write(bogus, "x");
    expect(() => recordToolCall(join(bogus, "nested"), detail())).not.toThrow();
    await flushAuditWritesForTest();
  });

  describe("auditEnabled / createAuditSink toggle", () => {
    test("on by default", () => {
      expect(auditEnabled()).toBe(true);
      expect(createAuditSink(agentDir)).toBeDefined();
    });

    test("disabled by 0/off/false/no", () => {
      for (const v of ["0", "off", "false", "no", "OFF", " false "]) {
        process.env.PHANTOMBOT_AUDIT_TOOL_CALLS = v;
        expect(auditEnabled()).toBe(false);
        expect(createAuditSink(agentDir)).toBeUndefined();
      }
    });

    test("enabled by any other value", () => {
      process.env.PHANTOMBOT_AUDIT_TOOL_CALLS = "1";
      expect(auditEnabled()).toBe(true);
    });

    test("no sink without an agent dir", () => {
      expect(createAuditSink(undefined)).toBeUndefined();
      expect(createAuditSink("")).toBeUndefined();
    });

    test("the sink writes through to disk", async () => {
      const sink = createAuditSink(agentDir);
      expect(sink).toBeDefined();
      sink!(detail({ title: "Grep: needle" }));
      await flushAuditWritesForTest();
      const lines = await readAuditLines(agentDir);
      expect(lines[0]!.note).toBe("Grep: needle");
    });
  });
});
