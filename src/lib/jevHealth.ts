/**
 * Decision-model fallback telemetry (issue #597).
 *
 * The decision model (TypeSafe Jev today) is an OPTIONAL backend in front of
 * two pre-existing methods — the harness threat judge and the keyword
 * brain-swap scorer — and it is designed to degrade silently: a timeout, a
 * revoked key or a provider outage falls back to the old method and the turn
 * carries on. That is the right runtime behaviour and the wrong operational
 * one: the operator configured a decision model, believes it is deciding, and
 * nothing on the box says otherwise. Exactly the failure shape #516 hit when
 * a revoked embeddings key dropped memory search to keyword-only with doctor
 * reporting "semantic search off" and no reason.
 *
 * So every decision-model call records its OUTCOME (never its content) in a
 * small per-persona ledger, and `phantombot doctor` reports it: which
 * consumer, how many calls in the window, how many fell back, when, and the
 * last error string. Purely diagnostic — it never feeds an exit code, because
 * falling back is a designed degradation, not a fault.
 *
 * Deliberate properties:
 *   - BEST EFFORT. Every function swallows its own errors. Telemetry must
 *     never be able to fail a turn it is only observing.
 *   - OUTCOMES ONLY. The screened text, the verdict and the routed message
 *     never touch this file — an untrusted payload copied into a plaintext
 *     ledger is an exfiltration path, and the ledger is read by doctor.
 *   - ATOMIC WRITES (tmp + rename), so a crash mid-write cannot leave doctor
 *     reading half a JSON document.
 *   - A ROLLING WINDOW, not a lifetime total. "17 fallbacks" is unreadable
 *     without a denominator and a timeframe; counters reset once the window
 *     is older than JEV_HEALTH_WINDOW_HOURS, while the last-seen facts
 *     (last ok, last failure, last error, consecutive failures) persist
 *     across resets because they answer "is it broken right now".
 *
 * Concurrent turns of one persona share the daemon process and the calls are
 * deliberately fire-and-forget, so the read-modify-write below is SERIALIZED
 * PER LEDGER with an in-process promise queue — 20 parallel outcomes must
 * record 20 calls, or the N/M doctor prints is meaningless. The queue is not
 * a contention point in front of the security control because callers never
 * await it. A cross-PROCESS pair (the daemon and a one-off CLI writing in the
 * same instant) can still lose one increment; that is accepted — this is a
 * health indicator, not an accounting ledger.
 */

