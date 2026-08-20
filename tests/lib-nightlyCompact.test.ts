import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  archiveDirPath,
  archiveForCompaction,
  type CompactionCandidate,
  compactionCandidates,
  compactionVerdict,
  DAILY_BUDGET_BYTES,
  defaultBudgets,
  formatCompactionSummary,
  resolveBudgets,
  settleCompaction,
} from "../src/lib/nightlyCompact.ts";
import { NIGHTLY_STAGES, type NightlyState } from "../src/lib/nightly.ts";

let dir: string;

const okRecord = {
  mtime_ms: 1,
  size: 1,
  hash: "h",
  stages_done: [...NIGHTLY_STAGES],
  completed_at: "2026-01-01T00:00:00.000Z",
  status: "ok" as const,
};

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "phantombot-compact-"));
  await mkdir(join(dir, "memory"), { recursive: true });
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const big = (n: number) => "x".repeat(n);

describe("compactionCandidates", () => {
  test("picks only files over budget", async () => {
    await writeFile(join(dir, "MEMORY.md"), big(20 * 1024));
    await writeFile(join(dir, "memory", "decisions.md"), big(1024));
    const got = await compactionCandidates(dir, {}, { today: "2026-08-20" });
    expect(got.map((c) => c.path)).toEqual(["MEMORY.md"]);
    expect(got[0]!.kind).toBe("memory");
    expect(got[0]!.sizeBytes).toBe(20 * 1024);
  });

  test("ignores drawers that do not exist", async () => {
    const got = await compactionCandidates(dir, {}, { today: "2026-08-20" });
    expect(got).toEqual([]);
  });

  test("daily file needs BOTH stages ok before it is a candidate", async () => {
    await writeFile(join(dir, "memory", "2026-01-01.md"), big(DAILY_BUDGET_BYTES + 1));
    const partial: NightlyState = {
      processed: { "2026-01-01": { ...okRecord, status: "partial", stages_done: ["distill"] } },
    };
    expect(await compactionCandidates(dir, partial, { today: "2026-08-20" })).toEqual([]);

    const done: NightlyState = { processed: { "2026-01-01": okRecord } };
    const got = await compactionCandidates(dir, done, { today: "2026-08-20" });
    expect(got.map((c) => c.path)).toEqual([join("memory", "2026-01-01.md")]);
    expect(got[0]!.date).toBe("2026-01-01");
  });

  test("daily file inside the age window is left alone", async () => {
    await writeFile(join(dir, "memory", "2026-08-19.md"), big(DAILY_BUDGET_BYTES + 1));
    const state: NightlyState = { processed: { "2026-08-19": okRecord } };
    expect(await compactionCandidates(dir, state, { today: "2026-08-20" })).toEqual([]);
    const got = await compactionCandidates(dir, state, {
      today: "2026-08-20",
      minAgeDays: 0,
    });
    expect(got).toHaveLength(1);
  });
});

describe("resolveBudgets", () => {
  test("override raises a byte budget but never the shrink guard", async () => {
    await writeFile(
      join(dir, "memory", ".compaction-budgets.json"),
      JSON.stringify({ "MEMORY.md": 99_999, maxShrinkPct: 100 }),
    );
    const b = await resolveBudgets(dir);
    const mem = b.find((x) => x.path === "MEMORY.md")!;
    expect(mem.budgetBytes).toBe(99_999);
    expect(mem.maxShrinkPct).toBe(40);
  });

  test("unreadable override falls back to defaults", async () => {
    await writeFile(join(dir, "memory", ".compaction-budgets.json"), "{not json");
    expect(await resolveBudgets(dir)).toEqual(defaultBudgets());
  });
});

describe("compactionVerdict", () => {
  const c = (size: number, pct = 40): CompactionCandidate => ({
    path: "MEMORY.md",
    kind: "memory",
    budgetBytes: 10,
    maxShrinkPct: pct,
    absPath: "/nope",
    sizeBytes: size,
  });

  test("classifies each outcome", () => {
    expect(compactionVerdict(c(100), 80).status).toBe("compacted");
    expect(compactionVerdict(c(100), 100).status).toBe("unchanged");
    expect(compactionVerdict(c(100), 120).status).toBe("grew");
    expect(compactionVerdict(c(100), 0).status).toBe("reverted");
  });

  test("shrinking past the allowance is reverted, at the boundary it is not", () => {
    expect(compactionVerdict(c(100), 60).status).toBe("compacted"); // exactly 40%
    const over = compactionVerdict(c(100), 59);
    expect(over.status).toBe("reverted");
    expect(over.note).toContain("limit 40%");
  });

  test("a daily file may lose most of its bulk", () => {
    expect(compactionVerdict(c(1000, 90), 100).status).toBe("compacted");
    expect(compactionVerdict(c(1000, 90), 99).status).toBe("reverted");
  });
});

describe("archive + settle", () => {
  const candidate = (absPath: string, size: number): CompactionCandidate => ({
    path: "MEMORY.md",
    kind: "memory",
    budgetBytes: 10,
    maxShrinkPct: 40,
    absPath,
    sizeBytes: size,
  });

  test("archives the exact bytes before a pass", async () => {
    const p = join(dir, "MEMORY.md");
    await writeFile(p, "original");
    const archived = await archiveForCompaction(dir, candidate(p, 8), "2026-08-20");
    expect(archived.startsWith(archiveDirPath(dir, "2026-08-20"))).toBe(true);
    expect(await readFile(archived, "utf8")).toBe("original");
    // the live file is copied, never moved
    expect(await readFile(p, "utf8")).toBe("original");
  });

  test("a pass within the allowance is kept and accounted", async () => {
    const p = join(dir, "MEMORY.md");
    await writeFile(p, big(100));
    const c = candidate(p, 100);
    const archived = await archiveForCompaction(dir, c, "2026-08-20");
    await writeFile(p, big(70));
    const outcome = await settleCompaction(c, archived);
    expect(outcome.status).toBe("compacted");
    expect(outcome.bytesBefore).toBe(100);
    expect(outcome.bytesAfter).toBe(70);
    expect((await stat(p)).size).toBe(70);
  });

  test("an over-eager pass is rolled back from the archive", async () => {
    const p = join(dir, "MEMORY.md");
    await writeFile(p, "keep me".repeat(20));
    const c = candidate(p, (await stat(p)).size);
    const archived = await archiveForCompaction(dir, c, "2026-08-20");
    await writeFile(p, "oops");
    const outcome = await settleCompaction(c, archived);
    expect(outcome.status).toBe("reverted");
    expect(outcome.bytesAfter).toBe(outcome.bytesBefore);
    expect(await readFile(p, "utf8")).toBe("keep me".repeat(20));
  });

  test("a file deleted by the pass is restored", async () => {
    const p = join(dir, "MEMORY.md");
    await writeFile(p, "content");
    const c = candidate(p, 7);
    const archived = await archiveForCompaction(dir, c, "2026-08-20");
    await rm(p);
    const outcome = await settleCompaction(c, archived);
    expect(outcome.status).toBe("reverted");
    expect(await readFile(p, "utf8")).toBe("content");
  });
});

test("summary reports totals and per-file bytes", () => {
  const s = formatCompactionSummary([
    { path: "MEMORY.md", kind: "memory", bytesBefore: 100, bytesAfter: 60, status: "compacted" },
  ]);
  expect(s).toContain("100 → 60 bytes");
  expect(s).toContain("MEMORY.md");
  expect(formatCompactionSummary([])).toContain("nothing over budget");
});
