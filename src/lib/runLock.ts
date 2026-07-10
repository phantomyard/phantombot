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

/**
 * Try to acquire the lock. Returns either a LockHandle (success) or a
 * LockConflict (another process holds it). Stale locks (holder dead, or a
 * recycled PID) are reclaimed transparently.
 */
export function acquireRunLock(path: string): LockHandle | LockConflict {
  mkdirSync(dirname(path), { recursive: true });

  const tryCreate = (): boolean => {
    try {
      const fd = openSync(path, "wx"); // O_CREAT | O_EXCL
      writeSync(fd, lockPayload());
      closeSync(fd);
      return true;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "EEXIST") return false;
      throw e;
    }
  };

  if (tryCreate()) return makeHandle(path);

  // Lock exists. Inspect the holder.
  let holder: ParsedLock = { pid: NaN, token: "" };
  try {
    holder = parseLock(readFileSync(path, "utf8"));
  } catch {
    // File disappeared between our create attempt and the read — race.
  }

  if (
    Number.isInteger(holder.pid) &&
    holder.pid > 0 &&
    holderIsAlive(holder)
  ) {
    return { path, pid: holder.pid };
  }

  // Stale (holder dead, recycled PID, or unreadable). Try to reclaim.
  try {
    unlinkSync(path);
  } catch {
    /* it might have been removed by someone else; the next create will tell us */
  }
  if (tryCreate()) return makeHandle(path);

  // Race lost — someone grabbed it between our unlink and our create.
  // Read the current holder PID one more time and report.
  try {
    holder = parseLock(readFileSync(path, "utf8"));
  } catch {
    holder = { pid: NaN, token: "" };
  }
  return { path, pid: Number.isInteger(holder.pid) ? holder.pid : NaN };
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
