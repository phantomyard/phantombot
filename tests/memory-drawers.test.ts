/**
 * Drawer entries as rows (#410 stage two): identity, supersession, lifecycle,
 * decay, and the markdown ingest.
 *
 * The load-bearing assertions here are the NEGATIVE ones — commitments and
 * people must never decay, and nothing may ever be deleted. Those are the two
 * ways this design loses memory silently, so they get explicit tests rather
 * than relying on the type split alone.
 */

import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtemp, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  BELIEF_KINDS,
  DORMANT_FLOOR,
  DrawerStore,
  DRAWER_KINDS,
  drawerEntryId,
  decays,
  scoreEntry,
  statusAllowed,
} from "../src/memory/drawers.ts";
import {
  ingestDrawerFile,
  ingestDrawers,
  parseDrawer,
} from "../src/memory/drawerIngest.ts";

const PERSONA = "robbie";

function store(): DrawerStore {
  return new DrawerStore(new Database(":memory:"));
}

function daysAgo(n: number): Date {
  return new Date(Date.now() - n * 86_400_000);
}

describe("entry identity", () => {
  test("the same entry filed twice is one row, reaffirmed not duplicated", () => {
    const s = store();
    const first = s.file({
      persona: PERSONA,
      kind: "norms",
      content: "Alerts go via Telegram.",
      assertedAt: daysAgo(10),
    });
    const second = s.file({
      persona: PERSONA,
      kind: "norms",
      content: "  alerts go via   telegram  ",
    });
    expect(second.id).toBe(first.id);
    expect(s.list(PERSONA, "norms")).toHaveLength(1);
    // The original assertion date survives; the reaffirmation moves the clock.
    expect(second.assertedAt.getTime()).toBe(first.assertedAt.getTime());
    expect(second.lastReaffirmedAt.getTime()).toBeGreaterThan(
      first.lastReaffirmedAt.getTime(),
    );
  });

  test("ids are stable across processes and scoped per persona and kind", () => {
    const a = drawerEntryId(PERSONA, "norms", "Alerts go via Telegram.");
    expect(drawerEntryId(PERSONA, "norms", "alerts go via telegram")).toBe(a);
    expect(drawerEntryId(PERSONA, "lessons", "Alerts go via Telegram.")).not.toBe(a);
    expect(drawerEntryId("kai", "norms", "Alerts go via Telegram.")).not.toBe(a);
  });

  test("reaffirming an OLD copy never drags the decay clock backwards", () => {
    const s = store();
    const fresh = s.file({
      persona: PERSONA,
      kind: "lessons",
      content: "Verify the mechanism, not just the conclusion.",
    });
    const again = s.file({
      persona: PERSONA,
      kind: "lessons",
      content: "Verify the mechanism, not just the conclusion.",
      assertedAt: daysAgo(400),
    });
    expect(again.lastReaffirmedAt.getTime()).toBe(
      fresh.lastReaffirmedAt.getTime(),
    );
  });
  test("re-filing without a source or weight cannot escalate either", () => {
    const s = store();
    const first = s.file({
      persona: PERSONA,
      kind: "norms",
      content: "A quiet, unverified norm.",
      source: "unverified",
      weight: 0,
    });
    expect(first.source).toBe("unverified");
    expect(first.weight).toBe(0);

    // A bare re-file is evidence the entry is still live, NOT evidence it is
    // more trusted or more important than when it was filed.
    const again = s.file({
      persona: PERSONA,
      kind: "norms",
      content: "A quiet, unverified norm.",
    });
    expect(again.source).toBe("unverified");
    expect(again.weight).toBe(0);
    expect(again.lastReaffirmedAt.getTime()).toBeGreaterThanOrEqual(
      first.lastReaffirmedAt.getTime(),
    );

    // An EXPLICIT higher value still raises both.
    const raised = s.file({
      persona: PERSONA,
      kind: "norms",
      content: "A quiet, unverified norm.",
      source: "principal",
      weight: 2,
    });
    expect(raised.source).toBe("principal");
    expect(raised.weight).toBe(2);
  });

  test("a first insert that names no source lands at 'self', not 'principal'", () => {
    const s = store();
    const entry = s.file({
      persona: PERSONA,
      kind: "lessons",
      content: "Filed by a third-party tool that omitted source.",
    });
    expect(entry.source).toBe("self");
  });

  test("fileEntry reports insert vs reaffirm", () => {
    const s = store();
    const input = {
      persona: PERSONA,
      kind: "norms" as const,
      content: "Reported once, reaffirmed once.",
    };
    expect(s.fileEntry(input).inserted).toBe(true);
    expect(s.fileEntry(input).inserted).toBe(false);
    expect(s.list(PERSONA, "norms")).toHaveLength(1);
  });

});

