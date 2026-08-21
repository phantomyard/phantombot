/**
 * Size-capped rotation for phantombot's file-based service logs (#428).
 *
 * Only two platforms need this. On Linux the systemd --user units log to
 * journald, which rotates on its own; on macOS launchd appends forever to the
 * `StandardOutPath`/`StandardErrorPath` files baked into the plist, and on
 * Windows each scheduled task appends with `cmd >>`. Neither caps anything, so
 * a long-lived box grows a single log file without limit — one macOS host
 * reached ~700 MB before it was truncated by hand.
 *
 * COPY-TRUNCATE, NEVER RENAME — this is the whole design, and getting it
 * wrong is worse than shipping nothing. The live file is held open by a
 * process we do not control (launchd, or the always-on `cmd` wrapper) with an
 * O_APPEND descriptor. A descriptor follows the INODE, not the path: rename
 * the live file to `.1` and the writer keeps appending to the renamed inode
 * forever, so the freshly-created `<name>.log` stays empty and every log line
 * after the first rotation silently lands in a file nobody tails. Copying the
 * bytes out and then truncating the original in place keeps the writer's
 * descriptor pointed at the same inode, and O_APPEND recomputes the offset per
 * write, so the file refills from 0 rather than leaving a sparse hole.
 *
 * The known cost of copy-truncate (logrotate's `copytruncate` has the same
 * one): lines written between the copy and the truncate are lost. That window
 * is a few milliseconds against a 30-minute cadence, and the alternative is
 * losing every line indefinitely — see above.
 *
 * Rotated generations (`<name>.log.1` … `.log.N`) are NOT held open by
 * anyone, so those are shifted with plain renames.
 */

import { existsSync } from "node:fs";
import {
  copyFile,
  readdir,
  readFile,
  rename,
  stat,
  truncate,
  unlink,
  writeFile,
} from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { isPhantombotBinary } from "./binaryIdentity.ts";
import { serviceLogDir } from "./platform.ts";

/** Per-file size above which a log is rotated. */
export const DEFAULT_MAX_BYTES = 16 * 1024 * 1024;
/** How many rotated generations to retain per log file. */
export const DEFAULT_KEEP = 3;
/** A lock older than this is treated as abandoned by a crashed rotation. */
export const LOCK_STALE_MS = 5 * 60_000;

const LOCK_FILE = ".rotate.lock";

export interface RotateLogDirInput {
  /** Directory of `*.log` files to rotate. */
  dir: string;
  /** Rotate a file once it exceeds this many bytes. Default 16 MiB. */
  maxBytes?: number;
  /** Retained generations per file; 0 discards instead of keeping. Default 3. */
  keep?: number;
  /** Injectable clock, for lock staleness. Default `new Date()`. */
  now?: Date;
}

export interface RotatedLog {
  /** Base name of the rotated log. */
  file: string;
  /** Size in bytes at the moment it was rotated. */
  bytes: number;
}

export interface SkippedLog {
  file: string;
  /** Error code (`EBUSY`, `EACCES`, …) or message. */
  reason: string;
}

export interface RotateLogDirResult {
  dir: string;
  rotated: RotatedLog[];
  /** Files that were over the cap but could not be rotated. */
  skipped: SkippedLog[];
  /** True when another rotation holds the directory lock; nothing was done. */
  lockedOut: boolean;
}

/**
 * Read the numeric override from `name`, ignoring anything that isn't a
 * finite, non-negative number. A typo'd env var must never disable rotation
 * or set a nonsense cap — it falls back to the default instead.
 */
function numericEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === "") return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) return fallback;
  return Math.floor(n);
}

/** Configured per-file cap (`PHANTOMBOT_LOG_MAX_BYTES`, else 16 MiB). */
export function configuredMaxBytes(): number {
  const n = numericEnv("PHANTOMBOT_LOG_MAX_BYTES", DEFAULT_MAX_BYTES);
  // 0 would mean "rotate on every pass", which is a footgun, not a setting.
  return n > 0 ? n : DEFAULT_MAX_BYTES;
}

/** Configured retained generations (`PHANTOMBOT_LOG_KEEP`, else 3). */
export function configuredKeep(): number {
  return numericEnv("PHANTOMBOT_LOG_KEEP", DEFAULT_KEEP);
}

/**
 * Take the directory lock. Two personas' heartbeats can fire at the same
 * second and both target the same shared log directory; without this they can
 * interleave the generation shift and lose (or duplicate) a generation.
 * Returns false when a FRESH lock is already held — a stale one is stolen, so
 * a crashed rotation cannot wedge rotation forever.
 */
async function acquireLock(dir: string, now: Date): Promise<boolean> {
  const path = join(dir, LOCK_FILE);
  try {
    await writeFile(path, `${process.pid} ${now.toISOString()}\n`, {
      flag: "wx",
    });
    return true;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
  }
  let heldAt: number | undefined;
  try {
    const body = await readFile(path, "utf8");
    const iso = body.trim().split(/\s+/)[1];
    const t = iso ? Date.parse(iso) : Number.NaN;
    if (Number.isFinite(t)) heldAt = t;
  } catch {
    // Unreadable lock — fall through and treat it as stale.
  }
  if (heldAt !== undefined && now.getTime() - heldAt < LOCK_STALE_MS) {
    return false;
  }
  await writeFile(path, `${process.pid} ${now.toISOString()}\n`);
  return true;
}

async function releaseLock(dir: string): Promise<void> {
  try {
    await unlink(join(dir, LOCK_FILE));
  } catch {
    // Already gone (stolen as stale by another pass) — nothing to release.
  }
}

