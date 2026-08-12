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

import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { mkdirSync, readdirSync, rmSync, statSync } from "node:fs";
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
 * Resolve a persona-owned temp directory (`<personaDir>/tmp`), creating it if
 * needed. Harness temp files land HERE instead of the shared system `/tmp`
 * (issue #365) — which keeps writes on real disk, gives full per-persona
 * isolation (ownership, perms, AND free space all follow the persona), and
 * means one persona can never starve another's tmpfs. It also lets phantombot
 * still write when the system `/tmp` is full.
 */
export function personaTmpDir(personaDirPath: string): string {
  const dir = join(personaDirPath, "tmp");
  mkdirSync(dir, { recursive: true });
  return dir;
}

/**
 * Aggressive startup sweep of a persona's temp dir: delete any entry older
 * than `maxAgeMs` (default 1h). Age-gated so a concurrent in-flight turn's
 * harness dir (younger than the max turn duration) is never nuked mid-spawn.
 *
 * Only phantombot's own residue lives here — harness/route dirs from crashed or
 * SIGKILL'd turns that never ran their `finally` cleanup. The run lock is NOT
 * in this dir (it lives in `$XDG_RUNTIME_DIR` / `~/.cache`, see runLock.ts), so
 * this sweep can never touch it. Best-effort: a missing dir, or an entry that
 * vanishes mid-sweep, is ignored — cleanup must never break startup.
 */
export function cleanupPersonaTmpDir(
  personaDirPath: string,
  maxAgeMs = 3_600_000,
): void {
  const dir = join(personaDirPath, "tmp");
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return; // dir doesn't exist yet — nothing to sweep
  }
  const now = Date.now();
  for (const name of names) {
    const full = join(dir, name);
    try {
      if (now - statSync(full).mtimeMs > maxAgeMs) {
        rmSync(full, { recursive: true, force: true });
      }
    } catch {
      // race: entry vanished between readdir and stat/rm — ignore
    }
  }
}

/**
 * Create a private temp directory for a single harness invocation. The caller
 * MUST call `cleanup()` in a `finally` once the child process has exited, so a
 * thrown error or an early generator return still removes the files.
 *
 * `baseDir` (issue #365) is the persona-owned tmp root; when omitted we fall
 * back to the system `os.tmpdir()` for tests and degraded/no-persona paths.
 */
export async function createHarnessTempDir(
  baseDir?: string,
): Promise<HarnessTempDir> {
  const base = baseDir ?? tmpdir();
  // Ensure the persona tmp root exists before mkdtemp (first use on a fresh
  // box). Harmless for the os.tmpdir() fallback, which always exists.
  if (baseDir) await mkdir(base, { recursive: true });
  const dir = await mkdtemp(join(base, "phantombot-harness-"));
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
