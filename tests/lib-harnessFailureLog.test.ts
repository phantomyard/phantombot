/**
 * Tests for the bounded harness-failure evidence log (issue #638).
 */

import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  boundStderrTail,
  createHarnessFailureSink,
} from "../src/lib/harnessFailureLog.ts";

describe("boundStderrTail", () => {
  test("keeps the LAST 20 lines, each capped to 400 chars", () => {
    const lines = Array.from({ length: 30 }, (_, i) => `line ${i}`);
    const out = boundStderrTail(lines)!;
    expect(out.length).toBe(20);
    expect(out[0]).toBe("line 10");
    expect(out.at(-1)).toBe("line 29");

    const long = ["y".repeat(1000)];
    expect(boundStderrTail(long)![0]!.length).toBe(400);
  });

  test("empty and undefined tails collapse to undefined", () => {
    expect(boundStderrTail(undefined)).toBeUndefined();
    expect(boundStderrTail([])).toBeUndefined();
  });
});

describe("createHarnessFailureSink", () => {
  test("appends one JSON line per failure under <agentDir>/harness-failures/", () => {
    const dir = mkdtempSync(join(tmpdir(), "hfl-"));
    try {
      const sink = createHarnessFailureSink(dir);
      sink({
        ts: "2026-10-01T10:36:00Z",
        persona: "kai",
        harnessId: "codex",
        error: "codex exited with code 1",
        exitCode: 1,
        cause: "rate_limit",
        stderrTail: ["ERROR: You've hit your usage limit."],
      });
      sink({ ts: "2026-10-01T10:37:00Z", harnessId: "native", error: "timed out" });
      const date = new Date().toISOString().slice(0, 10);
      const raw = readFileSync(
        join(dir, "harness-failures", `${date}.jsonl`),
        "utf8",
      );
      const rows = raw.trim().split("\n").map((l) => JSON.parse(l));
      expect(rows.length).toBe(2);
      expect(rows[0]).toMatchObject({
        persona: "kai",
        harnessId: "codex",
        exitCode: 1,
        stderrTail: ["ERROR: You've hit your usage limit."],
      });
      expect(rows[1]).toMatchObject({ harnessId: "native" });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a broken sink degrades to a silent no-op, never throws", () => {
    // A path where a regular FILE occupies the directory slot → mkdir fails.
    const dir = mkdtempSync(join(tmpdir(), "hfl-"));
    const blocker = join(dir, "harness-failures");
    const { writeFileSync } = require("node:fs") as typeof import("node:fs");
    writeFileSync(blocker, "not a directory");
    try {
      const sink = createHarnessFailureSink(dir);
      expect(() =>
        sink({ ts: "t", harnessId: "codex", error: "e" }),
      ).not.toThrow();
      // Second call is also a no-op (broken latch), still not a throw.
      expect(() =>
        sink({ ts: "t", harnessId: "codex", error: "e" }),
      ).not.toThrow();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
