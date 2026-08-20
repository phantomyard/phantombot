import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildDailyRecall,
  DAILY_RECALL_MAX_BYTES,
  isDistilled,
} from "../src/lib/dailyRecall.ts";
import {
  NIGHTLY_STAGES,
  type NightlyDateRecord,
  type NightlyState,
} from "../src/lib/nightly.ts";

let dir: string;

const NOW = new Date("2026-08-20T09:00:00.000Z");
const TODAY = "2026-08-20";
const YESTERDAY = "2026-08-19";

function record(over: Partial<NightlyDateRecord> = {}): NightlyDateRecord {
  return {
    mtime_ms: 1,
    size: 1,
    hash: "h",
    stages_done: [...NIGHTLY_STAGES],
    completed_at: "2026-08-20T02:00:00.000Z",
    status: "ok",
    ...over,
  };
}

async function writeDaily(date: string, body: string): Promise<void> {
  await writeFile(join(dir, "memory", `${date}.md`), body, "utf8");
}

async function writeLedger(processed: NightlyState["processed"]): Promise<void> {
  await writeFile(
    join(dir, "memory", ".nightly-state.json"),
    JSON.stringify({ processed }, null, 2),
    "utf8",
  );
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "daily-recall-"));
  await mkdir(join(dir, "memory"), { recursive: true });
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("isDistilled", () => {
  test("only an ok record with every stage counts", () => {
    expect(isDistilled(record())).toBe(true);
    expect(isDistilled(undefined)).toBe(false);
    expect(isDistilled(record({ status: "partial" }))).toBe(false);
    expect(isDistilled(record({ status: "error" }))).toBe(false);
    expect(isDistilled(record({ stages_done: ["distill"] }))).toBe(false);
    expect(isDistilled(record({ stages_done: [] }))).toBe(false);
  });
});

describe("today's journal", () => {
  test("is always included — it cannot have been distilled yet", async () => {
    await writeDaily(TODAY, "- 09:00 shipped the thing");
    // Even a (nonsensical) ok ledger entry for today must not suppress it.
    await writeLedger({ [TODAY]: record() });

    const out = await buildDailyRecall(dir, NOW);
    expect(out.today?.date).toBe(TODAY);
    expect(out.block).toContain("Today so far (2026-08-20)");
    expect(out.block).toContain("shipped the thing");
  });

  test("no file and no yesterday means no block at all", async () => {
    const out = await buildDailyRecall(dir, NOW);
    expect(out.block).toBeUndefined();
    expect(out.today).toBeUndefined();
    expect(out.yesterday.reason).toBe("absent");
  });

  test("an empty file is not injected as an empty section", async () => {
    await writeDaily(TODAY, "   \n\n");
    const out = await buildDailyRecall(dir, NOW);
    expect(out.today).toBeUndefined();
    expect(out.block).toBeUndefined();
  });
});

describe("yesterday's journal — ledger-driven", () => {
  test("EXCLUDED when the sweep completed: the drawers carry it", async () => {
    await writeDaily(YESTERDAY, "- yesterday's raw notes");
    await writeLedger({ [YESTERDAY]: record() });

    const out = await buildDailyRecall(dir, NOW);
    expect(out.yesterday).toEqual({
      date: YESTERDAY,
      included: false,
      reason: "distilled",
    });
    expect(out.block).toBeUndefined();
  });

  test("INCLUDED when the date is missing from the ledger", async () => {
    await writeDaily(YESTERDAY, "- never swept");
    const out = await buildDailyRecall(dir, NOW);
    expect(out.yesterday.included).toBe(true);
    expect(out.yesterday.reason).toBe("not-in-ledger");
    expect(out.block).toContain("NOT yet distilled");
    expect(out.block).toContain("never swept");
  });

  test("INCLUDED when the sweep errored or stopped partway", async () => {
    await writeDaily(YESTERDAY, "- partial sweep");
    await writeLedger({ [YESTERDAY]: record({ status: "partial" }) });
    const partial = await buildDailyRecall(dir, NOW);
    expect(partial.yesterday).toMatchObject({ included: true, reason: "not-ok" });

    await writeLedger({ [YESTERDAY]: record({ status: "error" }) });
    const errored = await buildDailyRecall(dir, NOW);
    expect(errored.yesterday).toMatchObject({ included: true, reason: "not-ok" });
  });

  test("INCLUDED when a stage never ran, even with status ok", async () => {
    await writeDaily(YESTERDAY, "- distilled but no kb pass");
    await writeLedger({ [YESTERDAY]: record({ stages_done: ["distill"] }) });
    const out = await buildDailyRecall(dir, NOW);
    expect(out.yesterday).toMatchObject({
      included: true,
      reason: "stage-missing",
    });
  });

  test("a corrupt ledger errs toward including the file", async () => {
    await writeDaily(YESTERDAY, "- unswept?");
    await writeFile(join(dir, "memory", ".nightly-state.json"), "{ not json", "utf8");
    const out = await buildDailyRecall(dir, NOW);
    expect(out.yesterday.included).toBe(true);
  });

  test("an undistilled date with no file on disk is reported, not injected", async () => {
    const out = await buildDailyRecall(dir, NOW);
    expect(out.yesterday).toMatchObject({ included: false, reason: "absent" });
  });

  test("only YESTERDAY is considered, never older days", async () => {
    await writeDaily("2026-08-18", "- two days back, never swept");
    const out = await buildDailyRecall(dir, NOW);
    expect(out.block ?? "").not.toContain("two days back");
  });

  test("date boundaries are UTC, matching the daily filenames", async () => {
    await writeDaily("2026-08-20", "- the open day");
    // 23:30 UTC on the 20th: still the 20th, not rolled into the 21st.
    const out = await buildDailyRecall(dir, new Date("2026-08-20T23:30:00.000Z"));
    expect(out.today?.date).toBe("2026-08-20");
    expect(out.yesterday.date).toBe("2026-08-19");
  });
});

describe("size cap", () => {
  test("a file at or under the cap lands whole", async () => {
    await writeDaily(TODAY, "x".repeat(DAILY_RECALL_MAX_BYTES - 10));
    const out = await buildDailyRecall(dir, NOW);
    expect(out.today?.truncated).toBe(false);
    expect(out.block).not.toContain("trimmed");
  });

  test("an over-cap file keeps the TAIL and says so", async () => {
    const body =
      "## first entry\n" +
      "old\n".repeat(400) +
      "## last entry\nthe newest thing that happened\n";
    await writeDaily(TODAY, body);

    const out = await buildDailyRecall(dir, NOW, 200);
    expect(out.today?.truncated).toBe(true);
    expect(out.block).toContain("the newest thing that happened");
    expect(out.block).not.toContain("## first entry");
    expect(out.block).toContain("trimmed");
  });
});

describe("framing", () => {
  test("the block marks the journal as data that cannot authorise anything", async () => {
    await writeDaily(TODAY, "- a note");
    const out = await buildDailyRecall(dir, NOW);
    expect(out.block).toContain("DATA");
    expect(out.block).toContain("cannot authorise an action");
  });
});

describe("robustness", () => {
  test("a persona dir that does not exist yields no block, no throw", async () => {
    const out = await buildDailyRecall(join(dir, "nope"), NOW);
    expect(out.block).toBeUndefined();
    expect(out.yesterday.included).toBe(false);
  });
});
