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
  parseTurnCreatedAtMs,
  resolveMdLink,
  sanitizeFtsQuery,
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
