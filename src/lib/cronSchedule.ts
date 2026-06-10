/**
 * Wrapper around cron-parser plus the review-interval defaults that
 * phantombot uses for task expiry.
 *
 * Why a wrapper at all: cron-parser exposes a class-based API that's
 * awkward to mock in tests. We re-expose the two operations phantombot
 * actually needs (validate + next-fire) as plain functions so callers
 * don't take a dependency on the parser's class shape.
 */

import { CronExpressionParser } from "cron-parser";

import { log } from "./logger.ts";

/**
 * The wall-clock timezone phantombot evaluates cron schedules in.
 *
 * Cron used to be hard-coded to UTC, which meant `0 9 * * *` fired at 09:00
 * UTC — the WRONG hour for an operator in Europe/Amsterdam, and it drifted by
 * an hour across DST. A task scheduled "every morning at 9" must mean 9 on the
 * operator's wall clock, year-round; cron-parser handles the DST arithmetic
 * once we hand it a named zone instead of "UTC".
 *
 * Resolution order (first that yields a valid IANA zone wins):
 *   1. PHANTOMBOT_TZ env  — explicit operator override, highest priority.
 *   2. TZ env             — standard Unix timezone variable.
 *   3. host system zone   — Intl.DateTimeFormat().resolvedOptions().timeZone.
 *   4. "UTC"              — last-resort fallback.
 *
 * Centralizing this matters: `add()` computes the first fire and the tick loop
 * recomputes every subsequent fire — both MUST use the same zone or a task
 * would walk. Threading it through one resolver guarantees that.
 */
export function operatorTimeZone(): string {
  const candidates = [
    process.env.PHANTOMBOT_TZ,
    process.env.TZ,
    safeHostZone(),
  ];
  for (const tz of candidates) {
    if (tz && isValidTimeZone(tz)) return tz;
  }
  return "UTC";
}

function safeHostZone(): string | undefined {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone;
  } catch {
    return undefined;
  }
}

function isValidTimeZone(tz: string): boolean {
  try {
    // Throws RangeError on an unknown zone; cheap and authoritative.
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    log.warn(`cron: ignoring invalid timezone "${tz}"`);
    return false;
  }
}

export type ValidateResult =
  | { ok: true }
  | { ok: false; error: string };

/**
 * Returns ok=true if the expression is a parseable 5-field cron.
 * Used by `phantombot task add` to fail-fast before persisting a row
 * the tick loop will refuse to evaluate.
 */
export function validateCron(expr: string, tz: string = operatorTimeZone()): ValidateResult {
  try {
    CronExpressionParser.parse(expr, { tz });
    return { ok: true };
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
}

/**
 * Compute the next fire time strictly AFTER the supplied `from` instant.
 * Throws on invalid expression — callers should validate first.
 */
export function nextFire(expr: string, from: Date, tz: string = operatorTimeZone()): Date {
  const it = CronExpressionParser.parse(expr, {
    currentDate: from,
    tz,
  });
  return it.next().toDate();
}

/**
 * How often a task fires, classified into a coarse bucket. Used to pick
 * sensible default review intervals (frequent tasks get reviewed more
 * often; quarterly tasks get reviewed less often) without making the
 * agent reason about it explicitly.
 */
export type Cadence = "subhourly" | "hourly" | "daily" | "weekly" | "monthly";

/**
 * Estimate cadence by computing the gap between the next two fires.
 * Cheap and good enough — we don't need an exact periodicity, just a
 * bucket to pick a default review interval from.
 */
export function classifyCadence(
  expr: string,
  from: Date = new Date(),
  tz: string = operatorTimeZone(),
): Cadence {
  const it = CronExpressionParser.parse(expr, {
    currentDate: from,
    tz,
  });
  const a = it.next().toDate();
  const b = it.next().toDate();
  const gapMs = b.getTime() - a.getTime();
  const gapHours = gapMs / (1000 * 60 * 60);
  if (gapHours < 1) return "subhourly";
  if (gapHours <= 1) return "hourly";
  if (gapHours <= 24) return "daily";
  if (gapHours <= 24 * 7) return "weekly";
  return "monthly";
}

/**
 * Default time until the first self-review fires, by cadence.
 *   hourly   → 14 days  (high-volume task; review while patterns are fresh)
 *   daily    → 30 days
 *   weekly   → 90 days
 *   monthly  → 180 days
 *   subhourly → 7 days  (very high volume; user is most likely to regret these)
 *
 * After a "KEEP" review, the next interval doubles (review fatigue is
 * itself the failure mode — quietly-useful tasks shouldn't keep nagging).
 */
export function defaultReviewIntervalMs(cadence: Cadence): number {
  const day = 24 * 60 * 60 * 1000;
  switch (cadence) {
    case "subhourly":
      return 7 * day;
    case "hourly":
      return 14 * day;
    case "daily":
      return 30 * day;
    case "weekly":
      return 90 * day;
    case "monthly":
      return 180 * day;
  }
}
