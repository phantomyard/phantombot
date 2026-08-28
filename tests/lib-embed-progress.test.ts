/**
 * `onProgress` on the embedding jobs (issue #471).
 *
 * The TUI draws a real progress bar rather than printing "now go and run
 * `phantombot memory index --reembed`". That bar is only honest if the counts
 * behind it are, so these tests pin the contract the UI relies on.
 */

import { describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { runEmbedJob, type EmbedProgress } from "../src/lib/embedJob.ts";

function fakeIndex(paths: string[]) {
  const embeddings = new Map<string, unknown>();
  return {
    allNotePaths: () => paths,
    virtualText: () => undefined,
    pruneNoteEmbeddingChunks: () => {},
    embeddingSha: () => undefined,
    upsertEmbedding: (path: string, i: number) => embeddings.set(`${path}:${i}`, 1),
    embeddings,
  };
}

function personaWith(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), "phantombot-embed-progress-"));
  for (const [path, content] of Object.entries(files)) {
    const full = join(dir, path);
    mkdirSync(join(full, ".."), { recursive: true });
    writeFileSync(full, content, "utf8");
  }
  return dir;
}

const okEmbedder = Object.assign(
  async () => ({ ok: true as const, values: [0.1, 0.2] }),
  { space: undefined },
);

describe("runEmbedJob onProgress", () => {
  test("reports once per chunk, with a monotonically rising done count", async () => {
    const dir = personaWith({
      "kb/a.md": "alpha",
      "kb/b.md": "beta",
    });
    const seen: EmbedProgress[] = [];
    const result = await runEmbedJob({
      personaDir: dir,
      index: fakeIndex(["kb/a.md", "kb/b.md"]) as never,
      embedder: okEmbedder as never,
      maxChunkChars: 1000,
      force: true,
      onProgress: (p) => seen.push({ ...p }),
    });
    expect(result.embeddedChunks).toBe(2);
    expect(seen).toHaveLength(2);
    expect(seen.map((p) => p.done)).toEqual([1, 2]);
    expect(seen.map((p) => p.path)).toEqual(["kb/a.md", "kb/b.md"]);
  });

  test("the total GROWS as the walk proceeds — it is a lower bound, not a target", async () => {
    // Files are chunked lazily, so a UI must render "8,431 / 12,904" and let
    // the denominator move rather than compute a percentage that walks
    // backwards.
    const dir = personaWith({ "kb/a.md": "a", "kb/b.md": "b", "kb/c.md": "c" });
    const totals: number[] = [];
    await runEmbedJob({
      personaDir: dir,
      index: fakeIndex(["kb/a.md", "kb/b.md", "kb/c.md"]) as never,
      embedder: okEmbedder as never,
      maxChunkChars: 1000,
      force: true,
      onProgress: (p) => totals.push(p.total),
    });
    expect(totals).toEqual([1, 2, 3]);
  });

  test("a throwing progress sink never fails the embedding run", async () => {
    const dir = personaWith({ "kb/a.md": "alpha" });
    const result = await runEmbedJob({
      personaDir: dir,
      index: fakeIndex(["kb/a.md"]) as never,
      embedder: okEmbedder as never,
      maxChunkChars: 1000,
      force: true,
      onProgress: () => {
        throw new Error("the screen went away");
      },
    });
    expect(result.embeddedChunks).toBe(1);
  });

  test("a failed chunk still advances the bar", async () => {
    const dir = personaWith({ "kb/a.md": "alpha" });
    const seen: EmbedProgress[] = [];
    const result = await runEmbedJob({
      personaDir: dir,
      index: fakeIndex(["kb/a.md"]) as never,
      embedder: (async () => ({ ok: false as const, error: "429" })) as never,
      maxChunkChars: 1000,
      force: true,
      onProgress: (p) => seen.push({ ...p }),
    });
    expect(result.failedChunks).toBe(1);
    expect(seen.map((p) => p.done)).toEqual([1]);
  });

  test("no sink is a supported case — the CLI passes none", async () => {
    const dir = personaWith({ "kb/a.md": "alpha" });
    const result = await runEmbedJob({
      personaDir: dir,
      index: fakeIndex(["kb/a.md"]) as never,
      embedder: okEmbedder as never,
      maxChunkChars: 1000,
      force: true,
    });
    expect(result.embeddedChunks).toBe(1);
  });
});
