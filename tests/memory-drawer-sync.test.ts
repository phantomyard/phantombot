/**
 * The #410 wiring: markdown drawers → `drawer_entries` rows → the threat
 * judge's briefing.
 *
 * The regression this file exists to prevent is the one that shipped twice:
 * schema and parser present, nothing calling either. So the assertions here
 * are deliberately about CALLERS — the heartbeat files rows, the briefing
 * reads them — not about the row model, which `memory-drawers.test.ts` covers.
 */

import { describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  drawerSection,
  openDrawerStore,
  renderDrawer,
  syncDrawers,
} from "../src/memory/drawerSync.ts";
import { runHeartbeat } from "../src/lib/heartbeat.ts";
import { packBriefing, BRIEFING_DRAWERS } from "../src/orchestrator/screen.ts";

const PERSONA = "robbie";

async function persona(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "drawer-sync-"));
  await mkdir(join(dir, "memory"), { recursive: true });
  return dir;
}

async function opened(dir: string) {
  return openDrawerStore(join(dir, "memory.sqlite"));
}

describe("syncDrawers", () => {
  test("projects markdown into rows, then skips unchanged files", async () => {
    const dir = await persona();
    await writeFile(
      join(dir, "memory", "norms.md"),
      "# Norms\n\n## 2026-06-01\n\n- [norm] Deploys on Fridays are routine here.\n",
    );
    const { store, db, close } = await opened(dir);
    try {
      const first = await syncDrawers({ store, db, personaDir: dir, persona: PERSONA });
      expect(first.ingested.find((r) => r.kind === "norms")?.inserted).toBe(1);
      expect(first.missing).toContain("decisions");

      const second = await syncDrawers({ store, db, personaDir: dir, persona: PERSONA });
      // The whole point of the content-hash marker: no re-parse, no re-upsert.
      expect(second.unchanged).toContain("norms");
      expect(second.ingested.find((r) => r.kind === "norms")).toBeUndefined();
      expect(store.list(PERSONA, "norms")).toHaveLength(1);
    } finally {
      close();
    }
  });

  test("re-ingests when the file content changes", async () => {
    const dir = await persona();
    const path = join(dir, "memory", "lessons.md");
    await writeFile(path, "- [lesson] One.\n");
    const { store, db, close } = await opened(dir);
    try {
      await syncDrawers({ store, db, personaDir: dir, persona: PERSONA });
      await writeFile(path, "- [lesson] One.\n- [lesson] Two.\n");
      const again = await syncDrawers({ store, db, personaDir: dir, persona: PERSONA });
      expect(again.unchanged).not.toContain("lessons");
      expect(store.list(PERSONA, "lessons")).toHaveLength(2);
    } finally {
      close();
    }
  });

  test("--force re-ingests an unchanged file", async () => {
    const dir = await persona();
    await writeFile(join(dir, "memory", "people.md"), "- [person] Ada writes compilers.\n");
    const { store, db, close } = await opened(dir);
    try {
      await syncDrawers({ store, db, personaDir: dir, persona: PERSONA });
      const forced = await syncDrawers({
        store, db, personaDir: dir, persona: PERSONA, force: true,
      });
      expect(forced.unchanged).toHaveLength(0);
      // Reaffirmed, never duplicated — ids are content-derived.
      expect(forced.ingested.find((r) => r.kind === "people")?.reaffirmed).toBe(1);
      expect(store.list(PERSONA, "people")).toHaveLength(1);
    } finally {
      close();
    }
  });

  test("one unreadable drawer does not cost the others", async () => {
    const dir = await persona();
    // A directory where a file is expected: readFile throws EISDIR.
    await mkdir(join(dir, "memory", "decisions.md"));
    await writeFile(join(dir, "memory", "norms.md"), "- [norm] Still briefed.\n");
    const { store, db, close } = await opened(dir);
    try {
      const r = await syncDrawers({ store, db, personaDir: dir, persona: PERSONA });
      expect(r.ingested.map((x) => x.kind)).toContain("norms");
      expect(r.ingested.map((x) => x.kind)).not.toContain("decisions");
      expect(store.list(PERSONA, "norms")).toHaveLength(1);
    } finally {
      close();
    }
  });

  test("a failed drawer is retried next sync rather than marked done", async () => {
    const dir = await persona();
    const path = join(dir, "memory", "decisions.md");
    await mkdir(path);
    const { store, db, close } = await opened(dir);
    try {
      await syncDrawers({ store, db, personaDir: dir, persona: PERSONA });
      await rm(path, { recursive: true });
      await writeFile(path, "- [decision] Chose rows over prose.\n");
      const retry = await syncDrawers({ store, db, personaDir: dir, persona: PERSONA });
      expect(retry.ingested.find((r) => r.kind === "decisions")?.inserted).toBe(1);
    } finally {
      close();
    }
  });
});

