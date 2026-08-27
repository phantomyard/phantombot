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

import { describe, expect, spyOn, test } from "bun:test";
import { Database } from "bun:sqlite";
import { existsSync } from "node:fs";
import {
  mkdtemp,
  mkdir,
  readFile,
  writeFile,
  stat,
  utimes,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  JournalStore,
  journalEntryId,
  normalizeTags,
  renderDay,
  renderEntry,
  renderRecall,
  renderStub,
  selectForRecall,
  JOURNAL_STUB_MAX_BYTES,
  type JournalEntry,
} from "../src/memory/journal.ts";
import {
  absorbDay,
  ingestJournalMarkdown,
  openJournalStore,
  parseJournalLine,
  writeJournalEntry,
} from "../src/memory/journalIngest.ts";
import { dayFingerprint } from "../src/memory/journal.ts";
import {
  dropOpenDayIndex,
  indexOpenDay,
  JOURNAL_BACKLOG_ALARM_DAYS,
  renderClosedDays,
} from "../src/memory/journalRender.ts";
import { MemoryIndex } from "../src/lib/memoryIndex.ts";
import { JOURNAL_RECALL_BUDGET_BYTES } from "../src/lib/dailyRecall.ts";

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

  test("absorbDay adopts a hand-written file and is a no-op without one", async () => {
    const dir = await personaTree();
    await writeFile(join(dir, "memory", `${DAY}.md`), "- [lesson] one\n", "utf8");
    const s = store();
    expect((await absorbDay(s, dir, P, DAY))?.inserted).toBe(1);
    // Second pass: same content-derived id, so nothing new.
    expect((await absorbDay(s, dir, P, DAY))?.inserted).toBe(0);
    // A day born as rows has no file at all — that is the normal case now.
    expect(await absorbDay(s, dir, P, "2026-08-26")).toBeUndefined();
  });
});

