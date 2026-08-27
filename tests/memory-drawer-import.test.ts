/**
 * #437 — the `<!-- id: kind:hexid -->` marker and `importDrawerMarkdown`,
 * the inverse of `exportDrawerMarkdown`. See drawerImport.ts's header for the
 * two structural guards this suite exists to pin: a marker can only ever
 * resolve within its own kind, and an id that doesn't name a real row here
 * degrades to "no marker" rather than doing anything destructive.
 */

import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { openDrawerStore } from "../src/memory/drawerSync.ts";
import {
  exportDrawerMarkdown,
  formatIdMarker,
  renderEntryMarkdown,
} from "../src/memory/drawerExport.ts";
import { parseDrawer } from "../src/memory/drawerIngest.ts";
import { importDrawerMarkdown } from "../src/memory/drawerImport.ts";
import { runMemoryDrawers } from "../src/cli/memory.ts";
import { drawerEntryId } from "../src/memory/drawers.ts";
import { openJournalStore } from "../src/memory/journalIngest.ts";
import { indexOpenDay } from "../src/memory/journalRender.ts";
import { MemoryIndex } from "../src/lib/memoryIndex.ts";

const PERSONA = "robbie";

async function persona(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "drawer-import-"));
  await mkdir(join(dir, "memory"), { recursive: true });
  return dir;
}

async function opened(dir: string) {
  return openDrawerStore(join(dir, "memory.sqlite"));
}

describe("renderEntryMarkdown / parseDrawer — the marker round-trips", () => {
  test("withId appends the marker; parseDrawer strips it back off content", () => {
    const entry = {
      id: "abc123abc123abc1",
      persona: PERSONA,
      kind: "norms" as const,
      content: "[norm] one line",
      weight: 1,
      status: "active" as const,
      source: "self" as const,
      assertedAt: new Date(),
      lastReaffirmedAt: new Date(),
    };
    const withMarker = renderEntryMarkdown(entry, { withId: true });
    expect(withMarker).toBe(
      "- [norm] one line\n<!-- id: norms:abc123abc123abc1 -->",
    );
    const parsed = parseDrawer(withMarker);
    expect(parsed).toHaveLength(1);
    expect(parsed[0]!.content).toBe("[norm] one line");
    expect(parsed[0]!.idMarker).toEqual({ kind: "norms", id: "abc123abc123abc1" });

    // Default (no opts) stays exactly the old shape — pinning backward compat
    // for verifyDrawerRoundTrip and existing callers.
    expect(renderEntryMarkdown(entry)).toBe("- [norm] one line");
  });

  test("marker survives on a multi-line block entry without polluting content", () => {
    const entry = {
      id: "deadbeefdeadbeef",
      persona: PERSONA,
      kind: "decisions" as const,
      content: "Ship the thing\ndetail line one\ndetail line two",
      weight: 1,
      status: "active" as const,
      source: "self" as const,
      assertedAt: new Date(),
      lastReaffirmedAt: new Date(),
    };
    const md = renderEntryMarkdown(entry, { withId: true });
    const parsed = parseDrawer(md);
    expect(parsed).toHaveLength(1);
    // Body lines round-trip through NORMALIZED identity, not raw bytes —
    // block-form re-indents on render (see renderEntryMarkdown's header
    // note), so the parsed content only has to normalize back to the
    // original, not match it byte for byte.
    expect(parsed[0]!.content.replace(/\n\s*/g, "\n")).toBe(entry.content);
    // What this test actually pins: the marker survived intact, unmerged
    // into the body it trails.
    expect(parsed[0]!.idMarker).toEqual({
      kind: "decisions",
      id: "deadbeefdeadbeef",
    });
  });

  test("a malformed marker line is inert — no crash, no idMarker, not content", () => {
    const text = [
      "- [norm] a plain entry",
      "<!-- id: not-a-valid-marker -->",
      "",
    ].join("\n");
    const parsed = parseDrawer(text);
    expect(parsed).toHaveLength(1);
    expect(parsed[0]!.content).toBe("[norm] a plain entry");
    expect(parsed[0]!.idMarker).toBeUndefined();
  });
});

