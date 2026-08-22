/**
 * Argv-length workaround for harnesses that carry large prompt data on the
 * command line.
 *
 * There are TWO limits, and they bite on different platforms:
 *
 *   - Windows caps a whole process command line at ~8,191 characters (the
 *     CreateProcess lpCommandLine limit). Phantombot's rendered payloads
 *     (persona + memory + conversation history) blow straight past it, so the
 *     child fails to spawn with "The command line is too long."
 *   - Linux caps a SINGLE argv string at 131,071 bytes (MAX_ARG_STRLEN, 32
 *     pages, hard-coded in fs/exec.c). This is NOT the 2 MB `ARG_MAX` that
 *     `getconf ARG_MAX` reports and that this file used to cite: ARG_MAX
 *     bounds the total of argv+envp, MAX_ARG_STRLEN bounds each string on its
 *     own and cannot be raised (no sysctl, no ulimit). A system prompt over
 *     128 KB therefore fails with E2BIG on a box with gigabytes free.
 *
 * The second limit is not theoretical: a persona whose journal grew past
 * ~128 KB wedged completely, every turn dying at `posix_spawn` with
 * `E2BIG: argument list too long` (issue #426).
 *
 * The fix is to spill the oversized argv payloads - the system prompt and
 * the rendered conversation - into temp files and hand the child a short file
 * reference instead:
 *
 *   - pi:     `--system-prompt <file>` (pi reads a path's contents as the
 *             system prompt) and the positional `@<file>` (pi includes an
 *             `@file`'s contents in the initial message). Pi spills
 *             unconditionally on every platform.
 *   - claude: `--system-prompt-file <file>` (the conversation already travels
 *             on stdin, so only the system prompt needs spilling). Claude
 *             spills on Windows always, and on any platform once the prompt
 *             is large enough to approach MAX_ARG_STRLEN.
 *
 * Both mechanisms were verified empirically against pi 0.80.3 and Claude Code
 * before this was written.
 */

import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { mkdirSync, readdirSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { log } from "./logger.ts";
import { ensurePersonaTmpDir } from "./personaPaths.ts";

/**
 * Linux's per-argv-string ceiling: MAX_ARG_STRLEN = 32 * PAGE_SIZE = 131,072
 * bytes, of which one byte is the NUL terminator, so 131,071 usable. Hard-coded
 * in the kernel (fs/exec.c) - not tunable, and unrelated to `getconf ARG_MAX`.
 * Exported so tests can assert the threshold sits below it.
 */
export const MAX_ARG_STRLEN_BYTES = 131_071;

/**
 * Spill a single argv payload to a temp file once it exceeds this many bytes.
 *
 * 96 KB leaves ~35 KB of headroom under MAX_ARG_STRLEN. The headroom is
 * deliberately fat rather than snug because the number we measure and the
 * number the kernel measures are not quite the same string: we size the
 * payload itself, while `execve` sizes each argv element after the runtime has
 * encoded it. Sizing on `Buffer.byteLength` already removes the UTF-8 surprise
 * (a journal full of em dashes is 3x its `.length` in bytes); the remaining
 * slack covers anything the spawn path adds around the value.
 *
 * The cost of spilling early is one small file write and one read in the
 * child, so an over-eager spill is nearly free while an under-eager one wedges
 * the persona entirely. When in doubt, spill.
 */
export const ARGV_SPILL_THRESHOLD_BYTES = 96 * 1024;

/**
 * True when this argv payload must be spilled to a temp file rather than
 * passed inline.
 *
 * Windows: ALWAYS true. Its limit is on the whole command line (~8,191 chars),
 * not one element, so no per-payload size test can be trusted - the other args
 * and the payload share one budget. Keeping it unconditional preserves the
 * behaviour that shipped in #277 and verified on the Alpha VM.
 *
 * Elsewhere: true once `payloadBytes` crosses ARGV_SPILL_THRESHOLD_BYTES.
 * Callers that omit `payloadBytes` get the old platform-only answer, which is
 * the correct default for a caller that has no single dominant payload.
 *
 * `platform` is injectable so both branches are unit-testable on a POSIX CI
 * runner.
 */
export function argvNeedsTempFiles(
  platform: NodeJS.Platform = process.platform,
  payloadBytes?: number,
): boolean {
  if (platform === "win32") return true;
  return payloadBytes !== undefined && payloadBytes > ARGV_SPILL_THRESHOLD_BYTES;
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
 * `baseDir` (issue #365) is the persona-owned tmp root, and EVERY production
 * caller passes one: the turn orchestrator, the threat judge and the durable-
 * fact extractor all resolve `<personaDir>/tmp`. Spilled payloads are persona
 * data — a system prompt carries memory, drawers and conversation — so they
 * must not land in a world-readable shared `/tmp` alongside other personas'.
 *
 * When no `baseDir` is given we fall back to the ACTIVE persona's tmp dir
 * (#435) rather than the shared system tmp, so even a caller that forgot to
 * thread the base through still keeps the spill inside the persona boundary.
 * That fallback is WARNED about rather than silently taken, because a
 * production spill reaching it is a plumbing regression, not a configuration
 * choice. It is a fallback and not a throw: refusing the turn on a headless
 * box would be worse.
 */
export async function createHarnessTempDir(
  baseDir?: string,
): Promise<HarnessTempDir> {
  if (!baseDir) {
    log.warn("createHarnessTempDir: no persona tmp base given, falling back to the active persona's tmp dir", {
      fallback: ensurePersonaTmpDir(),
    });
  }
  const base = baseDir ?? ensurePersonaTmpDir();
  // Ensure the persona tmp root exists before mkdtemp (first use on a fresh
  // box). Harmless for the os.tmpdir() fallback, which always exists.
  await mkdir(base, { recursive: true });
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
