/**
 * In-memory per-harness cooldown store.
 *
 * Why this exists: the gemini harness can sit on a 429 (or any 4XX) for
 * ~2 min while gemini-cli runs its built-in retryWithBackoff loop, then
 * the phantombot orchestrator falls through to the next harness anyway.
 * We want two improvements:
 *
 *   1. FAST FALLBACK — when a harness fails with a recoverable error
 *      (especially a 4XX detected on stderr), advance to the next CLI
 *      in the chain immediately, without waiting for the upstream's own
 *      retry budget to drain.
 *
 *   2. COOLDOWN — once a harness has failed, don't try it again for a
 *      while. If a Google capacity exhaustion just kicked us off
 *      gemini-3-flash-preview, hammering it on every turn over the
 *      next minute is pure latency for the user. Skip it; come back to
 *      it after a cooldown window.
 *
 * Cooldown schedule (per harness id, consecutive failures):
 *
 *      failures=1  →  150 s base
 *      failures=2  →  300 s
 *      failures=3  →  600 s
 *      failures=4  →  1200 s
 *      failures=5  →  2400 s
 *      failures>=6 →  3600 s (cap)
 *
 * Each base value is jittered by ±25% to spread fleet-wide retries
 * across time (multiple agents on the same network all hitting
 * Google's capacity wall would otherwise re-converge after the same
 * 150s and stampede). A successful turn (`done` chunk with non-empty
 * text) resets the failure count and clears any active cooldown.
 *
 * Lifetime: process-local. Resets across phantombot restarts. That's
 * fine — the cooldown is a soft hint for "this is probably still
 * broken, save the round-trip"; if we just restarted, we're fresh
 * out of state and might as well try.
 *
 * Concurrency: phantombot serializes turns per conversation, and the
 * orchestrator runs a single turn at a time within one process, so
 * naive in-memory state without locking is safe.
 */

/** Base cooldown for the first consecutive failure, in milliseconds. */
export const BASE_COOLDOWN_MS = 150_000; // 150 s

/** Hard upper bound on a single cooldown window, in milliseconds. */
export const MAX_COOLDOWN_MS = 3_600_000; // 1 h

/**
 * Jitter ratio: the actual cooldown is uniformly drawn from
 * [base * (1 - JITTER_RATIO), base * (1 + JITTER_RATIO)].
 */
export const JITTER_RATIO = 0.25;

interface HarnessCooldownState {
  /** How many consecutive failures we've seen. Reset on success. */
  consecutiveFailures: number;
  /** Epoch ms after which the harness is eligible again. */
  cooldownUntilMs: number;
}

/**
 * Snapshot of the cooldown for one harness. `cooled=false` means the
 * harness is eligible right now; the orchestrator can call
 * `harness.invoke()` immediately. `cooled=true` means skip — the
 * window expires at `untilMs`.
 */
export interface CooldownStatus {
  cooled: boolean;
  /** Epoch ms when the cooldown expires. 0 if never cooled. */
  untilMs: number;
  /** Failures-in-a-row driving the current backoff. */
  consecutiveFailures: number;
}

/**
 * Injection seam for tests. The store calls `random()` once per
 * `markFailure` to compute the jittered cooldown duration. Production
 * uses Math.random; tests pass a deterministic generator.
 */
export type RandomFn = () => number;

/**
 * Compute the un-jittered base cooldown for a given consecutive
 * failure count. Exported for tests; production callers should use
 * markFailure() and isCooledDown(), not this.
 */
export function baseCooldownForFailures(failures: number): number {
  if (failures <= 0) return 0;
  // Doubling each step: 150, 300, 600, 1200, 2400, 3600+
  const raw = BASE_COOLDOWN_MS * Math.pow(2, failures - 1);
  return Math.min(raw, MAX_COOLDOWN_MS);
}

/**
 * Apply ±JITTER_RATIO to `base`. Exported for tests; production
 * callers shouldn't need this directly.
 */
export function applyJitter(base: number, random: RandomFn): number {
  // random() ∈ [0, 1)  →  factor ∈ [1 - JITTER_RATIO, 1 + JITTER_RATIO).
  const factor = 1 - JITTER_RATIO + random() * (2 * JITTER_RATIO);
  return Math.round(base * factor);
}

/**
 * Per-process cooldown store keyed by harness id ("gemini", "pi", "claude").
 *
 * The store is "soft": cooled-down harnesses can still be force-tried
 * by the orchestrator when there is no other option (the alternative
 * would be a stuck agent that refuses to reply). See orchestrator/fallback.ts.
 */
export class CooldownStore {
  private readonly state = new Map<string, HarnessCooldownState>();

  constructor(
    private readonly random: RandomFn = Math.random,
    /** Test seam — defaults to Date.now. */
    private readonly now: () => number = Date.now,
  ) {}

  /**
   * Record a recoverable failure for `harnessId`. Increments the
   * consecutive-failure count and (re)arms the cooldown window with
   * jitter applied. Returns the resulting status (handy for logging).
   */
  markFailure(harnessId: string): CooldownStatus {
    const prev = this.state.get(harnessId);
    const failures = (prev?.consecutiveFailures ?? 0) + 1;
    const base = baseCooldownForFailures(failures);
    const jittered = applyJitter(base, this.random);
    const untilMs = this.now() + jittered;
    const next: HarnessCooldownState = {
      consecutiveFailures: failures,
      cooldownUntilMs: untilMs,
    };
    this.state.set(harnessId, next);
    return {
      cooled: true,
      untilMs,
      consecutiveFailures: failures,
    };
  }

  /**
   * Record a successful turn for `harnessId`. Clears the failure
   * counter and any active cooldown.
   */
  markSuccess(harnessId: string): void {
    this.state.delete(harnessId);
  }

  /**
   * Check whether `harnessId` is currently cooled down. Past the
   * cooldown window, returns `cooled=false` but PRESERVES the
   * consecutive-failure count — so a near-immediate re-failure
   * lengthens the window again rather than restarting at the
   * 150 s base. Only `markSuccess` clears the failure count.
   */
  isCooledDown(harnessId: string): CooldownStatus {
    const s = this.state.get(harnessId);
    if (!s) {
      return { cooled: false, untilMs: 0, consecutiveFailures: 0 };
    }
    const cooled = this.now() < s.cooldownUntilMs;
    return {
      cooled,
      untilMs: s.cooldownUntilMs,
      consecutiveFailures: s.consecutiveFailures,
    };
  }

  /**
   * Drop all state. Tests use this; production has no caller because
   * the store's lifetime is the phantombot process.
   */
  clear(): void {
    this.state.clear();
  }
}

/**
 * Process-wide cooldown store shared across the orchestrator and any
 * caller that wants to inspect harness state (e.g. /status diagnostics
 * down the line). Tests use `new CooldownStore()` directly to avoid
 * cross-test bleed.
 */
export const cooldownStore = new CooldownStore();
