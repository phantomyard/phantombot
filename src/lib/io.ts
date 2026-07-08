/**
 * Shared minimal IO interfaces and helpers for CLI commands.
 *
 * Subcommands take WriteSink instead of NodeJS.WriteStream so tests can
 * pass capture buffers without faking the full WriteStream API.
 */

import { mkdir, rename, unlink, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

export interface WriteSink {
  write(chunk: string | Uint8Array): boolean | void;
}

/**
 * Atomically write `contents` to `path`.
 *
 * Plain `writeFile` is NOT atomic: a crash, OOM-kill, or power loss mid-write
 * leaves a truncated/half-written file on disk. For JSON state files that the
 * whole process must parse on startup (state.json, reply-mode-overrides.json)
 * a torn write is catastrophic — the next `JSON.parse` throws and can brick
 * every command until the file is deleted by hand.
 *
 * The fix is the standard tempfile + rename dance: write the full payload to a
 * sibling temp file, then `rename()` it over the target. rename(2) is atomic on
 * POSIX, so a concurrent reader sees either the complete old file or the
 * complete new file — never a partial one. The temp name carries pid + random
 * so two writers racing on the same target never clobber each other's temp.
 * On any failure the temp file is unlinked (best-effort) and the error rethrown.
 *
 * Mirrors the pattern already used in channels/phantomchat/personaStore.ts.
 */
export async function writeFileAtomic(
  path: string,
  contents: string,
  options?: { mode?: number },
): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
  try {
    await writeFile(tmp, contents, { encoding: "utf8", mode: options?.mode });
    await rename(tmp, path);
  } catch (e) {
    try {
      await unlink(tmp);
    } catch {
      /* best-effort cleanup — temp file may not exist */
    }
    throw e;
  }
}
