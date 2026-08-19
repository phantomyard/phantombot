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
 *
 * ── Cost is a correctness concern here, not a nicety ──
 * On Linux the token is a `/proc` read: free, and the reason this module could
 * be written without thinking about cost. Off Linux there is no such file, so
 * the token costs a CHILD PROCESS — and this probe sits on two hot paths: every
 * `registerTurn`, and every foreign ticket examined by the workspace guard,
 * whose whole budget is a few tens of milliseconds. Shipped unbounded, that made
 * an uncontended Windows guard spawn dozens of interpreters and blew a 5s
 * in-process registry test to 5021ms. Three rules keep it honest:
 *
 *   1. Ask the CHEAP probe first, with a timeout sized to a hot path.
 *   2. Ask once per pid and remember the answer briefly (`SPAWN_TOKEN_TTL_MS`).
 *   3. Remember WHICH probe works — including "none of them do" — so a box that
 *      blocks the interpreter pays for that discovery once, not forever.
 *
 * Every one of those can only make an answer stale in the direction of "the
 * holder is still alive", which is the direction that keeps two writers out of
 * one workspace. Staleness that resolves itself in seconds beats a live holder
 * evicted because the probe was too slow to answer.
 */

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

/** Probe seam so tests don't have to conjure real pids. */
export type ProcessAliveProbe = (pid: number) => boolean;

/** Probe seam for the start-time half of the identity check. */
export type ProcessStartProbe = (pid: number) => string | null;

/**
 * How long a spawn-derived token stays good for.
 *
 * Only ever consulted for a pid we already believe is ALIVE, and a live
 * process's start time cannot change, so the only way a cached token misleads
 * is pid reuse inside the window — which reads as "same owner", i.e. still
 * held. Short enough that even that self-heals in seconds; long enough that a
 * whole guard acquisition (six attempts, ~120ms) probes each pid once.
 */
const SPAWN_TOKEN_TTL_MS = 15_000;

/** Bound on the memo, so a long-lived process cannot accumulate dead pids. */
const SPAWN_TOKEN_CACHE_MAX = 256;

/**
 * Timeout for a spawned probe. Sized against the guard's budget rather than
 * against the worst imaginable interpreter start: a probe that takes seconds
 * has already failed at its job, and "can't tell" is a safe answer.
 */
const START_PROBE_TIMEOUT_MS = 3_000;

/**
 * Operator off-switch for the probes that must spawn a helper (`PHANTOMBOT_
 * PROCESS_START_PROBE=0`). Set it where the interpreter is blocked by policy
 * or simply unwanted, and the identity check degrades to the documented
 * pid-only fallback — the behaviour every non-Linux platform had before the
 * Windows token existed. Linux is unaffected: reading `/proc` spawns nothing.
 */
export function osStartProbeEnabled(): boolean {
  const v = process.env.PHANTOMBOT_PROCESS_START_PROBE;
  if (v === undefined) return true;
  return !/^(0|off|false|no)$/i.test(v.trim());
}

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

const spawnTokenCache = new Map<number, { token: string | null; at: number }>();

/**
 * Memoised wrapper for the platforms whose token costs a child process.
 *
 * Exported for tests: the guard asks about the same pid repeatedly, once per
 * retry, and "how many child processes did that cost" is the property under
 * test — not something the returned token can show.
 */
export function cachedSpawnToken(
  pid: number,
  probe: (pid: number) => string | null,
  now: number = Date.now(),
): string | null {
  const hit = spawnTokenCache.get(pid);
  if (hit && now - hit.at < SPAWN_TOKEN_TTL_MS) return hit.token;
  const token = probe(pid);
  // Wholesale clear rather than LRU eviction: the map is a cost optimisation,
  // not state, and the ceiling exists only so it cannot grow without bound.
  if (spawnTokenCache.size >= SPAWN_TOKEN_CACHE_MAX) spawnTokenCache.clear();
  spawnTokenCache.set(pid, { token, at: now });
  return token;
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
      // No child process, so no memo: the read is cheaper than the bookkeeping
      // and stays exact.
      const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
      const tail = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
      return tail[19] ?? null;
    }
    if (process.platform === "darwin") {
      return cachedSpawnToken(pid, darwinStartToken);
    }
    if (process.platform === "win32") {
      return cachedSpawnToken(pid, windowsStartToken);
    }
  } catch {
    // Process gone, permission denied, no procfs, ps missing — all mean
    // "can't tell", and "can't tell" must never masquerade as a match.
  }
  return null;
}

/**
 * Outcome of one spawned probe.
 *
 * The distinction that matters is UNUSABLE vs answered-with-nothing. `wmic`
 * exits non-zero and says "No Instance(s) Available" for a pid that has already
 * gone: that is the probe working correctly, and demoting it for that would
 * make every dead pid re-run the whole discovery ladder.
 */
type ProbeOutcome =
  | { status: "answered"; out: string }
  | { status: "unusable" };

/** Injectable spawn seam — the only part of the ladder that touches the OS. */
export type ProbeRunner = (cmd: string, args: string[]) => ProbeOutcome;

function runProbe(cmd: string, args: string[]): ProbeOutcome {
  try {
    return {
      status: "answered",
      out: execFileSync(cmd, args, {
        encoding: "utf8",
        timeout: START_PROBE_TIMEOUT_MS,
        stdio: ["ignore", "pipe", "ignore"],
        // CREATE_NO_WINDOW. Without it, a phantombot with no console of its own
        // — a scheduled task, a service, a GUI launch — makes Windows allocate
        // a NEW console for each probe, so the user watches black windows flash
        // past. Every other Windows spawn in this repo sets it; this one is on
        // a hot path, so a miss is a strobe rather than a flicker. No-op on
        // POSIX.
        windowsHide: true,
      }),
    };
  } catch (e) {
    return probeOutcomeForError(e as NodeJS.ErrnoException);
  }
}