import { existsSync } from "node:fs";
import { readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { log } from "./logger.ts";

/** Which decision-model consumer produced an outcome. */
export type JevConsumerId = "judge" | "router";

/** Counters reset once the window is older than this. */
export const JEV_HEALTH_WINDOW_HOURS = 24;

export interface JevConsumerHealth {
  /** Calls attempted in the current window. */
  calls: number;
  /** Calls in the current window that fell back to the pre-Jev method. */
  fallbacks: number;
  /** ISO start of the current counting window. */
  window_started_at: string;
  /** ISO time of the last call the decision model answered. */
  last_ok_at?: string;
  /** ISO time of the last call that fell back. */
  last_fallback_at?: string;
  /** The last fallback's error string (provider message, never payload). */
  last_error?: string;
  /** Fallbacks since the last success — survives a window reset. */
  consecutive_fallbacks: number;
}

export interface JevHealthState {
  judge?: JevConsumerHealth;
  router?: JevConsumerHealth;
}

export function jevHealthPath(personaDir: string): string {
  return join(personaDir, ".jev-health.json");
}

/** Read the ledger. `{}` when absent or unreadable — never throws. */
export async function loadJevHealth(
  personaDir: string,
): Promise<JevHealthState> {
  const p = jevHealthPath(personaDir);
  if (!existsSync(p)) return {};
  try {
    const parsed = JSON.parse(await readFile(p, "utf8")) as JevHealthState;
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

function freshWindow(nowIso: string): JevConsumerHealth {
  return {
    calls: 0,
    fallbacks: 0,
    window_started_at: nowIso,
    consecutive_fallbacks: 0,
  };
}

/** True when `entry`'s window has aged out and its counters should reset. */
export function windowExpired(
  entry: JevConsumerHealth,
  now: Date,
  windowHours = JEV_HEALTH_WINDOW_HOURS,
): boolean {
  const started = Date.parse(entry.window_started_at);
  if (!Number.isFinite(started)) return true;
  return now.getTime() - started >= windowHours * 3_600_000;
}

export interface RecordJevOutcomeInput {
  /** Root of the personas directory (`config.personasDir`). */
  personasDir?: string;
  /** Persona name; absent (e.g. a harness turn with no persona) = no-op. */
  persona?: string;
  consumer: JevConsumerId;
  /** false = the decision model did not answer and the fallback ran. */
  ok: boolean;
  /** Provider/timeout error string. NEVER the screened or routed text. */
  error?: string;
  /** Injectable clock for tests. */
  now?: Date;
}

/**
 * Record one decision-model outcome. Best effort: any failure is logged at
 * debug and swallowed.
 */
/**
 * One in-flight write chain per ledger file. Concurrent outcomes for the same
 * persona append to the tail, so each read-modify-write sees the previous
 * one's result instead of racing it (a `Promise.all` of 20 records produced
 * `{calls:1}` before this — every writer read the same pre-image).
 */
const ledgerQueues = new Map<string, Promise<void>>();
/** Disambiguates tmp names for writers in the same process (see below). */
let tmpCounter = 0;

export async function recordJevOutcome(
  input: RecordJevOutcomeInput,
): Promise<void> {
  const { personasDir, persona } = input;
  if (!personasDir || !persona) return;
  const target = jevHealthPath(join(personasDir, persona));
  const tail = ledgerQueues.get(target) ?? Promise.resolve();
  // A rejected link must never stall the chain (writeOutcome swallows its own
  // errors; the catch is belt-and-suspenders).
  const run = tail.catch(() => {}).then(() => writeOutcome(target, input));
  ledgerQueues.set(target, run);
  try {
    await run;
  } finally {
    // Drop the tail entry once it settles so a quiet box does not accumulate
    // map entries; a later writer simply starts a new chain.
    if (ledgerQueues.get(target) === run) ledgerQueues.delete(target);
  }
}

async function writeOutcome(
  target: string,
  input: RecordJevOutcomeInput,
): Promise<void> {
  const { personasDir, persona, consumer, ok } = input;
  const now = input.now ?? new Date();
  const nowIso = now.toISOString();
  const dir = join(personasDir!, persona!);
  try {
    const state = await loadJevHealth(dir);
    const prior = state[consumer];
    const entry =
      prior && !windowExpired(prior, now)
        ? { ...prior }
        : {
            ...freshWindow(nowIso),
            // Last-seen facts answer "is it broken NOW" and so outlive the
            // counting window they were observed in.
            ...(prior
              ? {
                  ...(prior.last_ok_at ? { last_ok_at: prior.last_ok_at } : {}),
                  ...(prior.last_fallback_at
                    ? { last_fallback_at: prior.last_fallback_at }
                    : {}),
                  ...(prior.last_error ? { last_error: prior.last_error } : {}),
                  consecutive_fallbacks: prior.consecutive_fallbacks,
                }
              : {}),
          };
    entry.calls += 1;
    if (ok) {
      entry.last_ok_at = nowIso;
      entry.consecutive_fallbacks = 0;
    } else {
      entry.fallbacks += 1;
      entry.last_fallback_at = nowIso;
      entry.consecutive_fallbacks += 1;
      if (input.error) entry.last_error = input.error.slice(0, 300);
    }
    const next: JevHealthState = { ...state, [consumer]: entry };
    // Unique tmp name: pid alone collides for two writers in one process
    // (the in-process queue serializes same-ledger writers, but judge and
    // router ledgers share the file — the queue is keyed on the FILE, so
    // this is belt-and-suspenders against any future caller that writes
    // without queueing).
    const tmp = `${target}.${process.pid}.${tmpCounter++}.tmp`;
    await writeFile(tmp, JSON.stringify(next, null, 2) + "\n", "utf8");
    await rename(tmp, target);
  } catch (e) {
    log.debug(`jev health: could not record outcome: ${(e as Error).message}`);
  }
}
