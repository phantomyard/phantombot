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
    if (process.platform === "win32") return windowsStartToken(pid);
  } catch {
    // Process gone, permission denied, no procfs, ps missing — all mean
    // "can't tell", and "can't tell" must never masquerade as a match.
  }
  return null;
}


/**
 * Pull the first CIM datetime out of a `CreationDate` query.
 *
 * Split from the spawn so the parsing is testable off-Windows. Two shapes reach
 * here, because two probes can answer:
 *
 *   PowerShell round-trip   `2026-08-19T14:22:31.1234567+02:00`
 *   wmic CIM_DATETIME       `20260819142231.123456+120`
 *
 * Both carry sub-second precision, which is what makes them usable as identity:
 * a pid is not reissued twice within the same 100ns tick. Anything else — an
 * empty result for a pid that has already exited, a localized error, a header
 * row — yields null, which every caller reads as "can't tell" rather than as a
 * mismatch.
 */
export function parseWindowsStart(out: string): string | null {
  for (const raw of out.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || /^CreationDate$/i.test(line)) continue;
    // ISO 8601 (PowerShell -Format o) or CIM_DATETIME (wmic). Nothing else is
    // accepted: a partial match would be an identity that changes on its own.
    if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/.test(line)) return line;
    if (/^\d{14}\.\d{6}[+-]\d{1,4}$/.test(line)) return line;
  }
  return null;
}

/**
 * Windows half of the identity check.
 *
 * Without this every Windows ticket was written with NO `pid_start`, so the
 * only question the recovery path could ask was `kill(pid, 0)` — and Windows
 * recycles pids briskly. A guard process that crashed mid-section, whose pid was
 * then reissued, read as a live owner forever: the workspace wedged with no age
 * escape, and adding one would have reintroduced the two-writer race the
 * ownership rule exists to prevent. The missing piece was identity, not a
 * timeout.
 *
 * `Win32_Process.CreationDate` is the natural answer: the kernel's own creation
 * timestamp for the process currently holding that pid, at 100ns resolution.
 * Two probes, tried in order, because neither is present everywhere:
 *
 *   - PowerShell + `Get-CimInstance` — present on every supported Windows, but
 *     costs a few hundred ms of interpreter start.
 *   - `wmic` — cheaper, and the fallback rather than the default because it is
 *     deprecated and absent from recent Windows builds.
 *
 * Cost is paid only when another ticket is actually present: an uncontended
 * acquire never probes anyone, and our OWN token is computed once per process.
 * A pid is interpolated into the query only after an integer check, so no
 * caller-supplied text can reach the command line.
 */
function windowsStartToken(pid: number): string | null {
  if (!Number.isInteger(pid) || pid <= 0) return null;
  const probes: [string, string[]][] = [
    [
      "powershell.exe",
      [
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        `$p = Get-CimInstance Win32_Process -Filter "ProcessId=${pid}"; ` +
          `if ($p) { $p.CreationDate.ToString("o") }`,
      ],
    ],
    [
      "wmic",
      ["process", "where", `ProcessId=${pid}`, "get", "CreationDate"],
    ],
  ];
  for (const [cmd, args] of probes) {
    try {
      const out = execFileSync(cmd, args, {
        encoding: "utf8",
        timeout: 10_000,
        stdio: ["ignore", "pipe", "ignore"],
      });
      const parsed = parseWindowsStart(out);
      if (parsed !== null) return parsed;
    } catch {
      // Missing interpreter, blocked by policy, or the process exited between
      // the liveness check and this call. Try the next probe.
    }
  }
  return null;
}

/**
 * Our own token never changes, and off Linux it costs a fork (a PowerShell
 * start on Windows). Compute once.
 */
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
