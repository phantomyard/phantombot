/**
 * Is a recorded pid still the process that recorded it?
 *
 * Extracted verbatim from `lib/nightly.ts` (#403), where it was written to stop
 * the nightly sweep deferring to a dead owner. Issue #391 needs exactly the same
 * question answered about a different kind of owner — an in-flight TURN — so the
 * primitives live here and `nightly.ts` re-exports them for back-compat.
 *
 * The pairing matters. `kill(pid, 0)` alone answers "does this number name a
 * process", which is not the question: pids wrap, so an unrelated process can
 * inherit the number and be reported alive long after the owner died. The
 * kernel's start time for the pid disambiguates, because a reused pid is
 * necessarily a different process with a different start.
 *
 * A null token means "can't tell" and must NEVER be treated as "different" —
 * every caller falls back to the pid check alone, which is strictly better than
 * no check at all.
 */

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

/** Probe seam so tests don't have to conjure real pids. */
export type ProcessAliveProbe = (pid: number) => boolean;

/** Probe seam for the start-time half of the identity check. */
export type ProcessStartProbe = (pid: number) => string | null;

/**
 * Does this pid name a process that exists on this box?
 *
 * `kill(pid, 0)` sends no signal — it only runs the kernel's permission and
 * existence checks. ESRCH means gone; EPERM means it exists but belongs to
 * another user, which still counts as alive.
 */
export function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
}

/**
 * An opaque token that identifies WHICH process currently holds `pid`.
 *
 * Returns `null` when the platform has no cheap probe or the read fails; the
 * caller then falls back to the pid check alone. Only ever compared for
 * equality with a token produced the same way, so the format is deliberately
 * unspecified.
 */
export function processStartToken(pid: number): string | null {
  try {
    if (process.platform === "linux") {
      // /proc/<pid>/stat field 22 (starttime, in clock ticks since boot).
      // comm (field 2) is parenthesised and may itself contain spaces and
      // parens, so split AFTER the last ')' — field 3 lands at index 0.
      const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
      const tail = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
      return tail[19] ?? null;
    }
    if (process.platform === "darwin") {
      const out = execFileSync("ps", ["-o", "lstart=", "-p", String(pid)], {
        encoding: "utf8",
        timeout: 5_000,
        stdio: ["ignore", "pipe", "ignore"],
      });
      return out.trim() || null;
    }
  } catch {
    // Process gone, permission denied, no procfs, ps missing — all mean
    // "can't tell", and "can't tell" must never masquerade as a match.
  }
  return null;
}

/** Our own token never changes, and on darwin it costs a fork. Compute once. */
let ownStartToken: string | null | undefined;
export function selfStartToken(): string | null {
  if (ownStartToken === undefined) ownStartToken = processStartToken(process.pid);
  return ownStartToken;
}

/**
 * Is the process that recorded `pid` + `pidStart` still the one holding `pid`?
 *
 * The shared shape of the #402 and #391 checks: dead pid → gone; live pid whose
 * start token has changed → the number was recycled, so the original owner is
 * also gone. An absent or unreadable token leaves the pid check as the verdict.
 */
export function isSameProcess(
  pid: number,
  pidStart: string | undefined,
  isAlive: ProcessAliveProbe = isProcessAlive,
  startToken: ProcessStartProbe = processStartToken,
): boolean {
  if (!isAlive(pid)) return false;
  if (!pidStart) return true;
  const seen = startToken(pid);
  return seen === null || seen === pidStart;
}
