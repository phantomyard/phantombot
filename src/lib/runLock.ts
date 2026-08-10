/**
 * Single-instance lock for `phantombot run`.
 *
 * Prevents two phantombot run processes from racing each other on the
 * same Telegram bot token (would cause sporadic duplicate replies and
 * missed messages — Telegram getUpdates serves whichever long-poll
 * arrives first per update).
 *
 * Lock file lives at $XDG_RUNTIME_DIR/phantombot.run.lock if available
 * (tmpfs, cleaned on reboot — ideal), else /tmp/phantombot-<uid>.run.lock.
 *
 * Acquisition: O_EXCL create with our identity inside. On EEXIST, read the
 * existing holder and decide whether it's still alive (reclaim if not).
 *
 * ── PID REUSE — why we record more than a bare PID (item d) ──
 * Liveness used to be a bare `process.kill(pid, 0)`. That has a nasty failure
 * mode: PIDs are recycled. If phantombot crashes holding the lock and the OS
 * later hands that same numeric PID to some UNRELATED process (a cron job, a
 * shell, anything), `kill(pid,0)` succeeds and we conclude "the lock is still
 * held" — forever. phantombot then refuses to start, with no real conflict.
 *
 * Fix: alongside the PID we record a process-INSTANCE token — the kernel boot
 * id plus the process start-time from /proc/<pid>/stat. PID + boot + start-time
 * uniquely identifies one process instance; a recycled PID has a DIFFERENT
 * start-time, so we can tell "the original phantombot is alive" from "a
 * stranger inherited its PID" and reclaim the stale lock in the latter case.
 *
 * The token is best-effort and platform-specific: /proc on Linux, CIM
 * (Win32_Process.CreationDate) on Windows. On platforms where we can't read it
 * (macOS), we degrade to the old PID-only liveness check — no worse than
 * before. The only cost of the degraded path is that a crash-then-PID-recycle
 * can make a stale lock look live until the lock file is removed.
 *
 * ── Why Windows needs this MORE than Linux (2026-07-10) ──
 * The daemon is force-killed (`taskkill /F`) on every stop/restart/self-update,
 * so `release()` never runs and the lock FILE always survives its holder. The
 * next daemon start therefore ALWAYS lands on the stale-lock path and leans
 * entirely on the liveness check. With bare PID liveness, a recycled PID makes
 * a dead holder look alive and phantombot refuses to start — permanently, until
 * someone deletes %TEMP%\phantombot.run.lock by hand. That's a wedged bot with
 * no error anyone would think to look for, which is why the degraded path is
 * no longer acceptable here.
 */

import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeSync,
  closeSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

export interface LockHandle {
  /** Path to the lock file. */
  path: string;
  /** Release the lock — removes the file. Idempotent. */
  release: () => void;
}

export interface LockConflict {
  /** Path the lock lives at. */
  path: string;
  /** PID held in the lock file (NaN if file existed but unparseable). */
  pid: number;
}

export function defaultLockPath(): string {
  const xdg = process.env.XDG_RUNTIME_DIR;
  if (xdg) return join(xdg, "phantombot.run.lock");
  // Windows has no XDG_RUNTIME_DIR and no uid. `os.tmpdir()` resolves to the
  // per-user %TEMP% (…\AppData\Local\Temp), which is already user-scoped, so a
  // single filename there won't collide across accounts the way /tmp would.
  if (process.platform === "win32") {
    return join(tmpdir(), "phantombot.run.lock");
  }
  const uid = process.getuid?.() ?? 0;
  return join("/tmp", `phantombot-${uid}.run.lock`);
}

/**
 * The lock file payload: PID on line 1, instance token on line 2.
 * The token may be empty when /proc isn't available — callers tolerate that.
 */
function lockPayload(): string {
  return `${process.pid}\n${processInstanceToken(process.pid) ?? ""}`;
}

interface ParsedLock {
  pid: number;
  /** Instance token recorded at lock time, or "" if none was written. */
  token: string;
}

function parseLock(raw: string): ParsedLock {
  const [pidLine = "", tokenLine = ""] = raw.split("\n");
  return { pid: Number(pidLine.trim()), token: tokenLine.trim() };
}

/** Block the calling thread for `ms` without spinning the CPU. */
function sleepSync(ms: number): void {
  // Cap the busy-wait to 2s even if SharedArrayBuffer is unavailable —
  // prevents a pathological spin if something goes wrong.
  const capped = Math.min(ms, 2_000);
  try {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, capped);
  } catch {
    // SharedArrayBuffer unavailable (unusual) — busy-wait as a last resort.
    const until = Date.now() + capped;
    while (Date.now() < until) {
      /* spin */
    }
  }
}

/** Single, non-retrying read of the lock holder; undefined if no file. */
function readHolderOnce(path: string): ParsedLock | undefined {
  try {
    return parseLock(readFileSync(path, "utf8"));
  } catch {
    return undefined; // no file yet, or vanished under us
  }
}

