/**
 * When the nightly sweep gets triggered.
 *
 * There is no 02:00 timer any more. A clock is the wrong trigger for a pass
 * whose job is "distil the day that just closed": a box asleep at 02:00 misses
 * it entirely, and a box in a different timezone from its daily files runs it
 * against the wrong day. Two event-driven triggers replace it, both of which
 * are things that ALREADY happen:
 *
 *   1. startup   — `phantombot run` fires a detached sweep (covers laptops and
 *                  anything that was powered off).
 *   2. rollover  — the 30-min heartbeat notices that the calendar day has
 *                  changed since its previous fire, which means yesterday's
 *                  daily file is now closed, and fires a detached sweep.
 *
 * Rollover DETECTION rather than a file-creation watch: a daily file is written
 * lazily on the first capture of the day, so on a quiet day it may never be
 * created at all — a creation hook would silently starve, leaving yesterday
 * unprocessed forever. The day changing is unconditional.
 *
 * Both triggers are safe to fire redundantly: the sweep is ledger-driven and
 * idempotent, no-ops in milliseconds when nothing is pending, and holds an
 * in-flight marker so two sweeps can't double-file the same drawers.
 */

import { spawn } from "node:child_process";

import { log } from "./logger.ts";

/** Why a sweep was fired. Logged, and useful in tests. */
export type NightlyTriggerReason = "startup" | "rollover" | "manual";

/**
 * The calendar day used for daily-file NAMING, so rollover detection and the
 * files it is detecting rollover FOR agree on where the boundary is.
 *
 * That basis is currently UTC (`memory capture` names the file from
 * `toISOString()`), which means "the day" closes at 01:00/02:00 local in
 * Europe — a known wart, tracked separately. What matters here is that this
 * helper and the daily-file writer use the SAME wrong-or-right boundary; a
 * mismatch would fire the sweep while the day it is about to process is still
 * being appended to.
 */
export function dailyFileDate(at: Date = new Date()): string {
  return at.toISOString().slice(0, 10);
}

/**
 * Has the calendar day rolled over between the previous heartbeat fire and
 * now? `prevIso` is the timestamp recorded by the last fire; `undefined` (no
 * marker — first heartbeat ever, or a wiped state dir) is deliberately NOT a
 * rollover: startup already fired a sweep, and guessing here would double up.
 *
 * A clock stepped backwards (NTP correction, a restored VM snapshot) yields a
 * previous date in the future, which is also not a rollover — we compare for
 * strict "the recorded day is older than today".
 */
export function dayRolledOver(
  prevIso: string | undefined,
  now: Date = new Date(),
): boolean {
  if (!prevIso) return false;
  const prev = Date.parse(prevIso);
  if (Number.isNaN(prev)) return false;
  return dailyFileDate(new Date(prev)) < dailyFileDate(now);
}

/**
 * Fire a detached `phantombot nightly` for the given persona.
 *
 * Detached + unref'd on purpose: a first sweep over a long backlog can run for
 * many minutes, and it must not hold its parent's event loop (the daemon's
 * channel loop, or a heartbeat process that is supposed to exit in seconds) or
 * die when that parent does.
 */
export function spawnNightlySweep(
  persona: string,
  reason: NightlyTriggerReason,
): void {
  const entry = process.argv[1] ?? "";
  const dev = entry.endsWith(".ts") || entry.endsWith(".js");
  const args = dev
    ? [entry, "nightly", "--persona", persona]
    : ["nightly", "--persona", persona];
  try {
    const child = spawn(process.execPath, args, {
      detached: true,
      stdio: "ignore",
    });
    child.unref();
    log.info("nightly: spawned sweep", { persona, reason });
  } catch (e) {
    log.warn("nightly: could not spawn sweep", {
      persona,
      reason,
      error: (e as Error).message,
    });
  }
}
