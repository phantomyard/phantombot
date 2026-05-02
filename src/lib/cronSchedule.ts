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

export type ValidateResult =
  | { ok: true }
  | { ok: false; error: string };

/**
 * Returns ok=true if the expression is a parseable 5-field cron.
 * Used by `phantombot task add` to fail-fast before persisting a row
 * the tick loop will refuse to evaluate.
 */
export function validateCron(expr: string): ValidateResult {
  try {
    CronExpressionParser.parse(expr, { tz: "UTC" });
    return { ok: true };
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
}

/**
 * Compute the next fire time strictly AFTER the supplied `from` instant.
 * Throws on invalid expression — callers should validate first.
 */
export function nextFire(expr: string, from: Date): Date {
  const it = CronExpressionParser.parse(expr, {
    currentDate: from,
    tz: "UTC",
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
export function classifyCadence(expr: string, from: Date = new Date()): Cadence {
  const it = CronExpressionParser.parse(expr, {
    currentDate: from,
    tz: "UTC",
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
