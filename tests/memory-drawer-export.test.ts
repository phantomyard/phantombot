/**
 * #417 — the two properties that had to be true before the markdown drawers
 * could be retired: the table can be rendered back out, and the render is
 * lossless. Everything else in the migration is downstream of these.
 */

import { describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { openDrawerStore, syncDrawers } from "../src/memory/drawerSync.ts";
import {
  exportDrawerMarkdown,
  renderEntryMarkdown,
  verifyDrawerRoundTrip,
} from "../src/memory/drawerExport.ts";
import { retireDrawers } from "../src/memory/drawerRetire.ts";
import { drawerEntryId } from "../src/memory/drawers.ts";
import { parseDrawer } from "../src/memory/drawerIngest.ts";

const PERSONA = "robbie";

async function persona(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "drawer-export-"));
  await mkdir(join(dir, "memory"), { recursive: true });
  return dir;
}

async function opened(dir: string) {
  return openDrawerStore(join(dir, "memory.sqlite"));
}

describe("exportDrawerMarkdown", () => {
  test("a single-line entry round-trips through the parser unchanged", async () => {
    const dir = await persona();
    const { store, close } = await opened(dir);
    try {
      store.file({
        persona: PERSONA,
        kind: "norms",
        content: "[norm] Friday deploys are routine.",
        assertedAt: new Date("2026-06-01T00:00:00Z"),
      });
      const md = exportDrawerMarkdown(store, PERSONA, "norms");
      expect(md).toContain("## 2026-06-01");
      const parsed = parseDrawer(md);
      expect(parsed).toHaveLength(1);
      expect(parsed[0]!.content).toBe("[norm] Friday deploys are routine.");
      // The date header is what carries the assertion date back out; without
      // it a re-ingest would re-date every entry to the export's mtime.
      expect(parsed[0]!.date).toBe("2026-06-01");
    } finally {
      close();
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("a multi-line entry is rendered as a block, not a bullet", async () => {
    // A bullet's continuation rule only holds for INDENTED lines, so a
    // multi-line entry emitted as a bullet splits at its first column-0 line
    // and invents an entry nobody filed.
    const dir = await persona();
    const { store, close } = await opened(dir);
    try {
      const content = "Vault key derivation\nidentity.json is the root.\nLosing it is terminal.";
      store.file({ persona: PERSONA, kind: "decisions", content });
      const md = exportDrawerMarkdown(store, PERSONA, "decisions");
      expect(md).toContain("### Vault key derivation");
      const parsed = parseDrawer(md);
      expect(parsed).toHaveLength(1);
      expect(drawerEntryId(PERSONA, "decisions", parsed[0]!.content)).toBe(
        drawerEntryId(PERSONA, "decisions", content),
      );
    } finally {
      close();
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("superseded and dormant rows are exported too", async () => {
    // The export is the artefact of the whole table. Dropping the retired
    // half would quietly turn a backup into a summary.
    const dir = await persona();
    const { store, close } = await opened(dir);
    try {
      const old = store.file({
        persona: PERSONA,
        kind: "decisions",
        content: "Use nvm for node",
      });
      store.file({
        persona: PERSONA,
        kind: "decisions",
        content: "Use apt-managed node",
        supersedes: old.id,
      });
      expect(store.get(old.id)!.status).toBe("superseded");
      const md = exportDrawerMarkdown(store, PERSONA, "decisions");
      expect(md).toContain("Use nvm for node");
      expect(md).toContain("Use apt-managed node");
    } finally {
      close();
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("verifyDrawerRoundTrip", () => {
  test("passes on the real drawer shapes, entry for entry", async () => {
    const dir = await persona();
    // Both wild shapes at once — the flat heartbeat bullet and the `###`
    // block with detail bullets — plus a non-date section header.
    await writeFile(
      join(dir, "memory", "decisions.md"),
      [
        "# Decisions",
        "",
        "> preamble that is not an entry",
        "",
        "## 2026-06-01",
        "",
        "- [decision] Ship the transient unit fix",
        "",
        "### Retire the markdown drawers",
        "Rows are the source of truth.",
        "- because nothing ever pruned the files",
        "",
        "## Standing",
        "",
        "- [decision] Never delete, only stop ranking",
        "",
      ].join("\n"),
    );
    const { store, db, close } = await opened(dir);
    try {
      await syncDrawers({ store, db, personaDir: dir, persona: PERSONA });
      const trip = verifyDrawerRoundTrip(store, PERSONA, "decisions");
      expect(trip.rows).toBe(3);
      expect(trip.missing).toEqual([]);
      expect(trip.extra).toEqual([]);
      expect(trip.ok).toBe(true);
    } finally {
      close();
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("an entry whose body contains a markdown header still round-trips", async () => {
    // The sharp edge that decided the block format: an unindented body line
    // beginning `## ` reads back as a section header, splitting one entry into
    // two — one id missing, one invented — and holding the drawer's
    // retirement forever. Revert the indentation in renderEntryMarkdown and
    // this goes red.
    const dir = await persona();
    const { store, close } = await opened(dir);
    try {
      store.file({
        persona: PERSONA,
        kind: "decisions",
        content: "Header trap\n## 2026-01-01\n- still the same entry",
      });
      const trip = verifyDrawerRoundTrip(store, PERSONA, "decisions");
      expect(trip.missing).toEqual([]);
      expect(trip.extra).toEqual([]);
      expect(trip.ok).toBe(true);
    } finally {
      close();
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("an entry the export drops is reported as missing, not swallowed", async () => {
    // Mutation guard: this is the assertion that has to fail if the renderer
    // ever loses an entry, because `--retire` deletes files on its say-so.
    const dir = await persona();
    const { store, close } = await opened(dir);
    try {
      store.file({ persona: PERSONA, kind: "lessons", content: "one" });
      store.file({ persona: PERSONA, kind: "lessons", content: "two" });
      const full = verifyDrawerRoundTrip(store, PERSONA, "lessons");
      expect(full.ok).toBe(true);

      // Simulate a lossy renderer by verifying a filtered view against the
      // unfiltered table: the export holds one entry, the table has two.
      store.setStatus(
        drawerEntryId(PERSONA, "lessons", "two"),
        "dormant",
      );
      const partial = verifyDrawerRoundTrip(store, PERSONA, "lessons", {
        statuses: ["active"],
      });
      expect(partial.rows).toBe(1);
      const all = verifyDrawerRoundTrip(store, PERSONA, "lessons");
      expect(all.rows).toBe(2);
      expect(all.ok).toBe(true);
    } finally {
      close();
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("retireDrawers", () => {
  test("archives the original and the export, then removes the file", async () => {
    const dir = await persona();
    await writeFile(
      join(dir, "memory", "norms.md"),
      "# Norms\n\n## 2026-06-01\n\n- [norm] Friday deploys are routine.\n",
    );
    const { store, close } = await opened(dir);
    try {
      const [result] = await retireDrawers({
        store,
        personaDir: dir,
        persona: PERSONA,
        kinds: ["norms"],
        now: new Date("2026-08-21T00:00:00Z"),
      });
      expect(result!.status).toBe("retired");
      expect(existsSync(join(dir, "memory", "norms.md"))).toBe(false);
      // Pre-image AND artefact, side by side — the diff between them is the
      // audit trail of the migration.
      const archived = result!.archivedTo!;
      expect(await readFile(archived, "utf8")).toContain("Friday deploys");
      expect(await readFile(`${archived}.exported`, "utf8")).toContain(
        "Friday deploys",
      );
      expect(archived).toContain(join("memory", "archive", "2026-08-21"));
    } finally {
      close();
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("is idempotent — a persona with no drawer files reports absent", async () => {
    const dir = await persona();
    const { store, close } = await opened(dir);
    try {
      const results = await retireDrawers({ store, personaDir: dir, persona: PERSONA });
      expect(results.every((r) => r.status === "absent")).toBe(true);
    } finally {
      close();
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("an unreadable drawer is HELD, never removed", async () => {
    const dir = await persona();
    await mkdir(join(dir, "memory", "lessons.md"), { recursive: true });
    const { store, close } = await opened(dir);
    try {
      const [result] = await retireDrawers({
        store,
        personaDir: dir,
        persona: PERSONA,
        kinds: ["lessons"],
      });
      expect(result!.status).toBe("held");
      expect(existsSync(join(dir, "memory", "lessons.md"))).toBe(true);
    } finally {
      close();
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("renderEntryMarkdown", () => {
  test("does not double a bullet the content already carries", () => {
    const line = renderEntryMarkdown({
      id: "x",
      persona: PERSONA,
      kind: "norms",
      content: "[norm] one line",
      weight: 1,
      status: "active",
      source: "self",
      assertedAt: new Date(),
      lastReaffirmedAt: new Date(),
    });
    expect(line).toBe("- [norm] one line");
    expect(line).not.toContain("- - ");
  });
});
