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
 * crosses the threshold within seconds.
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
 * Coarse cause classification, derived from the error text a harness
 * yields plus the upstream HTTP status when we have one.
 *
 * `auth` is the sticky one: unlike a 429 it will never clear on its own,
 * so it is worth waking the owner. `rate_limit` is transient by nature and
 * only escalates when it takes the whole chain down with it.
 */
export type HarnessFailureCause = "auth" | "rate_limit" | "other";

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
  return "other";
}

/**
 * Legend appended to every alert.
 *
 * These messages are read by owners who do not necessarily read English, so
 * the payload above carries meaning in symbols, proper nouns and numbers —
 * harness ids, hostname, counts, HTTP status, the chain arrow. None of that
 * needs translating. What symbols alone cannot do is TEACH themselves, so a
 * legend rides along: the first alert someone ever receives should be
 * readable without a search. It costs a few lines in a message that fires at
 * most once per incident.
 *
 * Kept as one block so the glyph vocabulary has a single source of truth —
 * a symbol added to a message and not to the legend is a puzzle, and a
 * symbol reused for two causes is worse than prose.
 */
const LEGEND = [
  "\u2139\ufe0f  \u26a0\ufe0f degraded \u00b7 \ud83d\udea8 outage",
  "\ud83d\udd11\u2716 auth \u00b7 \u23f3\u2716 rate limit \u00b7 \ud83d\udca5 other",
  "\u00d7N failed turns \u00b7 \ud83d\udda5 host \u00b7 \u23f1 UTC",
  "\u2705\u2190\ud83d\udcac now answering \u00b7 \u26d4 chain exhausted, 0 replies",
  "\ud83d\udd27 fix \u00b7 \ud83d\udcc4 raw error",
].join("\n");

/** Sends one alert line to the owner. Injected so this module never
 *  imports a channel. Contracted to never throw. */
export type AlertSender = (message: string) => Promise<void> | void;

export interface HarnessAlertOptions {
  send: AlertSender;
  /** Test seam. */
  now?: () => number;
  /** Host label rendered into the message ("which box is broken?"). */
  host?: string;
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

  constructor(options?: HarnessAlertOptions) {
    this.send = options?.send;
    this.host = options?.host;
    this.now = options?.now ?? Date.now;
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
    error: string;
  }): Promise<void> {
    const state = this.incidents.get(input.harnessId);
    if (!state) return;
    if (state.cause !== "auth") return;
    if (state.consecutiveFailures < DEGRADE_AFTER_FAILURES) return;
    await this.emit(
      input.harnessId,
      "degraded",
      [
        `\u26a0\ufe0f ${input.harnessId} \ud83d\udd11\u2716 \u00d7${state.consecutiveFailures}${this.hostTag()}`,
        `\u2705 ${input.servedBy} \u2190 \ud83d\udcac`,
        `\ud83d\udd27 ${input.harnessId} /login`,
        `\u23f1 ${this.stamp()}`,
        "",
        LEGEND,
        "",
        `\ud83d\udcc4 ${truncate(input.error)}`,
      ].join("\n"),
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
    const causeGlyph =
      cause === "rate_limit"
        ? "\u23f3\u2716"
        : cause === "auth"
          ? "\ud83d\udd11\u2716"
          : "\ud83d\udca5";
    const detail =
      cause === "rate_limit" && input.httpStatus
        ? ` ${input.httpStatus}`
        : cause === "rate_limit"
          ? " 429"
          : "";
    await this.emit(
      input.harnessId,
      "exhausted",
      [
        `\ud83d\udea8 ${input.harnessId} ${causeGlyph}${detail}${this.hostTag()}`,
        `\u26d4 ${input.chain.join(" \u2192 ")} \u2192 \u2716  (0 \ud83d\udcac)`,
        `\u23f1 ${this.stamp()}`,
        "",
        LEGEND,
        "",
        `\ud83d\udcc4 ${truncate(input.error)}`,
      ].join("\n"),
    );
  }

  /** Drop all state. Tests only. */
  clear(): void {
    this.incidents.clear();
  }

  /** ` \ud83d\udda5 <host>` — omitted entirely when the host is unknown. */
  private hostTag(): string {
    return this.host ? ` \ud83d\udda5 ${this.host}` : "";
  }

  /** `YYYY-MM-DD HH:MMZ`. UTC on purpose: the reader and the broken box are
   *  routinely in different timezones, and Z is unambiguous in every locale. */
  private stamp(): string {
    return new Date(this.now()).toISOString().slice(0, 16).replace("T", " ") + "Z";
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
      await send(message);
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

function truncate(text: string, limit = 200): string {
  return text.length <= limit ? text : text.slice(0, limit) + "…";
}

/**
 * Process-wide alerter, mirroring `cooldownStore`. Unconfigured (and
 * therefore silent) until `phantombot run` installs a sender. Tests
 * construct their own `new HarnessAlerter({ send })`.
 */
export const harnessAlerter = new HarnessAlerter();
