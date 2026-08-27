/**
 * Embedding job — feeds the note_embeddings table.
 *
 * Iterates every (path, scope) row in the FTS5 `files` table, chunks the
 * file content if it's too large for a single embedding call, and embeds
 * each chunk via the configured provider. Skips chunks whose text_sha
 * matches the recorded value (no API call needed).
 *
 * Sequential, not parallel — avoids hitting Gemini's per-minute quota.
 */

import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { Config } from "../config.ts";
import { resolveEmbedders, type Embedder } from "./embedder.ts";
import type { EmbeddingSpace } from "./embeddingSpace.ts";
import { walkMarkdown, type MemoryIndex } from "./memoryIndex.ts";

export interface EmbedJobResult {
  totalFiles: number;
  totalChunks: number;
  embeddedChunks: number;
  skippedChunks: number;
  failedChunks: number;
  /** Compatibility aliases for callers from before chunk accounting. */
  totalNotes: number;
  embedded: number;
  skipped: number;
  failed: number;
  errors: Array<{ path: string; chunkIdx: number; error: string }>;
}

export type { Embedder } from "./embedder.ts";

export function defaultEmbedder(config: Config): Embedder | undefined {
  return resolveEmbedders(config).document;
}

export function defaultEmbedderWithFetch(
  config: Config,
  fetchImpl?: typeof fetch,
): Embedder | undefined {
  return resolveEmbedders(config, { fetchImpl }).document;
}

export interface RunEmbedJobInput {
  personaDir: string;
  index: MemoryIndex;
  embedder: Embedder;
  /** Character-based note/KB request guard resolved for the provider. */
  maxChunkChars: number;
  /** If true, re-embed every chunk regardless of sha match. */
  force?: boolean;
  space?: EmbeddingSpace;
}

export async function runEmbedJob(
  input: RunEmbedJobInput,
): Promise<EmbedJobResult> {
  const result: EmbedJobResult = {
    totalFiles: 0,
    totalChunks: 0,
    embeddedChunks: 0,
    skippedChunks: 0,
    failedChunks: 0,
    totalNotes: 0,
    embedded: 0,
    skipped: 0,
    failed: 0,
    errors: [],
  };

  // Pull the full file list straight from the FTS index (which has been
  // populated by refreshStale before we get here).
  const files = input.index.allNotePaths().map((path) => ({ path }));
  const space = input.space ?? input.embedder.space;

  for (const { path } of files) {
    result.totalFiles++;
    result.totalNotes++;
    let content: string;
    try {
      content = await readFile(join(input.personaDir, path), "utf8");
    } catch {
      // Not on disk. Either it is a VIRTUAL note whose text lives in a table
      // (the open journal day, #461) — embed that — or it is a stale row,
      // which refreshStale removes on its next call.
      const virtual = input.index.virtualText(path);
      if (virtual === undefined) continue;
      content = virtual;
    }

    const chunks = chunkText(content, input.maxChunkChars);
    result.totalChunks += chunks.length;
    input.index.pruneNoteEmbeddingChunks(path, chunks.length);
    for (let i = 0; i < chunks.length; i++) {
      const chunk = chunks[i]!;
      const sha = sha256(chunk);
      if (!input.force) {
        const recorded = input.index.embeddingSha(path, i, space);
        if (recorded === sha) {
          result.skippedChunks++;
          result.skipped++;
          continue;
        }
      }
      const r = await input.embedder(chunk);
      if (!r.ok) {
        result.failedChunks++;
        result.failed++;
        result.errors.push({ path, chunkIdx: i, error: r.error });
        continue;
      }
      input.index.upsertEmbedding(path, i, r.values, sha, space);
      result.embeddedChunks++;
      result.embedded++;
    }
  }

  return result;
}

export interface TurnEmbedJobResult {
  totalTurns: number;
  embedded: number;
  failed: number;
  errors: Array<{ path: string; error: string }>;
}

