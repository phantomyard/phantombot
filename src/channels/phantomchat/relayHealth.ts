/**
 * Relay health tracking + quarantine (issue #359).
 *
 * BACKGROUND. A nostr relay can answer a publish with `OK:true` and never
 * store the event (nostr-rs-relay's ACK-then-drop on non-conformant events, or
 * an unauthenticated publish under `nip42_auth`). Issue #368 added read-back
 * verification, which NAMES the relays that dropped an event — but nothing
 * acted on the result. In production 4 of the 7 canonical relays fail read-back
 * on ~100% of events, and we kept publishing to them on every message forever:
 * wasted connections, wasted publishes, and a warning line per send.
 *
 * WHAT THIS DOES. Turn that existing read-back signal into a quarantine
 * decision. A relay that fails read-back READBACK_STRIKE_THRESHOLD times in a
 * row is quarantined from the PUBLISH set for an exponentially growing span
 * (base one hour, jittered). It keeps its READ subscription — see "reads are
 * never quarantined" below — so promoting it back costs nothing.
 *
 * FOUR PROPERTIES THIS IS BUILT AROUND
 *
 * 1. NO POLLING, NO TIMERS. Health is a by-product of traffic we already
 *    generate: every publish already runs a read-back, so scoring is free.
 *    There is no health-check loop and not a single `setTimeout` in this file
 *    — quarantine expiry is evaluated lazily, by comparing `Date.now()` at the
 *    moment we next need a publish set. A pool that sends nothing burns
 *    literally zero cycles on health.
 *
 * 2. READS ARE NEVER QUARANTINED — so failover is instant. Quarantine applies
 *    ONLY to publish targets. The transport keeps its subscription open on
 *    every configured relay, which means (a) a relay that drops writes may
 *    still deliver reads, and the 15s catch-up poll keeps using it, and (b)
 *    every quarantined relay is a WARM SPARE: its socket is already open, so
 *    promoting one back into the publish set is a pure bookkeeping change with
 *    no connect, no handshake, no wait. This is the "I hate waiting to
 *    reconnect a relay" requirement — we never reconnect, because we never
 *    disconnected.
 *
 * 3. A FLOOR OF THREE. Delivery only needs ONE healthy relay shared by sender
 *    and recipient, but the sender and the recipient quarantine independently —
 *    phantombot's bad-relay set and the PWA's need not agree. A floor of 3
 *    keeps the intersection non-empty in practice. `publishTargets()` will
 *    therefore promote the best-ranked quarantined relays back, ignoring their
 *    remaining quarantine, rather than ever return fewer than
 *    MIN_PUBLISH_RELAYS. A quarantine is an OPINION about relay quality; the
 *    floor is a HARD CONSTRAINT and wins.
 *
 *    Say this precisely, because it will be quoted: the floor is NOT a proof of
 *    intersection. Two 3-subsets of a 7-relay list can be disjoint. What makes
 *    disjointness unlikely is the floor TOGETHER WITH property 4 — both ends
 *    rank by the same pure function, so they only diverge to the extent their
 *    observations diverge. If we ever need a real guarantee it has to come from
 *    a pinned, shared write set, not from a larger floor.
 *
 * 4. DETERMINISTIC RANKING. `rankRelays` is a pure total order over (score,
 *    url). Given the same observations, phantombot and the PWA sort the same
 *    way — so the two ends converge on the same subset instead of drifting
 *    apart and losing their intersection. The url tiebreak matters: it is what
 *    makes the order total, and it is why a fresh client with no observations
 *    at all still picks the same three relays as everyone else.
 */

/** Consecutive read-back failures before a relay is quarantined. */
export const READBACK_STRIKE_THRESHOLD = 5;

/**
 * First quarantine span. Doubles on each REPEAT offence (a relay that earns a
 * quarantine again after already serving one), capped at QUARANTINE_MAX_MS, so
 * a persistently dead relay is retried roughly twice a day instead of hourly,
 * while a relay that had one bad hour is back in rotation quickly.
 */
export const QUARANTINE_BASE_MS = 60 * 60 * 1000; // 1 hour
export const QUARANTINE_MAX_MS = 6 * 60 * 60 * 1000; // 6 hours

