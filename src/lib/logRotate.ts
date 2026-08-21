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
  rm,
  stat,
  truncate,
  unlink,
  writeFile,
} from "node:fs/promises";
import { randomUUID } from "node:crypto";
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
/**
 * Second lock, taken ONLY to serialise the takeover of a stale {@link
 * LOCK_FILE}. Every mutation of the real lock happens while holding this, so
 * "is it still stale?" can be re-checked without a race.
 */
const STEAL_FILE = ".rotate.lock.steal";

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

/** Contents of a held lock: owner pid, when it was taken, and its token. */
interface LockHolder {
  heldAt?: number;
  token?: string;
}

async function readLock(path: string): Promise<LockHolder | null> {
  let body: string;
  try {
    body = await readFile(path, "utf8");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return null;
    // Unreadable but present — treat it as a holder with no timestamp, which
    // makes it stale (and therefore stealable) rather than permanent.
    return {};
  }
  const [, iso, token] = body.trim().split(/\s+/);
  const t = iso ? Date.parse(iso) : Number.NaN;
  return { heldAt: Number.isFinite(t) ? t : undefined, token };
}

function isStale(holder: LockHolder, now: Date): boolean {
  if (holder.heldAt === undefined) return true;
  return now.getTime() - holder.heldAt >= LOCK_STALE_MS;
}

/** Create the lock exclusively. Returns our token, or null if it exists. */
async function createLock(path: string, now: Date): Promise<string | null> {
  const token = randomUUID();
  try {
    await writeFile(path, `${process.pid} ${now.toISOString()} ${token}\n`, {
      flag: "wx",
    });
    return token;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
    return null;
  }
}

/**
 * Take the directory lock. Two personas' heartbeats can fire at the same
 * second and both target the same shared log directory; without this they can
 * interleave the generation shift and lose (or duplicate) a generation.
 * Returns the owner token, or null when a FRESH lock is already held.
 *
 * Takeover of a STALE lock (left by a crashed pass, so rotation cannot wedge
 * forever) is the delicate part: a plain overwrite lets every contender that
 * read the same stale timestamp decide it won. So the steal is serialised by a
 * SECOND exclusive create — `wx` is atomic on every supported platform — and
 * the winner re-reads the lock while holding it. A contender that was looking
 * at a now-superseded stale lock therefore sees the successor's FRESH lock and
 * backs out instead of clobbering it. Exactly one contender enters.
 */
export async function acquireLock(dir: string, now: Date): Promise<string | null> {
  const path = join(dir, LOCK_FILE);
  const stealPath = join(dir, STEAL_FILE);

  const direct = await createLock(path, now);
  if (direct) return direct;

  const holder = await readLock(path);
  // Vanished between the create and the read — one more uncontended attempt.
  if (!holder) return await createLock(path, now);
  if (!isStale(holder, now)) return null;

  // Serialise the steal. Only the winner of this create may touch the lock.
  if (!(await createLock(stealPath, now))) {
    // Someone else is stealing right now, or crashed mid-steal. A steal lock
    // that is itself stale is cleared here so the NEXT pass can proceed;
    // clearing and stealing in one pass would reintroduce the race.
    const stealHolder = await readLock(stealPath);
    if (stealHolder && isStale(stealHolder, now)) {
      await rm(stealPath, { force: true });
    }
    return null;
  }
  try {
    // Re-check under the steal lock: this is the read that cannot be raced.
    const current = await readLock(path);
    if (current && !isStale(current, now)) return null;
    await rm(path, { force: true });
    return await createLock(path, now);
  } finally {
    await rm(stealPath, { force: true });
  }
}

/** Options for {@link releaseLock}. */
export interface ReleaseLockOptions {
  /** Injectable clock, for staleness of the steal lock. Default `new Date()`. */
  now?: Date;
  /**
   * Test hook, awaited between the ownership read and the unlink, i.e. exactly
   * at the interleave a check-then-unlink release would lose. Not used in
   * production.
   */
  afterOwnershipRead?: () => Promise<void>;
}