describe("supersession", () => {
  test("a newer entry retires the one it names, and neither is deleted", () => {
    const s = store();
    const old = s.file({
      persona: PERSONA,
      kind: "norms",
      content: "Deploys need a nod from the principal.",
    });
    const next = s.file({
      persona: PERSONA,
      kind: "norms",
      content: "Deploys to develop are routine; only prod needs a nod.",
      supersedes: old.id,
    });

    expect(s.get(old.id)!.status).toBe("superseded");
    expect(next.supersedes).toBe(old.id);
    // Both rows are still there: retirement is a ranking decision, not a DELETE.
    expect(s.list(PERSONA, "norms")).toHaveLength(2);
    const ranked = s.ranked(PERSONA, "norms");
    expect(ranked.map((e) => e.id)).toEqual([next.id]);
  });

  test("superseding an unknown id does not fail the write that replaces it", () => {
    const s = store();
    const entry = s.file({
      persona: PERSONA,
      kind: "norms",
      content: "Never name the principal in public review prose.",
      supersedes: "0000000000000000",
    });
    expect(s.get(entry.id)!.status).toBe("active");
  });

  test("re-filing does NOT revive a superseded entry", () => {
    const s = store();
    const old = s.file({
      persona: PERSONA,
      kind: "norms",
      content: "Old rule.",
    });
    s.file({
      persona: PERSONA,
      kind: "norms",
      content: "New rule.",
      supersedes: old.id,
    });
    // A stale tool re-files its old norm on every startup. It must not come back.
    s.file({ persona: PERSONA, kind: "norms", content: "Old rule." });
    expect(s.get(old.id)!.status).toBe("superseded");
  });
  test("an entry may not supersede itself", () => {
    const s = store();
    const content = "A norm that would erase itself.";
    expect(() =>
      s.file({
        persona: PERSONA,
        kind: "norms",
        content,
        supersedes: drawerEntryId(PERSONA, "norms", content),
      }),
    ).toThrow(/supersede itself/);
    // And nothing was written: the caller bug does not leave a half-state.
    expect(s.list(PERSONA, "norms")).toHaveLength(0);
  });

  test("supersession never reaches across kinds", () => {
    const s = store();
    const decision = s.file({
      persona: PERSONA,
      kind: "decisions",
      content: "Route OVH traffic through the residential SOCKS proxy.",
    });
    s.file({
      persona: PERSONA,
      kind: "people",
      content: "A person fact that names a decision's id.",
      supersedes: decision.id,
    });
    // The decision is in another drawer; a wrong-kind id must miss, not retire
    // an unrelated row.
    expect(s.get(decision.id)!.status).toBe("active");
  });

});