describe("render, verify, prune", () => {
  test("today is NEVER rendered — it is still being written to", async () => {
    const dir = await personaTree();
    const s = store();
    s.append({ persona: P, date: DAY, content: "mid-day", tags: ["lesson"] });
    const r = await renderClosedDays(s, dir, P, DAY);
    expect(r.rendered).toEqual([]);
    expect(existsSync(join(dir, "memory", `${DAY}.md`))).toBe(false);
    // And the rows are untouched, so recall still has the day.
    expect(s.countDay(P, DAY)).toBe(1);
  });

  test("a closed day is rendered, verified, and its rows KEPT for one run", async () => {
    const dir = await personaTree();
    const s = store();
    s.append({ persona: P, date: "2026-08-26", content: "yesterday", tags: ["lesson"] });
    const r = await renderClosedDays(s, dir, P, DAY);
    expect(r.rendered).toEqual(["2026-08-26"]);
    expect(r.pruned).toEqual([]);
    // Retention overlap: the content is in BOTH places until an independent
    // later run re-confirms the file. A nightly that renders and then dies
    // costs disk, not memory.
    expect(s.countDay(P, "2026-08-26")).toBe(1);
    expect(await readFile(join(dir, "memory", "2026-08-26.md"), "utf8")).toContain(
      "yesterday",
    );
  });

  test("the NEXT run prunes the rows of the day the last one verified", async () => {
    const dir = await personaTree();
    const s = store();
    s.append({ persona: P, date: "2026-08-25", content: "older", tags: ["lesson"] });
    await renderClosedDays(s, dir, P, "2026-08-26", new Date("2026-08-26T03:00:00Z"));
    const second = await renderClosedDays(s, dir, P, DAY, new Date(`${DAY}T03:00:00Z`));
    expect(second.pruned).toEqual(["2026-08-25"]);
    expect(s.countDay(P, "2026-08-25")).toBe(0);
    // The day still exists — as the artefact the prune was conditional on.
    expect(await readFile(join(dir, "memory", "2026-08-25.md"), "utf8")).toContain(
      "older",
    );
  });

  test("a day whose artefact stopped matching is NOT pruned; it is re-rendered", async () => {
    const dir = await personaTree();
    const s = store();
    const date = "2026-08-25";
    s.append({ persona: P, date, content: "load-bearing", tags: ["decision"] });
    await renderClosedDays(s, dir, P, "2026-08-26", new Date("2026-08-26T03:00:00Z"));
    // Something else ate the file between the two runs.
    await writeFile(join(dir, "memory", `${date}.md`), "truncated\n", "utf8");

    const second = await renderClosedDays(s, dir, P, DAY, new Date(`${DAY}T03:00:00Z`));
    expect(second.pruned).toEqual([]);
    // Rows survived, so the content is recoverable...
    expect(s.countDay(P, date)).toBeGreaterThan(0);
    // ...and the next run rebuilds the file from them.
    const third = await renderClosedDays(s, dir, P, DAY, new Date(`${DAY}T03:00:00Z`));
    expect(third.rendered).toContain(date);
    expect(await readFile(join(dir, "memory", `${date}.md`), "utf8")).toContain(
      "load-bearing",
    );
  });

  test("a render that does not verify keeps the rows and reports the day", async () => {
    const dir = await personaTree();
    const s = store();
    s.append({ persona: P, date: "2026-08-26", content: "precious", tags: ["lesson"] });
    // Simulate a disk that accepts the write and returns something else.
    const spy = spyOn(await import("node:fs/promises"), "readFile");
    spy.mockImplementation((async () =>
      "corrupted on the way back\n") as unknown as typeof import("node:fs/promises").readFile);
    try {
      const r = await renderClosedDays(s, dir, P, DAY);
      expect(r.rendered).toEqual([]);
      expect(r.failed).toEqual(["2026-08-26"]);
    } finally {
      spy.mockRestore();
    }
    expect(s.countDay(P, "2026-08-26")).toBe(1);
  });

  test("three missed nights render as three separate days, not one blob", async () => {
    const dir = await personaTree();
    const s = store();
    for (const d of ["2026-08-24", "2026-08-25", "2026-08-26"]) {
      s.append({
        persona: P,
        date: d,
        content: `work on ${d}`,
        tags: ["lesson"],
        createdAt: new Date(`${d}T09:00:00.000Z`),
      });
    }
    const r = await renderClosedDays(s, dir, P, DAY);
    expect(r.rendered).toEqual(["2026-08-24", "2026-08-25", "2026-08-26"]);
    for (const d of r.rendered) {
      expect(await readFile(join(dir, "memory", `${d}.md`), "utf8")).toBe(
        `# ${d}\n- [lesson] work on ${d} · 09:00Z\n`,
      );
    }
    expect(r.backlogDays).toBe(0);
  });

  test("a stalled nightly is reported as a backlog, not left silent", async () => {
    const dir = await personaTree();
    const s = store();
    for (const d of ["2026-08-20", "2026-08-21", "2026-08-22", "2026-08-23"]) {
      s.append({ persona: P, date: d, content: `work on ${d}` });
    }
    // Nothing can be written: every render fails, so the backlog stands.
    const spy = spyOn(await import("node:fs/promises"), "writeFile");
    spy.mockImplementation((async () => {
      throw new Error("EROFS: read-only file system");
    }) as unknown as typeof import("node:fs/promises").writeFile);
    let r;
    try {
      r = await renderClosedDays(s, dir, P, DAY);
    } finally {
      spy.mockRestore();
    }
    expect(r!.failed).toHaveLength(4);
    expect(r!.backlogDays).toBe(4);
    expect(r!.backlogDays).toBeGreaterThan(JOURNAL_BACKLOG_ALARM_DAYS);
  });

  test("a render absorbs a hand-appended line instead of clobbering it", async () => {
    const dir = await personaTree();
    const s = store();
    const date = "2026-08-26";
    s.append({ persona: P, date, content: "from the table", tags: ["lesson"] });
    await writeFile(
      join(dir, "memory", `${date}.md`),
      `# ${date}\n- written by hand\n`,
      "utf8",
    );

    await renderClosedDays(s, dir, P, DAY);

    const text = await readFile(join(dir, "memory", `${date}.md`), "utf8");
    // Sync-then-write, never write-over.
    expect(text).toContain("written by hand");
    expect(text).toContain("from the table");
  });

  test("writeJournalEntry files the row and writes NO markdown", async () => {
    const dir = await personaTree();
    const dbPath = join(dir, "memory.db");
    const ok = await writeJournalEntry(
      dbPath,
      dir,
      {
        persona: P,
        date: DAY,
        content: "captured once",
        tags: ["decision", "lesson"],
        createdAt: new Date(`${DAY}T07:18:00.000Z`),
      },
      { skipIndex: true },
    );
    expect(ok).toBe(true);
    // The open day is rows only; the artefact is the nightly's job.
    expect(existsSync(join(dir, "memory", `${DAY}.md`))).toBe(false);
    const { store: s, close } = await openJournalStore(dbPath);
    try {
      // ONE row for a two-tag capture. This is the 41%.
      expect(s.listDay(P, DAY).map(renderEntry)).toEqual([
        "- [decision,lesson] captured once · 07:18Z",
      ]);
    } finally {
      close();
    }
  });

  test("a fingerprint is taken of what is ON DISK, not of what we meant", () => {
    const text = renderDay(DAY, []);
    expect(dayFingerprint(text)).toBe(dayFingerprint(text));
    expect(dayFingerprint(text)).not.toBe(dayFingerprint(`${text}tampered\n`));
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

  test("the budget is a HARD bound: one oversized row is skipped, not kept", () => {
    // Production budget, production-shaped content: `memory capture` caps
    // nothing, so one pasted log or stack trace is all it takes. The old rule
    // ("always keep the highest-priority row") let this single entry through
    // unmeasured and made the budget advisory — which is the unbounded prompt
    // this table exists to bound.
    const huge = entry({
      id: "huge",
      content: "x".repeat(200_000),
      tags: ["decision"],
      createdAt: new Date(`${DAY}T09:00:00.000Z`),
    });
    const small = entry({
      id: "small",
      content: "a short decision that must survive the fat one",
      tags: ["decision"],
      createdAt: new Date(`${DAY}T08:00:00.000Z`),
    });
    const sel = selectForRecall([small, huge], JOURNAL_RECALL_BUDGET_BYTES);
    expect(sel.bytes).toBeLessThanOrEqual(JOURNAL_RECALL_BUDGET_BYTES);
    // The oversized row is highest priority AND newest, so it is considered
    // first — packing must continue past it rather than stopping.
    expect(sel.entries.map((e) => e.id)).toEqual(["small"]);
    expect(sel.droppedOversize).toBe(1);
    expect(sel.droppedForBudget).toBe(1);
  });

  test("a day of nothing but oversized rows comes back as stubs", () => {
    const sel = selectForRecall(
      [
        entry({ id: "a", content: "x".repeat(40_000), tags: ["decision"] }),
        entry({ id: "b", content: "y".repeat(40_000) }),
      ],
      JOURNAL_RECALL_BUDGET_BYTES,
    );
    // Nothing can be shown in full — but "nothing in full" is not "nothing".
    expect(sel.entries).toHaveLength(0);
    expect(sel.stubbed.map((e) => e.id)).toEqual(["a", "b"]);
    expect(sel.droppedOversize).toBe(2);
    expect(sel.droppedForBudget).toBe(2);
    // The whole point of #467: no entry left WITHOUT a trace in the block.
    expect(sel.droppedEntirely).toBe(0);
    expect(sel.bytes).toBeGreaterThan(0);
    expect(sel.bytes).toBeLessThanOrEqual(JOURNAL_RECALL_BUDGET_BYTES);
  });

  test("droppedOversize means bigger than the WHOLE budget, not the reserve", () => {
    // A row at ~90% of the budget does not fit alongside anything, but it is
    // not oversized: it comes back on a quieter day. Counting it as oversized
    // would make the recall note claim, falsely, that it never can.
    const big = entry({
      id: "big",
      content: "z".repeat(15_000),
      tags: ["decision"],
      createdAt: new Date(`${DAY}T08:00:00.000Z`),
    });
    const rest = many(60);
    const sel = selectForRecall([big, ...rest], JOURNAL_RECALL_BUDGET_BYTES);
    expect(sel.bytes).toBeLessThanOrEqual(JOURNAL_RECALL_BUDGET_BYTES);
    expect(sel.droppedForBudget).toBeGreaterThan(0);
    expect(sel.droppedOversize).toBe(0);
  });

  test("a tiny budget drops everything rather than busting itself", () => {
    const sel = selectForRecall(many(5), 1);
    expect(sel.entries).toHaveLength(0);
    expect(sel.bytes).toBe(0);
    expect(sel.droppedOversize).toBe(5);
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

  test("history that predates the table is left ALONE, not backfilled", async () => {
    const dir = await personaTree();
    const closed = join(dir, "memory", "2020-01-01.md");
    const original = "# 2020-01-01\nfree-form prose nobody should rewrite\n";
    await writeFile(closed, original, "utf8");
    const s = store();
    await renderClosedDays(s, dir, P, DAY);
    // Rows are the write path from here on; every day BEFORE the upgrade
    // stays exactly the file it already is. There is no 205-file migration to
    // run, and no day is rewritten with a fingerprint the nightly sweep would
    // then re-queue.
    expect(await readFile(closed, "utf8")).toBe(original);
    expect(s.countDay(P, "2020-01-01")).toBe(0);
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

describe("recall drops chatter before decisions", () => {
  test("an untagged entry is dropped before a tagged one, whatever the order", () => {
    const pad = "z".repeat(200);
    const all: JournalEntry[] = [
      entry({
        id: "decision-first",
        content: `chose X over Y ${pad}`,
        tags: ["decision"],
        createdAt: new Date(`${DAY}T08:00:00.000Z`),
      }),
      entry({
        id: "chatter",
        content: `ran the thing and looked at the output ${pad}`,
        createdAt: new Date(`${DAY}T09:00:00.000Z`),
      }),
      entry({
        id: "lesson-last",
        content: `learned Z ${pad}`,
        tags: ["lesson"],
        createdAt: new Date(`${DAY}T10:00:00.000Z`),
      }),
    ];
    // Room for two entries in full plus the stub reserve.
    const sel = selectForRecall(all, 640);
    expect(sel.entries.map((e) => e.id)).toEqual(["decision-first", "lesson-last"]);
    // The OLDEST entry survived and a newer one did not, which is exactly what
    // the byte-slice on the file could never do: it cut from the front, so the
    // morning's tagged captures were always the first casualty.
    expect(sel.droppedForBudget).toBe(1);
    // The chatter is not shown in full — but it is still ACCOUNTED for, as a
    // stub, so the turn can see that something happened at 09:00.
    expect(sel.stubbed.map((e) => e.id)).toEqual(["chatter"]);
    expect(sel.droppedEntirely).toBe(0);
  });

  test("a big entry does not starve the smaller ones behind it", () => {
    const all: JournalEntry[] = [
      entry({ id: "small-a", content: "a", createdAt: new Date(`${DAY}T08:00:00.000Z`) }),
      entry({
        id: "huge",
        content: "x".repeat(5_000),
        createdAt: new Date(`${DAY}T09:00:00.000Z`),
      }),
      entry({ id: "small-b", content: "b", createdAt: new Date(`${DAY}T10:00:00.000Z`) }),
    ];
    const sel = selectForRecall(all, 200);
    // The oversized entry is skipped, not treated as the end of the budget.
    expect(sel.entries.map((e) => e.id)).toEqual(["small-a", "small-b"]);
  });
});

describe("degradation instead of dropping (#467)", () => {
  const long = (n: number) =>
    Array.from({ length: n }, (_, i) =>
      entry({
        id: `e${i}`,
        content: `entry number ${i} — ${"detail ".repeat(40)}`,
        tags: ["decision"],
        createdAt: new Date(Date.parse(`${DAY}T08:00:00.000Z`) + i * 60_000),
      }),
    );

  test("an over-budget day comes back as full entries PLUS stubs", () => {
    const sel = selectForRecall(long(60), 4_000);
    expect(sel.entries.length).toBeGreaterThan(0);
    expect(sel.stubbed.length).toBeGreaterThan(0);
    // The bound is over EVERYTHING emitted, stubs included — a budget that
    // only counts the full entries is not a budget.
    expect(sel.bytes).toBeLessThanOrEqual(4_000);
    expect(Buffer.byteLength(renderRecall(sel), "utf8")).toBeLessThanOrEqual(
      4_000,
    );
    // Accounting adds up: every eligible row is kept, stubbed or counted.
    expect(sel.entries.length + sel.stubbed.length + sel.droppedEntirely).toBe(
      60,
    );
  });

  test("a stub carries tags, clock and searchable head text", () => {
    const stub = renderStub(
      entry({
        content:
          "phantomops prod stuck at starting: status_generator holds a DB " +
          "session across a long tool call and Postgres kills it",
        tags: ["decision", "lesson"],
        createdAt: new Date(`${DAY}T15:31:00.000Z`),
      }),
    );
    expect(stub).toContain("[decision,lesson]");
    expect(stub).toContain("15:31Z");
    // The head text is the load-bearing part: a bare count cannot be searched
    // for, and a turn cannot look up something it does not know happened.
    expect(stub).toContain("status_generator");
    expect(stub).toContain("memory search");
    expect(Buffer.byteLength(stub, "utf8")).toBeLessThanOrEqual(
      JOURNAL_STUB_MAX_BYTES,
    );
  });

  test("a pathological tag list cannot bust the stub cap", () => {
    const stub = renderStub(
      entry({
        content: "a decision worth finding again",
        tags: Array.from({ length: 20 }, (_, i) => `tag-number-${i}`),
        createdAt: new Date(`${DAY}T09:12:00.000Z`),
      }),
    );
    expect(Buffer.byteLength(stub, "utf8")).toBeLessThanOrEqual(
      JOURNAL_STUB_MAX_BYTES,
    );
    // The overflow is reported, not silently forgotten...
    expect(stub).toMatch(/\+\d+\]/);
    // ...and the head text still survives, which is the point of a stub.
    expect(stub).toContain("decision");
    expect(stub).toContain("09:12Z");
  });

  test("a single tag longer than the whole tag allowance still fits", () => {
    const stub = renderStub(
      entry({ content: "short", tags: ["x".repeat(500)] }),
    );
    expect(Buffer.byteLength(stub, "utf8")).toBeLessThanOrEqual(
      JOURNAL_STUB_MAX_BYTES,
    );
    expect(stub).toContain("[+1]");
  });

  test("a multi-line capture stubs to ONE line", () => {
    const stub = renderStub(
      entry({ content: "first line\nsecond line\n\nthird line", tags: ["lesson"] }),
    );
    expect(stub.includes("\n")).toBe(false);
  });

  test("stubs are interleaved chronologically, not appended in a footer", () => {
    const sel = selectForRecall(long(40), 3_000);
    const lines = renderRecall(sel).split("\n");
    const stamps = lines.map((l) => l.slice(-6));
    expect([...stamps].sort()).toEqual(stamps);
    // A stub in its right place says "something happened here you cannot
    // see"; the same stub in a footer says nothing about when.
    expect(lines.some((l) => l.includes("elided"))).toBe(true);
  });

  test("a day that fits pays NO stub reserve", () => {
    const all = long(3);
    const sel = selectForRecall(all, JOURNAL_RECALL_BUDGET_BYTES);
    expect(sel.entries).toHaveLength(3);
    expect(sel.stubbed).toHaveLength(0);
    expect(sel.droppedForBudget).toBe(0);
  });

  test("a budget too small even for stubs drops the rest and counts it", () => {
    const sel = selectForRecall(long(20), 60);
    expect(sel.entries).toHaveLength(0);
    expect(sel.stubbed).toHaveLength(0);
    expect(sel.droppedEntirely).toBe(20);
    expect(sel.bytes).toBe(0);
  });

  test("the markdown that reaches DISK is not stubbed", () => {
    // Stubs are a prompt-time artefact. renderDay/renderEntry feed the file
    // the nightly writes and parseJournalLine reads back, so a lossy line
    // there would overwrite a day's rows with their own summary.
    const e = long(1)[0]!;
    expect(renderDay(DAY, [e])).toContain(e.content);
    expect(renderEntry(e)).not.toContain("elided");
  });
});

describe("recall weighting (#467)", () => {
  const sized = (over: Partial<JournalEntry>) =>
    entry({ content: `${"pad ".repeat(120)}`, ...over });

  test("a morning commitment outranks an afternoon person note", () => {
    const all = [
      sized({
        id: "commitment",
        tags: ["commitment"],
        createdAt: new Date(`${DAY}T08:00:00.000Z`),
      }),
      sized({
        id: "person",
        tags: ["person"],
        createdAt: new Date(`${DAY}T17:00:00.000Z`),
      }),
    ];
    // Room for exactly one in full, plus the stub reserve.
    const sel = selectForRecall(all, 800);
    expect(sel.entries.map((e) => e.id)).toEqual(["commitment"]);
    // Time makes a commitment MORE urgent, not less relevant — same rule
    // BELIEF_KINDS applies in the drawers, so there is one decay model here.
    expect(sel.stubbed.map((e) => e.id)).toEqual(["person"]);
  });

  test("a morning decision outranks an afternoon person note", () => {
    const all = [
      sized({
        id: "decision",
        tags: ["decision"],
        createdAt: new Date(`${DAY}T08:00:00.000Z`),
      }),
      sized({
        id: "person",
        tags: ["person"],
        createdAt: new Date(`${DAY}T17:00:00.000Z`),
      }),
    ];
    const sel = selectForRecall(all, 800);
    // Pure recency — the pre-#467 rule — would have kept the newer one. On
    // the day this was measured every row was tagged, so recency alone was
    // deciding which DECISIONS survived.
    expect(sel.entries.map((e) => e.id)).toEqual(["decision"]);
  });

  test("recency still dominates between equals", () => {
    const all = [
      sized({
        id: "old",
        tags: ["decision"],
        createdAt: new Date(`${DAY}T08:00:00.000Z`),
      }),
      sized({
        id: "new",
        tags: ["decision"],
        createdAt: new Date(`${DAY}T17:00:00.000Z`),
      }),
    ];
    expect(selectForRecall(all, 800).entries.map((e) => e.id)).toEqual(["new"]);
  });

  test("weighting NEVER lifts narration above a tagged capture", () => {
    // The band is strict: no score in the tagged band can be overtaken by an
    // untagged row, however fresh. This is the guarantee the byte-slice on
    // the markdown file could not make.
    const all = [
      sized({
        id: "tagged-oldest",
        tags: ["person"],
        createdAt: new Date(`${DAY}T06:00:00.000Z`),
      }),
      sized({
        id: "narration-newest",
        createdAt: new Date(`${DAY}T23:59:00.000Z`),
      }),
    ];
    const sel = selectForRecall(all, 800);
    expect(sel.entries.map((e) => e.id)).toEqual(["tagged-oldest"]);
  });

  test("selection is a pure function of the rows, not of the wall clock", () => {
    // The decay clock is the newest entry in the SET. A wall clock would make
    // the same journal select differently depending on when the turn ran.
    const all = [
      sized({
        id: "a",
        tags: ["decision"],
        createdAt: new Date(`${DAY}T08:00:00.000Z`),
      }),
      sized({
        id: "b",
        tags: ["person"],
        createdAt: new Date(`${DAY}T09:00:00.000Z`),
      }),
    ];
    const first = selectForRecall(all, 800).entries.map((e) => e.id);
    const later = selectForRecall(all, 800).entries.map((e) => e.id);
    expect(later).toEqual(first);
  });
});

describe("index on write", () => {
  test("today's capture is searchable before any markdown exists", async () => {
    const dir = await personaTree();
    const dbPath = join(dir, "memory.db");
    const indexPath = join(dir, "index.sqlite");
    await writeJournalEntry(
      dbPath,
      dir,
      {
        persona: P,
        date: DAY,
        content: "the OVH cluster stalls when a DB session is held open",
        tags: ["lesson"],
        createdAt: new Date(`${DAY}T09:00:00.000Z`),
      },
      { indexPath },
    );
    // No file — and yet the persona's own reflex finds it. Without this the
    // journal would be invisible to `memory search` until the nightly ran,
    // i.e. an up-to-24-hour hole in the middle of the memory system.
    expect(existsSync(join(dir, "memory", `${DAY}.md`))).toBe(false);
    const ix = await MemoryIndex.open(indexPath);
    try {
      const hits = ix.search("cluster stalls", { scope: "memory" });
      expect(hits.map((h) => h.path)).toContain(`memory/${DAY}.md`);
    } finally {
      ix.close();
    }
  });

  test("a virtual day is not evicted by a refresh that finds no file", async () => {
    const dir = await personaTree();
    const indexPath = join(dir, "index.sqlite");
    const s = store();
    s.append({ persona: P, date: DAY, content: "still open", tags: ["lesson"] });
    await indexOpenDay(s, P, DAY, indexPath);
    const ix = await MemoryIndex.open(indexPath);
    try {
      // refreshStale removes rows whose file is gone. A virtual note has no
      // file by design, so "gone" is its normal state — evicting it would put
      // the hole straight back.
      await ix.refreshStale(dir);
      expect(ix.search("still open", { scope: "memory" }).length).toBe(1);
    } finally {
      ix.close();
    }
  });

  test("`memory index --rebuild` does not erase the open day", async () => {
    const dir = await personaTree();
    const indexPath = join(dir, "index.sqlite");
    const s = store();
    s.append({
      persona: P,
      date: DAY,
      content: "the rollback ACL bypass was in node_by_mac",
      tags: ["lesson"],
    });
    await indexOpenDay(s, P, DAY, indexPath);
    const ix = await MemoryIndex.open(indexPath);
    try {
      expect(ix.search("ACL bypass", { scope: "memory" }).length).toBe(1);
      // rebuild() is the documented repair for a damaged index, and it drops
      // notes/files and re-walks DISK. The open day has no file by design, so
      // a plain rebuild deletes it and finds nothing to put back — the repair
      // command would silently blind the persona to its own morning until the
      // next capture happened to republish it.
      await ix.rebuild(dir);
      expect(ix.search("ACL bypass", { scope: "memory" }).length).toBe(1);
    } finally {
      ix.close();
    }
  });

  test("a rebuild cannot lose a capture that lands while it is running", async () => {
    // rebuild() carries virtual notes across the DELETE, which is a
    // read-modify-write on rows the daemon is also writing: writeJournalEntry
    // republishes the open day against this same shared index DB. If the
    // snapshot, the delete and the restore are three autocommitted steps, a
    // capture that lands in between is written back over with the older
    // snapshot body and stops being searchable — and unlike a real note, a
    // virtual one cannot be recovered by re-walking the disk.
    const dir = await personaTree();
    const indexPath = join(dir, "index.sqlite");
    const s = store();
    s.append({ persona: P, date: DAY, content: "the morning entry" });
    await indexOpenDay(s, P, DAY, indexPath);

    const ix = await MemoryIndex.open(indexPath);
    // A second connection standing in for the concurrent publisher. Its
    // busy_timeout is deliberately tiny: the interleaved write below runs
    // INSIDE the rebuild's transaction on the other connection, so if the
    // section holds the write lock the publisher can only wait, and we want
    // it to give up in milliseconds rather than deadlock the test.
    const db2 = new Database(indexPath);
    db2.exec("PRAGMA journal_mode = WAL");
    db2.exec("PRAGMA busy_timeout = 50");
    const publisher = new MemoryIndex(db2);

    const newerBody = `# ${DAY}\n\n- the morning entry\n- the afternoon entry\n`;
    const publish = () =>
      publisher.upsertVirtualNote({
        path: `memory/${DAY}.md`,
        scope: "memory",
        title: `Journal ${DAY}`,
        body: newerBody,
      });

    let madeToWait = false;
    // Fire the publisher exactly between the snapshot and the restore, which
    // is the only window where the lost update is possible.
    const db = (ix as unknown as { db: Database }).db;
    const origExec = db.exec.bind(db);
    (db as { exec: (sql: string) => unknown }).exec = (sql: string) => {
      const out = origExec(sql);
      if (sql.includes("DELETE FROM notes")) {
        try {
          publish();
        } catch {
          madeToWait = true;
        }
      }
      return out;
    };

    try {
      await ix.rebuild(dir);
      (db as { exec: (sql: string) => unknown }).exec = origExec;

      // The section is mutually exclusive, so the publisher never got to
      // write mid-rebuild — it was refused and would, in the real daemon,
      // block on busy_timeout until the restore had committed.
      expect(madeToWait).toBe(true);
      if (madeToWait) publish();

      // ...and having waited, its newer body is the one that survives.
      expect(ix.search("afternoon entry", { scope: "memory" }).length).toBe(1);
    } finally {
      publisher.close();
      ix.close();
    }
  });

  test("a rebuild still lets the real file take over the virtual path", async () => {
    const dir = await personaTree();
    const indexPath = join(dir, "index.sqlite");
    const s = store();
    s.append({ persona: P, date: DAY, content: "row copy of the day" });
    await indexOpenDay(s, P, DAY, indexPath);
    // The day closed and the nightly rendered it while the index was broken.
    await writeFile(
      join(dir, "memory", `${DAY}.md`),
      `# ${DAY}\n- file copy of the day\n`,
      "utf8",
    );
    const ix = await MemoryIndex.open(indexPath);
    try {
      await ix.rebuild(dir);
      // Carrying the virtual note across the delete must not outrank the
      // artefact: forceAll re-indexes the real file over the same path, so
      // the day appears once, from disk.
      expect(ix.search("file copy", { scope: "memory" }).length).toBe(1);
      expect(ix.search("row copy", { scope: "memory" }).length).toBe(0);
    } finally {
      ix.close();
    }
  });

  test("a stale file at the open day's path cannot clobber the live rows", async () => {
    const dir = await personaTree();
    const indexPath = join(dir, "index.sqlite");
    const s = store();
    // The pre-#463 markdown absorbDay turned into rows and left on disk by
    // design. Its body stops at the moment of absorption; the rows carry on.
    const file = join(dir, "memory", `${DAY}.md`);
    await writeFile(file, `\n# ${DAY}\n\n- morning note only\n`, "utf8");
    const then = new Date(Date.now() - 60_000);
    await utimes(file, then, then);

    s.append({
      persona: P,
      date: DAY,
      content: "release run 33109716080 failed on HTTP 400",
      tags: ["lesson"],
    });
    await indexOpenDay(s, P, DAY, indexPath);

    const ix = await MemoryIndex.open(indexPath);
    try {
      // refreshStale runs on the heartbeat, on `memory index`, on rebuild and
      // on every retrieval turn. Before the fix it re-indexed the older file
      // over the virtual row and flipped virtual 1 -> 0, so the publisher won
      // for seconds after each capture and lost permanently — recall kept
      // printing "nothing is lost, memory search" for entries search could no
      // longer reach.
      await ix.refreshStale(dir);
      expect(ix.search("33109716080", { scope: "memory" }).length).toBe(1);
      await ix.refreshStale(dir);
      expect(ix.search("33109716080", { scope: "memory" }).length).toBe(1);
    } finally {
      ix.close();
    }
  });

  test("a file written after the virtual note still takes the path over", async () => {
    const dir = await personaTree();
    const indexPath = join(dir, "index.sqlite");
    const s = store();
    s.append({ persona: P, date: DAY, content: "row copy of the day" });
    await indexOpenDay(s, P, DAY, indexPath);
    // The nightly rendered the artefact but never got to relinquish the
    // virtual row — a crash, or an index it could not open. Ownership must
    // still hand over on the mtime alone, or the stand-in shadows the real
    // file for good and the rows behind it are pruned out from under it.
    const artefact = join(dir, "memory", `${DAY}.md`);
    await writeFile(artefact, `# ${DAY}\n- file copy of the day\n`, "utf8");
    // Stamped past the clock-skew grace: this is the unambiguous handover,
    // not the window where the two stamps carry no information.
    const later = new Date(Date.now() + 60_000);
    await utimes(artefact, later, later);

    const ix = await MemoryIndex.open(indexPath);
    try {
      await ix.refreshStale(dir);
      expect(ix.search("file copy", { scope: "memory" }).length).toBe(1);
      expect(ix.search("row copy", { scope: "memory" }).length).toBe(0);
    } finally {
      ix.close();
    }
  });

  test("a file written a coarse-clock tick 'before' the note still wins", async () => {
    const dir = await personaTree();
    const indexPath = join(dir, "index.sqlite");
    const s = store();
    s.append({ persona: P, date: DAY, content: "row copy of the day" });
    await indexOpenDay(s, P, DAY, indexPath);
    // mtime and indexed_at come from different clocks: the filesystem's is
    // coarse, so a file written strictly AFTER the note is published lands
    // with an mtime a tick earlier. Without the grace window the guard is
    // biased against the artefact in exactly the direction that never heals.
    const artefact = join(dir, "memory", `${DAY}.md`);
    await writeFile(artefact, `# ${DAY}\n- file copy of the day\n`, "utf8");
    const db = new Database(indexPath);
    const published = Date.parse(
      (
        db
          .query("SELECT indexed_at AS at FROM files WHERE path = ?")
          .get(`memory/${DAY}.md`) as { at: string }
      ).at,
    );
    db.close();
    const skewed = new Date(published - 2);
    await utimes(artefact, skewed, skewed);

    const ix = await MemoryIndex.open(indexPath);
    try {
      await ix.refreshStale(dir);
      expect(ix.search("file copy", { scope: "memory" }).length).toBe(1);
      expect(ix.search("row copy", { scope: "memory" }).length).toBe(0);
    } finally {
      ix.close();
    }
  });

  test("a rebuild keeps the virtual note's original publish time", async () => {
    const dir = await personaTree();
    const indexPath = join(dir, "index.sqlite");
    const s = store();
    s.append({ persona: P, date: DAY, content: "row copy of the day" });
    await indexOpenDay(s, P, DAY, indexPath);
    const rendered = join(dir, "memory", `${DAY}.md`);
    await writeFile(rendered, `# ${DAY}\n- file copy of the day\n`, "utf8");
    const after = new Date(Date.now() + 60_000);
    await utimes(rendered, after, after);

    const ix = await MemoryIndex.open(indexPath);
    try {
      // rebuild() restores the snapshot it took. Re-dating the restored row
      // to "now" would make every artefact written before the repair look
      // older than the stand-in it replaced, so the repair itself would pin
      // the stale copy in place.
      await ix.rebuild(dir);
      expect(ix.search("file copy", { scope: "memory" }).length).toBe(1);
      expect(ix.search("row copy", { scope: "memory" }).length).toBe(0);
    } finally {
      ix.close();
    }
  });

  test("the rendered file replaces the virtual entry at the same path", async () => {
    const dir = await personaTree();
    const indexPath = join(dir, "index.sqlite");
    const date = "2026-08-26";
    const s = store();
    s.append({ persona: P, date, content: "yesterday's work", tags: ["lesson"] });
    await indexOpenDay(s, P, date, indexPath);
    await renderClosedDays(s, dir, P, DAY, new Date(`${DAY}T03:00:00Z`));
    await dropOpenDayIndex(P, date, indexPath);

    const ix = await MemoryIndex.open(indexPath);
    try {
      await ix.refreshStale(dir);
      // One hit, not two: the virtual stand-in and the real file share the
      // path the artefact will always have, so the day is never double-counted
      // and there is no cutover to get wrong.
      const hits = ix.search("yesterday", { scope: "memory" });
      expect(hits.map((h) => h.path)).toEqual([`memory/${date}.md`]);
    } finally {
      ix.close();
    }
  });
});
