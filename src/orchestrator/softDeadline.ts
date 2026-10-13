/**
 * Soft-deadline fitting for turns that run under a chain-wide wall-clock
 * deadline — background task wakes (issue #668).
 *
 * The soft deadline (#639) interrupts a healthy mid-work turn BEFORE the hard
 * cap and hands it a wrap-up nudge. A foreground turn arms it only when the
 * configured value sits strictly below the hard cap, which is right there: the
 * cap is fixed, and a short-cap caller (probe, threat judge, recovery reply)
 * is meant to go without.
 *
 * A wake is different. Its hard cap is not a fixed number but the time
 * REMAINING before the chain deadline (#631), recomputed for every attempt —
 * a fallback after a slow primary, a resumed slot, a nudge pass. A soft
 * deadline that was configured against the full interactive hour is at or past
 * that clamped cap as often as not, and then it never fires: the attempt is
 * hard-killed and everything it did is discarded, the exact outcome the soft
 * deadline exists to prevent. So under a chain deadline the soft deadline is
 * FITTED to each attempt's cap instead of dropped.
 */

/** Share of an attempt's hard cap spent before the wrap-up nudge fires. */
export const CHAIN_SOFT_FRACTION = 0.8;

/**
 * Smallest wrap-up window worth interrupting for. When fitting would leave the
 * nudge pass less than this before the hard kill, the interrupt costs a
 * process restart and buys nothing, so the soft deadline is left disarmed and
 * the hard cap stands alone.
 */
export const MIN_CHAIN_WRAPUP_MS = 30_000;

/**
 * The soft deadline one attempt should run with, given the configured soft
 * deadline and the hard cap that attempt was actually handed.
 *
 *   - disabled (undefined or <= 0)        → undefined: an operator's
 *     `harness_soft_timeout_s = 0` is never overridden.
 *   - no hard cap                         → the configured value, unchanged.
 *   - configured value fits under the cap → the configured value, unchanged.
 *   - otherwise                           → CHAIN_SOFT_FRACTION of the cap, or
 *     undefined when that leaves under MIN_CHAIN_WRAPUP_MS to wrap up in.
 */
export function fitSoftTimeoutToCap(
  softTimeoutMs: number | undefined,
  hardCapMs: number | undefined,
): number | undefined {
  if (softTimeoutMs === undefined || softTimeoutMs <= 0) return undefined;
  if (hardCapMs === undefined) return softTimeoutMs;
  if (softTimeoutMs < hardCapMs) return softTimeoutMs;
  const fitted = Math.floor(hardCapMs * CHAIN_SOFT_FRACTION);
  if (fitted <= 0 || hardCapMs - fitted < MIN_CHAIN_WRAPUP_MS) return undefined;
  return fitted;
}