describe("drawerSection", () => {
  test("prefers rows and folds multi-line entries to one bullet", async () => {
    const dir = await persona();
    await writeFile(join(dir, "memory", "norms.md"), "- from the file\n");
    const { store, close } = await opened(dir);
    try {
      store.file({
        persona: PERSONA,
        kind: "norms",
        content: "A norm\nwrapped over lines",
      });
      const section = await drawerSection(store, dir, PERSONA, "norms");
      expect(section?.from).toBe("rows");
      expect(section?.text).toBe("- A norm wrapped over lines");
      expect(section?.text).not.toContain("from the file");
    } finally {
      close();
    }
  });

  test("falls back to the markdown file when the drawer has no rows", async () => {
    const dir = await persona();
    await writeFile(join(dir, "memory", "norms.md"), "- only on disk\n");
    const { store, close } = await opened(dir);
    try {
      const section = await drawerSection(store, dir, PERSONA, "norms");
      expect(section?.from).toBe("file");
      expect(section?.text).toBe("- only on disk");
    } finally {
      close();
    }
  });

  test("the fallback is per drawer, not per briefing", async () => {
    const dir = await persona();
    await writeFile(join(dir, "memory", "norms.md"), "- only on disk\n");
    const { store, close } = await opened(dir);
    try {
      store.file({ persona: PERSONA, kind: "decisions", content: "filed as a row" });
      expect((await drawerSection(store, dir, PERSONA, "decisions"))?.from).toBe("rows");
      expect((await drawerSection(store, dir, PERSONA, "norms"))?.from).toBe("file");
    } finally {
      close();
    }
  });

  test("a row query that throws still falls back to the file", async () => {
    const dir = await persona();
    await writeFile(join(dir, "memory", "norms.md"), "- only on disk\n");
    const { store, close } = await opened(dir);
    try {
      const broken = Object.assign(Object.create(Object.getPrototypeOf(store)), store, {
        ranked: () => {
          throw new Error("malformed database disk image");
        },
      }) as typeof store;
      const section = await drawerSection(broken, dir, PERSONA, "norms");
      expect(section?.from).toBe("file");
      expect(section?.text).toBe("- only on disk");
    } finally {
      close();
    }
  });

  test("nothing on disk and nothing in rows yields nothing", async () => {
    const dir = await persona();
    const { store, close } = await opened(dir);
    try {
      expect(await drawerSection(store, dir, PERSONA, "norms")).toBeUndefined();
      expect(renderDrawer(store, PERSONA, "norms")).toBeUndefined();
    } finally {
      close();
    }
  });

  test("superseded entries never reach the briefing", async () => {
    const dir = await persona();
    const { store, close } = await opened(dir);
    try {
      const old = store.file({ persona: PERSONA, kind: "norms", content: "old rule" });
      store.file({
        persona: PERSONA,
        kind: "norms",
        content: "new rule",
        supersedes: old.id,
      });
      const section = await drawerSection(store, dir, PERSONA, "norms");
      expect(section?.text).toContain("new rule");
      expect(section?.text).not.toContain("old rule");
    } finally {
      close();
    }
  });
});

