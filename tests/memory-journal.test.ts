/**
 * The daily journal as rows (#461).
 *
 * The load-bearing assertions here are the ones that name the ACTUAL bug this
 * replaced: a two-tag capture must produce ONE row and ONE line (it used to
 * produce two of each, and both copies were injected into every prompt for the
 * rest of the day), and ingesting the historical markdown must COLLAPSE the
 * pairs it already wrote rather than faithfully preserving them.
 *
 * The second group is about not losing anything on the way: nothing is
 * deleted, closed days keep their bytes, a hand-appended line is absorbed
 * rather than clobbered, and a budgeted recall says how much it dropped.
 */

import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtemp, mkdir, readFile, writeFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  JournalStore,
  journalEntryId,
  normalizeTags,
  renderDay,
  renderEntry,
  selectForRecall,
  type JournalEntry,
} from "../src/memory/journal.ts";
import {
  ingestJournalDir,
  ingestJournalMarkdown,
  mirrorDay,
  openJournalStore,
  parseJournalLine,
  writeJournalEntry,
} from "../src/memory/journalIngest.ts";

const P = "robbie";
const DAY = "2026-08-27";

function store(): JournalStore {
  return new JournalStore(new Database(":memory:"));
}

async function personaTree(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "phantombot-journal-"));
  await mkdir(join(dir, "memory"), { recursive: true });
  return dir;
}

function entry(over: Partial<JournalEntry> = {}): JournalEntry {
  return {
    id: "x",
    persona: P,
    date: DAY,
    content: "something happened",
    tags: [],
    source: "self",
    createdAt: new Date(`${DAY}T09:00:00.000Z`),
    ...over,
  };
}

describe("journal rows", () => {
  test("a multi-tag capture is ONE row carrying both tags", () => {
    const s = store();
    const { entry: e, inserted } = s.append({
      persona: P,
      date: DAY,
      content: "resume-with-context shipped",
      tags: ["decision", "lesson"],
    });
    expect(inserted).toBe(true);
    expect(e.tags).toEqual(["decision", "lesson"]);
    expect(s.countDay(P, DAY)).toBe(1);
  });

  test("re-filing the same text merges instead of appending", () => {
    const s = store();
    s.append({ persona: P, date: DAY, content: "same thing", tags: ["lesson"] });
    const second = s.append({
      persona: P,
      date: DAY,
      content: "  Same thing.  ",
      tags: ["norm"],
    });
    expect(second.inserted).toBe(false);
    expect(s.countDay(P, DAY)).toBe(1);
    // Tags UNION — a later capture adds a drawer, it does not replace one.
    expect(second.entry.tags).toEqual(["lesson", "norm"]);
  });

  test("a merge keeps the EARLIEST sighting, never the latest", () => {
    const s = store();
    const late = new Date(`${DAY}T17:00:00.000Z`);
    const early = new Date(`${DAY}T08:00:00.000Z`);
    s.append({ persona: P, date: DAY, content: "x", createdAt: late });
    const merged = s.append({ persona: P, date: DAY, content: "x", createdAt: early });
    // Otherwise a re-capture reorders the day: a morning note would sort to
    // the evening and the journal would stop being a record of when things
    // were written down.
    expect(merged.entry.createdAt.toISOString()).toBe(early.toISOString());
  });

  test("the same text on a DIFFERENT day is a different row", () => {
    const s = store();
    s.append({ persona: P, date: DAY, content: "standup" });
    s.append({ persona: P, date: "2026-08-28", content: "standup" });
    expect(s.countDay(P, DAY)).toBe(1);
    expect(s.countDay(P, "2026-08-28")).toBe(1);
    expect(s.dates(P)).toEqual(["2026-08-28", DAY]);
  });

  test("ids are content-derived, so any writer computes the same one", () => {
    expect(journalEntryId(P, DAY, "a thing")).toBe(
      journalEntryId(P, DAY, " A Thing. "),
    );
    expect(journalEntryId(P, DAY, "a thing")).not.toBe(
      journalEntryId("lena", DAY, "a thing"),
    );
  });

  test("tags are canonicalised: lowercased, de-duplicated, ordered", () => {
    expect(normalizeTags([" Lesson ", "decision", "LESSON", ""])).toEqual([
      "decision",
      "lesson",
    ]);
  });

  test("taggedForDay returns only tagged rows", () => {
    const s = store();
    s.append({ persona: P, date: DAY, content: "untagged note" });
    s.append({ persona: P, date: DAY, content: "a lesson", tags: ["lesson"] });
    const tagged = s.taggedForDay(P, DAY);
    expect(tagged.map((e) => e.content)).toEqual(["a lesson"]);
  });
});

