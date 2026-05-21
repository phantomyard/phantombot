/**
 * Timer fire-marker bookkeeping for heartbeat + tick.
 *
 * Why this exists: when phantombot's user-systemd timers go silent
 * (broken symlinks after an update, bus going away, host being
 * suspended for days), the only signal is "stuff didn't run." Doctor
 * needs a positive on-disk indicator that says "heartbeat last ran at
 * T" / "tick last ran at T" so a >threshold age can be flagged.
 *
 * We write one cheap, atomic marker file per timer in XDG_STATE_HOME.
 * No JSON parsing on read — we just stat() the mtime — but the file
 * also contains the ISO timestamp + a "runs=" counter for forensic
 * tail -F use. Marker files are TIMER-scoped (not persona-scoped) on
 * purpose: heartbeat may eventually run multi-persona, and tick has
 * no persona at all. We're tracking the timer's heartbeat, not any
 * one persona's memory.
 *
 * Staleness thresholds are passed in by callers (doctor picks them)
 * rather than hard-coded here, because the heartbeat-firing-every-30m
 * vs tick-firing-every-minute cadence means they need different bars.
 */

import { existsSync, readFileSync, statSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import { xdgStateHome } from "../config.ts";
import { log } from "./logger.ts";

export function heartbeatMarkerPath(): string {
  return join(xdgStateHome(), "phantombot", "heartbeat.last-fired");
}

export function tickMarkerPath(): string {
  return join(xdgStateHome(), "phantombot", "tick.last-fired");
}

interface MarkerPayload {
  iso: string;
  runs: number;
}

function parseMarker(text: string): MarkerPayload | undefined {
  const lines = text.split("\n").filter((l) => l.length > 0);
  if (lines.length === 0) return undefined;
  // Format: "ISO=2026-05-20T07:30:00.000Z runs=42"
  const head = lines[lines.length - 1]!;
  const isoMatch = /ISO=(\S+)/.exec(head);
  const runsMatch = /runs=(\d+)/.exec(head);
  if (!isoMatch) return undefined;
  const iso = isoMatch[1]!;
  if (Number.isNaN(Date.parse(iso))) return undefined;
  const runs = runsMatch ? Number(runsMatch[1]) : 0;
  return { iso, runs };
}

/**
 * Record that the named timer just fired. Best-effort: any write
 * failure is logged and swallowed — we never want a disk hiccup in
 * the marker to break the actual heartbeat/tick work.
 *
 * The ISO timestamp comes from `new Date().toISOString()`, i.e.
 * wall-clock time. A backward NTP step between two fires would make
 * the recorded age look briefly negative (clamped to 0 by
 * `loadLastFired`) or smaller than the real elapsed time. Fine here
 * because the staleness bars are coarse: heartbeat 120m, tick 5m. If
 * tighter age thresholding becomes important, switch to a monotonic
 * clock (`process.hrtime.bigint()` snapshotted at process start) for
 * the age delta and keep the wall-clock ISO only for forensic logs.
 */
async function recordFired(path: string): Promise<void> {
  try {
    let runs = 0;
    if (existsSync(path)) {
      try {
        const prev = parseMarker(readFileSync(path, "utf8"));
        if (prev) runs = prev.runs;
      } catch {
        // Corrupt marker — reset counter, keep going.
      }
    }
    const next: MarkerPayload = {
      iso: new Date().toISOString(),
      runs: runs + 1,
    };
    await mkdir(dirname(path), { recursive: true });
    await writeFile(
      path,
      `ISO=${next.iso} runs=${next.runs}\n`,
      "utf8",
    );
  } catch (e) {
    log.warn("timerHealth: failed to record fire", {
      path,
      error: (e as Error).message,
    });
  }
}

export function recordHeartbeatFired(): Promise<void> {
  return recordFired(heartbeatMarkerPath());
}

export function recordTickFired(): Promise<void> {
  return recordFired(tickMarkerPath());
}

export interface TimerLastFired {
  /** ISO timestamp of the last recorded fire, or undefined if no marker. */
  iso?: string;
  /** Whole-number minutes since the last fire, or undefined if none. */
  ageMinutes?: number;
  /** Total fires recorded (rough — resets on marker corruption). */
  runs?: number;
}

function loadLastFired(path: string, now: Date): TimerLastFired {
  if (!existsSync(path)) return {};
  try {
    // Cheap path: stat mtime. We still parse the body so the JSON
    // report carries the explicit ISO (which doesn't drift if someone
    // touches the file).
    const text = readFileSync(path, "utf8");
    const parsed = parseMarker(text);
    if (parsed) {
      const t = Date.parse(parsed.iso);
      const ageMs = now.getTime() - t;
      return {
        iso: parsed.iso,
        ageMinutes: Math.max(0, Math.round(ageMs / 60_000)),
        runs: parsed.runs,
      };
    }
    // Fall back to mtime if the body is unreadable.
    const mt = statSync(path).mtime;
    return {
      iso: mt.toISOString(),
      ageMinutes: Math.max(0, Math.round((now.getTime() - mt.getTime()) / 60_000)),
    };
  } catch (e) {
    log.warn("timerHealth: failed to read marker", {
      path,
      error: (e as Error).message,
    });
    return {};
  }
}

export function loadHeartbeatLastFired(now: Date = new Date()): TimerLastFired {
  return loadLastFired(heartbeatMarkerPath(), now);
}

export function loadTickLastFired(now: Date = new Date()): TimerLastFired {
  return loadLastFired(tickMarkerPath(), now);
}

/**
 * Default staleness bars used by doctor. Heartbeat fires every 30m,
 * so a 2h bar tolerates 3 missed fires before yelling. Tick fires
 * every minute, so a 5m bar tolerates 4 missed fires. Both are
 * deliberately loose — we want a "this timer is dead" signal, not a
 * "this timer was 30 seconds late" signal.
 */
export const HEARTBEAT_STALE_MINUTES = 120;
export const TICK_STALE_MINUTES = 5;
