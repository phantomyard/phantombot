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

/**
 * A ledger record whose fingerprint MATCHES the file on disk — i.e. the day is
 * distilled and nothing has been appended since the sweep. Anything else and
 * the shared `isDailyDistilled` predicate rightly refuses to compact it.
 */
const sweptRecord = async (date: string) => {
  const st = await stat(join(dir, "memory", `${date}.md`));
  return { ...okRecord, mtime_ms: Math.floor(st.mtimeMs), size: st.size };
};

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

  test("an over-budget drawer file is NEVER a candidate", async () => {
    // Drawers are database rows now (#417/#418); a drawer file on disk is a
    // retirement hold, reported by the heartbeat and `doctor`. Compaction
    // must never select or rewrite it, and since #419 it does not even
    // measure it — there is no drawer budget left to report.
    await writeFile(join(dir, "memory", "commitments.md"), big(700 * 1024));
    await writeFile(join(dir, "memory", "decisions.md"), big(700 * 1024));
    expect(await compactionCandidates(dir, {}, { today: "2026-08-20" })).toEqual([]);
    expect(defaultBudgets().map((b) => b.path)).toEqual(["MEMORY.md"]);
  });

  test("daily file needs BOTH stages ok before it is a candidate", async () => {
    await writeFile(join(dir, "memory", "2026-01-01.md"), big(DAILY_BUDGET_BYTES + 1));
    const partial: NightlyState = {
      processed: { "2026-01-01": { ...okRecord, status: "partial", stages_done: ["distill"] } },
    };
    expect(await compactionCandidates(dir, partial, { today: "2026-08-20" })).toEqual([]);

    const done: NightlyState = {
      processed: { "2026-01-01": await sweptRecord("2026-01-01") },
    };
    const got = await compactionCandidates(dir, done, { today: "2026-08-20" });
    expect(got.map((c) => c.path)).toEqual([join("memory", "2026-01-01.md")]);
    expect(got[0]!.date).toBe("2026-01-01");
  });

  test("a day APPENDED TO after its sweep is not a candidate", async () => {
    // The tail was never promoted to a drawer or a KB note, so this is the one
    // place it exists. `dailyRecall` re-injects exactly this case; if the
    // compactor disagreed it would truncate the tail to a stub instead.
    const file = join(dir, "memory", "2026-01-01.md");
    await writeFile(file, big(DAILY_BUDGET_BYTES + 1));
    const rec = await sweptRecord("2026-01-01");
    await writeFile(file, `${big(DAILY_BUDGET_BYTES + 1)}\n- [lesson] late capture\n`);

    const stale: NightlyState = { processed: { "2026-01-01": rec } };
    expect(await compactionCandidates(dir, stale, { today: "2026-08-20" })).toEqual([]);

    // Re-swept: same file, fingerprint caught up — now it may be compacted.
    const fresh: NightlyState = {
      processed: { "2026-01-01": await sweptRecord("2026-01-01") },
    };
    expect(
      (await compactionCandidates(dir, fresh, { today: "2026-08-20" })).map((c) => c.date),
    ).toEqual(["2026-01-01"]);
  });

  test("daily file inside the age window is left alone", async () => {
    await writeFile(join(dir, "memory", "2026-08-19.md"), big(DAILY_BUDGET_BYTES + 1));
    const state: NightlyState = {
      processed: { "2026-08-19": await sweptRecord("2026-08-19") },
    };
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

  test("a second same-day pass archives its OWN pre-image, not the first's", async () => {
    // Regression: reusing the first pass's copy rolls a later pass back PAST
    // its own starting point, resurrecting content the first pass correctly
    // removed. Each pass must be recoverable to the state it began from.
    const p = join(dir, "MEMORY.md");
    await writeFile(p, "A".repeat(100));
    const first = await archiveForCompaction(dir, candidate(p, 100), "2026-08-20");

    // pass one prunes down to 70 bytes, legitimately
    await writeFile(p, "B".repeat(70));
    const c2 = candidate(p, 70);
    const second = await archiveForCompaction(dir, c2, "2026-08-20");
    expect(second).not.toBe(first);
    expect(await readFile(second, "utf8")).toBe("B".repeat(70));
    // the first pre-image survives — nothing in the archive is ever deleted
    expect(await readFile(first, "utf8")).toBe("A".repeat(100));

    // pass two overshoots and is rolled back to 70 bytes, NOT to 100
    await writeFile(p, "C");
    const outcome = await settleCompaction(c2, second);
    expect(outcome.status).toBe("reverted");
    expect(await readFile(p, "utf8")).toBe("B".repeat(70));
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
