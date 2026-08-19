/**
 * Advisory locks on SHARED WORKING COPIES (issue #405, gap C of #391).
 *
 * ── The gap ──
 * The #391 collisions did not happen in phantombot's own state. They happened
 * in `/tmp/phantombot-inspect` — a git checkout two turns share, with no lock
 * on it at all. One turn checked out a branch while the other was committing to
 * it. The turn registry (#404) makes each turn AWARE of the other; it does not
 * give them anywhere to serialise, so two turns that both decide to proceed
 * still trample the same tree.
 *
 * ── Honest scope: this is ADVISORY, and cannot be otherwise here ──
 * A turn runs `git` through the harness's own Bash tool. Phantombot does not
 * sit in that path and cannot intercept it, so nothing at this layer can STOP a
 * turn from writing to a checkout it does not hold. What this module provides
 * is a deterministic, crash-safe place to record the claim, and a protocol the
 * prompt teaches. That is a real improvement over the status quo — a turn that
 * ASKS now gets a truthful answer instead of having no way to find out — but it
 * is a cooperative protocol, not an enforcement boundary, and calling it a lock
 * should not be read as a guarantee. Enforcement would need the mutation path
 * itself to take the lock (a git wrapper, or a harness-level hook), which is a
 * bigger change than this one and belongs in its own issue.
 *
 * ── The holder is a TURN, not a process ──
 * First cut of this module tied liveness to `process.pid`, copying the turn
 * registry. That made the whole feature a no-op, and the reason is worth
 * keeping written down: the only caller is `phantombot workspace lock`, a CLI
 * that exits milliseconds after it writes the file, so the recorded pid was
 * always dead by the time anyone read it and every lock pruned itself as stale
 * on the very next query. The daemon process that runs the turn is the wrong
 * answer too — it hosts several turns at once and outlives all of them.
 *
 * So the holder is the TURN, and liveness is delegated to the #404 registry:
 * a lock carrying a `turn_id` is held while that turn is running, and released
 * the moment it is not. `pid` is retained for diagnosis only, never for
 * liveness.
 *
 * ── Crash safety, and what happens when we cannot tell ──
 * A holder that dies without releasing leaves a stale file, broken on
 * inspection rather than by a timer: the registry reports the turn finished (or
 * its owning process died — `isRunning` covers both) and the next query prunes
 * the lock.
 *
 * When the registry cannot answer — it is disabled, or the turn id is not in it
 * at all — we fall back to AGE ALONE and keep the lock until MAX_LOCK_AGE_MS.
 * That direction is deliberate. Guessing "free" on a lock we cannot verify
 * reintroduces exactly the collision this exists to prevent, whereas guessing
 * "held" costs a second turn a `git clone` into a different directory, and is
 * bounded: an hour, `--force`, or a plain `unlock`. Locks taken by hand from a
 * shell carry no turn id and are governed by that same age rule — they are held
 * until released, which is what someone taking a lock by hand means.
 *
 * ── Why not flock ──
 * `flock(2)` would be mandatory-ish and crash-safe for free, and it is what
 * `lib/runLock.ts` uses. It is the wrong tool HERE for the same reason pid
 * liveness was: an fd-backed lock dies with the process that opened it, and the
 * holder we need to represent outlives the CLI that claims it. We also need to
 * answer "who holds it, and since when" from a DIFFERENT process, which an fd
 * cannot tell you. So: a JSON file, plus the registry for liveness.
 *
 * Toggle: `PHANTOMBOT_WORKSPACE_LOCKS=0/off/false/no` disables — every acquire
 * succeeds and every query reports unheld, which is the pre-#405 behaviour.
 */

