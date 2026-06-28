/**
 * Tests for the FTS5 memory index.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  MemoryIndex,
  NOTES_SCHEMA_VERSION,
  resolveMdLink,
  sanitizeFtsQuery,
  turnPath,
  walkMarkdown,
} from "../src/lib/memoryIndex.ts";
import { Database } from "bun:sqlite";
import type { Turn } from "../src/memory/store.ts";

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

describe("MemoryIndex.open", () => {
  test("applies busy_timeout before schema setup (file-backed)", async () => {
    const dir = await mkdtemp(join(tmpdir(), "phantombot-mi-open-"));
    const index = await MemoryIndex.open(join(dir, "index.sqlite"));
    try {
      // busy_timeout is connection-scoped (not persisted to the file), so we
      // read it back off the index's own db handle. If it were still set after
      // db.exec(SCHEMA), the first schema statements would be unprotected.
      const db = (index as unknown as { db: { query: (sql: string) => { get: () => Record<string, number> } } }).db;
      const row = db.query("PRAGMA busy_timeout").get();
      expect(Object.values(row)[0]).toBe(5000);
    } finally {
      index.close();
      await rm(dir, { recursive: true, force: true });
    }
  });
});

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

  test("searches indexed conversation turns alongside memory files", async () => {
    const turn: Turn = {
      id: 42,
      persona: "phantom",
      conversation: "telegram:1001",
      role: "user",
      text: "The Vesuvius pension tracing email came from Isio.",
      createdAt: new Date("2026-05-28T06:00:00Z"),
      embeddable: true,
    };
    ix.upsertTurn(turn);

    const hits = ix.search("Vesuvius pension", { scope: "all" });
    expect(hits[0]?.scope).toBe("turns");
    expect(hits[0]?.path).toBe(turnPath(turn));
    expect(hits[0]?.snippet).toContain("Vesuvius");
  });

  test("scope=turns returns only indexed conversation turns", async () => {
    await note("memory/decisions.md", "Vesuvius memory note");
    await ix.refreshStale(personaDir);
    ix.upsertTurn({
      id: 7,
      persona: "phantom",
      conversation: "telegram:1001",
      role: "assistant",
      text: "Vesuvius turn note",
      createdAt: new Date("2026-05-28T06:00:00Z"),
      embeddable: true,
    });

    const hits = ix.search("Vesuvius", { scope: "turns" });
    expect(hits).toHaveLength(1);
    expect(hits[0]?.scope).toBe("turns");
    expect(hits[0]?.path).toContain("/7");
  });

  test("deleteConversationTurns removes turn docs, embeddings, and state", () => {
    const turn: Turn = {
      id: 9,
      persona: "phantom",
      conversation: "telegram:1001",
      role: "user",
      text: "reset-sensitive turn",
      createdAt: new Date("2026-05-28T06:00:00Z"),
      embeddable: true,
    };
    const vec = new Float32Array([1, 0, 0]);
    ix.upsertTurn(turn, vec, "sha");
    ix.updateTurnIndexState("phantom", "telegram:1001", 9, 20);

    ix.deleteConversationTurns("phantom", "telegram:1001");

    expect(ix.search("reset-sensitive", { scope: "turns" })).toEqual([]);
    expect(ix.embeddingCount()).toBe(0);
    expect(ix.turnIndexState("phantom", "telegram:1001")).toBeUndefined();
  });

  test("conversation filter scopes turns but keeps memory/kb global (FTS)", async () => {
    await note("memory/decisions.md", "Vesuvius pension is a shared memory note");
    await ix.refreshStale(personaDir);
    // Same topic indexed under two different conversations.
    ix.upsertTurn({
      id: 1,
      persona: "phantom",
      conversation: "telegram:AAA",
      role: "user",
      text: "Vesuvius pension discussed in conversation AAA",
      createdAt: new Date("2026-05-28T06:00:00Z"),
      embeddable: true,
    });
    ix.upsertTurn({
      id: 2,
      persona: "phantom",
      conversation: "telegram:BBB",
      role: "user",
      text: "Vesuvius pension discussed in conversation BBB",
      createdAt: new Date("2026-05-28T06:01:00Z"),
      embeddable: true,
    });

    const paths = ix
      .search("Vesuvius pension", { scope: "all", conversation: "telegram:AAA" })
      .map((h) => h.path);
    // Shared note stays global to the persona...
    expect(paths).toContain("memory/decisions.md");
    // ...but only the CURRENT conversation's turn surfaces, never the other.
    expect(paths.some((p) => p.includes("AAA"))).toBe(true);
    expect(paths.some((p) => p.includes("BBB"))).toBe(false);
  });

  test("hybridSearch vector path never leaks another conversation's turns", () => {
    const vec = new Float32Array([1, 0, 0]);
    // One turn embedding per conversation, identical vectors so cosine is tied.
    ix.upsertTurn(
      {
        id: 1,
        persona: "phantom",
        conversation: "telegram:AAA",
        role: "user",
        text: "pension turn in AAA",
        createdAt: new Date("2026-05-28T06:00:00Z"),
        embeddable: true,
      },
      vec,
      "sha-aaa",
    );
    ix.upsertTurn(
      {
        id: 2,
        persona: "phantom",
        conversation: "telegram:BBB",
        role: "user",
        text: "pension turn in BBB",
        createdAt: new Date("2026-05-28T06:01:00Z"),
        embeddable: true,
      },
      vec,
      "sha-bbb",
    );

    const paths = ix
      .hybridSearch("pension", vec, {
        scope: "all",
        conversation: "telegram:AAA",
        limit: 10,
      })
      .map((h) => h.path);
    // The current conversation's turn is reachable; the other never is —
    // even though its embedding is an equally-good vector match.
    expect(paths.some((p) => p.includes("AAA"))).toBe(true);
    expect(paths.some((p) => p.includes("BBB"))).toBe(false);
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

describe("resolveMdLink", () => {
  test("resolves relative targets against the linking note", () => {
    expect(resolveMdLink("kb/infra/dns.md", "../ops/ns.md")).toBe(
      "kb/ops/ns.md",
    );
    expect(resolveMdLink("kb/infra/dns.md", "vault")).toBe("kb/infra/vault.md");
    expect(resolveMdLink("kb/a.md", "./b.md")).toBe("kb/b.md");
  });

  test("rejects external URLs and tree escapes", () => {
    expect(resolveMdLink("kb/a.md", "https://x.com")).toBeNull();
    expect(resolveMdLink("kb/a.md", "/etc/passwd")).toBeNull();
    expect(resolveMdLink("kb/a.md", "../../etc/passwd")).toBeNull();
  });
});

describe("BM25F field weighting", () => {
  test("a title/tag match outranks a body-only match", async () => {
    // Note A mentions "kubernetes" only deep in the body.
    await note(
      "kb/concepts/a.md",
      "---\ntitle: Grocery list\n---\n# Grocery list\n" +
        "milk eggs bread. an aside about kubernetes maybe.\n",
    );
    // Note B has it as the title + a tag — the authoritative concept.
    await note(
      "kb/concepts/b.md",
      "---\ntitle: Kubernetes\ntags: [kubernetes, infra]\n---\n" +
        "# Kubernetes\nour cluster notes.\n",
    );
    await ix.refreshStale(personaDir);

    const hits = ix.search("kubernetes", { scope: "kb", limit: 5 });
    expect(hits[0]?.path).toBe("kb/concepts/b.md");
  });

  test("a query that matches only an alias still finds the note", async () => {
    await note(
      "kb/concepts/creds.md",
      "---\ntitle: Secret Rotation\naliases: [credential cycling]\n---\n" +
        "# Secret Rotation\nrun the playbook.\n",
    );
    await ix.refreshStale(personaDir);

    const hits = ix.search("credential cycling", { scope: "kb" });
    expect(hits.map((h) => h.path)).toContain("kb/concepts/creds.md");
  });
});

describe("MemoryIndex.searchExpanded (OKF link-graph)", () => {
  test("pulls in a linked neighbour that did not match lexically", async () => {
    // Seed matches "postgres"; neighbour is about backups and links nowhere
    // near the query term, but is reachable via a markdown link.
    await note(
      "kb/infra/postgres.md",
      "---\ntitle: Postgres\n---\n# Postgres\n" +
        "Primary datastore. See [backups](backups.md).\n",
    );
    await note(
      "kb/infra/backups.md",
      "---\ntitle: Backups\n---\n# Backups\n" +
        "Nightly snapshots to cold storage.\n",
    );
    await ix.refreshStale(personaDir);

    const plain = ix.search("postgres", { scope: "kb" }).map((h) => h.path);
    expect(plain).toContain("kb/infra/postgres.md");
    expect(plain).not.toContain("kb/infra/backups.md");

    const expanded = ix.searchExpanded("postgres", { scope: "kb", maxAdd: 3 });
    const byPath = new Map(expanded.map((h) => [h.path, h]));
    expect(byPath.has("kb/infra/backups.md")).toBe(true);
    expect(byPath.get("kb/infra/backups.md")?.expanded).toBe(true);
    // The real lexical hit is never displaced and not flagged expanded.
    expect(byPath.get("kb/infra/postgres.md")?.expanded).toBeUndefined();
  });

  test("inbound links expand too (neighbour links TO the hit)", async () => {
    await note(
      "kb/infra/dns.md",
      "---\ntitle: DNS\n---\n# DNS\nname resolution notes.\n",
    );
    await note(
      "kb/infra/cutover.md",
      "---\ntitle: Cutover\n---\n# Cutover\nplan that references [dns](dns.md).\n",
    );
    await ix.refreshStale(personaDir);

    const expanded = ix
      .searchExpanded("resolution", { scope: "kb", maxAdd: 3 })
      .map((h) => h.path);
    expect(expanded).toContain("kb/infra/dns.md");
    expect(expanded).toContain("kb/infra/cutover.md");
  });

  test("maxAdd 0 disables expansion", async () => {
    await note("kb/infra/a.md", "# A\nalpha links to [b](b.md)\n");
    await note("kb/infra/b.md", "# B\nbravo\n");
    await ix.refreshStale(personaDir);
    const hits = ix.searchExpanded("alpha", { scope: "kb", maxAdd: 0 });
    expect(hits.every((h) => !h.expanded)).toBe(true);
  });
});

describe("notes-schema self-heal", () => {
  test("a legacy v1 single-column index is rebuilt on open", async () => {
    const dir = await mkdtemp(join(tmpdir(), "phantombot-mi-heal-"));
    const idxPath = join(dir, "index.sqlite");
    const pdir = join(dir, "persona");
    await mkdir(join(pdir, "kb"), { recursive: true });
    await writeFile(
      join(pdir, "kb", "x.md"),
      "---\ntitle: Widget\n---\n# Widget\nthe widget concept.\n",
    );

    // Hand-build a pre-OKF (v1) index: old single-column `notes`, a stale
    // `files` row, and no meta version.
    const raw = new Database(idxPath, { create: true });
    raw.exec("PRAGMA journal_mode = WAL");
    raw.exec(
      "CREATE VIRTUAL TABLE notes USING fts5(path UNINDEXED, scope UNINDEXED, content, tokenize = 'porter unicode61');",
    );
    raw.exec(
      "CREATE TABLE files (path TEXT PRIMARY KEY, scope TEXT, mtime_ms INTEGER, size INTEGER, indexed_at TEXT);",
    );
    raw
      .prepare(
        "INSERT INTO files (path, scope, mtime_ms, size, indexed_at) VALUES (?,?,?,?,?)",
      )
      .run("kb/x.md", "kb", 1, 1, new Date().toISOString());
    raw.close();

    // Opening through MemoryIndex must detect the stale schema, drop+rebuild,
    // and then index the note with the new fielded columns.
    const healed = await MemoryIndex.open(idxPath);
    try {
      await healed.refreshStale(pdir);
      const hits = healed.search("widget", { scope: "kb" });
      expect(hits.map((h) => h.path)).toContain("kb/x.md");
      const ver = (
        healed as unknown as {
          db: { query: (s: string) => { get: () => { value: string } | null } };
        }
      ).db
        .query("SELECT value FROM meta WHERE key = 'notes_schema_version'")
        .get();
      expect(Number(ver?.value)).toBe(NOTES_SCHEMA_VERSION);
    } finally {
      healed.close();
      await rm(dir, { recursive: true, force: true });
    }
  });
});