describe("decay", () => {
  test("beliefs halve every half-life and drop out of ranking under the floor", () => {
    const s = store();
    const now = new Date();
    const stale = s.file({
      persona: PERSONA,
      kind: "lessons",
      content: "A lesson nobody has restated in four years.",
      assertedAt: daysAgo(120 * 4),
    });
    const live = s.file({
      persona: PERSONA,
      kind: "lessons",
      content: "A lesson from this week.",
    });

    expect(scoreEntry(s.get(stale.id)!, now)).toBeLessThan(DORMANT_FLOOR);
    expect(s.ranked(PERSONA, "lessons", { now }).map((e) => e.id)).toEqual([
      live.id,
    ]);
  });

  test("a reaffirmation resets the clock and revives a dormant belief", () => {
    const s = store();
    const now = new Date();
    const old = s.file({
      persona: PERSONA,
      kind: "decisions",
      content: "Use apt-managed node, not nvm.",
      assertedAt: daysAgo(180 * 5),
    });
    expect(s.sweepDormant(PERSONA, now).map((e) => e.id)).toEqual([old.id]);
    expect(s.get(old.id)!.status).toBe("dormant");

    const revived = s.file({
      persona: PERSONA,
      kind: "decisions",
      content: "Use apt-managed node, not nvm.",
    });
    expect(revived.status).toBe("active");
    expect(s.ranked(PERSONA, "decisions", { now })).toHaveLength(1);
  });

  test("a dormant entry is still queryable — it is retired, not removed", () => {
    const s = store();
    const old = s.file({
      persona: PERSONA,
      kind: "norms",
      content: "An ancient norm.",
      assertedAt: daysAgo(365 * 10),
    });
    s.sweepDormant(PERSONA);
    expect(s.ranked(PERSONA, "norms")).toHaveLength(0);
    expect(s.list(PERSONA, "norms").map((e) => e.id)).toEqual([old.id]);
    expect(s.get(old.id)).toBeDefined();
  });

  test("commitments and people NEVER decay, however old", () => {
    const s = store();
    const now = new Date();
    for (const kind of ["commitments", "people"] as const) {
      const s2 = store();
      const entry = s2.file({
        persona: PERSONA,
        kind,
        content: "Something asserted a very long time ago.",
        assertedAt: daysAgo(365 * 10),
      });
      expect(decays(kind)).toBe(false);
      expect(scoreEntry(entry, now)).toBe(1);
      // Still ranked, still injectable: age makes an obligation urgent, not stale.
      expect(s2.ranked(PERSONA, kind, { now }).map((e) => e.id)).toEqual([
        entry.id,
      ]);
    }
    // And the dormancy sweep must not touch them either.
    const c = s.file({
      persona: PERSONA,
      kind: "commitments",
      content: "Pay the Q1 VAT return.",
      assertedAt: daysAgo(365 * 10),
    });
    expect(s.sweepDormant(PERSONA, now)).toHaveLength(0);
    expect(s.get(c.id)!.status).toBe("active");
  });

  test("the belief split is exactly the three belief drawers", () => {
    expect([...BELIEF_KINDS].sort()).toEqual(["decisions", "lessons", "norms"]);
    expect(DRAWER_KINDS.filter((k) => !decays(k)).sort()).toEqual([
      "commitments",
      "people",
    ]);
  });

  test("weight scales the score without touching the clock", () => {
    const s = store();
    const now = new Date();
    const heavy = s.file({
      persona: PERSONA,
      kind: "norms",
      content: "A loud standing rule.",
      weight: 4,
      assertedAt: daysAgo(365),
    });
    const light = s.file({
      persona: PERSONA,
      kind: "norms",
      content: "A quiet aside.",
      assertedAt: daysAgo(30),
    });
    const ranked = s.ranked(PERSONA, "norms", { now });
    expect(ranked[0]!.id).toBe(heavy.id);
    expect(ranked[1]!.id).toBe(light.id);
  });

  test("a re-file takes the higher weight, never the lower", () => {
    const s = store();
    const first = s.file({
      persona: PERSONA,
      kind: "norms",
      content: "Loud rule.",
      weight: 5,
    });
    const again = s.file({
      persona: PERSONA,
      kind: "norms",
      content: "Loud rule.",
      weight: 1,
    });
    expect(again.weight).toBe(5);
    expect(first.id).toBe(again.id);
  });
});

describe("lifecycle", () => {
  test("a discharged commitment stops ranking but stays on the record", () => {
    const s = store();
    const c = s.file({
      persona: PERSONA,
      kind: "commitments",
      content: "Chase the Isio reply.",
    });
    s.setStatus(c.id, "discharged");
    expect(s.ranked(PERSONA, "commitments")).toHaveLength(0);
    expect(s.get(c.id)!.status).toBe("discharged");
  });

  test("expired and discharged are distinct states", () => {
    expect(statusAllowed("commitments", "expired")).toBe(true);
    expect(statusAllowed("commitments", "discharged")).toBe(true);
  });

  test("a kind cannot take a status it has no meaning for", () => {
    const s = store();
    const n = s.file({
      persona: PERSONA,
      kind: "norms",
      content: "A norm.",
    });
    expect(() => s.setStatus(n.id, "discharged")).toThrow(/cannot be/);
    const p = s.file({
      persona: PERSONA,
      kind: "people",
      content: "A person fact.",
    });
    expect(() => s.setStatus(p.id, "dormant")).toThrow(/cannot be/);
  });
});

