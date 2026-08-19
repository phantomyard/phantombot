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
 * ── Why not flock ──
 * `flock(2)` would be genuinely mandatory-ish and crash-safe for free, and it
 * is what `lib/runLock.ts` uses. It is the wrong tool HERE: an fd-backed lock
 * dies with the process that opened it, and the holder we need to represent is
 * a TURN — which outlives no process boundary we control and may be one of
 * several in a single daemon. We also need to answer "who holds it, and since
 * when" from a DIFFERENT process, which an fd cannot tell you. So: a JSON file
 * plus the #403 pid+start-time liveness check, the same pattern the turn
 * registry uses, for the same reasons.
 *
 * ── Crash safety ──
 * A holder that dies without releasing leaves a stale file. It is broken on
 * inspection, not by a timer: a lock is only held if its owner pid is still the
 * SAME process (`lib/processLiveness.ts`) and it is younger than
 * MAX_LOCK_AGE_MS. An unprobeable platform falls back to the pid check, and a
 * stale lock is taken over silently — the alternative, a wedged workspace that
 * needs a human to clear a lockfile, is worse than the race it prevents.
 *
 * Toggle: `PHANTOMBOT_WORKSPACE_LOCKS=0/off/false/no` disables — every acquire
 * succeeds and every query reports unheld, which is the pre-#405 behaviour.
 */

import { createHash } from "node:crypto";
import {
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";

import { xdgStateHome } from "../config.ts";
import { log } from "./logger.ts";
import {
  isSameProcess,
  selfStartToken,
  type ProcessAliveProbe,
  type ProcessStartProbe,
} from "./processLiveness.ts";

/**
 * Age past which a held lock is considered abandoned.
 *
 * Backstop for the leak the pid check cannot see: a long-lived daemon whose
 * turn was abandoned without running its release path stays "alive and the same
 * process" forever. One hour matches MAX_TURN_LIFETIME_MS in the turn registry
 * — a lock cannot outlive the turn that holds it.
 */
export const MAX_LOCK_AGE_MS = 60 * 60 * 1000;

export interface WorkspaceLockRecord {
  /** Absolute, resolved path of the working copy. */
  workspace: string;
  /** Turn id from the turn registry, when the caller has one. */
  turn_id?: string;
  persona: string;
  conversation: string;
  pid: number;
  /** Start token for `pid` — see lib/processLiveness.ts. */
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
  now?: Date;
  isAlive?: ProcessAliveProbe;
  startToken?: ProcessStartProbe;
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

function writeLock(dir: string, record: WorkspaceLockRecord): void {
  mkdirSync(dir, { recursive: true });
  const finalPath = join(dir, lockFileName(record.workspace));
  const tmpPath = `${finalPath}.${process.pid}.tmp`;
  writeFileSync(tmpPath, JSON.stringify(record), "utf8");
  renameSync(tmpPath, finalPath);
}

function isHeld(
  record: WorkspaceLockRecord,
  now: Date,
  isAlive?: ProcessAliveProbe,
  startToken?: ProcessStartProbe,
): boolean {
  const acquired = Date.parse(record.acquired_at);
  if (!Number.isNaN(acquired) && now.getTime() - acquired > MAX_LOCK_AGE_MS) {
    return false;
  }
  return isSameProcess(record.pid, record.pid_start, isAlive, startToken);
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
      typeof record?.pid !== "number"
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
  if (isHeld(found.record, now, probes.isAlive, probes.startToken)) {
    return found.record;
  }
  try {
    unlinkSync(found.path);
  } catch {}
  return undefined;
}

export type AcquireResult =
  | { ok: true; record: WorkspaceLockRecord; tookOver: boolean }
  | { ok: false; heldBy: WorkspaceLockRecord };

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
  const existing = readLock(dir, workspace);
  let tookOver = false;
  if (existing) {
    const held = isHeld(
      existing.record,
      now,
      probes.isAlive,
      probes.startToken,
    );
    const mine =
      input.turnId !== undefined && existing.record.turn_id === input.turnId;
    if (held && !mine) return { ok: false, heldBy: existing.record };
    tookOver = !held;
  }

  try {
    writeLock(dir, record);
  } catch (e) {
    // A lock we cannot write is a lock nobody can see. Fail OPEN: refusing the
    // turn's work because a state file would not write turns a visibility
    // feature into an outage.
    log.debug("workspaceLock: acquire failed", { error: (e as Error).message });
    return { ok: true, record, tookOver: false };
  }
  return { ok: true, record, tookOver };
}

/**
 * Release a workspace.
 *
 * Only the holder may release. `turnId` is checked when both sides have one, so
 * a turn cannot drop a lock it never took — the classic way a cooperative
 * protocol turns into silent corruption.
 */
export function releaseWorkspace(
  workspace: string,
  opts: { turnId?: string; force?: boolean } = {},
  probes: LockProbes = {},
): boolean {
  if (!locksEnabled()) return true;
  const dir = probes.dir ?? defaultLockDir();
  const found = readLock(dir, normalizeWorkspace(workspace));
  if (!found) return true;
  if (!opts.force && opts.turnId && found.record.turn_id) {
    if (found.record.turn_id !== opts.turnId) return false;
  }
  try {
    unlinkSync(found.path);
    return true;
  } catch (e) {
    log.debug("workspaceLock: release failed", { error: (e as Error).message });
    return false;
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
      typeof record?.pid !== "number"
    ) {
      try {
        unlinkSync(path);
      } catch {}
      continue;
    }
    if (!isHeld(record, now, probes.isAlive, probes.startToken)) {
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