/**
 * Absolute paths of `<path>.<n>` generations with `n >= min`, newest first.
 */
async function generationsAtLeast(
  path: string,
  min: number,
): Promise<string[]> {
  const dir = dirname(path);
  const prefix = `${basename(path)}.`;
  const hits: string[] = [];
  for (const name of await readdir(dir)) {
    if (!name.startsWith(prefix)) continue;
    const n = Number(name.slice(prefix.length));
    if (Number.isInteger(n) && n >= min) hits.push(join(dir, name));
  }
  return hits;
}

/**
 * Shift `<path>.1 … .N` up by one, dropping the oldest, then copy the live
 * file into `.1` and truncate it in place.
 */
async function rotateOne(path: string, keep: number): Promise<void> {
  if (keep > 0) {
    // Prune every generation at or beyond `keep` before shifting. `.${keep}`
    // alone would be handled by the rename below overwriting it, but a keep
    // that was LOWERED (or a leftover from an older install) strands `.4`,
    // `.5`, … on disk forever — files nothing rotates and nothing ever
    // deletes, which is the same unbounded growth one directory deeper. Scan
    // rather than counting up from `keep`, so a GAP in the sequence cannot
    // hide everything above it.
    for (const dead of await generationsAtLeast(path, keep)) {
      await unlink(dead);
    }
    for (let i = keep - 1; i >= 1; i--) {
      const from = `${path}.${i}`;
      if (existsSync(from)) await rename(from, `${path}.${i + 1}`);
    }
    // Copy BEFORE truncating: if the copy fails we throw with the live file
    // still intact, which is the direction we want to fail in.
    await copyFile(path, `${path}.1`);
  }
  await truncate(path, 0);
}

/**
 * Rotate every `*.log` in `dir` that exceeds the size cap. Already-rotated
 * generations (`*.log.1`) are not candidates — the `.log` suffix test excludes
 * them, so a generation is never rotated twice.
 *
 * Never throws for a single unrotatable file: on Windows the live log can be
 * locked by the writing `cmd`, which surfaces as EBUSY/EPERM. That file is
 * reported in `skipped` and the pass continues.
 */
export async function rotateLogDir(
  input: RotateLogDirInput,
): Promise<RotateLogDirResult> {
  const { dir } = input;
  const maxBytes = input.maxBytes ?? configuredMaxBytes();
  const keep = input.keep ?? configuredKeep();
  const now = input.now ?? new Date();
  const result: RotateLogDirResult = {
    dir,
    rotated: [],
    skipped: [],
    lockedOut: false,
  };
  if (!existsSync(dir)) return result;

  if (!(await acquireLock(dir, now))) {
    result.lockedOut = true;
    return result;
  }
  try {
    const names = (await readdir(dir)).filter((n) => n.endsWith(".log"));
    for (const name of names.sort()) {
      const path = join(dir, name);
      try {
        const s = await stat(path);
        if (!s.isFile() || s.size <= maxBytes) continue;
        await rotateOne(path, keep);
        result.rotated.push({ file: name, bytes: s.size });
      } catch (e) {
        const err = e as NodeJS.ErrnoException;
        result.skipped.push({ file: name, reason: err.code ?? err.message });
      }
    }
  } finally {
    await releaseLock(dir);
  }
  return result;
}

/** Read-only view of a log directory, for `doctor`. */
export interface LogDirStats {
  /** Total bytes of every `*.log*` file (live and rotated) under `dir`. */
  bytes: number;
  /** Live logs already over the cap; the next pass rotates these. */
  overCap: string[];
}

/**
 * Size up a log directory without touching it. Takes no lock and renames
 * nothing, so it is safe to call while a rotation is in flight — a file that
 * vanishes mid-scan simply contributes nothing.
 */
export async function inspectLogDir(
  dir: string,
  maxBytes = configuredMaxBytes(),
): Promise<LogDirStats> {
  const stats: LogDirStats = { bytes: 0, overCap: [] };
  if (!existsSync(dir)) return stats;
  for (const name of (await readdir(dir)).sort()) {
    if (!name.includes(".log")) continue;
    try {
      const s = await stat(join(dir, name));
      if (!s.isFile()) continue;
      stats.bytes += s.size;
      // Only LIVE logs are rotation candidates; a `.log.1` generation is
      // already rotated and is never a candidate again.
      if (name.endsWith(".log") && s.size > maxBytes) stats.overCap.push(name);
    } catch {
      // Raced with a rotation — a missing file contributes nothing.
    }
  }
  return stats;
}

/** Input for {@link rotateServiceLogs}; both fields exist to be injected. */
export interface RotateServiceLogsInput {
  /**
   * Log directory to cap. Defaults to the host's service log directory, and
   * `null` means "this platform has none" (Linux → journald).
   */
  dir?: string | null;
  /**
   * Whether we are the INSTALLED binary. Defaults to a real check of
   * `process.execPath`.
   */
  installed?: boolean;
}

/**
 * Rotate the host's service logs, or return null when there is nothing to do.
 *
 * Guarded on binary identity for the same reason the service self-heal is: a
 * dev `bun src/index.ts` run (or a test that reaches production code by
 * accident) shares the developer's real `~/Library/Logs/phantombot`, and
 * truncating a developer's logs from a unit test is not an acceptable
 * side effect of running the suite.
 */
export async function rotateServiceLogs(
  input: RotateServiceLogsInput = {},
): Promise<RotateLogDirResult | null> {
  const installed = input.installed ?? isPhantombotBinary(process.execPath);
  if (!installed) return null;
  const dir = input.dir !== undefined ? input.dir : serviceLogDir();
  if (!dir) return null;
  return rotateLogDir({ dir });
}