describe("markdown ingest", () => {
  const SAMPLE = [
    "> _Preamble blockquote, not an entry._",
    "# Decisions",
    "---",
    "",
    "## 2026-04-03",
    "### Keep node apt-managed",
    "nvm was removed on 2026-05-04.",
    "- do not reintroduce it",
    "",
    "### Second decision under the same date",
    "body",
    "",
    "## Family",
    "### An undated entry",
    "body",
    "",
    "## 2026-06-04",
    "- - [decision] A flat capture bullet.",
    "",
  ].join("\n");

  test("parses both entry shapes and carries the section date", () => {
    const parsed = parseDrawer(SAMPLE);
    expect(parsed).toHaveLength(4);
    expect(parsed[0]!.content).toContain("Keep node apt-managed");
    expect(parsed[0]!.content).toContain("do not reintroduce it");
    expect(parsed[0]!.date).toBe("2026-04-03");
    expect(parsed[1]!.date).toBe("2026-04-03");
    // A non-date section header groups but dates nothing.
    expect(parsed[2]!.date).toBeUndefined();
    // The heartbeat's doubled dash is stripped.
    expect(parsed[3]!.content).toBe("[decision] A flat capture bullet.");
    expect(parsed[3]!.date).toBe("2026-06-04");
  });

  test("preamble, rules and the H1 title are not entries", () => {
    expect(parseDrawer("> quote\n# Title\n---\n\n").length).toBe(0);
  });

  test("ingest is idempotent: a second pass reaffirms, it never duplicates", async () => {
    const dir = await mkdtemp(join(tmpdir(), "drawer-ingest-"));
    await mkdir(join(dir, "memory"), { recursive: true });
    await writeFile(join(dir, "memory", "decisions.md"), SAMPLE);
    const s = store();

    const first = await ingestDrawerFile(s, dir, PERSONA, "decisions");
    expect(first.parsed).toBe(4);
    expect(first.inserted).toBe(4);
    expect(first.reaffirmed).toBe(0);

    const second = await ingestDrawerFile(s, dir, PERSONA, "decisions");
    expect(second.inserted).toBe(0);
    expect(second.reaffirmed).toBe(4);
    expect(s.list(PERSONA, "decisions")).toHaveLength(4);
  });

  test("the ingest leaves the markdown byte-identical", async () => {
    const dir = await mkdtemp(join(tmpdir(), "drawer-ingest-"));
    await mkdir(join(dir, "memory"), { recursive: true });
    const path = join(dir, "memory", "decisions.md");
    await writeFile(path, SAMPLE);
    await ingestDrawerFile(store(), dir, PERSONA, "decisions");
    expect(await Bun.file(path).text()).toBe(SAMPLE);
  });

  test("a missing drawer is a zero, not a throw", async () => {
    const dir = await mkdtemp(join(tmpdir(), "drawer-ingest-"));
    const results = await ingestDrawers(store(), dir, PERSONA);
    expect(results).toHaveLength(DRAWER_KINDS.length);
    expect(results.every((r) => r.parsed === 0)).toBe(true);
  });

  test("a future-dated section header cannot park the decay clock ahead of now", async () => {
    const dir = await mkdtemp(join(tmpdir(), "drawer-ingest-"));
    await mkdir(join(dir, "memory"), { recursive: true });
    await writeFile(
      join(dir, "memory", "norms.md"),
      "## 2999-01-01\n### A typo'd date\nbody\n",
    );
    const s = store();
    const now = new Date();
    await ingestDrawerFile(s, dir, PERSONA, "norms", now);
    const entry = s.list(PERSONA, "norms")[0]!;
    expect(entry.lastReaffirmedAt.getTime()).toBeLessThanOrEqual(now.getTime());
  });

  test("an entry ingested from a dated header decays from that date", async () => {
    const dir = await mkdtemp(join(tmpdir(), "drawer-ingest-"));
    await mkdir(join(dir, "memory"), { recursive: true });
    await writeFile(
      join(dir, "memory", "lessons.md"),
      "## 2020-01-01\n### An ancient lesson\nbody\n",
    );
    const s = store();
    await ingestDrawerFile(s, dir, PERSONA, "lessons");
    expect(s.ranked(PERSONA, "lessons")).toHaveLength(0);
    expect(s.list(PERSONA, "lessons")).toHaveLength(1);
  });
  test("bullets after a `###` block are their own entries, sub-bullets are not", () => {
    const parsed = parseDrawer(
      [
        "## 2026-08-20",
        "### Block entry",
        "body line",
        "",
        "- parent bullet:",
        "  - child a",
        "  - child b",
        "- second parent",
        "",
      ].join("\n"),
    );
    expect(parsed.map((e) => e.content)).toEqual([
      "Block entry\nbody line",
      "parent bullet:\n  - child a\n  - child b",
      "second parent",
    ]);
    expect(parsed.every((e) => e.date === "2026-08-20")).toBe(true);
  });

  test("a detail bullet running on from a block body stays in that block", () => {
    const parsed = parseDrawer(
      ["### Block entry", "body line", "- detail bullet", ""].join("\n"),
    );
    expect(parsed).toHaveLength(1);
    expect(parsed[0]!.content).toBe("Block entry\nbody line\n- detail bullet");
  });

  test("ingested markdown is the persona's own belief, not the principal's", async () => {
    const dir = await mkdtemp(join(tmpdir(), "drawer-source-"));
    await mkdir(join(dir, "memory"), { recursive: true });
    await writeFile(join(dir, "memory", "norms.md"), "- - [norm] A filed norm.\n");
    const s = store();
    await ingestDrawerFile(s, dir, PERSONA, "norms");
    const [entry] = s.list(PERSONA, "norms");
    expect(entry!.source).toBe("self");
  });

});
