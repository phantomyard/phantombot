/**
 * Cross-process registry of IN-FLIGHT TURNS (issue #391).
 *
 * ── The bug ──
 * Two phantombot turns for the SAME persona can run at the same time and be
 * completely invisible to each other. The daemon (`phantombot run`) is serving
 * an interactive conversation while `phantombot tick` — a SEPARATE oneshot
 * process — wakes a task and spawns its own `claude --print`. Observed twice:
 * both turns picked up the same GitHub PR and the same unlocked working
 * checkout, and the contributor got duplicate review comments. The gap between
 * the two starts was 63 SECONDS.
 *
 * ── Why the existing locks don't cover it ──
 * `lib/runLock.ts` is a real kernel-enforced single-instance lock, but it
 * guards `run` against `run`. `tick` takes its own separate `tick.lock`, which
 * serialises tick against tick. NOTHING sits between a woken tick turn and the
 * daemon's live interactive turn — by design, since the daemon must keep
 * answering while a task runs. The collision is not two daemons; it is one
 * daemon and one oneshot, each correctly holding a lock the other never wanted.
 *
 * ── What this is, and what it deliberately is NOT ──
 * This is a REGISTRY, not a mutex. It answers "who else is mid-turn for this
 * persona right now?" and lets callers decide what to do about it. It does not
 * block, does not queue, and never makes a turn wait on another turn's exit.
 * A hard mutex here would be worse than the bug: an interactive turn must never
 * be stalled behind a 30-minute background wake, and a wedged holder would take
 * the whole persona down with it.
 *
 * Three consumers, in increasing subtlety:
 *   1. `cli/tick.ts` DEFERS a task wake while the principal is mid-conversation
 *      (the cheap fix that would have prevented both incidents).
 *   2. `orchestrator/turn.ts` registers every turn here for the lifetime of the
 *      harness run, so (1) has something to see.
 *   3. `orchestrator/turn.ts` also injects a one-line notice into the system
 *      prompt when a sibling IS in flight, so a turn that runs anyway knows to
 *      keep its hands off shared state.
 *
 * ── Storage ──
 * One small JSON file per turn under `$XDG_STATE_HOME/phantombot/turns/`,
 * written tmp+rename so a reader never sees a half-file. A file, not a table in
 * `memory.sqlite`, on purpose: the writers are separate processes on different
 * lifecycles, entries are pure runtime state that nothing should retain, and a
 * crashed turn must be detectable by INSPECTION rather than cleanup. Readdir of
 * a directory holding single-digit files is cheaper than opening the DB.
 *
 * ── Crash safety ──
 * `release()` is best-effort: a SIGKILL, an OOM or a hard power cut leaves the
 * entry on disk with no `finished_at`. So a live entry is never trusted on its
 * face — it is only "running" if the recorded pid is STILL THE SAME PROCESS
 * (`lib/processLiveness.ts`, the #403 check) AND it is younger than
 * MAX_TURN_LIFETIME_MS. Both halves are load-bearing: the pid check catches the
 * crash, and the age ceiling catches the rarer case where a generator is
 * abandoned without being closed and the owning process is still very much
 * alive. Stale entries are pruned opportunistically on read, so there is no
 * timer to maintain and no cleanup command to forget to run.
 *
 * Toggle: on by default. Set `PHANTOMBOT_TURN_REGISTRY` to `0`/`off`/`false`/
 * `no` to disable, mirroring the other `PHANTOMBOT_*` runtime knobs. Disabled
 * means every read reports "nobody home" — which is exactly the pre-#391
 * behaviour, so the kill switch degrades to the old bug and never to a crash.
 */