/**
 * Release a lock we own. Ownership is checked against the token we wrote: a
 * pass whose lock was stolen as stale must not delete the successor's lock and
 * hand a third pass the directory mid-rotation.
 *
 * The token check alone is not enough, because reading the token and deleting
 * the file are two syscalls. A pass that overran {@link LOCK_STALE_MS} still
 * holds a lock any contender may steal, so the steal can land BETWEEN our read
 * (which still returns our own token) and our unlink (which would then remove
 * the successor's fresh lock, letting a third pass in mid-rotation). So the
 * release runs under the same {@link STEAL_FILE} lock that serialises takeover
 * in {@link acquireLock}: every mutation of the real lock — steal and release
 * alike — happens while holding it, which makes the check and the unlink
 * atomic with respect to each other.
 *
 * If the steal lock cannot be taken, a takeover is in flight right now (or a
 * pass crashed mid-steal). Either way we return WITHOUT deleting: not deleting
 * is always safe (a leftover lock is stale within {@link LOCK_STALE_MS} and
 * stealable by the next pass), whereas deleting under a racing takeover is the
 * bug this guards. A steal lock that is itself stale is cleared on the way out
 * so it cannot wedge later passes — but, exactly as in {@link acquireLock},
 * clearing and then taking it in the same pass would reintroduce the race: the
 * original steal holder may be paused just before its own mutation of the real
 * lock, and would install its successor into the window we just opened.
 *
 * Exported (with {@link acquireLock}) so the lock protocol itself can be
 * driven directly from tests; nothing outside this module calls it.
 */
export async function releaseLock(
  dir: string,
  token: string,
  options: ReleaseLockOptions = {},
): Promise<void> {
  const now = options.now ?? new Date();
  const path = join(dir, LOCK_FILE);
  const stealPath = join(dir, STEAL_FILE);

  const held = await createLock(stealPath, now);
  if (!held) {
    // A steal lock left behind by a crashed pass must not wedge later passes,
    // so clear it once it is itself stale — but do NOT take it here. Leaving
    // our own lock in place is safe; it goes stale and the next pass steals it.
    const stealHolder = await readLock(stealPath);
    if (stealHolder && isStale(stealHolder, now)) {
      await rm(stealPath, { force: true });
    }
    return;
  }

  try {
    const holder = await readLock(path);
    if (options.afterOwnershipRead) await options.afterOwnershipRead();
    if (!holder || holder.token !== token) return;
    try {
      await unlink(path);
    } catch {
      // Already gone — nothing to release.
    }
  } finally {
    await rm(stealPath, { force: true });
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
 * Snapshot the live file into `.1` and truncate it in place, shifting the
 * existing generations up by one and dropping anything beyond `keep`.
 *
 * ORDER MATTERS. The copy is the step most likely to fail (on Windows the live
 * log can be held by the writing `cmd`, which surfaces as EBUSY/EACCES), and
 * pruning/shifting first would mean a file that never manages to copy loses a
 * generation on every heartbeat until all retained history is gone — without
 * ever producing a new snapshot. So the copy goes to a temporary file in the
 * same directory FIRST; only once those bytes are safely on disk are the
 * existing generations touched, and the snapshot is published with a rename.
 * Every failure path removes the temporary and leaves the live file and all
 * generations exactly as they were.
 *
 * `keep === 0` means "discard", not "keep what is already there": every
 * numbered generation is pruned and no new snapshot is taken.
 */
async function rotateOne(path: string, keep: number): Promise<void> {
  if (keep > 0) {
    // Not `*.log`, and not a numeric generation, so neither the rotation scan
    // nor the prune scan can ever mistake it for a log.
    const tmp = `${path}.rotating-${randomUUID()}`;
    try {
      await copyFile(path, tmp);
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
      await rename(tmp, `${path}.1`);
    } catch (e) {
      await rm(tmp, { force: true });
      throw e;
    }
  } else {
    for (const dead of await generationsAtLeast(path, 1)) {
      await unlink(dead);
    }
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

  const token = await acquireLock(dir, now);
  if (!token) {
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
    await releaseLock(dir, token);
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