describe("markdown ingest", () => {
  test("parses bullet, stacked tags and stamp; strips all three", () => {
    const line = parseJournalLine("- [decision] shipped the thing · 07:18Z");
    expect(line).toEqual({
      content: "shipped the thing",
      tags: ["decision"],
      minutes: 7 * 60 + 18,
      source: "self",
    });
  });

  test("the date header and blank lines are not entries", () => {
    expect(parseJournalLine("# 2026-08-27")).toBeUndefined();
    expect(parseJournalLine("   ")).toBeUndefined();
    expect(parseJournalLine("---")).toBeUndefined();
  });

  test("a scheduler line is recognised as source 'task'", () => {
    const line = parseJournalLine(
      "[commitment] task 577: inbox poll — fires 2026-08-27T12:02:01Z (one-off)",
    );
    expect(line?.source).toBe("task");
    expect(line?.tags).toEqual(["commitment"]);
  });

  test("THE BUG: the two copies of a two-tag capture collapse to one row", () => {
    const s = store();
    const md = [
      `# ${DAY}`,
      "- [decision] opened #459 (resume-with-context) · 07:18Z",
      "- [lesson] opened #459 (resume-with-context) · 07:18Z",
    ].join("\n");
    const r = ingestJournalMarkdown(s, P, DAY, md);
    expect(r.parsed).toBe(2);
    expect(r.inserted).toBe(1);
    expect(r.merged).toBe(1);
    const rows = s.listDay(P, DAY);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.tags).toEqual(["decision", "lesson"]);
  });

  test("ingest is idempotent — a second pass writes nothing", () => {
    const s = store();
    const md = `# ${DAY}\n- [lesson] a thing · 09:00Z\n- plain note\n`;
    expect(ingestJournalMarkdown(s, P, DAY, md).inserted).toBe(2);
    const again = ingestJournalMarkdown(s, P, DAY, md);
    expect(again.inserted).toBe(0);
    expect(again.merged).toBe(2);
    expect(s.countDay(P, DAY)).toBe(2);
  });

  test("a stamped line is placed at its own time on its own day", () => {
    const s = store();
    ingestJournalMarkdown(s, P, DAY, "- [lesson] afternoon · 14:30Z\n");
    expect(s.listDay(P, DAY)[0]!.createdAt.toISOString()).toBe(
      `${DAY}T14:30:00.000Z`,
    );
  });

  test("ingestJournalDir walks every daily file and ignores other markdown", async () => {
    const dir = await personaTree();
    await writeFile(join(dir, "memory", `${DAY}.md`), "- [lesson] one\n", "utf8");
    await writeFile(join(dir, "memory", "2026-08-26.md"), "- two\n", "utf8");
    await writeFile(join(dir, "memory", "norms.md"), "- not a day\n", "utf8");
    const s = store();
    const results = await ingestJournalDir(s, dir, P);
    expect(results.map((r) => r.date)).toEqual(["2026-08-26", DAY]);
    expect(s.dates(P)).toEqual([DAY, "2026-08-26"]);
  });
});

describe("the markdown mirror", () => {
  test("mirrorDay ABSORBS a hand-appended line instead of clobbering it", async () => {
    const dir = await personaTree();
    const s = store();
    s.append({ persona: P, date: DAY, content: "from the table", tags: ["lesson"] });
    const path = join(dir, "memory", `${DAY}.md`);
    await writeFile(path, `# ${DAY}\n- written by hand\n`, "utf8");

    await mirrorDay(s, dir, P, DAY);

    const text = await readFile(path, "utf8");
    // Sync-then-write, never write-over: the hand edit is now a row, so it
    // survives the render that would otherwise have overwritten it.
    expect(text).toContain("written by hand");
    expect(text).toContain("from the table");
    expect(s.countDay(P, DAY)).toBe(2);
  });

  test("a mirror pass is stable — rendering twice changes nothing", async () => {
    const dir = await personaTree();
    const s = store();
    s.append({ persona: P, date: DAY, content: "one", tags: ["lesson"] });
    await mirrorDay(s, dir, P, DAY);
    const first = await readFile(join(dir, "memory", `${DAY}.md`), "utf8");
    await mirrorDay(s, dir, P, DAY);
    const second = await readFile(join(dir, "memory", `${DAY}.md`), "utf8");
    // If the render did not round-trip through the parser, every heartbeat
    // would rewrite the file and re-queue the nightly sweep forever.
    expect(second).toBe(first);
    expect(s.countDay(P, DAY)).toBe(1);
  });

  test("writeJournalEntry writes the row AND the day's markdown", async () => {
    const dir = await personaTree();
    const dbPath = join(dir, "memory.db");
    const ok = await writeJournalEntry(dbPath, dir, {
      persona: P,
      date: DAY,
      content: "captured once",
      tags: ["decision", "lesson"],
      createdAt: new Date(`${DAY}T07:18:00.000Z`),
    });
    expect(ok).toBe(true);
    const text = await readFile(join(dir, "memory", `${DAY}.md`), "utf8");
    // ONE line for a two-tag capture. This is the 41%.
    expect(text).toBe(`# ${DAY}\n- [decision,lesson] captured once · 07:18Z\n`);
  });

  test("renderDay round-trips back through the parser", () => {
    const s = store();
    s.append({
      persona: P,
      date: DAY,
      content: "round trip",
      tags: ["norm", "decision"],
      createdAt: new Date(`${DAY}T11:05:00.000Z`),
    });
    const md = renderDay(DAY, s.listDay(P, DAY));
    const back = store();
    ingestJournalMarkdown(back, P, DAY, md);
    const [a] = s.listDay(P, DAY);
    const [b] = back.listDay(P, DAY);
    expect(b!.content).toBe(a!.content);
    expect(b!.tags).toEqual(a!.tags);
    expect(b!.createdAt.toISOString()).toBe(a!.createdAt.toISOString());
  });
});