import { createHash } from "node:crypto";
import {
  closeSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import { join, resolve } from "node:path";

import { xdgStateHome } from "../config.ts";
import { log } from "./logger.ts";
import { readRegistry, registryEnabled } from "./turnRegistry.ts";
import {
  selfStartToken,
  type ProcessAliveProbe,
  type ProcessStartProbe,
} from "./processLiveness.ts";

/**
 * Age past which a held lock is considered abandoned.
 *
 * Backstop for everything the registry cannot see: a lock whose turn id is
 * unknown to it, or a hand-taken lock with no turn at all. One hour matches
 * MAX_TURN_LIFETIME_MS in the turn registry — a lock cannot outlive the longest
 * turn we are willing to believe in.
 */
export const MAX_LOCK_AGE_MS = 60 * 60 * 1000;

/**
 * How long the acquire critical section may be guarded before the guard itself
 * is presumed abandoned. Generous next to the work it protects (one read, one
 * rename) so a loaded box never breaks a live guard, tight enough that a
 * process killed mid-acquire does not wedge the workspace.
 */
const GUARD_STALE_MS = 5_000;

/** Attempts, and backoff between them, when another acquire holds the guard. */
const GUARD_ATTEMPTS = 6;
const GUARD_BACKOFF_MS = 20;

export interface WorkspaceLockRecord {
  /** Absolute, resolved path of the working copy. */
  workspace: string;
  /**
   * Turn id from the #404 registry, when the caller has one. This — not `pid`
   * — is what liveness is judged on. Absent for a lock taken by hand.
   */
  turn_id?: string;
  persona: string;
  conversation: string;
  /**
   * Process that wrote the record. DIAGNOSTIC ONLY: for the CLI this is a
   * process that exits immediately, so it says nothing about whether the lock
   * is live. Kept because "which process claimed this" is useful when reading
   * a lock by hand.
   */
  pid: number;
  /** Start token for `pid` — see lib/processLiveness.ts. Diagnostic only. */
  pid_start?: string;
  acquired_at: string;
  /** Free-text note on what the holder is doing. */
  purpose?: string;
}

export function locksEnabled(): boolean {
  const v = process.env.PHANTOMBOT_WORKSPACE_LOCKS;
  if (v !== undefined) return !/^(0|off|false|no)$/i.test(v.trim());
  return process.env.NODE_ENV !== "test";
}

export function defaultLockDir(): string {
  return (
    process.env.PHANTOMBOT_WORKSPACE_LOCK_DIR ??
    join(xdgStateHome(), "phantombot", "workspaces")
  );
}

export interface LockProbes {
  dir?: string;
  /** Turn registry directory, when it is not the default (tests). */
  registryDir?: string;
  now?: Date;
  isAlive?: ProcessAliveProbe;
  startToken?: ProcessStartProbe;
  /**
   * Override turn liveness. `true`/`false` answer it; `undefined` means "cannot
   * tell", which sends the caller to the age-only fallback.
   */
  turnRunning?: (turnId: string) => boolean | undefined;
}

/**
 * Filename for a workspace path.
 *
 * Hashed, not slugified: workspace paths are arbitrary and can exceed the 255-
 * byte filename limit, and two different paths must never collide onto one
 * lock. The full path is stored INSIDE the record, so the hash never has to be
 * reversed — it only has to be unique.
 */
function lockFileName(workspace: string): string {
  return `${createHash("sha256").update(workspace).digest("hex").slice(0, 32)}.json`;
}

/** Normalise a workspace path so `/tmp/x`, `/tmp/x/` and `/tmp/./x` are one lock. */
export function normalizeWorkspace(workspace: string): string {
  return resolve(workspace);
}

/** Block this thread briefly. Used only for guard backoff, only in milliseconds. */
function sleepSync(ms: number): void {
  try {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
  } catch {
    const until = Date.now() + ms;
    while (Date.now() < until) {
      /* Atomics unavailable — spin. Bounded by GUARD_BACKOFF_MS. */
    }
  }
}

/**
 * Serialise the acquire critical section.
 *
 * Acquire is read-check-write, and without this two `workspace lock` calls
 * racing on the same tree both read "free", both write, and both believe they
 * won — the precise failure the module exists to prevent, reproduced inside it.
 * `open(…, "wx")` is the atom: the kernel gives exclusive create to exactly one
 * caller, and everyone else sees EEXIST.
 *
 * Returns a release function, or undefined when the guard could not be taken —
 * which the caller must report as contention rather than papering over, because
 * proceeding without the guard is proceeding with the race.
 *
 * Staleness is judged against the WALL CLOCK, not the caller's injected `now`.
 * The guard's age comes from a real mtime written by a real process moments
 * ago; a test that pins `now` to a fixed date is reasoning about lock RECORDS,
 * and applying that clock here would either break live guards or preserve dead
 * ones depending on which side of the pinned date the suite runs.
 */
function takeGuard(dir: string, workspace: string): (() => void) | undefined {
  const guardPath = join(dir, `${lockFileName(workspace)}.guard`);
  for (let attempt = 0; attempt < GUARD_ATTEMPTS; attempt += 1) {
    try {
      const fd = openSync(guardPath, "wx");
      try {
        writeSync(fd, String(process.pid));
      } finally {
        closeSync(fd);
      }
      return () => {
        try {
          unlinkSync(guardPath);
        } catch {}
      };
    } catch {
      // Held by someone else — or abandoned by a process that died inside the
      // critical section, which we break by age so a crash cannot wedge a tree.
      try {
        const age = Date.now() - statSync(guardPath).mtimeMs;
        if (age > GUARD_STALE_MS) {
          unlinkSync(guardPath);
          continue;
        }
      } catch {
        // Vanished between the failed create and the stat: it was released, so
        // retry immediately rather than sleeping on a guard nobody holds.
        continue;
      }
      if (attempt < GUARD_ATTEMPTS - 1) sleepSync(GUARD_BACKOFF_MS);
    }
  }
  return undefined;
}

/**
 * Is the turn holding this lock still running?
 *
 * `undefined` means the registry cannot answer — it is switched off, or the id
 * is not in it. Both go to the age-only fallback; see the header for why we
 * fail toward "still held".
 */
function turnRunning(turnId: string, probes: LockProbes): boolean | undefined {
  if (probes.turnRunning) return probes.turnRunning(turnId);
  if (!registryEnabled()) return undefined;
  const snapshot = readRegistry({
    dir: probes.registryDir,
    now: probes.now,
    isAlive: probes.isAlive,
    startToken: probes.startToken,
  });
  if (snapshot.running.some((turn) => turn.id === turnId)) return true;
  if (snapshot.recent.some((turn) => turn.id === turnId)) return false;
  return undefined;
}

function withinMaxAge(record: WorkspaceLockRecord, now: Date): boolean {
  const acquired = Date.parse(record.acquired_at);
  if (Number.isNaN(acquired)) return false;
  return now.getTime() - acquired <= MAX_LOCK_AGE_MS;
}

function isHeld(
  record: WorkspaceLockRecord,
  now: Date,
  probes: LockProbes,
): boolean {
  // The age ceiling applies to every lock, however confident we are in it.
  if (!withinMaxAge(record, now)) return false;
  if (!record.turn_id) return true;
  const running = turnRunning(record.turn_id, probes);
  return running ?? true;
}

function readLock(
  dir: string,
  workspace: string,
): { record: WorkspaceLockRecord; path: string } | undefined {
  const path = join(dir, lockFileName(workspace));
  try {
    const record = JSON.parse(
      readFileSync(path, "utf8"),
    ) as WorkspaceLockRecord;
    if (
      typeof record?.workspace !== "string" ||
      typeof record?.acquired_at !== "string"
    ) {
      try {
        unlinkSync(path);
      } catch {}
      return undefined;
    }
    return { record, path };
  } catch {
    return undefined;
  }
}

function writeLock(dir: string, record: WorkspaceLockRecord): void {
  mkdirSync(dir, { recursive: true });
  const finalPath = join(dir, lockFileName(record.workspace));
  const tmpPath = `${finalPath}.${process.pid}.tmp`;
  writeFileSync(tmpPath, JSON.stringify(record), "utf8");
  renameSync(tmpPath, finalPath);
}

/** Who holds this workspace right now, if anyone. Prunes a stale lock as it reads. */
export function workspaceHolder(
  workspace: string,
  probes: LockProbes = {},
): WorkspaceLockRecord | undefined {
  if (!locksEnabled()) return undefined;
  const dir = probes.dir ?? defaultLockDir();
  const now = probes.now ?? new Date();
  const found = readLock(dir, normalizeWorkspace(workspace));
  if (!found) return undefined;
  if (isHeld(found.record, now, { ...probes, now })) return found.record;
  try {
    unlinkSync(found.path);
  } catch {}
  return undefined;
}

export type AcquireResult =
  | { ok: true; record: WorkspaceLockRecord; tookOver: boolean }
  | { ok: false; reason: "held"; heldBy: WorkspaceLockRecord }
  | { ok: false; reason: "contended" };

/**
 * Claim a workspace.
 *
 * Re-entrant for the same turn: a turn that already holds the lock re-acquires
 * it rather than deadlocking against itself, because a turn cannot reasonably
 * be expected to track whether an earlier step already claimed the tree.
 *
 * `tookOver` reports that a dead holder's lock was reclaimed — worth logging,
 * because a workspace whose previous holder crashed mid-write may well be in a
 * dirty state the new holder should look at before trusting it.
 */
export function acquireWorkspace(
  input: {
    workspace: string;
    persona: string;
    conversation: string;
    turnId?: string;
    purpose?: string;
  },
  probes: LockProbes = {},
): AcquireResult {
  const workspace = normalizeWorkspace(input.workspace);
  const now = probes.now ?? new Date();
  const record: WorkspaceLockRecord = {
    workspace,
    persona: input.persona,
    conversation: input.conversation,
    pid: process.pid,
    acquired_at: now.toISOString(),
  };
  if (input.turnId) record.turn_id = input.turnId;
  if (input.purpose) record.purpose = input.purpose;
  const token = selfStartToken();
  if (token !== null) record.pid_start = token;

  if (!locksEnabled()) return { ok: true, record, tookOver: false };

  const dir = probes.dir ?? defaultLockDir();
  try {
    mkdirSync(dir, { recursive: true });
  } catch {}

  const releaseGuard = takeGuard(dir, workspace);
  if (!releaseGuard) {
    // Another acquire is inside the critical section. We cannot read-check-write
    // safely, and we will not guess: report contention and let the caller pick a
    // different directory, exactly as it would for a live holder.
    log.debug("workspaceLock: acquire contended", { workspace });
    return { ok: false, reason: "contended" };
  }

  try {
    const existing = readLock(dir, workspace);
    let tookOver = false;
    if (existing) {
      const held = isHeld(existing.record, now, { ...probes, now });
      const mine =
        input.turnId !== undefined && existing.record.turn_id === input.turnId;
      if (held && !mine)
        return { ok: false, reason: "held", heldBy: existing.record };
      tookOver = !held;
    }

    try {
      writeLock(dir, record);
    } catch (e) {
      // A lock we cannot write is a lock nobody can see. Fail OPEN: refusing the
      // turn's work because a state file would not write turns a visibility
      // feature into an outage.
      log.debug("workspaceLock: acquire failed", {
        error: (e as Error).message,
      });
      return { ok: true, record, tookOver: false };
    }
    return { ok: true, record, tookOver };
  } finally {
    releaseGuard();
  }
}

/**
 * Release a workspace.
 *
 * Only the holder may release. A record attributed to a turn is released by
 * THAT turn or by `force`, and by nothing else — including a caller with no
 * turn id at all, which is how a plain shell would otherwise drop a live claim
 * without meaning to. A record with no turn id was taken by hand, so a hand can
 * drop it.
 */
export function releaseWorkspace(
  workspace: string,
  opts: { turnId?: string; force?: boolean } = {},
  probes: LockProbes = {},
): boolean {
  if (!locksEnabled()) return true;
  const dir = probes.dir ?? defaultLockDir();
  const normalized = normalizeWorkspace(workspace);

  // Take the guard so a release cannot land between a concurrent acquire's
  // read and its write. Unlike acquire we proceed without it: unlink is atomic,
  // and refusing to release is how a workspace stays claimed forever.
  const releaseGuard = takeGuard(dir, normalized);
  try {
    const found = readLock(dir, normalized);
    if (!found) return true;
    if (!opts.force && found.record.turn_id) {
      if (found.record.turn_id !== opts.turnId) return false;
    }
    try {
      unlinkSync(found.path);
      return true;
    } catch (e) {
      log.debug("workspaceLock: release failed", {
        error: (e as Error).message,
      });
      return false;
    }
  } finally {
    releaseGuard?.();
  }
}

/** Every live lock, for `workspace status` and the prompt notice. */
export function listWorkspaceLocks(
  probes: LockProbes = {},
): WorkspaceLockRecord[] {
  if (!locksEnabled()) return [];
  const dir = probes.dir ?? defaultLockDir();
  const now = probes.now ?? new Date();
  let names: string[];
  try {
    names = readdirSync(dir).filter((n) => n.endsWith(".json"));
  } catch {
    return [];
  }
  const held: WorkspaceLockRecord[] = [];
  for (const name of names) {
    const path = join(dir, name);
    let record: WorkspaceLockRecord;
    try {
      record = JSON.parse(readFileSync(path, "utf8")) as WorkspaceLockRecord;
    } catch {
      try {
        unlinkSync(path);
      } catch {}
      continue;
    }
    if (
      typeof record?.workspace !== "string" ||
      typeof record?.acquired_at !== "string"
    ) {
      try {
        unlinkSync(path);
      } catch {}
      continue;
    }
    if (!isHeld(record, now, { ...probes, now })) {
      try {
        unlinkSync(path);
      } catch {}
      continue;
    }
    held.push(record);
  }
  held.sort((a, b) => Date.parse(a.acquired_at) - Date.parse(b.acquired_at));
  return held;
}

/**
 * The prompt block listing workspaces held by OTHER turns.
 *
 * Only ever shown alongside a live sibling — a lock held by a turn that is gone
 * is pruned, and a lock held by this turn is not news to it.
 */
export function workspaceLockNotice(
  locks: readonly WorkspaceLockRecord[],
): string | undefined {
  if (locks.length === 0) return undefined;
  const lines = locks.map((l) => {
    const who = l.conversation ? ` by \`${l.conversation}\`` : "";
    const why = l.purpose ? ` — ${l.purpose}` : "";
    return `  - \`${l.workspace}\` held${who} since ${l.acquired_at}${why}`;
  });
  return [
    "# Working copies claimed by another turn",
    "",
    ...lines,
    "",
    "These are shared checkouts another in-flight turn has claimed. Do not",
    "write to them: no branch switch, no commit, no rebase, no dependency",
    "install, no file edit. Reading is fine.",
    "",
    "If you need one, use a different directory (clone a fresh copy) rather",
    "than waiting or taking it over. The claim is advisory — nothing stops you",
    "writing anyway, which is exactly why it is on you to honour it.",
  ].join("\n");
}
