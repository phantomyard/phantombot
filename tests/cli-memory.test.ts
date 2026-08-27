/**
 * Tests for the `phantombot memory` subcommand handlers (run* fns).
 * The Citty wrappers themselves are trivial and not unit-tested.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  runMemoryCapture,
  runMemoryJournal,
  runMemoryGet,
  runMemoryIndex,
  runMemoryList,
  runMemorySearch,
  runMemoryToday,
} from "../src/cli/memory.ts";
import type { Config } from "../src/config.ts";
import { makeEmbeddingSpace } from "../src/lib/embeddingSpace.ts";
import { sha256 } from "../src/lib/embedJob.ts";
import { MemoryIndex } from "../src/lib/memoryIndex.ts";
import { openJournalStore } from "../src/memory/journalIngest.ts";

class CaptureStream {
  chunks: string[] = [];
  write(s: string | Uint8Array): boolean {
    this.chunks.push(typeof s === "string" ? s : new TextDecoder().decode(s));
    return true;
  }
  get text(): string {
    return this.chunks.join("");
  }
}

let workdir: string;
let config: Config;
let indexPath: string;

let savedXdgDataHome: string | undefined;

beforeEach(async () => {
  workdir = await mkdtemp(join(tmpdir(), "phantombot-mem-"));
  // Journal writes index the open day (#461) into the index under
  // XDG_DATA_HOME; keep that inside the temp tree.
  savedXdgDataHome = process.env.XDG_DATA_HOME;
  process.env.XDG_DATA_HOME = join(workdir, "xdg-data");
  await mkdir(join(workdir, "personas", "phantom", "memory"), {
    recursive: true,
  });
  await mkdir(join(workdir, "personas", "phantom", "kb", "concepts"), {
    recursive: true,
  });
  indexPath = join(workdir, "index.sqlite");
  config = {
    defaultPersona: "phantom",
    harnessIdleTimeoutMs: 600_000, harnessHardTimeoutMs: 600_000, harnessStartupTimeoutMs: 600_000,
    personasDir: join(workdir, "personas"),
    memoryDbPath: join(workdir, "memory.sqlite"),
    configPath: join(workdir, "config.toml"),
    harnesses: {
      chain: ["claude"],
      claude: { bin: "claude", model: "opus", fallbackModel: "sonnet" },
      pi: { bin: "pi", maxPayloadBytes: 1_500_000 },
    },
    channels: {},
    embeddings: { provider: "none" },
    voice: { provider: "none" },
  };
});

afterEach(async () => {
  if (savedXdgDataHome === undefined) delete process.env.XDG_DATA_HOME;
  else process.env.XDG_DATA_HOME = savedXdgDataHome;
  await rm(workdir, { recursive: true, force: true });
});

async function note(rel: string, content: string) {
  await writeFile(join(workdir, "personas", "phantom", rel), content);
}

function geminiConfig(): Config {
  return {
    ...config,
    embeddings: {
      provider: "gemini",
      gemini: { apiKey: "test", model: "embed", dims: 2 },
    },
  };
}

describe("runMemorySearch", () => {
  test("returns JSON results for a matching query", async () => {
    await note("kb/concepts/Foo.md", "deye inverter facts");
    const out = new CaptureStream();
    const code = await runMemorySearch({
      query: "deye",
      config,
      indexPath,
      out,
      err: new CaptureStream(),
    });
    expect(code).toBe(0);
    const parsed = JSON.parse(out.text);
    expect(parsed.persona).toBe("phantom");
    expect(parsed.query).toBe("deye");
    expect(parsed.results.length).toBe(1);
    expect(parsed.results[0].path).toBe("kb/concepts/Foo.md");
  });

  test("returns persona-not-found error and exit 2", async () => {
    const out = new CaptureStream();
    const err = new CaptureStream();
    const code = await runMemorySearch({
      query: "anything",
      persona: "nope",
      config,
      indexPath,
      out,
      err,
    });
    expect(code).toBe(2);
    expect(err.text).toContain("not found");
  });

  test("respects --scope memory|kb", async () => {
    await note("memory/decisions.md", "telegram bot");
    await note("kb/concepts/Telegram.md", "telegram api");
    const out = new CaptureStream();
    await runMemorySearch({
      query: "telegram",
      scope: "memory",
      config,
      indexPath,
      out,
      err: new CaptureStream(),
    });
    const parsed = JSON.parse(out.text);
    expect(parsed.results).toHaveLength(1);
    expect(parsed.results[0].scope).toBe("memory");
  });

  test("uses the OpenAI-compatible query embedder for hybrid search", async () => {
    await note("kb/concepts/Foo.md", "deye inverter facts");
    const ix = await MemoryIndex.open(indexPath);
    await ix.refreshStale(join(workdir, "personas", "phantom"));
    ix.upsertEmbedding(
      "kb/concepts/Foo.md",
      0,
      new Float32Array([1, 0]),
      "sha",
      makeEmbeddingSpace({
        provider: "openai-compatible",
        model: "embed",
        dimensions: 2,
        documentPrefix: "passage: ",
      }),
    );
    ix.close();
    const out = new CaptureStream();
    const code = await runMemorySearch({
      query: "different wording",
      config: {
        ...config,
        embeddings: {
          provider: "openai-compatible",
          openaiCompatible: {
            baseUrl: "http://localhost:8082/v1",
            model: "embed",
            apiKey: "",
            dims: 2,
            queryPrefix: "query: ",
            documentPrefix: "passage: ",
          },
        },
      },
      indexPath,
      out,
      err: new CaptureStream(),
      fetchImpl: (async (_url, init) => {
        expect(JSON.parse(String(init?.body)).input).toBe("query: different wording");
        return new Response(JSON.stringify({ data: [{ embedding: [1, 0] }] }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }) as typeof fetch,
    });
    expect(code).toBe(0);
    expect(JSON.parse(out.text).results[0].path).toBe("kb/concepts/Foo.md");
  });
});

describe("runMemoryGet", () => {
  test("cats a persona-relative file", async () => {
    await note("kb/concepts/A.md", "# A\n\nbody");
    const out = new CaptureStream();
    const code = await runMemoryGet({
      path: "kb/concepts/A.md",
      config,
      out,
      err: new CaptureStream(),
    });
    expect(code).toBe(0);
    expect(out.text).toBe("# A\n\nbody");
  });

  test("refuses absolute paths and traversals", async () => {
    const out = new CaptureStream();
    const err = new CaptureStream();
    const code = await runMemoryGet({
      path: "/etc/passwd",
      config,
      out,
      err,
    });
    expect(code).toBe(2);
    expect(err.text).toContain("refusing path outside persona dir");

    const err2 = new CaptureStream();
    const code2 = await runMemoryGet({
      path: "../../../etc/passwd",
      config,
      out: new CaptureStream(),
      err: err2,
    });
    expect(code2).toBe(2);
    expect(err2.text).toContain("refusing path outside");
  });

  test("returns 1 when the file doesn't exist", async () => {
    const err = new CaptureStream();
    const code = await runMemoryGet({
      path: "kb/concepts/MissingNote.md",
      config,
      out: new CaptureStream(),
      err,
    });
    expect(code).toBe(1);
    expect(err.text).toContain("not found");
  });
});

describe("runMemoryList", () => {
  test("lists files in a persona-relative dir, marks dirs vs files", async () => {
    await note("kb/concepts/A.md", "");
    await mkdir(
      join(workdir, "personas", "phantom", "kb", "concepts", "subdir"),
    );
    const out = new CaptureStream();
    const code = await runMemoryList({
      path: "kb/concepts",
      config,
      out,
      err: new CaptureStream(),
    });
    expect(code).toBe(0);
    expect(out.text).toContain("f  A.md");
    expect(out.text).toContain("d  subdir");
  });
});

describe("runMemoryToday", () => {
  test("creates memory/ and prints YYYY-MM-DD.md path", async () => {
    const out = new CaptureStream();
    const code = await runMemoryToday({
      config,
      date: "2026-05-02",
      out,
      err: new CaptureStream(),
    });
    expect(code).toBe(0);
    expect(out.text.trim()).toBe(
      join(workdir, "personas", "phantom", "memory", "2026-05-02.md"),
    );
    expect(existsSync(join(workdir, "personas", "phantom", "memory"))).toBe(
      true,
    );
  });
});

describe("runMemoryIndex", () => {
  test("--rebuild reports the count of files re-indexed", async () => {
    await note("kb/concepts/A.md", "alpha");
    await note("kb/concepts/B.md", "beta");
    const out = new CaptureStream();
    const code = await runMemoryIndex({
      config,
      indexPath,
      rebuild: true,
      out,
      err: new CaptureStream(),
    });
    expect(code).toBe(0);
    expect(out.text).toContain("rebuilt FTS index for 'phantom': 2 file(s)");
  });

  test("incremental refresh reports 0 on a fresh index that's been refreshed once", async () => {
    await note("kb/concepts/A.md", "alpha");
    await runMemoryIndex({
      config,
      indexPath,
      out: new CaptureStream(),
      err: new CaptureStream(),
    });
    const out = new CaptureStream();
    await runMemoryIndex({
      config,
      indexPath,
      out,
      err: new CaptureStream(),
    });
    expect(out.text).toContain("0 file(s)");
  });

  test("--reembed rebuilds vectors while preserving FTS and all indexed turns", async () => {
    await note("kb/concepts/A.md", "alpha source note");
    const seeded = await MemoryIndex.open(indexPath);
    await seeded.refreshStale(join(workdir, "personas", "phantom"));
    seeded.upsertTurn({
      id: 1,
      persona: "phantom",
      conversation: "cli:default",
      role: "user",
      text: "historical semantic turn",
      createdAt: new Date("2026-01-01T00:00:00Z"),
      embeddable: true,
      source: "principal",
      origin: "channel",
    });
    seeded.upsertEmbedding("kb/concepts/A.md", 0, new Float32Array([9]), "old");
    seeded.close();

    const code = await runMemoryIndex({
      config: {
        ...config,
        embeddings: {
          provider: "gemini",
          gemini: { apiKey: "test", model: "embed", dims: 2 },
        },
      },
      indexPath,
      reembed: true,
      out: new CaptureStream(),
      err: new CaptureStream(),
      embedder: async () => ({
        ok: true as const,
        values: new Float32Array([1, 2]),
        dims: 2,
      }),
    });
    expect(code).toBe(0);
    const check = await MemoryIndex.open(indexPath);
    try {
      expect(check.embeddingCount()).toBe(2);
      expect(check.search("alpha")).toHaveLength(1);
      expect(check.allTurnDocuments()).toHaveLength(1);
      expect(existsSync(join(workdir, "personas", "phantom", "kb/concepts/A.md"))).toBe(true);
    } finally {
      check.close();
    }
  });

  test("reembed preflight failure preserves old FTS state and vectors", async () => {
    await note("kb/concepts/A.md", "old content");
    const seeded = await MemoryIndex.open(indexPath);
    await seeded.refreshStale(join(workdir, "personas", "phantom"));
    const space = makeEmbeddingSpace({ provider: "gemini", model: "embed", dimensions: 2 });
    seeded.upsertEmbedding("kb/concepts/A.md", 0, new Float32Array([3, 4]), "old-sha", space);
    seeded.close();
    await note("kb/concepts/A.md", "edited content");

    const code = await runMemoryIndex({
      config: geminiConfig(),
      indexPath,
      reembed: true,
      out: new CaptureStream(),
      err: new CaptureStream(),
      embedder: async () => ({ ok: false as const, error: "endpoint down" }),
    });
    expect(code).toBe(1);
    const check = await MemoryIndex.open(indexPath);
    try {
      const row = check.allEmbeddings()[0]!;
      expect(Array.from(row.vec)).toEqual([3, 4]);
      expect(row.textSha).toBe("old-sha");
      expect(row.spaceFingerprint).toBe(space.fingerprint);
      expect(check.search("old content")).toHaveLength(1);
      expect(check.search("edited content")).toHaveLength(0);
    } finally {
      check.close();
    }
  });

  test("mid-note failure is nonzero and leaves the failed note out of the current space", async () => {
    await note("kb/concepts/A.md", "alpha");
    await note("kb/concepts/B.md", "beta");
    let calls = 0;
    const code = await runMemoryIndex({
      config: geminiConfig(),
      indexPath,
      reembed: true,
      out: new CaptureStream(),
      err: new CaptureStream(),
      embedder: async () => {
        calls++;
        return calls <= 2
          ? { ok: true as const, values: new Float32Array([1, 0]), dims: 2 }
          : { ok: false as const, error: "mid-note outage" };
      },
    });
    expect(code).toBe(1);
    const check = await MemoryIndex.open(indexPath);
    try {
      expect(
        check.allEmbeddings(
          makeEmbeddingSpace({ provider: "gemini", model: "embed", dimensions: 2 }),
        ),
      ).toHaveLength(1);
    } finally {
      check.close();
    }
  });

  test("mid-turn failure is nonzero and foreign turn residue remains ineligible", async () => {
    await note("kb/concepts/A.md", "alpha");
    const seeded = await MemoryIndex.open(indexPath);
    await seeded.refreshStale(join(workdir, "personas", "phantom"));
    seeded.upsertTurn({
      id: 1,
      persona: "phantom",
      conversation: "cli:default",
      role: "user",
      text: "historical turn",
      createdAt: new Date("2026-01-01T00:00:00Z"),
      embeddable: true,
      source: "principal",
      origin: "channel",
    }, new Float32Array([9, 9]), "foreign", makeEmbeddingSpace({ provider: "gemini", model: "old", dimensions: 2 }));
    seeded.close();
    let calls = 0;
    const code = await runMemoryIndex({
      config: geminiConfig(),
      indexPath,
      reembed: true,
      out: new CaptureStream(),
      err: new CaptureStream(),
      embedder: async () => {
        calls++;
        return calls <= 2
          ? { ok: true as const, values: new Float32Array([1, 0]), dims: 2 }
          : { ok: false as const, error: "mid-turn outage" };
      },
    });
    expect(code).toBe(1);
    const check = await MemoryIndex.open(indexPath);
    try {
      const current = makeEmbeddingSpace({ provider: "gemini", model: "embed", dimensions: 2 });
      expect(check.allEmbeddings(current)).toHaveLength(1);
      expect(check.allEmbeddings()).toHaveLength(2);
    } finally {
      check.close();
    }
  });

  test("successful reembed removes foreign-space residue and picks up new and edited notes", async () => {
    await note("kb/concepts/A.md", "old alpha");
    const seeded = await MemoryIndex.open(indexPath);
    await seeded.refreshStale(join(workdir, "personas", "phantom"));
    seeded.upsertEmbedding(
      "kb/concepts/A.md",
      0,
      new Float32Array([8, 8]),
      "foreign",
      makeEmbeddingSpace({ provider: "gemini", model: "old", dimensions: 2 }),
    );
    seeded.close();
    await note("kb/concepts/A.md", "new alpha");
    await note("kb/concepts/B.md", "new beta");
    const code = await runMemoryIndex({
      config: geminiConfig(),
      indexPath,
      reembed: true,
      out: new CaptureStream(),
      err: new CaptureStream(),
      embedder: async (text) => ({
        ok: true as const,
        values: new Float32Array([text.length, 1]),
        dims: 2,
      }),
    });
    expect(code).toBe(0);
    const check = await MemoryIndex.open(indexPath);
    try {
      const current = makeEmbeddingSpace({ provider: "gemini", model: "embed", dimensions: 2 });
      expect(check.allEmbeddings(current)).toHaveLength(2);
      expect(check.allEmbeddings()).toHaveLength(2);
      expect(check.embeddingSha("kb/concepts/A.md", 0, current)).toBe(sha256("new alpha"));
      expect(check.search("new beta")).toHaveLength(1);
    } finally {
      check.close();
    }
  });

  test("explicit reembed with no provider returns nonzero", async () => {
    const err = new CaptureStream();
    const code = await runMemoryIndex({
      config,
      indexPath,
      reembed: true,
      out: new CaptureStream(),
      err,
    });
    expect(code).toBe(1);
    expect(err.text).toContain("configure an embedding provider");
  });
});

describe("integration — search picks up files written between calls", () => {
  test("incremental search after adding a note returns the new note", async () => {
    await note("kb/concepts/A.md", "alpha");
    const out1 = new CaptureStream();
    await runMemorySearch({
      query: "alpha",
      config,
      indexPath,
      out: out1,
      err: new CaptureStream(),
    });
    expect(JSON.parse(out1.text).results).toHaveLength(1);

    // Wait a millisecond so the new file's mtime > A.md's
    await new Promise((r) => setTimeout(r, 5));
    await note("kb/concepts/B.md", "alpha and beta");
    const out2 = new CaptureStream();
    await runMemorySearch({
      query: "alpha",
      config,
      indexPath,
      out: out2,
      err: new CaptureStream(),
    });
    expect(JSON.parse(out2.text).results).toHaveLength(2);
  });
});

describe("runMemoryCapture — index-on-write", () => {
  // We probe the index DIRECTLY (no refreshStale) to isolate index-on-write
  // from runMemorySearch's own refresh, which would otherwise index the file
  // regardless and mask whether capture did it.
  async function rawHits(query: string): Promise<number> {
    const ix = await MemoryIndex.open(indexPath);
    try {
      return ix.search(query, { scope: "memory" }).length;
    } finally {
      ix.close();
    }
  }

  test("default capture indexes the new note in-line (recall-able without a refresh)", async () => {
    const code = await runMemoryCapture({
      config,
      text: "approve invoice PDFs from billing@knownvendor.com",
      tags: ["decision"],
      date: "2026-06-04",
      indexPath,
      out: new CaptureStream(),
      err: new CaptureStream(),
    });
    expect(code).toBe(0);
    expect(await rawHits("knownvendor")).toBeGreaterThanOrEqual(1);
  });

  test("skipIndex defers indexing (raw index has no hit until something refreshes)", async () => {
    await runMemoryCapture({
      config,
      text: "deferred capture about quetzalcoatlus",
      tags: ["lesson"],
      date: "2026-06-04",
      indexPath,
      skipIndex: true,
      out: new CaptureStream(),
      err: new CaptureStream(),
    });
    expect(await rawHits("quetzalcoatlus")).toBe(0);
  });
});

describe("runMemoryCapture — one row per capture (#461)", () => {
  test("a two-tag capture writes ONE journal row and NO markdown", async () => {
    const code = await runMemoryCapture({
      config,
      text: "opened #461 to retire the markdown journal",
      tags: ["decision", "lesson"],
      date: "2026-06-05",
      skipIndex: true,
      out: new CaptureStream(),
      err: new CaptureStream(),
    });
    expect(code).toBe(0);

    const { store, close } = await openJournalStore(config.memoryDbPath);
    try {
      const rows = store.listDay(config.defaultPersona, "2026-06-05");
      expect(rows).toHaveLength(1);
      expect(rows[0]!.tags).toEqual(["decision", "lesson"]);
    } finally {
      close();
    }

    // No markdown at all for an open day. The file is a DERIVED artefact the
    // nightly writes once the day is closed, which is what makes the rows the
    // single writer — a second one appending markdown here is exactly how the
    // duplication got in.
    expect(
      existsSync(join(workdir, "personas", "phantom", "memory", "2026-06-05.md")),
    ).toBe(false);
  });

  test("capturing the same text twice does not write a second row", async () => {
    for (let i = 0; i < 2; i++) {
      await runMemoryCapture({
        config,
        text: "the same lesson, learned twice",
        tags: ["lesson"],
        date: "2026-06-06",
        skipIndex: true,
        out: new CaptureStream(),
        err: new CaptureStream(),
      });
    }
    const { store, close } = await openJournalStore(config.memoryDbPath);
    try {
      expect(store.countDay(config.defaultPersona, "2026-06-06")).toBe(1);
    } finally {
      close();
    }
  });

  test("memory journal --export writes every day back out as markdown", async () => {
    await runMemoryCapture({
      config,
      text: "exportable entry",
      tags: ["norm"],
      date: "2026-06-07",
      skipIndex: true,
      out: new CaptureStream(),
      err: new CaptureStream(),
    });
    const dest = join(workdir, "export");
    const out = new CaptureStream();
    const code = await runMemoryJournal({
      config,
      export: dest,
      out,
      err: new CaptureStream(),
    });
    expect(code).toBe(0);
    // Retiring the file must not mean losing the readable artefact — same
    // promise `memory drawers --export` makes.
    expect(await readFile(join(dest, "2026-06-07.md"), "utf8")).toContain(
      "exportable entry",
    );
  });
});