describe("heartbeat drawer projection", () => {
  test("a line promoted this run is a row by the end of the same run", async () => {
    const dir = await persona();
    await writeFile(
      join(dir, "memory", "2026-06-04.md"),
      "# 2026-06-04\n- [norm] Nightly restarts are routine.\n",
    );
    // A legacy markdown drawer, mid-migration: its content must survive into
    // rows before the same run retires it.
    await writeFile(
      join(dir, "memory", "norms.md"),
      "# Norms\n\n## 2026-06-01\n\n- [norm] Friday deploys are routine.\n",
    );
    const dbPath = join(dir, "memory.sqlite");

    const r = await runHeartbeat({
      personaDir: dir,
      today: "2026-06-04",
      memoryDbPath: dbPath,
      persona: PERSONA,
    });
    expect(r.promoted).toHaveLength(1);
    expect(r.drawerSync?.ingested.find((x) => x.kind === "norms")?.inserted).toBe(1);

    const { store, close } = await openDrawerStore(dbPath);
    try {
      const contents = store.list(PERSONA, "norms").map((e) => e.content);
      expect(contents.some((c) => c.includes("Nightly restarts are routine"))).toBe(true);
      // The legacy file's entry is in the table too...
      expect(contents.some((c) => c.includes("Friday deploys are routine"))).toBe(true);
    } finally {
      close();
    }
    // ...which is what let the same heartbeat retire the file (#417).
    expect(
      r.drawerRetirement?.find((x) => x.kind === "norms")?.status,
    ).toBe("retired");
    expect(existsSync(join(dir, "memory", "norms.md"))).toBe(false);
  });

  test("a drawer whose entries are not all filed keeps its file", async () => {
    // The retirement gate, exercised through the heartbeat: rows are written
    // by the sync, so the only way to be short is for the ingest to have
    // missed something. Simulated by pointing the sync at an unreadable file
    // — the ingest fails, and the retirement must NOT take that as licence.
    const dir = await persona();
    await mkdir(join(dir, "memory", "decisions.md"), { recursive: true });
    const r = await runHeartbeat({
      personaDir: dir,
      today: "2026-06-04",
      memoryDbPath: join(dir, "memory.sqlite"),
      persona: PERSONA,
    });
    expect(r.drawerRetirement?.find((x) => x.kind === "decisions")?.status).toBe(
      "held",
    );
    expect(existsSync(join(dir, "memory", "decisions.md"))).toBe(true);
  });

  test("a drawer held on two consecutive heartbeats is only news once", async () => {
    // The whole point of the hold state: retirement fires 48 times a day and
    // the condition it reports is, by construction, a persistent one.
    const dir = await persona();
    await mkdir(join(dir, "memory", "decisions.md"), { recursive: true });
    const args = {
      personaDir: dir,
      today: "2026-06-04",
      memoryDbPath: join(dir, "memory.sqlite"),
      persona: PERSONA,
    };
    const first = await runHeartbeat(args);
    const second = await runHeartbeat(args);
    const held = (r: Awaited<ReturnType<typeof runHeartbeat>>) =>
      r.drawerRetirement?.find((x) => x.kind === "decisions");
    expect(held(first)?.firstHold).toBe(true);
    expect(held(second)?.status).toBe("held");
    expect(held(second)?.firstHold).toBe(false);
  });

  test("without a db path nothing is promoted and no markdown is written", async () => {
    // Deliberately not the old behaviour: with no store there is no write
    // path at all. The daily file keeps the lines for the next heartbeat.
    const dir = await persona();
    await writeFile(join(dir, "memory", "2026-06-04.md"), "- [norm] No database here.\n");
    const r = await runHeartbeat({ personaDir: dir, today: "2026-06-04" });
    expect(r.promoted).toEqual([]);
    expect(r.drawerSync).toBeUndefined();
    expect(existsSync(join(dir, "memory", "norms.md"))).toBe(false);
  });
});

describe("packBriefing", () => {
  const section = (kind: "decisions" | "people" | "norms", n: number, word: string) => ({
    kind,
    from: "rows" as const,
    text: Array.from({ length: n }, (_, i) => `- ${word} ${i}`).join("\n"),
  });

  test("passes everything through when it fits", () => {
    const out = packBriefing([section("norms", 2, "n")], 16 * 1024)!;
    expect(out).toContain("## memory/norms.md");
    expect(out).not.toContain("trimmed at cap");
  });

  test("an oversized early drawer cannot starve norms", () => {
    // The pre-#410 failure: decisions.md consumed the whole cap and the judge
    // was briefed with no norms at all, which is what makes it cry wolf.
    const out = packBriefing(
      [section("decisions", 4000, "decision"), section("norms", 3, "norm")],
      2048,
    )!;
    expect(out).toContain("## memory/norms.md");
    expect(out).toContain("- norm 0");
    expect(out).toContain("- norm 2");
    expect(Buffer.byteLength(out, "utf8")).toBeLessThanOrEqual(2048);
  });

  test("trims on entry boundaries, never mid-entry", () => {
    const out = packBriefing([section("decisions", 4000, "decision")], 1024)!;
    expect(out).toContain("[drawer trimmed at cap]");
    for (const line of out.split("\n")) {
      if (!line.startsWith("- ")) continue;
      // Every surviving bullet is a WHOLE bullet: `- decision <n>`.
      expect(line).toMatch(/^- decision \d+$/);
    }
  });

  test("a small drawer hands its unused share back", () => {
    const big = section("decisions", 4000, "decision");
    const small = section("norms", 1, "norm");
    const withSmall = packBriefing([big, small], 2048)!;
    const alone = packBriefing([big], 2048)!;
    // decisions gets its own share PLUS what norms did not need, so it is
    // longer than an even 50/50 split would have allowed.
    const decisionsPart = withSmall.split("## memory/norms.md")[0]!;
    expect(Buffer.byteLength(decisionsPart, "utf8")).toBeGreaterThan(1024);
    expect(Buffer.byteLength(alone, "utf8")).toBeLessThanOrEqual(2048);
  });

  test("empty in, undefined out", () => {
    expect(packBriefing([], 2048)).toBeUndefined();
  });
});

describe("briefing drawer paths", () => {
  test("are POSIX-separated on every platform", () => {
    // Compared for equality against the persona scaffold's paths, which are
    // written with forward slashes; a Windows join() here breaks that quietly.
    expect(BRIEFING_DRAWERS).toEqual([
      "memory/decisions.md",
      "memory/people.md",
      "memory/norms.md",
    ]);
  });
});
