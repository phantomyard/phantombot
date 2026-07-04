import { rm } from "node:fs/promises";

/**
 * Recursively remove a directory, retrying on Windows EBUSY/EPERM/ENOTEMPTY.
 *
 * Three facts force this helper's shape:
 *   1. On Windows, bun:sqlite releases the vault.sqlite file handle only when
 *      the Database object is FINALIZED by the GC — not synchronously on
 *      close(). Until then an rm of the enclosing temp dir throws EBUSY.
 *   2. That finalizer won't run on its own during a tight retry loop, so we
 *      force it with Bun.gc(true) before each attempt (empirically this drops
 *      the release latency from ~100ms of hoping-for-a-GC to 0ms).
 *   3. Bun's fs.rm IGNORES Node's maxRetries/retryDelay options, so we retry by
 *      hand rather than leaning on them.
 * On POSIX the first attempt succeeds and the gc()/retry machinery is inert.
 */
export async function rmrf(
  path: string,
  attempts = 20,
  delayMs = 50,
): Promise<void> {
  const gc = (globalThis as { Bun?: { gc?: (sync: boolean) => void } }).Bun?.gc;
  for (let i = 0; ; i++) {
    try {
      // Run finalizers so any just-closed bun:sqlite handle is released.
      gc?.(true);
      await rm(path, { recursive: true, force: true });
      return;
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      const retryable =
        code === "EBUSY" || code === "EPERM" || code === "ENOTEMPTY";
      if (!retryable || i >= attempts - 1) throw e;
      await new Promise((r) => setTimeout(r, delayMs));
    }
  }
}
