/**
 * Schedule expression parser.
 *
 * Translates human-friendly duration/cron expressions into the structured
 * data the TaskStore needs. Used by `phantombot task add` to support
 * one-off tasks (--in / --at) and recurring tasks with expiry
 * (--every / --until / --count / --for).
 */

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;
const WEEK_MS = 7 * DAY_MS;

const DURATION_RE = /^(\d+)\s*(s|m|h|d|w)$/i;

export interface ParseDurationResult {
  ok: true;
  ms: number;
  label: string; // e.g. "10m", "5h"
}

export interface ParseError {
  ok: false;
  error: string;
}

/**
 * Parse a relative duration like "10m", "5h", "2d", "1w", "30s".
 */
export function parseDuration(raw: string): ParseDurationResult | ParseError {
  const m = raw.trim().match(DURATION_RE);
  if (!m) {
    return {
      ok: false,
      error: `invalid duration "${raw}" — use format like 10m, 5h, 2d, 1w`,
    };
  }
  const num = parseInt(m[1]!, 10);
  const unit = m[2]!.toLowerCase();
  let ms: number;
  switch (unit) {
    case "s":
      ms = num * 1000;
      break;
    case "m":
      ms = num * MINUTE_MS;
      break;
    case "h":
      ms = num * HOUR_MS;
      break;
    case "d":
      ms = num * DAY_MS;
      break;
    case "w":
      ms = num * WEEK_MS;
      break;
    default:
      return { ok: false, error: `unknown unit "${unit}"` };
  }
  if (ms <= 0) {
    return { ok: false, error: `duration must be positive: "${raw}"` };
  }
  return { ok: true, ms, label: raw.trim() };
}

/**
 * Parse an absolute timestamp. Accepts ISO 8601 or a looser
 * "YYYY-MM-DD HH:MM" format with optional timezone offset.
 */
export function parseAt(raw: string, _now: Date = new Date()): { ok: true; firesAt: Date } | ParseError {
  const trimmed = raw.trim();
  // Try ISO 8601 first.
  let d = new Date(trimmed);
  if (!isNaN(d.getTime())) {
    return { ok: true, firesAt: d };
  }
  // Try "YYYY-MM-DD HH:MM" with optional timezone.
  // Append :00 seconds if only hours:minutes.
  const withSeconds = /^\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2}$/.test(trimmed)
    ? trimmed + ":00"
    : trimmed;
  d = new Date(withSeconds);
  if (!isNaN(d.getTime())) {
    return { ok: true, firesAt: d };
  }
  return {
    ok: false,
    error: `cannot parse "${raw}" as a date — use ISO 8601 like "2026-05-07T09:00:00Z" or "2026-05-07 09:00"`,
  };
}

/**
 * Convert a human repetition interval to a 5-field cron expression.
 * Supported: "Nm", "Nh", "Nd" for small N, and "1w".
 *
 * Mapping (all anchored at :00 or :00:00 for sub-minute alignment):
 *   30s  - not expressible as 5-field cron; returns error (use 1m)
 *   1m   - every minute
 *   5m   - every 5 minutes
 *   30m  - every 30 minutes
 *   1h   - top of every hour
 *   2h   - every 2 hours at :00
 *   6h   - every 6 hours at :00
 *   1d   - midnight UTC every day
 *   2d   - midnight UTC every 2 days (drifts at month boundary; see below)
 *   1w   - midnight UTC every Sunday
 *
 * KNOWN LIMITATION (cron month-boundary drift):
 *   Cron's day-of-month step ("(asterisk)/N" in the day field) restarts every
 *   month, so any --every Nd where N does not divide the month length, and
 *   any --every Nw for N > 1, will drift at month boundaries. Example:
 *   "0 0 (asterisk)/14 (asterisk) (asterisk)" fires on day 1 and day 15 of
 *   each month, not strictly every 14 days. We accept this for daily
 *   intervals (it's how POSIX cron works and users expect it for "every 2
 *   days"), but multi-week intervals are explicitly refused — pick "1w"
 *   (every Sunday) or use --in for a one-off.
 */
export function parseEvery(raw: string): { ok: true; cron: string } | ParseError {
  const parsed = parseDuration(raw);
  if (!parsed.ok) {
    return {
      ok: false,
      error: `invalid --every "${raw}": ${parsed.error}`,
    };
  }

  const { ms, label } = parsed;

  if (ms < MINUTE_MS) {
    return {
      ok: false,
      error: `--every ${label} is too frequent — minimum is 1m (60s)`,
    };
  }

  // < 1h → sub-hourly (minute field)
  if (ms < HOUR_MS) {
    const minutes = Math.floor(ms / MINUTE_MS);
    return { ok: true, cron: `*/${minutes} * * * *` };
  }

  // < 1d → hourly (minute=0, hour field)
  if (ms < DAY_MS) {
    const hours = Math.floor(ms / HOUR_MS);
    return { ok: true, cron: `0 */${hours} * * *` };
  }

  // < 1w → daily (minute=0, hour=0, day field)
  if (ms < WEEK_MS) {
    const days = Math.floor(ms / DAY_MS);
    return { ok: true, cron: `0 0 */${days} * *` };
  }

  // >= 1w → weekly (midnight Sunday)
  const weeks = Math.floor(ms / WEEK_MS);
  if (weeks === 1) {
    return { ok: true, cron: "0 0 * * 0" };
  }
  // Multi-week intervals can't be expressed as a stable cron (day-of-month
  // step resets each month → drift). Refuse and point the user at
  // alternatives.
  return {
    ok: false,
    error: `--every ${label} drifts at month boundaries — use "1w" (every Sunday) or schedule a one-off with --at`,
  };
}

/**
 * Max duration for recurring tasks (90 days, in ms).
 */
export const MAX_RECURRING_DURATION_MS = 90 * DAY_MS;

/**
 * Parse --for as a duration string (same format as --in).
 * Returns ms from now.
 */
export function parseFor(raw: string): ParseDurationResult | ParseError {
  return parseDuration(raw);
}

/**
 * Format a Date in the local timezone for display.
 */
export function formatLocal(date: Date): string {
  return date.toLocaleString(undefined, {
    weekday: "short",
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    timeZoneName: "short",
  });
}
