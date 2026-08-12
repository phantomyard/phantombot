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
 * Name prefixes of the temp dirs phantombot itself creates under a persona's
 * `tmp`. The startup sweep deletes ONLY entries matching one of these; anything
 * else living in `<personaDir>/tmp` — a scratch file an agent or operator left
 * there — survives regardless of age. This enforces the no-user-data-deletion
 * contract IN CODE (reviewers Kai + Lena, #367), not just in a docstring.
 *
 *   - `phantombot-harness-*`  createHarnessTempDir (this file)
 *   - `phantombot-route-*`    the pi route extension (piRouting / spawnPi)
 */
export const OWNED_TMP_PREFIXES = [
  "phantombot-harness-",
  "phantombot-route-",
] as const;

/** True when `name` is one of phantombot's own temp-dir names (see above). */
function isOwnedTmpEntry(name: string): boolean {
  return OWNED_TMP_PREFIXES.some((prefix) => name.startsWith(prefix));
}

/**
 * Default sweep TTL: 24h. Deliberately FAT, not tight. A harness dir's mtime is
 * stamped once at spawn and never touched again, so a turn still running when
 * another phantombot process sweeps would have its in-use dir reaped if the gate
 * were near the max turn duration. The default `harnessHardTimeoutMs` is exactly
 * 1h and operator-bumpable, so a 1h gate could nuke a live turn mid-run (Lena,
 * #367). 24h clears any plausible turn by a wide margin, and residue is cheap —
 * a few stale KB beats a mid-turn ENOENT.
 */
export const PERSONA_TMP_SWEEP_MAX_AGE_MS = 24 * 3_600_000;

/**
 * Aggressive startup sweep of a persona's temp dir: delete phantombot's OWN
 * temp dirs (see OWNED_TMP_PREFIXES) older than `maxAgeMs` (default 24h). Two
 * guardrails make this safe:
 *
 *   1. Prefix-gated — only `phantombot-harness-*` / `phantombot-route-*` are
 *      ever candidates; a user/agent scratch file in the same dir is untouched.
 *   2. Age-gated (24h) — well past any live turn, so an in-flight harness dir is
 *      never reaped mid-run.
 *
 * These dirs are residue from crashed / SIGKILL'd turns that never ran their
 * `finally` cleanup. The run lock is NOT here (it lives in `$XDG_RUNTIME_DIR` /
 * `~/.cache`, see runLock.ts), so this sweep can never touch it.
 *
 * Windows note: `rmSync` throws EBUSY/EPERM if any file under an entry still has
 * an open handle — a live turn, or an AV/search-indexer scan — unlike POSIX,
 * where unlinking an open file succeeds. `maxRetries` rides out the transient
 * AV/indexer case; a genuinely in-use dir simply fails the rm and is swallowed,
 * so on Windows a live turn is protected TWICE (age gate + open-handle lock).
 *
 * Best-effort throughout: a missing dir, or an entry that vanishes / is locked
 * mid-sweep, is ignored — cleanup must never break startup.
 */
export function cleanupPersonaTmpDir(
  personaDirPath: string,
  maxAgeMs = PERSONA_TMP_SWEEP_MAX_AGE_MS,
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
    if (!isOwnedTmpEntry(name)) continue; // never touch non-phantombot data
    const full = join(dir, name);
    try {
      if (now - statSync(full).mtimeMs > maxAgeMs) {
        rmSync(full, { recursive: true, force: true, maxRetries: 2, retryDelay: 50 });
      }
    } catch {
      // race (entry vanished between readdir and stat/rm) or Windows in-use
      // open handle — leave it, sweep the rest.
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
      // maxRetries: on Windows the child's (or an AV/indexer's) handle on a
      // file under `dir` can linger a beat past process exit, making an
      // immediate recursive rm throw EBUSY/EPERM/ENOTEMPTY; retry rides that
      // out. No-op cost on POSIX. Still best-effort — swallow if it can't.
      await rm(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }).catch(() => {});
    },
  };
}
