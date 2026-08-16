/**
 * Refresh a persona's search index in CODE.
 *
 * Two passes over memory/ + kb/: fill the SQLite FTS5 table from any file
 * whose mtime moved, then embed the chunks whose text sha changed. Nothing
 * else in the system does this — a KB note written by the nightly is
 * invisible to `memory search` until it runs.
 *
 * This used to be a line inside the nightly's KB PROMPT
 * ("run `phantombot memory index --rebuild` at the end"), i.e. deterministic
 * work behind a probabilistic trigger: if the model forgot, or the turn died,
 * the index silently lagged a day. Two wins from moving it here:
 *
 *   - it is guaranteed to run, exactly once, AFTER both concurrent stages
 *     have joined — which is precisely the write/index race that made the
 *     stages unsafe to parallelise; and
 *   - it uses `refreshStale`, not `rebuild`. `rebuild` drops the tables and
 *     re-embeds EVERY file with force, which on a mature persona means
 *     re-embedding hundreds of unchanged daily files every single night.
 */

import type { Config } from "../config.ts";
import { defaultEmbedder, runEmbedJob } from "./embedJob.ts";
import { log } from "./logger.ts";
import { MemoryIndex } from "./memoryIndex.ts";

export interface RefreshPersonaIndexInput {
  config: Config;
  /** Persona working directory (contains memory/ and kb/). */
  personaDir: string;
  /** Path to the persona's index db. */
  indexPath: string;
  /** Skip the embedding pass (FTS only). */
  noEmbed?: boolean;
}

export interface RefreshPersonaIndexResult {
  indexed: number;
  removed: number;
  embedded: number;
  embedFailed: number;
  /** Non-fatal failure message, if the refresh could not complete. */
  error?: string;
}

/**
 * Never throws: a failed index refresh must not fail the work that produced
 * the files. The error is logged and returned for the caller to report.
 */
export async function refreshPersonaIndex(
  input: RefreshPersonaIndexInput,
): Promise<RefreshPersonaIndexResult> {
  const result: RefreshPersonaIndexResult = {
    indexed: 0,
    removed: 0,
    embedded: 0,
    embedFailed: 0,
  };
  let ix: MemoryIndex | undefined;
  try {
    ix = await MemoryIndex.open(input.indexPath);
    const fts = await ix.refreshStale(input.personaDir);
    result.indexed = fts.indexed;
    result.removed = fts.removed;

    if (input.noEmbed) return result;
    const embedder = defaultEmbedder(input.config);
    if (!embedder) return result; // keyword-only install: valid, not a fault
    const r = await runEmbedJob({
      personaDir: input.personaDir,
      index: ix,
      embedder,
    });
    result.embedded = r.embedded;
    result.embedFailed = r.failed;
  } catch (e) {
    result.error = (e as Error).message;
    log.warn("index refresh failed (non-fatal)", { error: result.error });
  } finally {
    ix?.close();
  }
  return result;
}
