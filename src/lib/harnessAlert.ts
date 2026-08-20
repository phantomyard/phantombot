/**
 * Harness health alerting — make a degraded primary LOUD.
 *
 * Failover is deliberately invisible to the user (#284): when claude
 * returns a synthetic `authentication_failed` or `rate_limit` message we
 * suppress its prose and let the next harness answer, so nobody sees
 * "You've hit your session limit" in the middle of a conversation.
 *
 * The cost of that silence showed up on Robbie: a broken OAuth token
 * failed EVERY claude turn for ~3.5 days (21 consecutive
 * `authentication_failed` fallbacks) and the only signal anywhere was the
 * provider's billing dashboard. The agent kept working, so nothing looked
 * wrong. That is the bug this module fixes — not the failover itself.
 *
 * Two alerts, deliberately different in character:
 *
 *   1. DEGRADED — the primary harness is failing but a fallback answered
 *      the turn. The user is still being served; this is FYI-with-an-action
 *      ("go re-auth"). Fires once per incident, not once per turn.
 *
 *   2. EXHAUSTED — no harness could answer. Nothing was delivered. This is
 *      an outage, and the classic shape is a rate limit on the primary with
 *      no fallback configured or every fallback already cooled.
 *
 * Dedup model: an "incident" is a run of consecutive failures for one
 * harness. `noteSuccess` closes the incident, so the NEXT outage alerts
 * again. Within an incident we alert at most once per kind, plus a
 * re-alert floor (REALERT_MS) so a week-long outage doesn't go silent
 * forever after its opening message.
 *
 * Trigger threshold: DEGRADED waits for DEGRADE_AFTER_FAILURES consecutive
 * failures rather than firing on the first one. A single 429 that recovers
 * two minutes later (observed on Robbie 2026-08-19) is not worth a push
 * notification; a token that is actually dead fails every single turn and
 * crosses the threshold in single-digit minutes. (Not seconds: cooldown
 * backoff skips the harness between attempts — 150s, 300s, ... — so three
 * real attempts is ~7.5 min at best, longer on a box with sparse turns.
 * Against 3.5 silent days that is still the whole win.)
 *
 * Lifetime: process-local, like the cooldown store. A restart re-arms the
 * alert — correct, since a restart is also when a fixed credential would
 * first be picked up.
 */

import { log } from "./logger.ts";

/** Consecutive failures on one harness before a DEGRADED alert fires. */
export const DEGRADE_AFTER_FAILURES = 3;

/** Floor between repeat alerts of the same kind within one open incident. */
export const REALERT_MS = 6 * 60 * 60 * 1000; // 6 h

/**
 * Hard deadline on one alert send. The degraded alert is awaited on the
 * turn's COMPLETION path, and the installed sender (`runNotify`) publishes
 * to nostr — `Promise.allSettled(pool.publish(...))` against a relay that
 * accepts the socket and never ACKs has no timeout of its own. A hang there
 * would stall the very turn the alert is reporting on, which is the same
 * harm as throwing, only quieter (and `try/catch` does not cover it). Turn-
 * side callers of `phantombot notify` wrap it in `timeout 25` for exactly
 * this reason; this is that guard, moved inside so both call sites get it.
 */
export const ALERT_SEND_TIMEOUT_MS = 20_000;

/**
 * Coarse cause classification, derived from the error text a harness
 * yields plus the upstream HTTP status when we have one.
 *
 * `auth` is the sticky one: unlike a 429 it will never clear on its own,
 * so it is worth waking the owner. `rate_limit` is transient by nature and
 * only escalates when it takes the whole chain down with it. `timeout` is
 * split out of `other` purely so the outage alert can NAME it: a wedged
 * harness and a crashed one both rendered as "harness error", which sent
 * the reader to the journals to find out which (observed on
 * kw-phantombot 2026-08-20 — a 300s idle kill on a single-harness chain).
 * It changes no policy: like `other` it never fires the degraded alert.
 */
export type HarnessFailureCause = "auth" | "rate_limit" | "timeout" | "other";

/**
 * Statuses the claude CLI stamps that mean "this credential/account is not
 * going to work until a human intervenes". `oauth_org_not_allowed` and
 * `billing_error` sit here with `authentication_failed` because they share
 * the property that matters: retrying cannot fix them.
 */
const AUTH_MARKERS = [
  "authentication_failed",
  "oauth_org_not_allowed",
  "billing_error",
  "invalid_api_key",
  "unauthorized",
];

const RATE_LIMIT_MARKERS = ["rate_limit", "quota", "resource_exhausted"];