/**
 * Read the lock holder, tolerating the brief window in which a concurrent
 * starter has created the file (O_EXCL winner) but not yet written its PID
 * line. An empty / pid<=0 payload on an EXISTING file almost always means
 * "someone is mid-write", not "genuinely stale" — treating it as stale would
 * unlink a live holder's lock and let a second daemon start. So we re-read a
 * few times over ~1s: a real winner writes its PID microseconds later and we
 * back off correctly; a process that crashed between create and write leaves
 * the file empty forever, so after the deadline we still return it as stale and
 * the caller reclaims it.
 */
function readHolderWithRetry(path: string): ParsedLock {
  const deadlineMs = Date.now() + 1_000;
  let holder: ParsedLock = { pid: NaN, token: "" };
  for (;;) {
    try {
      holder = parseLock(readFileSync(path, "utf8"));
    } catch {
      // File disappeared between our create attempt and the read — race lost;
      // let the caller's reclaim path re-create it.
      return { pid: NaN, token: "" };
    }
    if (Number.isInteger(holder.pid) && holder.pid > 0) return holder;
    if (Date.now() >= deadlineMs) return holder;
    sleepSync(50);
  }
}

/**
 * Try to acquire the lock. Returns either a LockHandle (success) or a
 * LockConflict (another process holds it). Stale locks (holder dead, or a
 * recycled PID) are reclaimed transparently.
 */
export function acquireRunLock(path: string): LockHandle | LockConflict {
  mkdirSync(dirname(path), { recursive: true });

  // Fast path: if a genuine LIVE holder already owns the lock, report the
  // conflict WITHOUT computing our own payload. On Windows `lockPayload()`
  // spawns PowerShell (~300ms–5s); `tick` calls acquireRunLock every minute and
  // conflicts by design once the daemon is up, so paying that spawn on every
  // conflict would add ~1440 PowerShell launches/day of pure churn. A single
  // cheap read avoids it. (An empty / pid<=0 / dead / recycled holder falls
  // through to the create+reclaim path below.)
  const preexisting = readHolderOnce(path);
  if (
    preexisting &&
    Number.isInteger(preexisting.pid) &&
    preexisting.pid > 0 &&
    holderIsAlive(preexisting)
  ) {
    return { path, pid: preexisting.pid };
  }

  // Compute the payload BEFORE creating the file. If `lockPayload()`'s PowerShell
  // spawn ran between `openSync` and `writeSync`, the lock file would sit EMPTY
  // for the whole spawn duration. A second starter reading it in that window
  // sees an empty file → pid parses as 0 → "stale" → it unlinks the live
  // holder's lock and starts its own daemon. Two pollers on one bot token =
  // the getUpdates 409 flood + double-fired turns. Precomputing shrinks the
  // create→write gap to microseconds and reuses one payload across both
  // tryCreate attempts.
  const payload = lockPayload();

  const tryCreate = (): boolean => {
    try {
      const fd = openSync(path, "wx"); // O_CREAT | O_EXCL
      writeSync(fd, payload);
      closeSync(fd);
      return true;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "EEXIST") return false;
      throw e;
    }
  };

  if (tryCreate()) return makeHandle(path);

  // Lock exists. Inspect the holder — tolerating the brief window where a
  // concurrent starter created the file but hasn't written its PID line yet.
  const holder = readHolderWithRetry(path);

  if (
    Number.isInteger(holder.pid) &&
    holder.pid > 0 &&
    holderIsAlive(holder)
  ) {
    return { path, pid: holder.pid };
  }

  // Stale (holder dead, recycled PID, or unreadable). Make the EVICTION the
  // point of mutual exclusion, not the write. Rename the stale file AWAY using
  // the shared `path` as the FIXED rename SOURCE: the OS renames a given source
  // path exactly once, so only ONE racer wins the eviction; every other racer's
  // rename fails with ENOENT (the source is already gone) and adopts whoever
  // wins. A plain rename ONTO `path` would silently overwrite and let two
  // racers both land their own lock — renaming FROM `path` is what makes it
  // exclusive. The subsequent O_EXCL create is a second gate, so exactly one
  // process ever writes the fresh lock.
  const evicted = path + `.evicting.${process.pid}`;
  try {
    renameSync(path, evicted); // fixed SOURCE ⇒ exactly one racer succeeds
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") {
      // Another racer already evicted the stale lock — adopt the winner.
      return adoptCurrentHolder(path);
    }
    throw e;
  }
  // We won the eviction. Drop the stale file and O_EXCL-create our fresh lock.
  try {
    unlinkSync(evicted);
  } catch {
    /* fine — vanished under us */
  }
  if (tryCreate()) return makeHandle(path);
  // A concurrent initial-create landed in the brief gap after we renamed the
  // stale file away (path was momentarily absent). They hold a real O_EXCL
  // lock now — adopt them rather than fight for it.
  return adoptCurrentHolder(path);
}

/**
 * A concurrent starter won the eviction and is (re)creating the lock. Re-read
 * the lock until a live holder appears — the winner needs a moment to unlink the
 * evicted file and O_EXCL-create the fresh one — then report it as a conflict.
 * Bounded so a winner that dies mid-recreate can't hang us forever.
 */