import { randomUUID } from "node:crypto";
import {
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";

import { log } from "./logger.ts";
import {
  isSameProcess,
  selfStartToken,
  type ProcessAliveProbe,
  type ProcessStartProbe,
} from "./processLiveness.ts";
import type { TurnOrigin } from "../memory/store.ts";
import { personaRunDir } from "./personaPaths.ts";

/**
 * How long after an interactive turn FINISHES a task wake keeps deferring.
 *
 * The point is not the turn that is running — it is the conversation around it.
 * The principal sends a message, reads the reply, thinks, sends another; the
 * turns are short but the exchange is continuous, and a wake that lands in a
 * gap between two messages collides just as badly as one that lands mid-turn.
 * Three minutes covers a normal back-and-forth without parking a poller for the
 * rest of the afternoon.
 */
export const INTERACTIVE_COOLDOWN_MS = 3 * 60 * 1000;

/**
 * Hard ceiling on deferral. Past this, a due task fires even if the principal
 * is still typing.
 *
 * Deferral has to be bounded or a long conversation starves every scheduled
 * task on the box — and a task that never runs is a worse failure than the
 * collision this module exists to prevent, because it is SILENT. Fifteen
 * minutes is comfortably longer than any realistic exchange and comfortably
 * shorter than the cadence of anything we schedule.
 */
export const MAX_DEFERRAL_MS = 15 * 60 * 1000;

/**
 * Age past which a still-live entry stops counting as a running turn.
 *
 * Backstop for the one leak `release()` cannot cover: an async generator that
 * is abandoned without `.return()` never runs its `finally`, so a perfectly
 * healthy long-lived daemon can leave an entry whose pid check says "alive
 * and the same process" forever. One hour is above the 30-minute background
 * wake ceiling, so it can only ever fire on a genuine leak.
 */
export const MAX_TURN_LIFETIME_MS = 60 * 60 * 1000;

/** How long a finished entry is kept before it is pruned from disk. */
const RETENTION_MS = 2 * 60 * 60 * 1000;

/** Origins that mean "a human is talking to this persona right now". */
const INTERACTIVE_ORIGINS: readonly TurnOrigin[] = ["channel"];

export interface TurnRecord {
  /** Unique per turn. */
  id: string;
  persona: string;
  conversation: string;
  origin: TurnOrigin;
  /** Process that owns the turn. */
  pid: number;
  /** Start token for `pid` — see lib/processLiveness.ts. Absent = unprobeable. */
  pid_start?: string;
  /** ISO timestamp. */
  started_at: string;
  /** ISO timestamp; absent while the turn is still running. */
  finished_at?: string;
}

export interface TurnHandle {
  id: string;
  /** Mark the turn finished. Idempotent, never throws. */
  release: () => void;
}

/**
 * Is the registry enabled? On unless explicitly turned off.
 *
 * The `NODE_ENV === "test"` default-off is not squeamishness about side effects
 * — it is correctness. `runTurn` registers unconditionally, so a suite that
 * exercises any turn-driving code path would otherwise write live-looking
 * entries into the REAL `$XDG_STATE_HOME` with the test runner's pid, and the
 * box's actual `tick` would then defer every task wake for the cooldown window
 * because it believes the principal is mid-conversation. Tests that mean to
 * exercise the registry opt in explicitly by setting this var and pointing
 * PHANTOMBOT_TURN_REGISTRY_DIR at a temp dir.
 */
export function registryEnabled(): boolean {
  const v = process.env.PHANTOMBOT_TURN_REGISTRY;
  if (v !== undefined) return !/^(0|off|false|no)$/i.test(v.trim());
  return process.env.NODE_ENV !== "test";
}

/**
 * Where entries live. `PHANTOMBOT_TURN_REGISTRY_DIR` overrides, which both
 * gives tests an isolated directory and lets an operator relocate the runtime
 * state without moving all of `$XDG_STATE_HOME`.
 */
export function defaultRegistryDir(): string {
  return (
    process.env.PHANTOMBOT_TURN_REGISTRY_DIR ??
    join(personaRunDir(), "turns")
  );
}

export interface RegistryProbes {
  dir?: string;
  now?: Date;
  isAlive?: ProcessAliveProbe;
  startToken?: ProcessStartProbe;
}

function entryPath(dir: string, id: string): string {
  return join(dir, `${id}.json`);
}

/**
 * Write a record tmp+rename.
 *
 * The rename is what makes a concurrent reader safe: it sees either the old
 * file or the new one, never a truncated JSON body mid-write.
 */
function writeRecord(dir: string, record: TurnRecord): void {
  mkdirSync(dir, { recursive: true });
  const finalPath = entryPath(dir, record.id);
  const tmpPath = `${finalPath}.${process.pid}.tmp`;
  writeFileSync(tmpPath, JSON.stringify(record), "utf8");
  renameSync(tmpPath, finalPath);
}

/**
 * Register the current process as running a turn.
 *
 * Never throws — a registry failure must degrade to "no visibility", never to a
 * failed turn. The returned handle's `release()` is equally defensive and
 * idempotent, so a caller can call it from a `finally` without guarding it.
 */
export function registerTurn(
  input: {
    persona: string;
    conversation: string;
    origin: TurnOrigin;
  },
  probes: RegistryProbes = {},
): TurnHandle {
  const id = randomUUID();
  if (!registryEnabled()) return { id, release: () => {} };

  const dir = probes.dir ?? defaultRegistryDir();
  const record: TurnRecord = {
    id,
    persona: input.persona,
    conversation: input.conversation,
    origin: input.origin,
    pid: process.pid,
    started_at: (probes.now ?? new Date()).toISOString(),
  };
  const token = selfStartToken();
  if (token !== null) record.pid_start = token;

  try {
    writeRecord(dir, record);
  } catch (e) {
    log.debug("turnRegistry: register failed", { error: (e as Error).message });
    return { id, release: () => {} };
  }

  let released = false;
  return {
    id,
    release: () => {
      if (released) return;
      released = true;
      try {
        // Rewrite rather than unlink: a just-finished turn is still evidence
        // the principal is mid-conversation, and INTERACTIVE_COOLDOWN_MS needs
        // that evidence to survive the turn it describes.
        writeRecord(dir, { ...record, finished_at: new Date().toISOString() });
      } catch (e) {
        log.debug("turnRegistry: release failed", {
          error: (e as Error).message,
        });
      }
    },
  };
}

/**
 * Is this entry a turn that is genuinely still running?
 *
 * Three ways to be "not running", and all three matter: it said so
 * (`finished_at`), its owner died without saying so (the pid check), or it is
 * so old that nothing sane is still working on it (the age ceiling).
 */
export function isRunning(
  record: TurnRecord,
  now: Date,
  isAlive?: ProcessAliveProbe,
  startToken?: ProcessStartProbe,
): boolean {
  if (record.finished_at) return false;
  const started = Date.parse(record.started_at);
  if (!Number.isNaN(started) && now.getTime() - started > MAX_TURN_LIFETIME_MS) {
    return false;
  }
  return isSameProcess(record.pid, record.pid_start, isAlive, startToken);
}

/** Should this entry be deleted from disk? */
function isExpired(record: TurnRecord, now: Date, running: boolean): boolean {
  if (running) return false;
  const stamp = Date.parse(record.finished_at ?? record.started_at);
  if (Number.isNaN(stamp)) return true;
  return now.getTime() - stamp > RETENTION_MS;
}

export interface RegistrySnapshot {
  /** Entries whose owner is still working, newest first. */
  running: TurnRecord[];
  /** Entries that finished (or died) but are still inside the retention window. */
  recent: TurnRecord[];
}

/**
 * Read the registry.
 *
 * Prunes expired entries as a side effect — pruning on read is what keeps the
 * directory bounded without a timer. Never throws: an unreadable registry
 * reports an empty snapshot, which puts every caller back on its pre-#391
 * behaviour.
 */
export function readRegistry(probes: RegistryProbes = {}): RegistrySnapshot {
  const empty: RegistrySnapshot = { running: [], recent: [] };
  if (!registryEnabled()) return empty;

  const dir = probes.dir ?? defaultRegistryDir();
  const now = probes.now ?? new Date();
  let names: string[];
  try {
    names = readdirSync(dir).filter((n) => n.endsWith(".json"));
  } catch {
    // No directory yet = no turns have ever run here. Not an error.
    return empty;
  }

  const running: TurnRecord[] = [];
  const recent: TurnRecord[] = [];
  for (const name of names) {
    const path = join(dir, name);
    let record: TurnRecord;
    try {
      record = JSON.parse(readFileSync(path, "utf8")) as TurnRecord;
    } catch {
      // Corrupt or half-written by an older build — drop it. A record we
      // cannot read is a record we cannot make a decision from.
      try {
        unlinkSync(path);
      } catch {}
      continue;
    }
    if (typeof record?.pid !== "number" || typeof record?.persona !== "string") {
      try {
        unlinkSync(path);
      } catch {}
      continue;
    }
    const live = isRunning(record, now, probes.isAlive, probes.startToken);
    if (isExpired(record, now, live)) {
      try {
        unlinkSync(path);
      } catch {}
      continue;
    }
    (live ? running : recent).push(record);
  }

  const byNewest = (a: TurnRecord, b: TurnRecord) =>
    Date.parse(b.started_at) - Date.parse(a.started_at);
  running.sort(byNewest);
  recent.sort(byNewest);
  return { running, recent };
}

/**
 * Turns for `persona` that are in flight right now, excluding `selfId`.
 *
 * Excluding self is not cosmetic: `orchestrator/turn.ts` registers BEFORE it
 * builds the system prompt, so without the filter every turn would announce
 * itself as its own sibling.
 */
export function siblingTurns(
  persona: string,
  selfId: string | undefined,
  probes: RegistryProbes = {},
): TurnRecord[] {
  return readRegistry(probes).running.filter(
    (r) => r.persona === persona && r.id !== selfId,
  );
}

export interface InteractiveActivity {
  /** An interactive turn is running right now. */
  inFlight: boolean;
  /** An interactive turn finished within INTERACTIVE_COOLDOWN_MS. */
  recent: boolean;
  /** The record that triggered it, for logging. */
  record?: TurnRecord;
}

/**
 * Is the principal mid-conversation with this persona?
 *
 * Checked AT FIRE TIME, never at schedule time — in the #391 incident the wake
 * was scheduled long before the conversation started and the gap between the
 * interactive turn and the collision was 63 seconds. Anything decided when the
 * task was created is looking at the wrong instant.
 */
export function interactiveActivity(
  persona: string,
  probes: RegistryProbes = {},
): InteractiveActivity {
  const now = probes.now ?? new Date();
  const snap = readRegistry({ ...probes, now });
  const mine = (r: TurnRecord) =>
    r.persona === persona && INTERACTIVE_ORIGINS.includes(r.origin);

  const live = snap.running.find(mine);
  if (live) return { inFlight: true, recent: false, record: live };

  // Only a CLEAN finish earns cooldown credit. An entry with no `finished_at`
  // whose owner is gone is a crashed turn, and #402 is the standing lesson on
  // what to do with those: never defer to a corpse. Granting a dead daemon a
  // cooldown would park every scheduled task on the box for three minutes
  // after each crash — and this fleet has seen 22 crashes in five days.
  const cooling = snap.recent.find((r) => {
    if (!mine(r) || !r.finished_at) return false;
    const stamp = Date.parse(r.finished_at);
    return (
      !Number.isNaN(stamp) && now.getTime() - stamp <= INTERACTIVE_COOLDOWN_MS
    );
  });
  if (cooling) return { inFlight: false, recent: true, record: cooling };

  return { inFlight: false, recent: false };
}

/**
 * Decide whether a due task wake should be held back.
 *
 * `dueAt` is the task's own `next_run_at`, left UNCHANGED by a deferral, which
 * is what makes the starvation ceiling free: how long we have been deferring is
 * just how overdue the task is. See `cli/tick.ts` for why nothing is written
 * back to the row.
 */
export function shouldDeferWake(
  persona: string,
  dueAt: Date,
  probes: RegistryProbes = {},
): { defer: boolean; reason?: string } {
  const now = probes.now ?? new Date();
  if (now.getTime() - dueAt.getTime() >= MAX_DEFERRAL_MS) {
    return { defer: false };
  }
  const activity = interactiveActivity(persona, { ...probes, now });
  if (activity.inFlight) {
    return { defer: true, reason: "interactive turn in flight" };
  }
  if (activity.recent) {
    return { defer: true, reason: "interactive turn within cooldown" };
  }
  return { defer: false };
}

/**
 * The sibling-awareness line injected into a turn's system prompt.
 *
 * Deliberately behavioural rather than informational. "Another turn is running"
 * tells a model a fact it has no idea what to do with; naming the shared
 * resources that actually got clobbered — a git checkout, a PR, a file — and
 * the correct response (verify, don't race; don't post twice) is what changes
 * the outcome. This is a HINT, not an enforcement boundary: it reduces the odds
 * of a duplicate action, it cannot prevent one.
 */
export function siblingNotice(siblings: TurnRecord[]): string | undefined {
  if (siblings.length === 0) return undefined;
  const list = siblings
    .map((s) => `\`${s.conversation}\` (started ${s.started_at})`)
    .join(", ");
  const plural = siblings.length === 1 ? "turn is" : "turns are";
  return [
    "# Concurrent turn in progress",
    "",
    `Another ${plural} running for this persona right now: ${list}.`,
    "You cannot see its context and it cannot see yours, so you may both be",
    "working the same thing — the same git checkout, the same PR or issue, the",
    "same file — without either of you noticing.",
    "",
    "Before you take any action that CHANGES SHARED STATE (a commit, a push, a",
    "PR comment or review, a merge, an external message, an edit to a file",
    "outside this persona's own memory), assume the sibling may have already",
    "done it. Check the current state first and verify its work rather than",
    "racing it. A duplicate comment to a contributor is worse than a late one.",
    "Read-only work needs no such care — carry on.",
  ].join("\n");
}