/**
 * Did the probe FAIL, or did it run and have nothing to say?
 *
 * This distinction is the whole difference between a ladder that settles on a
 * working rung and one that permanently gives up. `wmic` exits non-zero with
 * "No Instance(s) Available" for a pid that has already gone — the probe
 * working exactly as intended. Reading that as a broken probe would demote it,
 * walk the rest of the ladder, and then record "nothing on this box answers"
 * the first time anyone asked about a dead pid, which is the common case.
 *
 * A failure is: the binary is not there, we are not allowed to run it, or it
 * took longer than a hot path can wait. Split out and exported because it
 * cannot be reached through the injected runner the ladder tests use.
 */
export function probeOutcomeForError(
  err: NodeJS.ErrnoException & { signal?: string | null },
): ProbeOutcome {
  // Binary absent, blocked by policy, or too slow to belong on a hot path: the
  // probe itself is no good here, so stop asking it. A `signal` means
  // execFileSync killed it on our own timeout.
  if (err.code === "ENOENT" || err.code === "EACCES" || err.code === "EPERM") {
    return { status: "unusable" };
  }
  if (err.code === "ETIMEDOUT" || err.signal) return { status: "unusable" };
  // Anything else is a non-zero exit: it ran, it just had nothing to say.
  return { status: "answered", out: "" };
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

/** One rung of the Windows ladder: how to ask, and how much it costs. */
interface WindowsProbe {
  /** Stable id, so the pinned choice survives being re-derived. */
  id: "wmic" | "powershell";
  argv: (pid: number) => [string, string[]];
}

/**
 * Cheapest first. This order is the fix, not a preference.
 *
 * `wmic` is a native client: a couple of hundred milliseconds, and where it has
 * been removed (Windows 11 24H2 and newer) it fails ENOENT instantly — so
 * trying it first costs nothing on the machines where it is gone. PowerShell
 * has to start a .NET runtime, which is hundreds of milliseconds warm and
 * SECONDS cold on a loaded CI runner. Asking the expensive one first, as the
 * first cut did, meant every box paid the worst price and the cheap path was
 * never reached.
 */
const WINDOWS_PROBES: WindowsProbe[] = [
  {
    id: "wmic",
    argv: (pid) => [
      "wmic",
      ["process", "where", `ProcessId=${pid}`, "get", "CreationDate"],
    ],
  },
  {
    id: "powershell",
    argv: (pid) => [
      "powershell.exe",
      [
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        `$p = Get-CimInstance Win32_Process -Filter "ProcessId=${pid}"; ` +
          `if ($p) { $p.CreationDate.ToString("o") }`,
      ],
    ],
  },
];

/**
 * Which rung answered last time.
 *
 * `undefined` = not yet discovered, `null` = discovered that NOTHING on this
 * box answers. That second state is the one worth having: on a machine with no
 * wmic and a policy-blocked PowerShell, without it every single liveness
 * question re-runs the whole ladder — two failed spawns — forever.
 */
let winProbeChoice: WindowsProbe["id"] | null | undefined;

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
 *
 * A pid is interpolated into the query only after an integer check, so no
 * caller-supplied text can reach the command line.
 *
 * Exported with an injectable runner so the ladder's cost behaviour — order,
 * pinning, and the give-up state — is testable off Windows. The cost IS the
 * contract here; a version that returns the right token by spawning forty
 * interpreters is a broken one.
 */
export function windowsStartToken(
  pid: number,
  run: ProbeRunner = runProbe,
): string | null {
  if (!Number.isInteger(pid) || pid <= 0) return null;
  if (!osStartProbeEnabled()) return null;
  if (winProbeChoice === null) return null;

  const pinned = WINDOWS_PROBES.find((p) => p.id === winProbeChoice);
  const ladder = pinned ? [pinned] : WINDOWS_PROBES;
  for (const probe of ladder) {
    const [cmd, args] = probe.argv(pid);
    const outcome = run(cmd, args);
    if (outcome.status === "answered") {
      // It ran. Pin it even when the output is empty — a pid that has already
      // exited is a correct empty answer, not a broken probe.
      winProbeChoice = probe.id;
      return parseWindowsStart(outcome.out);
    }
    // The pinned rung has stopped working (uninstalled, newly blocked): fall
    // back to full discovery on the next call rather than answering null for
    // the rest of the process's life.
    if (pinned) {
      winProbeChoice = undefined;
      return null;
    }
  }
  // Nothing on this box answers. Remember it: rediscovery costs two failed
  // spawns, and it is not going to succeed on the next liveness question.
  winProbeChoice = null;
  return null;
}

/** macOS half: `ps` is the only portable source, and it costs a fork. */
function darwinStartToken(pid: number): string | null {
  if (!osStartProbeEnabled()) return null;
  const outcome = runProbe("ps", ["-o", "lstart=", "-p", String(pid)]);
  if (outcome.status !== "answered") return null;
  return outcome.out.trim() || null;
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
 * Drop every memoised probe result and the pinned ladder rung.
 *
 * Tests only: the pinning and the give-up state are deliberately process-wide,
 * so without this one test's discovery leaks into the next one's assertions.
 */
export function resetStartProbeCachesForTests(): void {
  spawnTokenCache.clear();
  winProbeChoice = undefined;
  ownStartToken = undefined;
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
