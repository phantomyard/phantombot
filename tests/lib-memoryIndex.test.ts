/**
 * Tests for the FTS5 memory index.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  indexedNoteType,
  MemoryIndex,
  NOTES_SCHEMA_VERSION,
  parseTurnCreatedAtMs,
  resolveMdLink,
  sanitizeFtsQuery,
  TURN_SCHEMA_VERSION,
  turnDecayFactor,
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

  test("records nested paths posix-style, never with backslashes", async () => {
    await note("kb/concepts/Foo.md", "foo");
    const paths = walkMarkdown(personaDir).map((f) => f.path);
    // Portability invariant: the index keys files the same way on every OS,
    // so a persona's memory can move between Linux and Windows without the
    // first walk missing every row (which deletes and re-embeds, or wipes,
    // the index). On the Windows CI runner this catches relative() emitting
    // backslash separators.
    expect(paths).toContain("kb/concepts/Foo.md");
    for (const p of paths) expect(p).not.toContain("\\");
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
      source: "principal",
      origin: "channel",
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
      source: "principal",
      origin: "channel",
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
      source: "principal",
      origin: "channel",
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
      source: "principal",
      origin: "channel",
    });
    ix.upsertTurn({
      id: 2,
      persona: "phantom",
      conversation: "telegram:BBB",
      role: "user",
      text: "Vesuvius pension discussed in conversation BBB",
      createdAt: new Date("2026-05-28T06:01:00Z"),
      embeddable: true,
      source: "principal",
      origin: "channel",
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
        source: "principal",
        origin: "channel",
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
        source: "principal",
        origin: "channel",
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

describe("indexedNoteType", () => {
  test("passes a canonical type through unchanged", () => {
    expect(indexedNoteType("runbook")).toBe("runbook");
  });

  test("keeps the raw spelling alongside the canonical one", () => {
    // Both must be searchable: canonical so legacy notes join their peers,
    // raw so adopting the vocabulary never makes an old note unfindable.
    expect(indexedNoteType("atomic-note")).toBe("concept atomic-note");
    expect(indexedNoteType("troubleshooting")).toBe("runbook troubleshooting");
  });

  test("normalises case and separators before folding", () => {
    expect(indexedNoteType("  Atomic_Note ")).toBe("concept atomic-note");
    expect(indexedNoteType("Runbook")).toBe("runbook");
  });

  test("keeps an unknown type on its own spelling so drift stays findable", () => {
    expect(indexedNoteType("wibble")).toBe("wibble");
  });

  test("yields empty for a missing type", () => {
    expect(indexedNoteType("")).toBe("");
    expect(indexedNoteType("   ")).toBe("");
  });
});

describe("OKF type column (BM25F)", () => {
  test("a note is retrievable by its declared type", async () => {
    await note(
      "kb/infra/deploy.md",
      "---\ntitle: Deploying the gateway\ntype: runbook\n---\n" +
        "# Deploying the gateway\nsteps here.\n",
    );
    await ix.refreshStale(personaDir);

    const hits = ix.search("runbook", { scope: "kb" });
    expect(hits.map((h) => h.path)).toContain("kb/infra/deploy.md");
  });

  test("a legacy type is retrievable by its canonical name", async () => {
    // The whole point of the alias map: this note predates the vocabulary and
    // was never edited, but searching the canonical type still finds it.
    await note(
      "kb/concepts/old.md",
      "---\ntitle: Backpressure\ntype: atomic-note\n---\n" +
        "# Backpressure\nnotes.\n",
    );
    await ix.refreshStale(personaDir);

    expect(ix.search("concept", { scope: "kb" }).map((h) => h.path)).toContain(
      "kb/concepts/old.md",
    );
    // ...and by the spelling actually on disk.
    expect(
      ix.search("atomic-note", { scope: "kb" }).map((h) => h.path),
    ).toContain("kb/concepts/old.md");
  });

  test("a type match does not outrank a title match", async () => {
    // `type` is a closed vocabulary, so it must stay a tiebreaker: the note
    // genuinely ABOUT runbooks should beat one merely typed as a runbook.
    await note(
      "kb/infra/typed.md",
      "---\ntitle: Rotating certificates\ntype: runbook\n---\n" +
        "# Rotating certificates\nsteps.\n",
    );
    await note(
      "kb/concepts/about.md",
      "---\ntitle: Runbook\ntags: [runbook]\n---\n" +
        "# Runbook\nwhat a runbook is.\n",
    );
    await ix.refreshStale(personaDir);

    const hits = ix.search("runbook", { scope: "kb", limit: 5 });
    expect(hits[0]?.path).toBe("kb/concepts/about.md");
  });

  test("snippets still come back non-empty after the column shift", async () => {
    // Guards NOTES_BODY_COL: FTS5 doesn't validate the column ordinal, so a
    // stale index silently returns empty snippets rather than erroring.
    await note(
      "kb/concepts/snip.md",
      "---\ntitle: Widget\ntype: concept\n---\n" +
        "# Widget\nthe quick brown fox jumps over the lazy dog.\n",
    );
    await ix.refreshStale(personaDir);

    const hits = ix.search("brown fox", { scope: "kb" });
    expect(hits[0]?.snippet).toContain("fox");
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

  test("inbound wikilinks expand (a note that [[wikilinks]] TO the hit)", async () => {
    // The target note matches lexically; the note that wikilinks to it does
    // NOT. Before the fix, wiki targets were never resolved to target_path so
    // inbound lookup (which keys on target_path) could never find them.
    await note(
      "kb/infra/store.md",
      "---\ntitle: Credential Store\n---\n# Credential Store\nwhere secrets live.\n",
    );
    await note(
      "kb/infra/rotate.md",
      "---\ntitle: Rotate\n---\n# Rotate\nsee [[Credential Store]] for the vault.\n",
    );
    await ix.refreshStale(personaDir);

    const plain = ix.search("secrets", { scope: "kb" }).map((h) => h.path);
    expect(plain).toContain("kb/infra/store.md");
    expect(plain).not.toContain("kb/infra/rotate.md");

    const expanded = ix
      .searchExpanded("secrets", { scope: "kb", maxAdd: 3 })
      .map((h) => h.path);
    expect(expanded).toContain("kb/infra/rotate.md");
  });

  test("wikilinks resolve multi-word aliases", async () => {
    // `[[credential cycling]]` must resolve to the note that declares
    // `aliases: [credential cycling]`. The old space-joined alias storage +
    // whitespace split could never match a multi-word alias.
    await note(
      "kb/infra/rotation.md",
      "---\ntitle: Secret Rotation\naliases: [credential cycling]\n---\n" +
        "# Secret Rotation\nrun the playbook.\n",
    );
    await note(
      "kb/infra/onboard.md",
      "---\ntitle: Onboarding\n---\n# Onboarding\n" +
        "new hires must read [[credential cycling]] first. xyzzy.\n",
    );
    await ix.refreshStale(personaDir);

    const plain = ix.search("xyzzy", { scope: "kb" }).map((h) => h.path);
    expect(plain).toContain("kb/infra/onboard.md");
    expect(plain).not.toContain("kb/infra/rotation.md");

    const expanded = ix
      .searchExpanded("xyzzy", { scope: "kb", maxAdd: 3 })
      .map((h) => h.path);
    expect(expanded).toContain("kb/infra/rotation.md");
  });

  test("forward-referenced wikilink resolves after its target is indexed", async () => {
    // The linking note is indexed before its target exists; a later refresh
    // adds the target. The post-pass must repair the dangling wiki link.
    await note(
      "kb/infra/plan.md",
      "---\ntitle: Plan\n---\n# Plan\nfollow [[Runbook]]. zzplan.\n",
    );
    await ix.refreshStale(personaDir);
    await note(
      "kb/infra/runbook.md",
      "---\ntitle: Runbook\n---\n# Runbook\nthe steps.\n",
    );
    await ix.refreshStale(personaDir);

    const expanded = ix
      .searchExpanded("zzplan", { scope: "kb", maxAdd: 3 })
      .map((h) => h.path);
    expect(expanded).toContain("kb/infra/runbook.md");
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

  test("a v3 index (no type column) is rebuilt so type becomes searchable", async () => {
    const dir = await mkdtemp(join(tmpdir(), "phantombot-mi-heal4-"));
    const idxPath = join(dir, "index.sqlite");
    const pdir = join(dir, "persona");
    await mkdir(join(pdir, "kb"), { recursive: true });
    await writeFile(
      join(pdir, "kb", "y.md"),
      "---\ntitle: Gateway recovery\ntype: troubleshooting\n---\n" +
        "# Gateway recovery\nthe steps.\n",
    );

    // Hand-build a v3 index: correct-for-its-day fielded columns, but no
    // `type`. This is what every already-deployed install looks like.
    const raw = new Database(idxPath, { create: true });
    raw.exec("PRAGMA journal_mode = WAL");
    raw.exec(
      "CREATE VIRTUAL TABLE notes USING fts5(path UNINDEXED, scope UNINDEXED, " +
        "title, tags, aliases, headings, body, tokenize = 'porter unicode61');",
    );
    raw.exec(
      "CREATE TABLE files (path TEXT PRIMARY KEY, scope TEXT, mtime_ms INTEGER, " +
        "size INTEGER, title TEXT DEFAULT '', aliases TEXT DEFAULT '', indexed_at TEXT);",
    );
    raw.exec(
      "CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);",
    );
    raw
      .prepare("INSERT INTO meta (key, value) VALUES ('notes_schema_version', '3')")
      .run();
    raw
      .prepare(
        "INSERT INTO files (path, scope, mtime_ms, size, indexed_at) VALUES (?,?,?,?,?)",
      )
      .run("kb/y.md", "kb", 1, 1, new Date().toISOString());
    raw.close();

    const healed = await MemoryIndex.open(idxPath);
    try {
      await healed.refreshStale(pdir);
      // The canonical type resolves even though the note says "troubleshooting"
      // and the old index had nowhere to put it.
      expect(healed.search("runbook", { scope: "kb" }).map((h) => h.path)).toContain(
        "kb/y.md",
      );
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

describe("turnDecayFactor", () => {
  test("halves the score at one half-life, quarters at two", () => {
    const d = { halfLifeDays: 30, floor: 0 };
    expect(turnDecayFactor(0, d)).toBeCloseTo(1, 6);
    expect(turnDecayFactor(30, d)).toBeCloseTo(0.5, 6);
    expect(turnDecayFactor(60, d)).toBeCloseTo(0.25, 6);
  });

  test("clamps to the floor for ancient turns", () => {
    const d = { halfLifeDays: 30, floor: 0.02 };
    // 300 days ≈ 10 half-lives → ~0.001, below the floor.
    expect(turnDecayFactor(300, d)).toBe(0.02);
  });

  test("half-life <= 0 disables decay (factor 1)", () => {
    expect(turnDecayFactor(9999, { halfLifeDays: 0, floor: 0 })).toBe(1);
    expect(turnDecayFactor(9999, { halfLifeDays: -5, floor: 0 })).toBe(1);
  });

  test("negative age (future turn) never exceeds 1", () => {
    expect(turnDecayFactor(-10, { halfLifeDays: 30, floor: 0 })).toBe(1);
  });
});

describe("parseTurnCreatedAtMs", () => {
  test("extracts the ISO timestamp from a rendered turn", () => {
    const iso = "2026-05-28T06:00:00.000Z";
    expect(parseTurnCreatedAtMs(`[user ${iso}]\nhello`)).toBe(Date.parse(iso));
  });

  test("returns undefined for a row without the bracketed prefix", () => {
    expect(parseTurnCreatedAtMs("just some text")).toBeUndefined();
    expect(parseTurnCreatedAtMs("[user not-a-date]\nx")).toBeUndefined();
  });
});

describe("turn-hit time decay (search / hybridSearch)", () => {
  const now = new Date("2026-06-01T00:00:00Z").getTime();
  const daysAgo = (n: number) => new Date(now - n * 86_400_000);

  function seedGhostAndFresh() {
    // Stale turn is a STRONGER lexical match (term repeated) so raw BM25 ranks
    // it first — the exact kw-openclaw ghost shape.
    ix.upsertTurn({
      id: 1,
      persona: "phantom",
      conversation: "telegram:1001",
      role: "assistant",
      text: "kw-openclaw kw-openclaw kw-openclaw is the runtime here",
      createdAt: daysAgo(300),
      embeddable: true,
      source: "self",
      origin: "channel",
    });
    ix.upsertTurn({
      id: 2,
      persona: "phantom",
      conversation: "telegram:1001",
      role: "user",
      text: "kw-openclaw was replaced by phantombot",
      createdAt: daysAgo(0),
      embeddable: true,
      source: "principal",
      origin: "channel",
    });
  }

  test("without decay the stale-but-stronger turn ranks first", () => {
    seedGhostAndFresh();
    const hits = ix.search("kw-openclaw", { scope: "turns" });
    expect(hits[0]?.path).toContain("/1"); // the 300-day-old ghost wins
  });

  test("with decay the fresh turn overtakes the stale ghost", () => {
    seedGhostAndFresh();
    const hits = ix.search("kw-openclaw", {
      scope: "turns",
      decay: { halfLifeDays: 30, floor: 0.02, nowMs: now },
    });
    expect(hits[0]?.path).toContain("/2"); // fresh correction now on top
    expect(hits[1]?.path).toContain("/1");
  });

  test("hybridSearch applies decay to fused turn scores", () => {
    seedGhostAndFresh();
    // No queryVec → hybridSearch falls back through search(); pass decay and
    // confirm the fresh turn wins there too.
    const hits = ix.hybridSearch("kw-openclaw", undefined, {
      scope: "turns",
      decay: { halfLifeDays: 30, floor: 0.02, nowMs: now },
    });
    expect(hits[0]?.path).toContain("/2");
  });

  test("curated notes are immune — a note's score is unchanged by decay", async () => {
    await note("kb/infra/runtime.md", "kw-openclaw runtime backup procedure");
    await ix.refreshStale(personaDir);
    const plain = ix.search("kw-openclaw", { scope: "kb" });
    const decayed = ix.search("kw-openclaw", {
      scope: "kb",
      decay: { halfLifeDays: 1, floor: 0.01, nowMs: now },
    });
    expect(decayed[0]?.path).toBe("kb/infra/runtime.md");
    // Same score with and without decay → notes never aged.
    expect(decayed[0]?.ftsScore).toBe(plain[0]?.ftsScore);
  });

  test("a turn with unparseable age is not decayed (factor 1)", () => {
    // Manually insert a turn_docs row whose content lacks the ISO prefix.
    const db = (ix as unknown as { db: import("bun:sqlite").Database }).db;
    db.prepare(
      "INSERT INTO turn_docs (path, persona, conversation, role, turn_id, content) " +
        "VALUES (?, ?, ?, ?, ?, ?)",
    ).run(
      "turns/phantom/telegram%3A1001/5",
      "phantom",
      "telegram:1001",
      "user",
      5,
      "kw-openclaw with no timestamp prefix",
    );
    const withDecay = ix.search("kw-openclaw", {
      scope: "turns",
      decay: { halfLifeDays: 1, floor: 0.01, nowMs: now },
    });
    const without = ix.search("kw-openclaw", { scope: "turns" });
    // Unparseable age → factor 1 → identical score.
    expect(withDecay[0]?.ftsScore).toBe(without[0]?.ftsScore);
  });
});

describe("turn provenance + audience columns", () => {
  const turn = (
    id: number,
    conversation: string,
    text: string,
    source: Turn["source"] = "principal",
    origin: Turn["origin"] = "channel",
  ): Turn => ({
    id,
    persona: "phantom",
    conversation,
    role: "user",
    text,
    createdAt: new Date("2026-05-28T06:00:00Z"),
    embeddable: true,
    source,
    origin,
  });

  test("turn hits carry source and audience derived at index time", () => {
    ix.upsertTurn(turn(1, "phantomchat:group:TEAM", "quixotic beam alignment", "other"));
    ix.upsertTurn(turn(2, "telegram:DM", "quixotic beam alignment", "principal"));
    ix.upsertTurn(turn(3, "telegram:-100123", "quixotic beam alignment", "principal"));

    const byConv = new Map(
      ix
        .search("quixotic beam", { scope: "turns", limit: 10 })
        .map((h) => [turnPathConversationOf(h.path), h]),
    );
    expect(byConv.get("phantomchat:group:TEAM")?.source).toBe("other");
    expect(byConv.get("phantomchat:group:TEAM")?.audience).toBe("multi-party");
    expect(byConv.get("telegram:DM")?.audience).toBe("private");
    // Telegram group/supergroup ids are negative → multi-party.
    expect(byConv.get("telegram:-100123")?.audience).toBe("multi-party");
  });

  test("turnFilter excludes conversations and audiences in SQL, before LIMIT", () => {
    // 15 current-conversation turns + 1 eligible cross turn. With a limit
    // BELOW 15, the cross turn still surfaces — the current conversation
    // never occupies a pool slot. (Kai's pool-starvation review on #378.)
    for (let i = 1; i <= 15; i++) {
      ix.upsertTurn(turn(i, "telegram:AAA", `zephyr shared token ${i}`));
    }
    ix.upsertTurn(turn(100, "telegram:BBB", "zephyr shared token cross"));

    const hits = ix.search("zephyr shared token", {
      scope: "turns",
      limit: 5,
      turnFilter: { excludeConversation: "telegram:AAA" },
    });
    expect(hits).toHaveLength(1);
    expect(hits[0]!.path).toContain("BBB");
  });

  test("turnFilter prefix-excludes channels and restricts audiences", () => {
    ix.upsertTurn(turn(1, "telegram:SECRET", "zephyr channel secret"));
    ix.upsertTurn(turn(2, "telegram:DM", "zephyr channel private"));
    ix.upsertTurn(turn(3, "phantomchat:group:G", "zephyr channel group"));

    // Prefix exclude drops ALL telegram:* sources.
    const noTelegram = ix.search("zephyr channel", {
      scope: "turns",
      limit: 10,
      turnFilter: { exclude: ["telegram"] },
    });
    expect(noTelegram.map((h) => h.path).join()).not.toContain("telegram");

    // A multi-party room admits only multi-party/public candidates.
    const groupRoom = ix.search("zephyr channel", {
      scope: "turns",
      limit: 10,
      turnFilter: { allowedAudiences: ["multi-party", "public"] },
    });
    expect(groupRoom).toHaveLength(1);
    expect(groupRoom[0]!.path).toContain("group");
  });

  test("re-inserting a turn keeps its surviving embedding (sha reuse)", () => {
    const t = turn(1, "telegram:AAA", "zephyr embedding reuse");
    const vec = new Float32Array([1, 0, 0]);
    ix.upsertTurn(t, vec, "sha-1");
    expect(ix.embeddingCount()).toBe(1);
    // Re-insert WITHOUT a vector (the turn-schema rebuild path): the FTS
    // row is rewritten, the embedding must survive untouched.
    ix.upsertTurn(t);
    expect(ix.embeddingCount()).toBe(1);
    expect(ix.turnEmbeddingSha(turnPath(t))).toBe("sha-1");
    expect(ix.search("zephyr embedding", { scope: "turns" })).toHaveLength(1);
  });
});

/** Decode the conversation segment of a turns/ path (test helper). */
function turnPathConversationOf(path: string): string {
  return decodeURIComponent(path.split("/")[2]!);
}

