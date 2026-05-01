/**
 * Tests for the FTS5 memory index.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  MemoryIndex,
  sanitizeFtsQuery,
  walkMarkdown,
} from "../src/lib/memoryIndex.ts";

let workdir: string;
let personaDir: string;
let ix: MemoryIndex;

beforeEach(async () => {
  workdir = await mkdtemp(join(tmpdir(), "phantombot-mi-"));
  personaDir = join(workdir, "persona");
  await mkdir(join(personaDir, "memory"), { recursive: true });
  await mkdir(join(personaDir, "kb", "concepts"), { recursive: true });
  await mkdir(join(personaDir, "kb", "infra"), { recursive: true });
  ix = await MemoryIndex.open(":memory:");
});

afterEach(async () => {
  ix.close();
  await rm(workdir, { recursive: true, force: true });
});

async function note(rel: string, content: string) {
  await writeFile(join(personaDir, rel), content);
}

describe("sanitizeFtsQuery", () => {
  test("strips special chars and quotes each token", () => {
    expect(sanitizeFtsQuery('hello world')).toBe('"hello" "world"');
    expect(sanitizeFtsQuery('"quoted (paren)"')).toBe('"quoted" "paren"');
    expect(sanitizeFtsQuery('a OR b')).toBe('"a" "OR" "b"');
  });

  test("returns empty-string sentinel on whitespace-only input", () => {
    expect(sanitizeFtsQuery("   ")).toBe('""');
    expect(sanitizeFtsQuery("")).toBe('""');
  });

  test("preserves digits and hyphens (so 'gpt-5' searches as one token)", () => {
    expect(sanitizeFtsQuery("gpt-5 vs claude-4")).toBe(
      '"gpt-5" "vs" "claude-4"',
    );
  });
});

describe("walkMarkdown", () => {
  test("returns empty when memory/ and kb/ are empty", () => {
    expect(walkMarkdown(personaDir)).toEqual([]);
  });

  test("walks memory/ and kb/ for .md files; skips non-md and dotfiles", async () => {
    await note("memory/2026-05-01.md", "today");
    await note("memory/people.md", "people");
    await note("kb/concepts/Foo.md", "foo");
    await note("kb/infra/.hidden.md", "hidden"); // skipped
    await note("memory/notes.txt", "skipped");
    const files = walkMarkdown(personaDir);
    const paths = files.map((f) => f.path).sort();
    expect(paths).toEqual([
      "memory/2026-05-01.md",
      "memory/people.md",
      "kb/concepts/Foo.md",
    ].sort());
  });
});

describe("MemoryIndex.refreshStale", () => {
  test("indexes everything on first run; reports removed=0", async () => {
    await note("memory/decisions.md", "we chose deye for the inverter");
    await note("kb/concepts/Inverter.md", "deye sun-12k spec");
    const r = await ix.refreshStale(personaDir);
    expect(r.indexed).toBe(2);
    expect(r.removed).toBe(0);
  });

  test("re-indexes only modified files on subsequent runs", async () => {
    await note("memory/a.md", "alpha");
    await note("kb/concepts/B.md", "beta");
    await ix.refreshStale(personaDir);
    // Touch only a.md
    await new Promise((r) => setTimeout(r, 5));
    await note("memory/a.md", "alpha v2");
    const r = await ix.refreshStale(personaDir);
    expect(r.indexed).toBe(1);
    expect(r.removed).toBe(0);
  });

  test("removes index entries for files that disappeared", async () => {
    await note("memory/a.md", "alpha");
    await note("kb/concepts/B.md", "beta");
    await ix.refreshStale(personaDir);
    await rm(join(personaDir, "memory/a.md"));
    const r = await ix.refreshStale(personaDir);
    expect(r.indexed).toBe(0);
    expect(r.removed).toBe(1);
  });
});

describe("MemoryIndex.search", () => {
  test("returns BM25-ranked hits", async () => {
    await note("kb/concepts/Inverter.md", "deye sun-12k inverter modbus");
    await note("kb/concepts/Solar.md", "solar panels and the inverter");
    await note("kb/concepts/Cat.md", "I have a cat named Lena");
    await ix.refreshStale(personaDir);

    const hits = ix.search("deye inverter");
    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0]?.path).toBe("kb/concepts/Inverter.md");
    expect(hits[0]?.scope).toBe("kb");
    expect(hits[0]?.snippet).toContain("«");
    // ftsScore is normalized to higher=better.
    expect(hits[0]?.ftsScore).toBeGreaterThan(0);
  });

  test("scopes to memory or kb when requested", async () => {
    await note("memory/decisions.md", "we chose elevenlabs for tts");
    await note("kb/infra/Voice.md", "elevenlabs voice config");
    await ix.refreshStale(personaDir);

    const memOnly = ix.search("elevenlabs", { scope: "memory" });
    expect(memOnly.map((h) => h.path)).toEqual(["memory/decisions.md"]);
    const kbOnly = ix.search("elevenlabs", { scope: "kb" });
    expect(kbOnly.map((h) => h.path)).toEqual(["kb/infra/Voice.md"]);
  });

  test("respects limit", async () => {
    for (let i = 0; i < 10; i++) {
      await note(`kb/concepts/N${i}.md`, "deye inverter test");
    }
    await ix.refreshStale(personaDir);
    const hits = ix.search("deye", { limit: 3 });
    expect(hits).toHaveLength(3);
  });

  test("returns [] for whitespace-only query", async () => {
    await note("kb/concepts/A.md", "anything");
    await ix.refreshStale(personaDir);
    expect(ix.search("   ")).toEqual([]);
  });
});

describe("MemoryIndex.rebuild", () => {
  test("drops and re-walks; survives a previous run", async () => {
    await note("kb/concepts/A.md", "first");
    await ix.refreshStale(personaDir);
    await note("kb/concepts/B.md", "second");
    const r = await ix.rebuild(personaDir);
    expect(r.indexed).toBe(2);
  });
});