/**
 * Text `killCauseToErrorChunk` (src/lib/harnessRunner.ts) stamps when it
 * kills a harness for producing nothing — the hard wall-clock cap, the idle
 * window, and the startup handshake window respectively. Kept as substrings
 * of those exact strings so a reworded suffix does not silently
 * de-classify; if that function's wording changes, this list changes with
 * it and the tests below say so.
 */
const TIMEOUT_MARKERS = ["timed out after", "produced no output within"];

/**
 * Classify a harness error chunk. Matching is on lowercased substrings
 * because the text is harness-authored and varies by CLI ("claude api
 * error: authentication_failed", "pi: 401 unauthorized"). HTTP status
 * wins when present — it is the least ambiguous signal we get.
 *
 * Exported for testing.
 */
export function classifyFailure(
  error: string,
  httpStatus?: number,
): HarnessFailureCause {
  if (httpStatus === 401 || httpStatus === 403) return "auth";
  if (httpStatus === 429) return "rate_limit";
  const text = error.toLowerCase();
  if (AUTH_MARKERS.some((m) => text.includes(m))) return "auth";
  if (RATE_LIMIT_MARKERS.some((m) => text.includes(m))) return "rate_limit";
  if (TIMEOUT_MARKERS.some((m) => text.includes(m))) return "timeout";
  return "other";
}

/** Sends one alert line to the owner. Injected so this module never
 *  imports a channel. Contracted to never throw. */
export type AlertSender = (message: string) => Promise<void> | void;

export interface HarnessAlertOptions {
  send: AlertSender;
  /** Test seam. */
  now?: () => number;
  /** Host label rendered into the message ("which box is broken?"). */
  host?: string;
  /** Test seam — overrides ALERT_SEND_TIMEOUT_MS. */
  sendTimeoutMs?: number;
}

interface IncidentState {
  consecutiveFailures: number;
  cause: HarnessFailureCause;
  /** Last alert time per kind, epoch ms. Cleared when the incident closes. */
  alertedAt: Map<string, number>;
}

/**
 * Tracks per-harness failure runs and emits at most one alert per incident
 * per kind. Not a scheduler and not a retry policy — cooldown owns that
 * (src/lib/cooldown.ts). This only decides when to SPEAK.
 */
export class HarnessAlerter {
  private readonly incidents = new Map<string, IncidentState>();
  private send: AlertSender | undefined;
  private host: string | undefined;
  private readonly now: () => number;
  private readonly sendTimeoutMs: number;

  constructor(options?: HarnessAlertOptions) {
    this.send = options?.send;
    this.host = options?.host;
    this.now = options?.now ?? Date.now;
    this.sendTimeoutMs = options?.sendTimeoutMs ?? ALERT_SEND_TIMEOUT_MS;
  }

  /**
   * Install the sender. Called once from `phantombot run` after config is
   * loaded. Until then every alert is a no-op — that is deliberate: `ask`,
   * tests and one-shot CLI paths have no owner channel to talk to and must
   * not try to open one.
   */
  configure(options: { send: AlertSender; host?: string }): void {
    this.send = options.send;
    this.host = options.host;
  }

  /** True once a sender is installed. */
  get enabled(): boolean {
    return this.send !== undefined;
  }

  /**
   * Record a recoverable failure. Returns the incident's failure count so
   * callers can log it.
   */
  noteFailure(
    harnessId: string,
    error: string,
    httpStatus?: number,
  ): number {
    const cause = classifyFailure(error, httpStatus);
    const prev = this.incidents.get(harnessId);
    const state: IncidentState = prev ?? {
      consecutiveFailures: 0,
      cause,
      alertedAt: new Map(),
    };
    // A run is per-CAUSE, not merely per-harness. Counting a 429 and an auth
    // failure into the same tally makes the count a lie in both directions:
    // two 429s + one auth blip would announce "auth failure x3" (the exact
    // notification this module promises NOT to send), and one stray `other`
    // in the middle of a dead-token run would silently mute it, which is the
    // 3.5-day scenario the module exists to catch. Changing cause therefore
    // starts a fresh run. `alertedAt` deliberately SURVIVES: the re-alert
    // floor is anti-spam and a flapping cause must not be a way around it.
    if (state.cause !== cause) state.consecutiveFailures = 0;
    state.consecutiveFailures += 1;
    state.cause = cause;
    this.incidents.set(harnessId, state);
    return state.consecutiveFailures;
  }

  /** Close the incident for `harnessId` — the harness answered a turn. */
  noteSuccess(harnessId: string): void {
    this.incidents.delete(harnessId);
  }

