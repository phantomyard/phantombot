/**
 * Windows argv-length workaround for harnesses that carry large prompt data
 * on the command line.
 *
 * POSIX ARG_MAX is ~2 MB, so phantombot's rendered payloads (persona + memory
 * + conversation history - routinely tens of KB) pass fine as argv. Windows
 * caps a whole process command line at ~8,191 characters (the CreateProcess
 * lpCommandLine limit), so the same payload makes the child fail to spawn with
 * "The command line is too long." - the harness then exits 1 and the bot
 * replies with nothing.
 *
 * The fix is to spill the two oversized argv payloads - the system prompt and
 * the rendered conversation - into temp files and hand the child a short file
 * reference instead:
 *
 *   - pi:     `--system-prompt <file>` (pi reads a path's contents as the
 *             system prompt) and the positional `@<file>` (pi includes an
 *             `@file`'s contents in the initial message).
 *   - claude: `--system-prompt-file <file>` (the conversation already travels
 *             on stdin, so only the system prompt needs spilling).
 *
 * Both mechanisms were verified empirically against pi 0.80.3 and Claude Code
 * before this was written. POSIX keeps the existing argv path byte-for-byte
 * unchanged - the temp-file path is gated to Windows only.
 */

import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * True when the platform's command line is short enough that large prompt
 * payloads must be spilled to temp files rather than passed as argv. Only
 * Windows today (~8,191-char limit). The `platform` arg is injectable so the
 * branch is unit-testable on a POSIX CI runner.
 */
export function argvNeedsTempFiles(
  platform: NodeJS.Platform = process.platform,
): boolean {
  return platform === "win32";
}

export interface HarnessTempDir {
  /** Absolute path of the private temp directory. */
  readonly dir: string;
  /** Write `content` to `<dir>/<name>`; resolves to the absolute path. */
  file(name: string, content: string): Promise<string>;
  /** Remove the temp dir and everything in it. Never throws. */
  cleanup(): Promise<void>;
}

/**
 * Create a private temp directory for a single harness invocation. The caller
 * MUST call `cleanup()` in a `finally` once the child process has exited, so a
 * thrown error or an early generator return still removes the files.
 */
export async function createHarnessTempDir(): Promise<HarnessTempDir> {
  const dir = await mkdtemp(join(tmpdir(), "phantombot-harness-"));
  return {
    dir,
    async file(name: string, content: string): Promise<string> {
      const path = join(dir, name);
      await writeFile(path, content, "utf8");
      return path;
    },
    async cleanup(): Promise<void> {
      await rm(dir, { recursive: true, force: true }).catch(() => {});
    },
  };
}
