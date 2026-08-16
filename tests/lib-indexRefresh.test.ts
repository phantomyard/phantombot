import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { refreshPersonaIndex } from "../src/lib/indexRefresh.ts";
import type { Config } from "../src/config.ts";

let workdir: string;
let personaDir: string;
let indexPath: string;
let config: Config;

beforeEach(async () => {
  workdir = await mkdtemp(join(tmpdir(), "phantombot-ixref-"));
  personaDir = join(workdir, "persona");
  indexPath = join(workdir, "index.sqlite");
  await mkdir(join(personaDir, "memory"), { recursive: true });
  await mkdir(join(personaDir, "kb", "concepts"), { recursive: true });
  config = { embeddings: { provider: "none" } } as unknown as Config;
});

afterEach(async () => {
  await rm(workdir, { recursive: true, force: true });
});

describe("refreshPersonaIndex", () => {
  // This is the work that used to sit in the nightly's KB PROMPT ("run
  // `phantombot memory index --rebuild` at the end") — deterministic work
  // behind a probabilistic trigger. In code it is guaranteed, ordered after
  // both stages' writes, and runs exactly once.
  test("indexes memory/ and kb/ files", async () => {
    await writeFile(
      join(personaDir, "memory", "2026-05-01.md"),
      "a decision about proxies",
      "utf8",
    );
    await writeFile(
      join(personaDir, "kb", "concepts", "proxy.md"),
      "# Proxy\nnotes",
      "utf8",
    );
    const r = await refreshPersonaIndex({ config, personaDir, indexPath });
    expect(r.error).toBeUndefined();
    expect(r.indexed).toBe(2);
  });

  // refreshStale, not rebuild: `rebuild` drops the tables and re-embeds every
  // file with force on every run — hundreds of unchanged dailies a night.
  test("a second call re-indexes nothing when no file changed", async () => {
    await writeFile(join(personaDir, "memory", "2026-05-01.md"), "x", "utf8");
    await refreshPersonaIndex({ config, personaDir, indexPath });
    const second = await refreshPersonaIndex({ config, personaDir, indexPath });
    expect(second.indexed).toBe(0);
    expect(second.error).toBeUndefined();
  });

  test("a changed file is picked up on the next call", async () => {
    const p = join(personaDir, "memory", "2026-05-01.md");
    await writeFile(p, "x", "utf8");
    await refreshPersonaIndex({ config, personaDir, indexPath });
    await writeFile(p, "x and more", "utf8");
    expect(
      (await refreshPersonaIndex({ config, personaDir, indexPath })).indexed,
    ).toBe(1);
  });

  // A failed refresh must never fail the distillation that produced the files:
  // the writes already landed, and the next refresh picks them up.
  test("an unusable index path is reported, not thrown", async () => {
    // A directory where the db file should be: sqlite can't open it.
    const r = await refreshPersonaIndex({
      config,
      personaDir,
      indexPath: join(personaDir, "memory"),
    });
    expect(r.error).toBeDefined();
    expect(r.indexed).toBe(0);
  });

  // Keyword-only installs (no embeddings provider) are a valid configuration,
  // not a fault — FTS still refreshes.
  test("no embeddings provider → FTS only, no error", async () => {
    await writeFile(join(personaDir, "memory", "2026-05-01.md"), "x", "utf8");
    const r = await refreshPersonaIndex({ config, personaDir, indexPath });
    expect(r.embedded).toBe(0);
    expect(r.error).toBeUndefined();
  });
});