  /**
   * The primary failed but `servedBy` answered the turn. Alerts once the
   * failure run crosses DEGRADE_AFTER_FAILURES, and only for causes a human
   * can act on (auth). A transient `other`/`rate_limit` that a fallback
   * absorbs is exactly the case #284 wanted silent.
   */
  async noteDegraded(input: {
    harnessId: string;
    servedBy: string;
  }): Promise<void> {
    const state = this.incidents.get(input.harnessId);
    if (!state) return;
    if (state.cause !== "auth") return;
    if (state.consecutiveFailures < DEGRADE_AFTER_FAILURES) return;
    await this.emit(
      input.harnessId,
      "degraded",
      `\u{1f511} ${input.harnessId} auth failure \u00d7${state.consecutiveFailures}${this.hostTag()} \u00b7 ${input.servedBy} serving, run \`${input.harnessId} /login\``,
    );
  }

  /**
   * Nothing in the chain could answer — the user got no reply. Always
   * alerts (subject to the re-alert floor): unlike a degraded primary this
   * is a visible outage, and the owner learning it from the agent beats
   * learning it from a stranger saying "it stopped replying".
   */
  async noteExhausted(input: {
    harnessId: string;
    error: string;
    httpStatus?: number;
    chain: string[];
  }): Promise<void> {
    const cause = classifyFailure(input.error, input.httpStatus);
    const label =
      cause === "rate_limit"
        ? "rate limited"
        : cause === "auth"
          ? "auth failure"
          : cause === "timeout"
            ? "timed out"
            : "harness error";
    const detail =
      cause === "rate_limit" && input.httpStatus
        ? ` ${input.httpStatus}`
        : cause === "rate_limit"
          ? " 429"
          : "";
    // Render the chain: "no fallback left" begs the question "out of what?",
    // and the answer is the difference between "add a fallback" and "both of
    // my harnesses are down".
    const chain = input.chain.length > 0 ? ` [${input.chain.join(" \u2192 ")}]` : "";
    // "no fallback left" implies one was tried and also failed. With a
    // single-entry chain nothing was ever available to try, and that is a
    // different fix (add a fallback, not debug two harnesses), so say so.
    // "usable", because a chain of one is also what a typo'd or unresolvable
    // harness id leaves behind — the owner may well have configured a
    // fallback that never made it into the chain.
    const exhaustion =
      input.chain.length <= 1
        ? "no usable fallback configured"
        : "no fallback left";
    await this.emit(
      input.harnessId,
      "exhausted",
      `\u{1f6a8} ${input.harnessId} ${label}${detail}${this.hostTag()} \u00b7 ${exhaustion}${chain}, turn undelivered`,
    );
  }

  /** Drop all state. Tests only. */
  clear(): void {
    this.incidents.clear();
  }

  /**
   * Resolve `p`, or reject at ALERT_SEND_TIMEOUT_MS. The timer is unref'd so
   * a pending deadline never holds the process open, and the underlying send
   * is abandoned rather than cancelled — it is fire-and-forget by then, and
   * the alternative (waiting for it) is the stall we are preventing.
   */
  private async withDeadline(p: Promise<void> | void): Promise<void> {
    if (!(p instanceof Promise)) return;
    const limit = this.sendTimeoutMs;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        p,
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () => reject(new Error(`alert send timed out after ${limit}ms`)),
            limit,
          );
          (timer as { unref?: () => void }).unref?.();
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  /** ` \ud83d\udda5 <host>` — omitted entirely when the host is unknown. */
  private hostTag(): string {
    return this.host ? ` \ud83d\udda5 ${this.host}` : "";
  }

  /**
   * Send, honouring per-incident dedup. A missing incident record (the
   * exhausted path can fire on a harness whose run we never opened) is
   * treated as a fresh one so the alert still goes out.
   */
  private async emit(
    harnessId: string,
    kind: string,
    message: string,
  ): Promise<void> {
    const send = this.send;
    if (!send) return;
    let state = this.incidents.get(harnessId);
    if (!state) {
      state = {
        consecutiveFailures: 1,
        cause: "other",
        alertedAt: new Map(),
      };
      this.incidents.set(harnessId, state);
    }
    const last = state.alertedAt.get(kind);
    const now = this.now();
    if (last !== undefined && now - last < REALERT_MS) return;
    state.alertedAt.set(kind, now);
    try {
      await this.withDeadline(send(message));
      log.warn("harnessAlert: notified owner", { harnessId, kind });
    } catch (e) {
      // Never let a failed notification break the turn — the alert is a
      // courtesy on top of a turn that already has its own outcome.
      log.warn("harnessAlert: send failed", {
        harnessId,
        kind,
        error: (e as Error).message,
      });
    }
  }
}

/**
 * Process-wide alerter, mirroring `cooldownStore`. Unconfigured (and
 * therefore silent) until `phantombot run` installs a sender. Tests
 * construct their own `new HarnessAlerter({ send })`.
 */
export const harnessAlerter = new HarnessAlerter();