describe("importDrawerMarkdown", () => {
  test("unmarked line files as new, same as plain ingest", async () => {
    const dir = await persona();
    const { store, close } = await opened(dir);
    try {
      const result = importDrawerMarkdown(
        store,
        PERSONA,
        "norms",
        "- [norm] a fresh house rule\n",
      );
      expect(result.inserted).toBe(1);
      expect(result.reaffirmed).toBe(0);
      expect(result.superseded).toBe(0);
      expect(store.list(PERSONA, "norms")).toHaveLength(1);
    } finally {
      close();
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("unchanged marked line reaffirms — no new row, no supersession", async () => {
    const dir = await persona();
    const { store, close } = await opened(dir);
    try {
      store.file({ persona: PERSONA, kind: "norms", content: "[norm] stable rule" });
      const before = store.list(PERSONA, "norms");
      expect(before).toHaveLength(1);
      const before1 = before[0]!.lastReaffirmedAt.getTime();

      const md = exportDrawerMarkdown(store, PERSONA, "norms", { withId: true });
      const result = importDrawerMarkdown(store, PERSONA, "norms", md, {
        now: new Date(before1 + 60_000),
      });

      expect(result.reaffirmed).toBe(1);
      expect(result.inserted).toBe(0);
      expect(result.superseded).toBe(0);
      const after = store.list(PERSONA, "norms");
      expect(after).toHaveLength(1);
      expect(after[0]!.id).toBe(before[0]!.id);
    } finally {
      close();
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("changed marked line supersedes the row it names", async () => {
    const dir = await persona();
    const { store, close } = await opened(dir);
    try {
      const original = store.file({
        persona: PERSONA,
        kind: "norms",
        content: "[norm] Friday deploys are fine",
      });
      let md = exportDrawerMarkdown(store, PERSONA, "norms", { withId: true });
      // Hand-edit: same marker, different content — this is exactly what a
      // human editing the export file does.
      md = md.replace("Friday deploys are fine", "Friday deploys need sign-off");

      const superseded: string[] = [];
      const result = importDrawerMarkdown(store, PERSONA, "norms", md, {
        onSupersede: (r) => superseded.push(r.content),
      });

      expect(result.superseded).toBe(1);
      expect(superseded).toEqual(["[norm] Friday deploys need sign-off"]);

      const rows = store.list(PERSONA, "norms");
      expect(rows).toHaveLength(2);
      const oldRow = rows.find((r) => r.id === original.id)!;
      const newRow = rows.find((r) => r.id !== original.id)!;
      expect(oldRow.status).toBe("superseded");
      expect(newRow.status).toBe("active");
      expect(newRow.supersedes).toBe(original.id);
      expect(newRow.content).toBe("[norm] Friday deploys need sign-off");
    } finally {
      close();
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("cross-kind marker is rejected — content still files, no cross-drawer write", async () => {
    const dir = await persona();
    const { store, close } = await opened(dir);
    try {
      const decision = store.file({
        persona: PERSONA,
        kind: "decisions",
        content: "Adopt the new build pipeline",
      });
      // A norms file claiming to supersede a decisions row.
      const forged = `- [norm] a suspicious rule\n${formatIdMarker("decisions", decision.id)}\n`;

      const result = importDrawerMarkdown(store, PERSONA, "norms", forged);

      expect(result.rejected).toBe(1);
      expect(result.entries[0]!.markerRejected).toBe("marker-mismatch");
      // Filed as an ordinary new norm — the marker was ignored, not honoured.
      expect(result.inserted).toBe(1);
      expect(result.superseded).toBe(0);

      // The decisions row is completely untouched.
      const decisionRow = store.get(decision.id)!;
      expect(decisionRow.status).toBe("active");
      expect(decisionRow.content).toBe("Adopt the new build pipeline");
    } finally {
      close();
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("a forged or stale id that names no real row degrades to a plain new entry", async () => {
    const dir = await persona();
    const { store, close } = await opened(dir);
    try {
      const bogusId = "0123456789abcdef";
      const text = `- [norm] a hand-typed marker\n${formatIdMarker("norms", bogusId)}\n`;

      const result = importDrawerMarkdown(store, PERSONA, "norms", text);

      expect(result.rejected).toBe(1);
      expect(result.entries[0]!.markerRejected).toBe("marker-unknown");
      expect(result.inserted).toBe(1);
      expect(result.superseded).toBe(0);
      expect(store.get(bogusId)).toBeUndefined();
    } finally {
      close();
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("a marker naming a row in a different persona degrades the same way", async () => {
    const dir = await persona();
    const { store, close } = await opened(dir);
    try {
      const otherPersonaRow = store.file({
        persona: "someone-else",
        kind: "norms",
        content: "[norm] belongs to another persona",
      });
      const text = `- [norm] my own new rule\n${formatIdMarker("norms", otherPersonaRow.id)}\n`;

      const result = importDrawerMarkdown(store, PERSONA, "norms", text);

      expect(result.rejected).toBe(1);
      expect(result.inserted).toBe(1);
      expect(result.superseded).toBe(0);
      // The other persona's row is untouched.
      expect(store.get(otherPersonaRow.id)!.status).toBe("active");
    } finally {
      close();
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("round trip: export --with-id then import unmodified is a no-op reaffirm across all statuses", async () => {
    const dir = await persona();
    const { store, close } = await opened(dir);
    try {
      const a = store.file({ persona: PERSONA, kind: "lessons", content: "[lesson] one" });
      store.file({ persona: PERSONA, kind: "lessons", content: "[lesson] two — replaces one", supersedes: a.id });

      const md = exportDrawerMarkdown(store, PERSONA, "lessons", { withId: true });
      const before = store.list(PERSONA, "lessons").map((r) => [r.id, r.status]).sort();

      const result = importDrawerMarkdown(store, PERSONA, "lessons", md);
      expect(result.superseded).toBe(0);
      expect(result.inserted).toBe(0);
      expect(result.reaffirmed).toBe(2);

      const after = store.list(PERSONA, "lessons").map((r) => [r.id, r.status]).sort();
      expect(after).toEqual(before);
    } finally {
      close();
      await rm(dir, { recursive: true, force: true });
    }
  });

  // A marker is a snapshot of an id, and an id is a hash of content — so the
  // moment a marked line is edited and imported, every copy of that export
  // still on disk names a retired row. These pin the behaviour when someone
  // does the ordinary thing and edits the same exported file again.
  describe("stale markers — the file outlives the import that consumed it", () => {
    const active = (store: { list: (p: string, k: "norms") => { status: string; content: string }[] }) =>
      store
        .list(PERSONA, "norms")
        .filter((r) => r.status === "active")
        .map((r) => r.content);

    test("editing the SAME export twice leaves exactly one active row", async () => {
      const dir = await persona();
      const { store, close } = await opened(dir);
      try {
        store.file({ persona: PERSONA, kind: "norms", content: "[norm] version a" });
        const md = exportDrawerMarkdown(store, PERSONA, "norms", { withId: true });

        // Round one supersedes `a`. Round two's marker STILL names `a`; before
        // the forward walk it re-retired `a` (a no-op) and left `b` active
        // beside `c` — the duplicate #437 exists to kill.
        importDrawerMarkdown(store, PERSONA, "norms", md.replace("version a", "version b"));
        const second = importDrawerMarkdown(store, PERSONA, "norms", md.replace("version a", "version c"));

        expect(second.superseded).toBe(1);
        expect(second.entries[0]!.previousContent).toBe("[norm] version b");
        expect(active(store)).toEqual(["[norm] version c"]);
      } finally {
        close();
        await rm(dir, { recursive: true, force: true });
      }
    });

    test("the walk follows a chain of any length, not just one hop", async () => {
      const dir = await persona();
      const { store, close } = await opened(dir);
      try {
        store.file({ persona: PERSONA, kind: "norms", content: "[norm] version a" });
        const md = exportDrawerMarkdown(store, PERSONA, "norms", { withId: true });
        for (const v of ["b", "c", "d"]) {
          importDrawerMarkdown(store, PERSONA, "norms", md.replace("version a", `version ${v}`));
        }
        expect(active(store)).toEqual(["[norm] version d"]);
      } finally {
        close();
        await rm(dir, { recursive: true, force: true });
      }
    });

    test("importing the same edited buffer twice is a no-op, not a self-supersession", async () => {
      const dir = await persona();
      const { store, close } = await opened(dir);
      try {
        store.file({ persona: PERSONA, kind: "norms", content: "[norm] version a" });
        const md = exportDrawerMarkdown(store, PERSONA, "norms", { withId: true });
        const edited = md.replace("version a", "version b");

        importDrawerMarkdown(store, PERSONA, "norms", edited);
        // Re-running the command is the ordinary way to retry it. The walk
        // lands on the row this very content produced, so asking it to
        // supersede itself would throw in fileEntry.
        const again = importDrawerMarkdown(store, PERSONA, "norms", edited);

        expect(again.superseded).toBe(0);
        expect(again.reaffirmed).toBe(1);
        expect(active(store)).toEqual(["[norm] version b"]);
      } finally {
        close();
        await rm(dir, { recursive: true, force: true });
      }
    });

    test("re-importing an UNEDITED stale export changes nothing", async () => {
      const dir = await persona();
      const { store, close } = await opened(dir);
      try {
        store.file({ persona: PERSONA, kind: "norms", content: "[norm] version a" });
        const md = exportDrawerMarkdown(store, PERSONA, "norms", { withId: true });
        importDrawerMarkdown(store, PERSONA, "norms", md.replace("version a", "version b"));

        // The line still matches the row its marker names, so this is a plain
        // reaffirm — the walk never runs. An unconditional walk would compare
        // "version a" against `b` and revert the drawer.
        const stale = importDrawerMarkdown(store, PERSONA, "norms", md);
        expect(stale.superseded).toBe(0);
        expect(active(store)).toEqual(["[norm] version b"]);
      } finally {
        close();
        await rm(dir, { recursive: true, force: true });
      }
    });

    test("resolveLive stays inside its persona and kind, and survives a cycle", async () => {
      const dir = await persona();
      const { store, close } = await opened(dir);
      try {
        const a = store.file({ persona: PERSONA, kind: "norms", content: "[norm] a" });
        const b = store.file({ persona: PERSONA, kind: "norms", content: "[norm] b", supersedes: a.id });

        expect(store.resolveLive(PERSONA, "norms", a.id)!.id).toBe(b.id);
        expect(store.resolveLive(PERSONA, "norms", b.id)!.id).toBe(b.id);
        // Wrong kind and wrong persona both miss rather than wander.
        expect(store.resolveLive(PERSONA, "decisions", a.id)).toBeUndefined();
        expect(store.resolveLive("someone-else", "norms", a.id)).toBeUndefined();
        expect(store.resolveLive(PERSONA, "norms", "deadbeefdeadbeef")).toBeUndefined();

        // Close the chain by hand — fileEntry blocks self-supersession but
        // nothing blocks a longer loop arriving through separate writes, and
        // the walk is driven by untrusted file content.
        store.file({ persona: PERSONA, kind: "norms", content: "[norm] a", supersedes: b.id });
        expect(store.resolveLive(PERSONA, "norms", a.id)).toBeDefined();
      } finally {
        close();
        await rm(dir, { recursive: true, force: true });
      }
    });
  });

  // CLI-level, because both of these are properties of how `--import` is
  // WIRED rather than of importDrawerMarkdown itself.
  describe("runMemoryDrawers --import", () => {
    class Sink {
      chunks: string[] = [];
      write(t: string) {
        this.chunks.push(t);
        return true;
      }
      get text() {
        return this.chunks.join("");
      }
    }

    async function cliEnv() {
      const root = await mkdtemp(join(tmpdir(), "drawer-cli-"));
      await mkdir(join(root, "personas", PERSONA, "memory"), { recursive: true });
      const saved = {
        cfg: process.env.PHANTOMBOT_CONFIG,
        personas: process.env.PHANTOMBOT_PERSONAS_DIR,
        data: process.env.XDG_DATA_HOME,
        state: process.env.XDG_STATE_HOME,
      };
      process.env.PHANTOMBOT_CONFIG = join(root, "config.toml");
      process.env.PHANTOMBOT_PERSONAS_DIR = join(root, "personas");
      process.env.XDG_DATA_HOME = join(root, "data");
      process.env.XDG_STATE_HOME = join(root, "state");
      const restore = async () => {
        for (const [k, v] of [
          ["PHANTOMBOT_CONFIG", saved.cfg],
          ["PHANTOMBOT_PERSONAS_DIR", saved.personas],
          ["XDG_DATA_HOME", saved.data],
          ["XDG_STATE_HOME", saved.state],
        ] as const) {
          if (v === undefined) delete process.env[k];
          else process.env[k] = v;
        }
        await rm(root, { recursive: true, force: true });
      };
      return { root, restore };
    }

    /** The open day as the table holds it — there is no file to read. */
    async function journalRows(root: string, date: string) {
      const { store, close } = await openJournalStore(
        join(root, "data", "phantombot", "memory.sqlite"),
      );
      try {
        return store.listDay(PERSONA, date);
      } finally {
        close();
      }
    }

    test("--import - is refused without --kind", async () => {
      const { restore } = await cliEnv();
      try {
        const out = new Sink();
        // Without the guard this drains stdin inside `for (const kind of
        // kinds)` and files the whole document into DRAWER_KINDS[0] —
        // `phantombot memory drawers --import - < norms.md` lands a norms
        // export in `people`, silently when the lines carry no markers.
        const code = await runMemoryDrawers({
          persona: PERSONA,
          import: "-",
          out,
        });
        expect(code).toBe(1);
        expect(out.text).toContain("--import - needs --kind");
      } finally {
        await restore();
      }
    });

    test("a supersession files ONE journal ROW, newlines escaped", async () => {
      const { root, restore } = await cliEnv();
      try {
        // A block-form entry is multi-line by definition. Interpolated raw,
        // its body spills to column 0 of the daily file — and a spilled line
        // shaped `[norm] …` matches promoteTaggedLines' TAG_PATTERN, so the
        // next heartbeat promotes it as a brand-new drawer entry.
        // Body lines are indented two spaces under a `### ` heading, and
        // TAG_PATTERN allows leading whitespace — so `  [norm] looks like a
        // tag` is exactly the shape the heartbeat would promote.
        const before = "[norm] one\nbody line\n[norm] looks like a tag";

        const dbPath = join(root, "data", "phantombot", "memory.sqlite");
        await mkdir(join(root, "data", "phantombot"), { recursive: true });
        const { store, close } = await openDrawerStore(dbPath);
        const row = store.file({ persona: PERSONA, kind: "norms", content: before });
        const md = exportDrawerMarkdown(store, PERSONA, "norms", { withId: true });
        expect(md).toContain(formatIdMarker("norms", row.id));
        close();

        const dir = join(root, "drawers");
        await mkdir(dir, { recursive: true });
        const edited = md.replace("### [norm] one", "### [norm] one edited");
        expect(edited).not.toBe(md);
        await writeFile(join(dir, "norms.md"), edited, "utf8");

        const out = new Sink();
        const code = await runMemoryDrawers({
          persona: PERSONA,
          kind: "norms",
          import: dir,
          out,
        });
        expect(code).toBe(0);
        expect(out.text).toContain("1 superseded");

        const date = new Date().toISOString().slice(0, 10);
        // ROWS, not a file. The audit used to be appended straight to
        // `memory/<date>.md`, which put a second writer on the open day: once
        // the day has rows, prompt recall reads the table and never sees that
        // file — and the index's virtual note for the open day lives at
        // exactly that path, so the next refreshStale replaced a whole day of
        // searchable rows with the audit line alone.
        expect(
          existsSync(join(root, "personas", PERSONA, "memory", `${date}.md`)),
        ).toBe(false);

        const rows = await journalRows(root, date);
        const logged = rows.filter((r) => r.content.startsWith("drawer-import:"));
        expect(logged).toHaveLength(1);
        // One ENTRY, and one line inside it — nothing spilled past the first
        // line, so nothing can round-trip back out as a separate entry.
        expect(logged[0]!.content).not.toContain("\n");
        // `drawer-import` is not a tag: tags are a promotion instruction, and
        // the heartbeat would go looking for a drawer of that name.
        expect(logged[0]!.tags).toEqual([]);
        // Mechanical, but not `task` — `task` rows are withheld from the
        // prompt, and #437 says a supersession must be loud.
        expect(logged[0]!.source).toBe("heartbeat");
      } finally {
        await restore();
      }
    });

    test("an import leaves the open day's rows searchable, not replaced by the audit", async () => {
      const { root, restore } = await cliEnv();
      try {
        const date = new Date().toISOString().slice(0, 10);
        const dbPath = join(root, "data", "phantombot", "memory.sqlite");
        const indexPath = join(root, "index.sqlite");
        await mkdir(join(root, "data", "phantombot"), { recursive: true });

        // A day's worth of real captures, already published to the index as
        // the open day's VIRTUAL note.
        const { store: journal, close: closeJournal } =
          await openJournalStore(dbPath);
        journal.append({
          persona: PERSONA,
          date,
          content: "the OVH cluster is only reachable through the SOCKS proxy",
          tags: ["lesson"],
        });
        await indexOpenDay(journal, PERSONA, date, indexPath);
        closeJournal();

        const { store, close } = await openDrawerStore(dbPath);
        const row = store.file({
          persona: PERSONA,
          kind: "norms",
          content: "[norm] one",
        });
        const md = exportDrawerMarkdown(store, PERSONA, "norms", { withId: true });
        expect(md).toContain(formatIdMarker("norms", row.id));
        close();

        const dir = join(root, "drawers");
        await mkdir(dir, { recursive: true });
        await writeFile(
          join(dir, "norms.md"),
          md.replace("[norm] one", "[norm] one edited"),
          "utf8",
        );

        const out = new Sink();
        expect(
          await runMemoryDrawers({
            persona: PERSONA,
            kind: "norms",
            import: dir,
            indexPath,
            out,
          }),
        ).toBe(0);
        expect(out.text).toContain("1 superseded");

        const ix = await MemoryIndex.open(indexPath);
        try {
          // The audit used to arrive as a REAL FILE at exactly the virtual
          // note's path, so the next refresh indexed it as the whole day and
          // the morning's captures stopped being findable. Both the capture
          // and the audit are rows now, so both survive the refresh.
          await ix.refreshStale(join(root, "personas", PERSONA));
          expect(ix.search("SOCKS proxy", { scope: "memory" }).length).toBe(1);
          expect(ix.search("superseded", { scope: "memory" }).length).toBe(1);
        } finally {
          ix.close();
        }
      } finally {
        await restore();
      }
    });

    test("a second-generation supersession logs the RETIRED row, not the marker", async () => {
      const { root, restore } = await cliEnv();
      try {
        // The generation-1 case above cannot catch a stale id: the marker
        // names A and A is exactly what gets retired, so marker id and live
        // id coincide. The bug only shows from the SECOND edit of the same
        // exported file — the marker still says A, but A was retired by B on
        // the previous import, and B is what this import actually takes out
        // of service.
        const dbPath = join(root, "data", "phantombot", "memory.sqlite");
        await mkdir(join(root, "data", "phantombot"), { recursive: true });
        const { store, close } = await openDrawerStore(dbPath);
        const rowA = store.file({
          persona: PERSONA,
          kind: "norms",
          content: "[norm] version a",
        });
        const md = exportDrawerMarkdown(store, PERSONA, "norms", { withId: true });
        expect(md).toContain(formatIdMarker("norms", rowA.id));
        close();

        const dir = join(root, "drawers");
        await mkdir(dir, { recursive: true });

        // Both edits are made to the SAME export — the marker never changes,
        // which is the whole point: the file has never seen B's id.
        const runImport = async (content: string) => {
          await writeFile(
            join(dir, "norms.md"),
            md.replace("[norm] version a", content),
            "utf8",
          );
          const out = new Sink();
          const code = await runMemoryDrawers({
            persona: PERSONA,
            kind: "norms",
            import: dir,
            out,
          });
          expect(code).toBe(0);
          expect(out.text).toContain("1 superseded");
        };

        await runImport("[norm] version b");
        await runImport("[norm] version c");

        const idB = drawerEntryId(PERSONA, "norms", "[norm] version b");
        const idC = drawerEntryId(PERSONA, "norms", "[norm] version c");

        const date = new Date().toISOString().slice(0, 10);
        const logged = (await journalRows(root, date))
          .map((r) => r.content)
          .filter((c) => c.startsWith("drawer-import:"));
        expect(logged).toHaveLength(2);

        // Generation 1: marker and retired row are the same row, so no
        // provenance suffix — the line stays as short as it was before.
        expect(logged[0]).toContain(`superseded norms:${rowA.id} -> `);
        expect(logged[0]).not.toContain("marker named");

        // Generation 2: B is what was retired and B is what gets named. The
        // marker's id survives as provenance, explicitly labelled, so a
        // reader can still follow the chain back to the line in the file.
        expect(logged[1]).toContain(`superseded norms:${idB}`);
        expect(logged[1]).toContain(`(marker named norms:${rowA.id})`);
        expect(logged[1]).toContain(`-> ${idC}`);
        // The bug: A appears as the RETIRED row on the second line, which
        // reads as a fork A->B, A->C that never happened, and leaves B's
        // retirement absent from the audit trail entirely.
        expect(logged[1]).not.toContain(`superseded norms:${rowA.id} ->`);
        // The id beside previousContent must agree with it: "version b" is
        // B's content, so the id must be B's.
        expect(logged[1]).toContain('"[norm] version b" -> "[norm] version c"');
      } finally {
        await restore();
      }
    });
  });

  test("drawerEntryId of unchanged content matches the marker id (sanity)", () => {
    const id = drawerEntryId(PERSONA, "norms", "[norm] some content");
    const md = `- [norm] some content\n${formatIdMarker("norms", id)}\n`;
    const parsed = parseDrawer(md);
    expect(parsed[0]!.idMarker!.id).toBe(id);
  });
});