describe("turn-schema self-heal", () => {
  test("a v1 turn_docs (no source/audience) is dropped and rebuilt on open", async () => {
    const dir = await mkdtemp(join(tmpdir(), "phantombot-mi-turnheal-"));
    const idxPath = join(dir, "index.sqlite");

    // Hand-build a pre-v2 index: old 6-column turn_docs with a row, a
    // turn_index_state cursor, and a surviving embedding.
    const raw = new Database(idxPath, { create: true });
    raw.exec("PRAGMA journal_mode = WAL");
    raw.exec(
      "CREATE VIRTUAL TABLE turn_docs USING fts5(path UNINDEXED, persona UNINDEXED, conversation UNINDEXED, role UNINDEXED, turn_id UNINDEXED, content, tokenize = 'porter unicode61');",
    );
    raw.exec(
      "CREATE TABLE turn_embeddings (path TEXT PRIMARY KEY, vec BLOB NOT NULL, text_sha TEXT NOT NULL, embedded_at TEXT NOT NULL);",
    );
    raw.exec(
      "CREATE TABLE turn_index_state (persona TEXT NOT NULL, conversation TEXT NOT NULL, last_turn_id INTEGER NOT NULL, user_turns_indexed INTEGER NOT NULL, indexed_at TEXT NOT NULL, PRIMARY KEY (persona, conversation));",
    );
    raw.exec(
      "CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);",
    );
    raw
      .prepare(
        "INSERT INTO turn_docs (path, persona, conversation, role, turn_id, content) VALUES (?,?,?,?,?,?)",
      )
      .run(
        "turns/phantom/telegram%3A1001/1",
        "phantom",
        "telegram:1001",
        "user",
        1,
        "[user 2026-05-28T06:00:00Z]\nzephyr legacy row",
      );
    raw
      .prepare(
        "INSERT INTO turn_embeddings (path, vec, text_sha, embedded_at) VALUES (?,?,?,?)",
      )
      .run(
        "turns/phantom/telegram%3A1001/1",
        Buffer.from(new Float32Array([1, 0, 0]).buffer),
        "sha-legacy",
        new Date().toISOString(),
      );
    raw
      .prepare(
        "INSERT INTO turn_index_state (persona, conversation, last_turn_id, user_turns_indexed, indexed_at) VALUES (?,?,?,?,?)",
      )
      .run("phantom", "telegram:1001", 1, 1, new Date().toISOString());
    raw.close();

    const healed = await MemoryIndex.open(idxPath);
    try {
      const db = (
        healed as unknown as {
          db: {
            query: (s: string) => {
              all: () => Array<Record<string, unknown>>;
              get: () => Record<string, unknown> | null;
            };
          };
        }
      ).db;
      // New columns exist...
      const cols = db.query("PRAGMA table_info(turn_docs)").all();
      expect(cols.some((c) => c.name === "source")).toBe(true);
      expect(cols.some((c) => c.name === "audience")).toBe(true);
      // ...old rows and the stale cursor are gone (the indexer re-walks)...
      expect(db.query("SELECT COUNT(*) AS c FROM turn_docs").get()!.c).toBe(0);
      expect(
        db.query("SELECT COUNT(*) AS c FROM turn_index_state").get()!.c,
      ).toBe(0);
      // ...but the embedding SURVIVED (rebuild costs no embed API calls).
      expect(healed.turnEmbeddingSha("turns/phantom/telegram%3A1001/1")).toBe(
        "sha-legacy",
      );
      // Version stamped.
      const ver = db
        .query("SELECT value FROM meta WHERE key = 'turn_schema_version'")
        .get();
      expect(Number(ver?.value)).toBe(TURN_SCHEMA_VERSION);
    } finally {
      healed.close();
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("per-path BM25 lookup for vector-only hits (#378)", () => {
  // Fixture strategy (per Robbie's review): the BBB turn must rank BELOW
  // the FTS top-25 pool. BM25 favours short documents, so we invert the
  // length relationship — dense short fillers that each contain the query
  // terms, and one long BBB turn where the query terms appear once buried
  // in padding. This pushes BBB to 26th+ lexically while its cosine keeps
  // it in the final slice. Without the per-path lookup, ftsScore stays
  // undefined and the tier-2 dual-gate silently drops it.
  const query = "relay auth token";
  const vec = new Float32Array([1, 0, 0]);
  const pad = Array.from({ length: 120 }, (_, k) => `padding${k}`).join(" ");

  // Note: this fixture's raw BM25 for BBB is ~5.4e-7 — effectively zero,
  // because all 31 seeded docs contain every query term so IDF collapses.
  // That's far below the production tier-2 floor (minScore: 2.0), and that's
  // fine: the invariant under test is score CONVENTION (per-path must equal
  // undecayed), not a realistic score value. Don't "fix" this fixture to
  // produce a plausible-looking score — doing so would break the length
  // inversion (padding vs. short fillers) that pushes BBB out of the FTS
  // top-25 pool, which is the vector-only condition the test depends on.
  // (#379/5)

  // Shared seeding helper so both tests use the same fixture.
  function seed(): void {
    // 30 short filler turns in AAA — all lexically competitive.
    for (let i = 1; i <= 30; i++) {
      ix.upsertTurn(
        {
          id: i,
          persona: "phantom",
          conversation: "phantomchat:group:AAA",
          role: "user",
          text: "relay auth token relay auth token",
          createdAt: new Date("2026-05-28T06:00:00Z"),
          embeddable: true,
          source: "principal",
          origin: "channel",
        },
        // Orthogonal vectors so fillers don't compete on cosine.
        new Float32Array([0, i / 30, 0]),
        `sha-aaa-${i}`,
      );
    }
    // One long BBB turn: high cosine, query terms appear once in a sea of padding.
    // BM25 penalises long documents → ranks below the 30 short fillers.
    ix.upsertTurn(
      {
        id: 300,
        persona: "phantom",
        conversation: "telegram:-100BBB",
        role: "user",
        text: `${pad} relay auth token ${pad}`,
        createdAt: new Date("2026-05-28T06:01:00Z"),
        embeddable: true,
        source: "principal",
        origin: "channel",
      },
      vec,
      "sha-bbb",
    );
  }

  test("vector hit outside FTS top-25 gets its real BM25 score", () => {
    seed();

    // limit: 40 so BBB survives the slice despite low lexical rank.
    const hits = ix.hybridSearch(query, vec, {
      scope: "all",
      limit: 40,
    });

    // The BBB turn must be in the results (its cosine is the highest).
    const bbbHit = hits.find((h) => h.path.includes("BBB"));
    expect(bbbHit).toBeDefined();
    // Its ftsScore must NOT be undefined — the per-path lookup filled it.
    expect(bbbHit!.ftsScore).toBeDefined();
    expect(bbbHit!.ftsScore!).toBeGreaterThan(0);
  });

  test("per-path BM25 score is raw (undecayed) even when decay is active", () => {
    seed();

    // Search WITH decay — inject nowMs 60 days later so all turns age
    // equally (1-minute spread doesn't change ranking).
    const decayed = ix.hybridSearch(query, vec, {
      scope: "all",
      limit: 40,
      decay: { halfLifeDays: 30, floor: 0.02, nowMs: Date.parse("2026-11-28T06:00:00Z") },
    });

    const bbbHit = decayed.find((h) => h.path.includes("BBB"));
    expect(bbbHit).toBeDefined();
    expect(bbbHit!.ftsScore).toBeDefined();

    // The raw score without decay — same query, same turn, no decay.
    const rawHits = ix.hybridSearch(query, vec, {
      scope: "all",
      limit: 40,
    });
    const rawBbb = rawHits.find((h) => h.path.includes("BBB"));
    expect(rawBbb).toBeDefined();
    expect(rawBbb!.ftsScore).toBeDefined();

    // Per-path ftsScore must equal the undecayed value, not decayed.
    expect(bbbHit!.ftsScore).toBe(rawBbb!.ftsScore);
  });
});
