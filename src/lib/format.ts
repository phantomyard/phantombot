/**
 * Tiny shared formatters for the chat-channel layer.
 *
 * Lives here so the truncation rule and the elapsed/uptime formats stay
 * consistent across `/status`, the long-turn placeholder, and any future
 * UX surface — instead of being copy-pasted into each.
 *
 * Keep this module dependency-free; it's pulled into the channel/CLI
 * layers that should remain trivially importable from tests.
 */

/**
 * Truncate a string to at most `max` characters, replacing the tail
 * with a single ellipsis when truncation is needed. Empty strings and
 * strings already within the budget are returned unchanged.
 */
export function truncateLine(s: string, max: number): string {
  if (s.length <= max) return s;
  return s.slice(0, max - 1) + "…";
}

/**
 * Format a wall-clock duration (in MILLISECONDS) for the long-turn
 * placeholder line. Always shows the largest two units, dropping
 * subseconds entirely.
 *
 *   45_000   → "45s"
 *   65_000   → "1m 5s"
 *   8_000_000 → "2h 13m"
 */
export function formatElapsedMs(ms: number): string {
  return formatElapsedSeconds(Math.floor(ms / 1000));
}

/**
 * Same shape as formatElapsedMs but takes seconds. Used by /status,
 * which already speaks in seconds. Adds a `Nd Nh` form for uptimes
 * that exceed a day — placeholders never run that long.
 */
export function formatElapsedSeconds(s: number): string {
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${s % 60}s`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ${m % 60}m`;
  const d = Math.floor(h / 24);
  return `${d}d ${h % 24}h`;
}