/**
 * ±10% jitter on every quarantine span. Without it, a fleet that all saw the
 * same relay die at the same time un-quarantines it at the same instant and
 * stampedes it. The jitter is applied once, when the quarantine is set.
 */
export const QUARANTINE_JITTER = 0.1;

/**
 * Never publish to fewer than this many relays — see property 3 above. If
 * quarantine would take us below the floor, the best-ranked quarantined relays
 * are promoted back to fill it.
 */
export const MIN_PUBLISH_RELAYS = 3;

/**
 * Per-relay health record. Deliberately small and JSON-shaped: it is cheap to
 * keep in memory, and cheap to persist later if we ever want health to survive
 * a restart (we currently don't — a restart is a reasonable moment to give
 * every relay a fresh chance).
 */
export interface RelayHealthRecord {
  /** Consecutive read-back failures. Reset to 0 by any confirmed store. */
  strikes: number;
  /** Lifetime counters, for ranking and for the health report. */
  confirmed: number;
  dropped: number;
  /** Epoch ms until which this relay is out of the publish set; 0 = active. */
  quarantinedUntil: number;
  /** How many quarantines this relay has served — drives the backoff. */
  quarantineCount: number;
}

const emptyRecord = (): RelayHealthRecord => ({
  strikes: 0,
  confirmed: 0,
  dropped: 0,
  quarantinedUntil: 0,
  quarantineCount: 0,
});

/**
 * Health score in [0, 1]: the share of read-backs a relay confirmed. A relay
 * with no observations yet scores 1 (optimistic — an unknown relay is assumed
 * good until it proves otherwise, which is what lets a fresh client use its
 * configured relays immediately). Current strikes are subtracted as a small
 * penalty so a relay that is failing RIGHT NOW ranks below one with the same
 * lifetime ratio that is currently fine.
 */
export function relayScore(rec: RelayHealthRecord | undefined): number {
  if (!rec) return 1;
  const total = rec.confirmed + rec.dropped;
  const ratio = total === 0 ? 1 : rec.confirmed / total;
  const strikePenalty = Math.min(rec.strikes, READBACK_STRIKE_THRESHOLD) /
    (READBACK_STRIKE_THRESHOLD * 10);
  return Math.max(0, ratio - strikePenalty);
}

/**
 * Deterministic total order: best score first, url ascending as the tiebreak.
 * PURE — no clock, no randomness — so both ends of a conversation produce the
 * same order from the same observations. Do not add a time term here.
 */
export function rankRelays(
  relays: readonly string[],
  health: ReadonlyMap<string, RelayHealthRecord>,
): string[] {
  return [...relays].sort((a, b) => {
    const diff = relayScore(health.get(b)) - relayScore(health.get(a));
    if (Math.abs(diff) > 1e-9) return diff;
    return a < b ? -1 : a > b ? 1 : 0;
  });
}

/**
 * Tracks per-relay read-back outcomes and derives the publish set.
 *
 * Lifecycle: `record()` is called once per relay per publish (from the
 * transport's existing read-back pass), `publishTargets()` is called once per
 * publish. Nothing else runs. No timers are created or held.
 */
export class RelayHealthTracker {
  private readonly health = new Map<string, RelayHealthRecord>();
  /** Relays whose quarantine we've already logged, so we log each once. */
  private readonly announced = new Set<string>();

  constructor(
    private relays: readonly string[],
    private readonly log: {
      info: (msg: string, meta?: unknown) => void;
      debug: (msg: string, meta?: unknown) => void;
    },
    /** Injectable for tests. Defaults to a ±QUARANTINE_JITTER factor. */
    private readonly jitter: () => number = () =>
      1 + (Math.random() * 2 - 1) * QUARANTINE_JITTER,
  ) {}

  /**
   * Replace the relay list this tracker ranks over.
   *
   * The tracker is constructed with the relay list, which would go stale the
   * day relay config becomes hot-reloadable. Rather than leave that as a
   * comment-shaped trap, the seam exists now: call this whenever the transport
   * re-reads its relay set. Health is keyed by URL, so relays that survive the
   * change KEEP their observations and their in-flight quarantines; records for
   * relays that are gone are dropped, so a long-lived process that rotates its
   * relay list does not accumulate them forever.
   */
  setRelays(relays: readonly string[]): void {
    this.relays = [...relays];
    const live = new Set(relays);
    for (const url of [...this.health.keys()]) {
      if (!live.has(url)) {
        this.health.delete(url);
        this.announced.delete(url);
      }
    }
  }

