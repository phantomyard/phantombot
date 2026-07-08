/**
 * Shared minimal IO interfaces and helpers for CLI commands.
 *
 * Subcommands take WriteSink instead of NodeJS.WriteStream so tests can
 * pass capture buffers without faking the full WriteStream API.
 */

import { mkdir, open, rename, unlink } from "node:fs/promises";
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
 * The fix is the standard tempfile + fsync + rename dance:
 *   1. write the full payload to a sibling temp file;
 *   2. fsync the temp file so its data + metadata are durably on disk BEFORE
 *      the rename — otherwise a plain write only guarantees the bytes reached
 *      the OS page cache, and a power loss can leave the renamed target with
 *      unwritten (zeroed/stale) data on filesystems that reorder data/metadata;
 *   3. `rename()` it over the target — rename(2) is atomic on POSIX, so a
 *      concurrent reader sees either the complete old file or the complete new
 *      file, never a partial one;
 *   4. fsync the containing directory so the rename itself is durable — without
 *      this a power loss immediately after rename can lose the directory entry
 *      update and leave the target missing entirely.
 *
 * The temp name carries pid + random so two writers racing on the same target
 * never clobber each other's temp. On any failure the temp file is unlinked
 * (best-effort) and the error rethrown.
 *
 * Directory fsync is best-effort: some platforms (notably Windows) reject
 * opening/fsyncing a directory, so that step is swallowed rather than failing
 * the whole write — the data fsync + atomic rename still hold there.
 *
 * Mirrors the pattern already used in channels/phantomchat/personaStore.ts.
 */
export async function writeFileAtomic(
  path: string,
  contents: string,
  options?: { mode?: number },
): Promise<void> {
  const dir = dirname(path);
  await mkdir(dir, { recursive: true });
  const tmp = `${path}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
  try {
    const fh = await open(tmp, "w", options?.mode);
    try {
      await fh.writeFile(contents, { encoding: "utf8" });
      await fh.sync();
    } finally {
      await fh.close();
    }
    await rename(tmp, path);
    // Durably persist the rename (the new directory entry) itself.
    try {
      const dirFh = await open(dir, "r");
      try {
        await dirFh.sync();
      } finally {
        await dirFh.close();
      }
    } catch {
      /* directory fsync unsupported on this platform — best-effort */
    }
  } catch (e) {
    try {
      await unlink(tmp);
    } catch {
      /* best-effort cleanup — temp file may not exist */
    }
    throw e;
  }
}
