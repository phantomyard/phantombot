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
 * Acquisition: O_EXCL create with our PID inside. On EEXIST, read the
 * existing PID and check via `process.kill(pid, 0)` whether the holder
 * is still alive. If dead (stale lock from a crash), reclaim. If alive,
 * report the conflict.
 */

import { existsSync, mkdirSync, openSync, readFileSync, unlinkSync, writeSync, closeSync } from "node:fs";
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
  const uid = process.getuid?.() ?? 0;
  return join("/tmp", `phantombot-${uid}.run.lock`);
}

/**
 * Try to acquire the lock. Returns either a LockHandle (success) or a
 * LockConflict (another process holds it). Stale locks (PID dead) are
 * reclaimed transparently.
 */
export function acquireRunLock(path: string): LockHandle | LockConflict {
  mkdirSync(dirname(path), { recursive: true });

  const tryCreate = (): boolean => {
    try {
      const fd = openSync(path, "wx"); // O_CREAT | O_EXCL
      writeSync(fd, String(process.pid));
      closeSync(fd);
      return true;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "EEXIST") return false;
      throw e;
    }
  };

  if (tryCreate()) return makeHandle(path);

  // Lock exists. Inspect the holder.
  let holderPid = NaN;
  try {
    holderPid = Number(readFileSync(path, "utf8").trim());
  } catch {
    // File disappeared between our create attempt and the read — race.
  }

  if (Number.isInteger(holderPid) && holderPid > 0 && pidIsAlive(holderPid)) {
    return { path, pid: holderPid };
  }

  // Stale (or unreadable). Try to reclaim.
  try {
    unlinkSync(path);
  } catch {
    /* it might have been removed by someone else; the next create will tell us */
  }
  if (tryCreate()) return makeHandle(path);

  // Race lost — someone grabbed it between our unlink and our create.
  // Read the current holder PID one more time and report.
  try {
    holderPid = Number(readFileSync(path, "utf8").trim());
  } catch {
    holderPid = NaN;
  }
  return { path, pid: Number.isInteger(holderPid) ? holderPid : NaN };
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
        const content = readFileSync(path, "utf8").trim();
        if (Number(content) === process.pid) unlinkSync(path);
      } catch {
        /* fine — already gone or unreadable */
      }
    },
  };
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

/** Type guard. */
export function isLockHandle(
  r: LockHandle | LockConflict,
): r is LockHandle {
  return typeof (r as LockHandle).release === "function";
}

/** Used by tests to check if a file is locked without actually creating it. */
export { existsSync as _lockFileExists };