  private rec(url: string): RelayHealthRecord {
    let r = this.health.get(url);
    if (!r) {
      r = emptyRecord();
      this.health.set(url, r);
    }
    return r;
  }

  /**
   * Record one read-back outcome. `confirmed` = the relay returned the event
   * we just published to it (it really stored it); false = it didn't, within
   * the read-back timeout.
   *
   * A single confirmation clears the strike streak: quarantine is for relays
   * that are CONSISTENTLY dropping, not ones that hiccuped or were slow to
   * index. This is also the recovery path — a promoted relay that starts
   * confirming again is immediately back to a clean record.
   */
  record(url: string, confirmed: boolean, now = Date.now()): void {
    const r = this.rec(url);
    if (confirmed) {
      r.confirmed++;
      if (r.strikes > 0) {
        this.log.debug("phantomchat: relay read-back recovered", {
          relay: url,
          clearedStrikes: r.strikes,
        });
      }
      r.strikes = 0;
      // A relay that confirms while quarantined has proved itself — let it
      // straight back in rather than making it sit out the rest of the span.
      if (r.quarantinedUntil > now) {
        r.quarantinedUntil = 0;
        this.announced.delete(url);
        this.log.info("phantomchat: relay released from quarantine early", {
          relay: url,
        });
      }
      return;
    }

    r.dropped++;
    r.strikes++;
    if (r.strikes < READBACK_STRIKE_THRESHOLD) return;
    if (r.quarantinedUntil > now) return; // already serving one

    const span = Math.min(
      QUARANTINE_BASE_MS * Math.pow(2, r.quarantineCount),
      QUARANTINE_MAX_MS,
    );
    const jittered = Math.round(span * this.jitter());
    r.quarantinedUntil = now + jittered;
    r.quarantineCount++;
    r.strikes = 0; // streak consumed by the quarantine
    this.announced.delete(url);
    this.log.info("phantomchat: relay quarantined from publish set", {
      relay: url,
      forMinutes: Math.round(jittered / 60000),
      offence: r.quarantineCount,
      confirmed: r.confirmed,
      dropped: r.dropped,
    });
  }

  /** True if `url` is currently serving a quarantine. */
  isQuarantined(url: string, now = Date.now()): boolean {
    return (this.health.get(url)?.quarantinedUntil ?? 0) > now;
  }

  /**
   * The relays to publish to right now.
   *
   * Healthy relays first; if that leaves us below MIN_PUBLISH_RELAYS, the
   * best-ranked quarantined relays are promoted back to fill the floor (the
   * floor is a hard constraint, quarantine is only an opinion — property 3).
   * Promotion is free: those sockets are still open for reads (property 2).
   *
   * Lazy expiry: quarantines are evaluated against `now` here, which is the
   * only place time is read. No timer wakes anything up to expire them.
   */
  publishTargets(now = Date.now()): string[] {
    const ranked = rankRelays(this.relays, this.health);
    const active = ranked.filter((url) => !this.isQuarantined(url, now));
    if (active.length >= MIN_PUBLISH_RELAYS) return active;

    // Below the floor — promote the best quarantined relays back, in rank
    // order, until we hit it (or run out of relays entirely).
    const promoted = ranked.filter((url) => this.isQuarantined(url, now));
    const filled = [...active];
    for (const url of promoted) {
      if (filled.length >= MIN_PUBLISH_RELAYS) break;
      filled.push(url);
      if (!this.announced.has(url)) {
        this.announced.add(url);
        this.log.info(
          "phantomchat: promoting quarantined relay to hold the floor",
          { relay: url, floor: MIN_PUBLISH_RELAYS, healthy: active.length },
        );
      }
    }
    return filled;
  }

  /** Snapshot for logging / diagnostics. Never used for control flow. */
  report(now = Date.now()): Array<
    { relay: string; score: number; quarantined: boolean } & RelayHealthRecord
  > {
    return rankRelays(this.relays, this.health).map((relay) => {
      const r = this.health.get(relay) ?? emptyRecord();
      return {
        relay,
        score: relayScore(r),
        quarantined: this.isQuarantined(relay, now),
        ...r,
      };
    });
  }
}
