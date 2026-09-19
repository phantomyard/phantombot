/**
 * In-memory per-harness cooldown store.
 *
 * Why this exists: a harness can sit on a provider 429 (or any 4XX) while
 * its client retries, then
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
 *      the provider, hammering it on every turn over the
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
 * Lifetime: in-memory, but OPTIONALLY persisted — see `hydrate()`. A window
 * the provider set (a quota that resets at a wall-clock time) outlives our
 * process, and `phantombot update` restarts the service, so a purely
 * process-local store re-probes a quota it already knows is closed every time
 * the box comes back. Persisted windows are re-adopted only while still in
 * the future.
 *
 * Concurrency: phantombot serializes turns per conversation, and the
 * orchestrator runs a single turn at a time within one process, so
 * naive in-memory state without locking is safe.
 */

/** Base cooldown for the first consecutive failure, in milliseconds. */
export const BASE_COOLDOWN_MS = 150_000; // 150 s

/** Hard upper bound on a HEURISTIC (laddered) cooldown window, in ms. */
export const MAX_COOLDOWN_MS = 3_600_000; // 1 h

/**
 * Upper bound on a window the PROVIDER asked for explicitly — a Retry-After
 * duration or a parsed "try again at ..." deadline.
 *
 * Higher than the ladder cap on purpose. A subscription quota is measured in
 * hours ("try again at 8:58 PM" on a 16:58 failure is four of them), and
 * clamping that to the ladder's one hour means re-probing a window we have
 * been TOLD is closed, three more times, for nothing. The ladder's cap stays
 * where it is because the ladder is a guess; this one is an instruction.
 *
 * Still bounded, because the instruction arrives as parsed prose: the worst
 * case a bad parse can buy is six hours of the chain preferring a fallback,
 * never a dropped turn — the all-cooled escape hatch in
 * orchestrator/fallback.ts runs the chain regardless when nobody is eligible.
 */
export const MAX_EXPLICIT_COOLDOWN_MS = 6 * 3_600_000; // 6 h

/**
 * Jitter ratio: the actual cooldown is uniformly drawn from
 * [base * (1 - JITTER_RATIO), base * (1 + JITTER_RATIO)].
 */
export const JITTER_RATIO = 0.25;

export interface HarnessCooldownState {
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
export interface CooldownPersistence {
  /**
   * Write the whole store out. Called on every state change, so it must be
   * cheap and MUST NOT throw — the cooldown is a latency optimisation and a
   * failed write can never be allowed to break a turn.
   */
  save(entries: Record<string, HarnessCooldownState>): void;
  /**
   * Optional: resolve once every write `save` has queued has settled. A sink
   * that writes synchronously, or one in a test, can omit it.
   */
  settled?(): Promise<void>;
}

export class CooldownStore {
  private readonly state = new Map<string, HarnessCooldownState>();
  private persistence: CooldownPersistence | undefined;

  constructor(
    private readonly random: RandomFn = Math.random,
    /** Test seam — defaults to Date.now. */
    private readonly now: () => number = Date.now,
  ) {}

  /**
   * Record a recoverable failure for `harnessId`. Increments the
   * consecutive-failure count and (re)arms the cooldown window with
   * jitter applied. Returns the resulting status (handy for logging).
   *
   * `retryAfterMs` (issue #559): when the provider explicitly said how
   * long to wait (HTTP `Retry-After`), the window honors that value
   * directly instead of the ladder — clamped to [1 ms, MAX_COOLDOWN_MS],
   * NOT jittered (it is an explicit instruction, not a heuristic). The
   * consecutive-failure count still increments so observability and the
   * post-window re-failure lengthening keep working.
   */
  markFailure(
    harnessId: string,
    opts: { retryAfterMs?: number } = {},
  ): CooldownStatus {
    const prev = this.state.get(harnessId);
    const failures = (prev?.consecutiveFailures ?? 0) + 1;
    const retryAfterMs = opts.retryAfterMs;
    const jittered =
      retryAfterMs !== undefined && retryAfterMs > 0
        ? Math.min(Math.max(Math.round(retryAfterMs), 1), MAX_EXPLICIT_COOLDOWN_MS)
        : applyJitter(baseCooldownForFailures(failures), this.random);
    const untilMs = this.now() + jittered;
    const next: HarnessCooldownState = {
      consecutiveFailures: failures,
      cooldownUntilMs: untilMs,
    };
    this.state.set(harnessId, next);
    this.flush();
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
    const had = this.state.delete(harnessId);
    if (had) this.flush();
  }

  /**
   * Install a persistence sink and adopt any windows it previously stored.
   *
   * Why persist at all, when the header above says a fresh process "might as
   * well try": because a window the PROVIDER set outlives our process. A
   * subscription quota that resets at 8:58 PM is still closed after a restart,
   * an update, or a crash loop — and `phantombot update` restarts the service,
   * so the case is common rather than exotic. Re-probing then is not a cheap
   * optimism, it is a guaranteed-failed turn's worth of latency in front of
   * the user, repeated on every restart inside the window.
   *
   * Only FUTURE windows are adopted, and the failure counts that come with
   * them: an expired entry restores nothing, so a box that was down for a day
   * comes up clean rather than benched.
   */
  hydrate(
    entries: Record<string, HarnessCooldownState>,
    persistence?: CooldownPersistence,
  ): void {
    const now = this.now();
    for (const [harnessId, entry] of Object.entries(entries)) {
      if (!entry || typeof entry.cooldownUntilMs !== "number") continue;
      if (entry.cooldownUntilMs <= now) continue;
      this.state.set(harnessId, {
        consecutiveFailures: Math.max(1, entry.consecutiveFailures ?? 1),
        cooldownUntilMs: entry.cooldownUntilMs,
      });
    }
    this.persistence = persistence;
  }

  /** Current windows, for persistence and for `/status`-style diagnostics. */
  snapshot(): Record<string, HarnessCooldownState> {
    return Object.fromEntries(this.state);
  }

  private flush(): void {
    if (!this.persistence) return;
    try {
      this.persistence.save(this.snapshot());
    } catch {
      // Contracted never to throw; belt and braces so a sink that breaks its
      // contract still cannot take a turn down with it.
    }
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
   * Drop all state — and PERSIST the drop.
   *
   * This used to also null out `this.persistence`, which made "reset the
   * cooldowns" a one-way door: the store kept working in memory but silently
   * stopped writing to disk until the process restarted, so the next restart
   * re-adopted the very windows that were cleared. Production has no caller
   * today, so nothing was broken in the field — but a `/status`-style "reset
   * cooldowns" admin path is exactly the caller this method exists for, and
   * it would have inherited the bug with no test able to see it.
   *
   * Keeping the sink and flushing an empty snapshot makes clear() mean the
   * same thing in memory and on disk. Tests construct `new CooldownStore()`
   * with no sink, so clear() stays a pure in-memory reset for them.
   */
  clear(): void {
    this.state.clear();
    this.flush();
  }
}

/**
 * Process-wide cooldown store shared across the orchestrator and any
 * caller that wants to inspect harness state (e.g. /status diagnostics
 * down the line). Tests use `new CooldownStore()` directly to avoid
 * cross-test bleed.
 */
export const cooldownStore = new CooldownStore();
