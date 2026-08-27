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

  test("a day of nothing but oversized rows returns none, and says so", () => {
    const sel = selectForRecall(
      [
        entry({ id: "a", content: "x".repeat(40_000), tags: ["decision"] }),
        entry({ id: "b", content: "y".repeat(40_000) }),
      ],
      JOURNAL_RECALL_BUDGET_BYTES,
    );
    expect(sel.entries).toHaveLength(0);
    expect(sel.bytes).toBe(0);
    // Reported, not silent: the caller turns this into a visible note. An
    // omission the model cannot see reads as "nothing happened today".
    expect(sel.droppedOversize).toBe(2);
    expect(sel.droppedForBudget).toBe(2);
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
    // Room for two entries out of three.
    const sel = selectForRecall(all, 480);
    expect(sel.entries.map((e) => e.id)).toEqual(["decision-first", "lesson-last"]);
    // The OLDEST entry survived and a newer one did not, which is exactly what
    // the byte-slice on the file could never do: it cut from the front, so the
    // morning's tagged captures were always the first casualty.
    expect(sel.droppedForBudget).toBe(1);
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
