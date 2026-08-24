/**
 * #437 — the `<!-- id: kind:hexid -->` marker and `importDrawerMarkdown`,
 * the inverse of `exportDrawerMarkdown`. See drawerImport.ts's header for the
 * two structural guards this suite exists to pin: a marker can only ever
 * resolve within its own kind, and an id that doesn't name a real row here
 * degrades to "no marker" rather than doing anything destructive.
 */

import { describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
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
import { drawerEntryId } from "../src/memory/drawers.ts";

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

  test("drawerEntryId of unchanged content matches the marker id (sanity)", () => {
    const id = drawerEntryId(PERSONA, "norms", "[norm] some content");
    const md = `- [norm] some content\n${formatIdMarker("norms", id)}\n`;
    const parsed = parseDrawer(md);
    expect(parsed[0]!.idMarker!.id).toBe(id);
  });
});