/** Re-embed every existing indexed turn; deliberately ignores cursor state. */
export async function runTurnEmbedJob(input: {
  index: MemoryIndex;
  embedder: Embedder;
  space?: EmbeddingSpace;
}): Promise<TurnEmbedJobResult> {
  const result: TurnEmbedJobResult = {
    totalTurns: 0,
    embedded: 0,
    failed: 0,
    errors: [],
  };
  const space = input.space ?? input.embedder.space;
  for (const row of input.index.allTurnDocuments()) {
    result.totalTurns++;
    const r = await input.embedder(row.content);
    if (!r.ok) {
      result.failed++;
      result.errors.push({ path: row.path, error: r.error });
      continue;
    }
    input.index.upsertTurnEmbedding(
      row.path,
      r.values,
      sha256(row.content),
      space,
    );
    result.embedded++;
  }
  return result;
}

export interface EmbeddingPreflightResult {
  ok: boolean;
  error?: string;
  path?: string;
}

/** Make one bounded real document request before a destructive vector pass. */
export async function runEmbeddingPreflight(input: {
  personaDir: string;
  index: MemoryIndex;
  embedder: Embedder;
  maxChunkChars: number;
}): Promise<EmbeddingPreflightResult> {
  // Include safe disk-backed notes that are not indexed yet. Reembed must
  // probe before refreshStale, so a freshly-created or changed note may be
  // the only practical bounded real-document request available.
  const paths = new Set([
    ...input.index.allNotePaths(),
    ...walkMarkdown(input.personaDir).map((file) => file.path),
  ]);
  for (const path of paths) {
    try {
      const content = await readFile(join(input.personaDir, path), "utf8");
      const chunk = chunkText(content, input.maxChunkChars)[0];
      if (chunk === undefined) continue;
      const r = await input.embedder(chunk);
      return r.ok
        ? { ok: true, path }
        : { ok: false, path, error: r.error };
    } catch {
      // Match runEmbedJob: an index row can outlive a note deleted from disk.
      // Preflight runs before refreshStale, so unreadable stale candidates must
      // not prevent a later readable document from probing the provider.
      continue;
    }
  }
  const turn = input.index.allTurnDocuments()[0];
  if (!turn) return { ok: true };
  const r = await input.embedder(turn.content);
  return r.ok
    ? { ok: true, path: turn.path }
    : { ok: false, path: turn.path, error: r.error };
}

export function chunkText(text: string, maxChars: number): string[] {
  maxChars = Math.floor(maxChars);
  if (!Number.isFinite(maxChars) || maxChars <= 0) {
    throw new Error("chunkText: maxChars must be a positive finite number");
  }
  if (text.length <= maxChars) return [text];

  const out: string[] = [];
  let start = 0;
  while (start < text.length) {
    const targetEnd = Math.min(start + maxChars, text.length);
    if (targetEnd === text.length) {
      out.push(text.slice(start));
      break;
    }

    // A boundary in the first half of the candidate window would create a
    // pathological tiny chunk. Search backwards only in the latter half,
    // preferring a paragraph boundary before a single newline.
    const earliestUseful = start + Math.max(1, Math.floor(maxChars / 2));
    const paragraph = text.lastIndexOf("\n\n", targetEnd);
    if (paragraph >= earliestUseful && paragraph + 2 <= targetEnd) {
      const end = paragraph + 2;
      out.push(text.slice(start, end));
      start = end;
      continue;
    }

    const newline = text.lastIndexOf("\n", targetEnd - 1);
    if (newline >= earliestUseful) {
      const end = newline + 1;
      out.push(text.slice(start, end));
      start = end;
      continue;
    }

    out.push(text.slice(start, targetEnd));
    start = targetEnd;
  }
  return out;
}

export function sha256(s: string): string {
  return createHash("sha256").update(s, "utf8").digest("hex");
}