function adoptCurrentHolder(path: string): LockConflict {
  const deadlineMs = Date.now() + 1_000;
  for (;;) {
    const holder = readHolderOnce(path);
    if (holder && Number.isInteger(holder.pid) && holder.pid > 0) {
      return { path, pid: holder.pid };
    }
    if (Date.now() >= deadlineMs) {
      return { path, pid: holder ? holder.pid : NaN };
    }
    sleepSync(50);
  }
}

function makeHandle(path: string): LockHandle {
  let released = false;
  return {
    path,
    release: () => {
      if (released) return;
      released = true;
      try {
        // Only remove if the file still has OUR pid; never clobber a
        // successor's lock (rare race).
        const { pid } = parseLock(readFileSync(path, "utf8"));
        if (pid === process.pid) unlinkSync(path);
      } catch {
        /* fine — already gone or unreadable */
      }
    },
  };
}

/**
 * Is the recorded holder genuinely still the process that took the lock?
 *
 * Two-part test:
 *   1. The PID must be alive (kill(pid,0)).
 *   2. If we recorded an instance token AND can compute the current token for
 *      that PID, they must MATCH. A mismatch means the PID was recycled to a
 *      different process — the original holder is gone, the lock is stale.
 *
 * When no token was recorded, or we can't read /proc (non-Linux), we fall back
 * to bare liveness — the historical behaviour.
 */
function holderIsAlive(holder: ParsedLock): boolean {
  if (!pidIsAlive(holder.pid)) return false;
  if (!holder.token) return true; // no nonce recorded → can't disprove liveness
  const current = processInstanceToken(holder.pid);
  if (current === undefined) return true; // can't compute → don't false-positive a kill
  return current === holder.token;
}

function pidIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    return code === "EPERM"; // exists but not ours; still alive
  }
}

/** Kernel boot id, read once. Distinguishes process instances across reboots. */
let cachedBootId: string | undefined | null = null;
function bootId(): string | undefined {
  if (cachedBootId !== null) return cachedBootId ?? undefined;
  try {
    cachedBootId = readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim();
  } catch {
    cachedBootId = undefined;
  }
  return cachedBootId ?? undefined;
}

/**
 * Windows instance token: the process's creation time, which the kernel stamps
 * per process instance. A recycled PID belongs to a process created later, so
 * its CreationDate differs and the token changes — exactly the property we need.
 *
 * Costs one PowerShell spawn (~300ms). That's tolerable because this runs at
 * most twice per `phantombot run` startup (once to write our own token, once to
 * check the previous holder's) and never on a hot path. Bounded by `timeout` so
 * a wedged PowerShell can't hang daemon startup; on any failure we return
 * undefined and fall back to bare PID liveness.
 *
 * Exported for testing.
 */
export function _windowsInstanceToken(pid: number): string | undefined {
  // The PID is read back out of the lock file; never interpolate it into the
  // CIM filter without proving it's a plain positive integer.
  if (!Number.isInteger(pid) || pid <= 0) return undefined;
  try {
    const out = execFileSync(
      "powershell",
      [
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        `(Get-CimInstance Win32_Process -Filter "ProcessId=${pid}")` +
          `.CreationDate.ToUniversalTime().ToString('o')`,
      ],
      {
        encoding: "utf8",
        timeout: 5_000,
        windowsHide: true,
        stdio: ["ignore", "pipe", "ignore"],
      },
    ).trim();
    return out ? `win:${out}` : undefined;
  } catch {
    // PowerShell missing, timed out, or the PID vanished mid-query.
    return undefined;
  }
}

/**
 * A token that uniquely identifies a running process instance: boot id +
 * the process start-time (field 22 of /proc/<pid>/stat, in clock ticks since
 * boot). Recycled PIDs get a different start-time, so the token changes.
 *
 * On Windows we use the CIM creation-time token instead. Returns undefined when
 * neither is available (e.g. macOS) — callers treat that as "fall back to bare
 * PID liveness".
 */
function processInstanceToken(pid: number): string | undefined {
  if (process.platform === "win32") return _windowsInstanceToken(pid);
  const boot = bootId();
  if (boot === undefined) return undefined;
  try {
    // The comm field (in parens) can contain spaces/parens, so anchor parsing
    // on the LAST ')' and split the remainder; starttime is field 22 overall,
    // i.e. index 19 of the post-')' fields (state is field 3 / index 0).
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    const after = stat.slice(stat.lastIndexOf(")") + 1).trim().split(/\s+/);
    const starttime = after[19];
    if (!starttime) return undefined;
    return `${boot}:${starttime}`;
  } catch {
    return undefined;
  }
}

/** Type guard. */
export function isLockHandle(
  r: LockHandle | LockConflict,
): r is LockHandle {
  return typeof (r as LockHandle).release === "function";
}

/** Used by tests to check if a file is locked without actually creating it. */
export { existsSync as _lockFileExists };