describe("recall selection", () => {
  const many = (n: number): JournalEntry[] =>
    Array.from({ length: n }, (_, i) =>
      entry({
        id: `e${i}`,
        content: `entry number ${i} ${"x".repeat(80)}`,
        createdAt: new Date(Date.parse(`${DAY}T08:00:00.000Z`) + i * 60_000),
      }),
    );

  test("spends the budget newest-first and reports what it dropped", () => {
    const all = many(50);
    const sel = selectForRecall(all, 1000);
    expect(sel.bytes).toBeLessThanOrEqual(1000);
    expect(sel.droppedForBudget).toBe(all.length - sel.entries.length);
    expect(sel.droppedForBudget).toBeGreaterThan(0);
    // Kept rows come back in READING order even though they were chosen in
    // reverse — a journal read newest-first is not a journal.
    expect(sel.entries.map((e) => e.content)).toEqual(
      [...sel.entries].sort(
        (a, b) => a.createdAt.getTime() - b.createdAt.getTime(),
      ).map((e) => e.content),
    );
    expect(sel.entries.at(-1)!.content).toBe(all.at(-1)!.content);
  });

  test("never returns nothing: the newest entry survives any budget", () => {
    const sel = selectForRecall(many(5), 1);
    expect(sel.entries).toHaveLength(1);
    expect(sel.entries[0]!.content).toContain("entry number 4");
  });

  test("scheduler rows are withheld and counted, not injected", () => {
    const all = [
      entry({ id: "a", content: "a real note" }),
      entry({ id: "b", content: "task 577: poll — fires later", source: "task" }),
    ];
    const sel = selectForRecall(all, 10_000);
    expect(sel.entries.map((e) => e.id)).toEqual(["a"]);
    expect(sel.withheldMechanical).toBe(1);
    // Withheld from the PROMPT, never from the table.
    expect(selectForRecall(all, 10_000, { includeMechanical: true }).entries)
      .toHaveLength(2);
  });

  test("renderEntry is stable and carries tags + stamp", () => {
    expect(
      renderEntry(
        entry({
          content: "a thing",
          tags: ["decision"],
          createdAt: new Date(`${DAY}T07:18:00.000Z`),
        }),
      ),
    ).toBe("- [decision] a thing · 07:18Z");
  });
});

describe("nothing is lost", () => {
  test("openJournalStore creates the database directory if absent", async () => {
    const dir = await personaTree();
    const dbPath = join(dir, "deeper", "memory.db");
    const { store: s, close } = await openJournalStore(dbPath);
    s.append({ persona: P, date: DAY, content: "hello" });
    close();
    expect((await stat(dbPath)).isFile()).toBe(true);
  });

  test("closed days keep their original bytes — only today is re-rendered", async () => {
    const dir = await personaTree();
    const closed = join(dir, "memory", "2026-08-26.md");
    const original = "# 2026-08-26\nfree-form prose nobody should rewrite\n";
    await writeFile(closed, original, "utf8");
    const s = store();
    await ingestJournalDir(s, dir, P);
    await mirrorDay(s, dir, P, DAY);
    // The nightly sweep fingerprints closed days by mtime+size; re-rendering
    // them would re-queue weeks of finished distillation for nothing.
    expect(await readFile(closed, "utf8")).toBe(original);
    // Ingested all the same, so the content is queryable as rows.
    expect(s.countDay(P, "2026-08-26")).toBe(1);
  });
});

describe("regressions", () => {
  test("the comma tag SET parses back as tags, not as content", () => {
    // Caught by the round-trip test above: `renderEntry` writes
    // `[decision,lesson]`, and a parser that only knew `[decision]` read that
    // whole marker as the start of the CONTENT — a different content_norm, so
    // a brand-new row, minted again on every heartbeat.
    const line = parseJournalLine("- [decision,lesson] a thing · 07:18Z");
    expect(line?.tags).toEqual(["decision", "lesson"]);
    expect(line?.content).toBe("a thing");
  });

  test("stacked markers on one line are both read", () => {
    const line = parseJournalLine("- [decision] [lesson] a thing");
    expect(line?.tags).toEqual(["decision", "lesson"]);
    expect(line?.content).toBe("a thing");
  });
});
