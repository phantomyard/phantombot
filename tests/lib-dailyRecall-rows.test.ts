/**
 * Daily recall reading the journal TABLE (#461).
 *
 * The point of the move is that the prompt stops scaling with how busy the day
 * was, so the assertions that matter are: rows are preferred when they exist,
 * markdown still works when they do not, the budget is enforced on whole
 * entries, and the block SAYS what it left out.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { buildDailyRecall } from "../src/lib/dailyRecall.ts";
import { openJournalStore } from "../src/memory/journalIngest.ts";

let dir: string;
let dbPath: string;

const NOW = new Date("2026-08-27T18:00:00.000Z");
const TODAY = "2026-08-27";

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "phantombot-recall-rows-"));
  await mkdir(join(dir, "memory"), { recursive: true });
  dbPath = join(dir, "memory.db");
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

async function seed(
  rows: Array<{ content: string; tags?: string[]; source?: "self" | "task"; at: string }>,
): Promise<void> {
  const { store, close } = await openJournalStore(dbPath);
  try {
    for (const r of rows) {
      store.append({
        persona: "robbie",
        date: TODAY,
        content: r.content,
        tags: r.tags,
        source: r.source,
        createdAt: new Date(`${TODAY}T${r.at}:00.000Z`),
      });
    }
  } finally {
    close();
  }
}

const src = () => ({ dbPath, persona: "robbie" });

describe("buildDailyRecall over rows", () => {
  test("prefers the table over the markdown file", async () => {
    await writeFile(
      join(dir, "memory", `${TODAY}.md`),
      `# ${TODAY}\n- stale copy on disk\n`,
      "utf8",
    );
    await seed([{ content: "the row version", at: "09:00" }]);

    const d = await buildDailyRecall(dir, NOW, undefined, undefined, src());
    expect(d.today?.layer).toBe("rows");
    expect(d.block).toContain("the row version");
    expect(d.block).not.toContain("stale copy on disk");
  });

  test("falls back to markdown when the table has nothing for the day", async () => {
    await writeFile(
      join(dir, "memory", `${TODAY}.md`),
      `# ${TODAY}\n- only on disk\n`,
      "utf8",
    );
    const d = await buildDailyRecall(dir, NOW, undefined, undefined, src());
    // An un-ingested persona must not lose its journal just because the rows
    // have not caught up yet.
    expect(d.today?.layer).toBe("file");
    expect(d.block).toContain("only on disk");
  });

  test("falls back to markdown when the database will not open", async () => {
    await writeFile(
      join(dir, "memory", `${TODAY}.md`),
      `# ${TODAY}\n- only on disk\n`,
      "utf8",
    );
    const d = await buildDailyRecall(dir, NOW, undefined, undefined, {
      dbPath: join(dir, "no-such-dir-file", "x", "\0bad"),
      persona: "robbie",
    });
    expect(d.today?.layer).toBe("file");
    expect(d.block).toContain("only on disk");
  });

  test("scheduler rows are withheld from the block and counted in it", async () => {
    await seed([
      { content: "a real decision", tags: ["decision"], at: "09:00" },
      { content: "task 577: poll — fires later", source: "task", at: "09:05" },
    ]);
    const d = await buildDailyRecall(dir, NOW, undefined, undefined, src());
    expect(d.block).toContain("a real decision");
    expect(d.block).not.toContain("task 577");
    expect(d.block).toContain("1 scheduled-task entry withheld");
  });

  test("the budget degrades older entries to stubs and says so", async () => {
    await seed(
      Array.from({ length: 40 }, (_, i) => ({
        content: `entry ${i} ${"y".repeat(60)}`,
        at: `09:${String(i).padStart(2, "0")}`,
      })),
    );
    const d = await buildDailyRecall(dir, NOW, 2_000, undefined, src());
    expect(d.today?.truncated).toBe(true);
    // Unexplained, an `… · elided` line reads as corruption; explained, it
    // reads as an index of the rest of the day, which is the point of #467.
    expect(d.block).toContain("shown as one-line stubs");
    expect(d.block).toContain("elided");
    // The block must say the missing entries are RETRIEVABLE. Truncation the
    // model cannot see reads as absence, and absence is what makes it
    // re-derive what it already wrote down this morning.
    expect(d.block).toContain("Nothing is lost");
    expect(d.block).toContain("memory search");
    // The newest survive IN FULL, the next band down as stubs carrying their
    // head text — which a bare count never did — and the block says plainly
    // how many got neither. Stubs are paid for out of the SAME budget, so a
    // heavy day still degrades rather than growing the prompt.
    expect(d.block).toContain("entry 39");
    expect(d.block).toContain("further entries are not shown at all");
    const lines = d.block!.split("\n").filter((l) => l.startsWith("- "));
    expect(lines.some((l) => l.includes("elided"))).toBe(true);
    expect(lines.at(-1)).not.toContain("elided");
    // Chronological throughout: stubs sit where they happened, not in a
    // footer — a stub in its right place says WHEN something is missing.
    const stamps = lines.map((l) => l.slice(-6));
    expect([...stamps].sort()).toEqual(stamps);
  });

  test("no rows and no file means no journal block at all", async () => {
    const d = await buildDailyRecall(dir, NOW, undefined, undefined, src());
    expect(d.today).toBeUndefined();
    expect(d.block).toBeUndefined();
  });

  test("an undistilled yesterday is served from rows too", async () => {
    const { store, close } = await openJournalStore(dbPath);
    try {
      store.append({
        persona: "robbie",
        date: "2026-08-26",
        content: "yesterday, never swept",
        createdAt: new Date("2026-08-26T10:00:00.000Z"),
      });
    } finally {
      close();
    }
    const d = await buildDailyRecall(dir, NOW, undefined, undefined, src());
    expect(d.yesterday.included).toBe(true);
    expect(d.yesterday.layer).toBe("rows");
    expect(d.yesterday.reason).toBe("not-in-ledger");
    expect(d.block).toContain("yesterday, never swept");
  });
});
