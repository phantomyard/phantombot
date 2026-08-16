/**
 * Tests for read-back-driven relay quarantine (issue #359).
 *
 * THE BUG: issue #368 gave us read-back verification, which correctly NAMES
 * the relays that ACK a publish and never store it — and then we published to
 * them again on the very next message, forever. In production 4 of 7 canonical
 * relays fail read-back on ~100% of events. Every send wasted 4 publishes and
 * emitted a warning; nothing ever adapted.
 *
 * THE FIX, and what these tests pin:
 *
 *   1. Consecutive read-back failures quarantine a relay from the PUBLISH set
 *      (and only the publish set — reads keep flowing, which is what makes
 *      promotion free).
 *   2. A single confirmation clears the streak, so a slow or hiccuping relay is
 *      never quarantined for a blip.
 *   3. The floor of 3 is a HARD constraint: quarantine may never shrink the
 *      publish set below it, because the recipient quarantines independently
 *      and the two sets must still intersect.
 *   4. Ranking is deterministic and pure, so both ends converge on the same
 *      subset from the same observations.
 *   5. Repeat offenders back off exponentially, and jitter keeps a fleet from
 *      un-quarantining in lockstep.
 */

import { describe, expect, test } from "bun:test";
import {
  finalizeEvent,
  generateSecretKey,
} from "nostr-tools/pure";
import {
  MIN_PUBLISH_RELAYS,
  QUARANTINE_BASE_MS,
  QUARANTINE_MAX_MS,
  READBACK_STRIKE_THRESHOLD,
  RelayHealthTracker,
  rankRelays,
  relayScore,
  type RelayHealthRecord,
} from "../src/channels/phantomchat/relayHealth.ts";
import {
  SimplePoolPhantomchatTransport,
  type NostrFilter,
  type RelayPool,
} from "../src/channels/phantomchat/transport.ts";
import type { NTNostrEvent } from "../src/lib/nostrCrypto.ts";

const quietLog = { info: () => {}, debug: () => {} };
/** No jitter — deterministic spans in tests. */
const noJitter = () => 1;

const SEVEN = [
  "wss://r1.example",
  "wss://r2.example",
  "wss://r3.example",
  "wss://r4.example",
  "wss://r5.example",
  "wss://r6.example",
  "wss://r7.example",
];

function tracker(relays = SEVEN) {
  return new RelayHealthTracker(relays, quietLog, noJitter);
}

/** Fail `url` enough times to earn a quarantine. */
function strikeOut(t: RelayHealthTracker, url: string, now = Date.now()): void {
  for (let i = 0; i < READBACK_STRIKE_THRESHOLD; i++) t.record(url, false, now);
}

describe("relay quarantine from read-back failures", () => {
  test("a relay is NOT quarantined before the strike threshold", () => {
    const t = tracker();
    const now = Date.now();
    for (let i = 0; i < READBACK_STRIKE_THRESHOLD - 1; i++) {
      t.record("wss://r1.example", false, now);
    }
    expect(t.isQuarantined("wss://r1.example", now)).toBe(false);
    expect(t.publishTargets(now)).toContain("wss://r1.example");
  });

  test("the threshold-th consecutive failure quarantines it", () => {
    const t = tracker();
    const now = Date.now();
    strikeOut(t, "wss://r1.example", now);
    expect(t.isQuarantined("wss://r1.example", now)).toBe(true);
    expect(t.publishTargets(now)).not.toContain("wss://r1.example");
  });

  test("one confirmation clears the streak — a blip never quarantines", () => {
    const t = tracker();
    const now = Date.now();
    for (let i = 0; i < READBACK_STRIKE_THRESHOLD - 1; i++) {
      t.record("wss://r1.example", false, now);
    }
    t.record("wss://r1.example", true, now); // recovered
    for (let i = 0; i < READBACK_STRIKE_THRESHOLD - 1; i++) {
      t.record("wss://r1.example", false, now);
    }
    expect(t.isQuarantined("wss://r1.example", now)).toBe(false);
  });

  test("quarantine expires lazily after the span, with no timer", () => {
    const t = tracker();
    const now = Date.now();
    strikeOut(t, "wss://r1.example", now);
    expect(t.isQuarantined("wss://r1.example", now + QUARANTINE_BASE_MS - 1)).toBe(true);
    expect(t.isQuarantined("wss://r1.example", now + QUARANTINE_BASE_MS + 1)).toBe(false);
  });

  test("a confirmation while quarantined releases it early", () => {
    const t = tracker();
    const now = Date.now();
    strikeOut(t, "wss://r1.example", now);
    expect(t.isQuarantined("wss://r1.example", now)).toBe(true);
    t.record("wss://r1.example", true, now);
    expect(t.isQuarantined("wss://r1.example", now)).toBe(false);
  });

  test("repeat offences back off exponentially and cap", () => {
    const t = tracker();
    let now = Date.now();
    // 1st offence: base span.
    strikeOut(t, "wss://r1.example", now);
    expect(t.isQuarantined("wss://r1.example", now + QUARANTINE_BASE_MS - 1)).toBe(true);
    // 2nd offence after it lapses: 2× base.
    now += QUARANTINE_BASE_MS + 1;
    strikeOut(t, "wss://r1.example", now);
    expect(t.isQuarantined("wss://r1.example", now + QUARANTINE_BASE_MS * 2 - 1)).toBe(true);
    expect(t.isQuarantined("wss://r1.example", now + QUARANTINE_BASE_MS * 2 + 1)).toBe(false);
    // Many offences later it saturates at the cap, never beyond.
    for (let i = 0; i < 10; i++) {
      now += QUARANTINE_MAX_MS + 1;
      strikeOut(t, "wss://r1.example", now);
    }
    expect(t.isQuarantined("wss://r1.example", now + QUARANTINE_MAX_MS + 1)).toBe(false);
  });

  test("jitter spreads the span so a fleet doesn't stampede", () => {
    const spans = new Set<number>();
    for (let i = 0; i < 20; i++) {
      const t = new RelayHealthTracker(SEVEN, quietLog);
      const now = 0;
      strikeOut(t, "wss://r1.example", now);
      // Binary-search-free probe: find the smallest ms at which it's free.
      let span = QUARANTINE_BASE_MS * 0.8;
      while (t.isQuarantined("wss://r1.example", span)) span += 60_000;
      spans.add(span);
    }
    expect(spans.size).toBeGreaterThan(1);
  });
});

describe("the floor of 3 outranks quarantine", () => {
  test("publish set never drops below MIN_PUBLISH_RELAYS", () => {
    const t = tracker();
    const now = Date.now();
    // Poison every single relay.
    for (const url of SEVEN) strikeOut(t, url, now);
    const targets = t.publishTargets(now);
    expect(targets.length).toBe(MIN_PUBLISH_RELAYS);
  });

  test("a quarantined relay is promoted back to fill the floor", () => {
    const t = tracker();
    const now = Date.now();
    // Kill 5 of 7 — only 2 healthy remain, one short of the floor.
    for (const url of SEVEN.slice(0, 5)) strikeOut(t, url, now);
    const targets = t.publishTargets(now);
    expect(targets.length).toBe(MIN_PUBLISH_RELAYS);
    expect(targets).toContain("wss://r6.example");
    expect(targets).toContain("wss://r7.example");
    // The third is a promoted quarantined relay — and it's the best-ranked one,
    // not an arbitrary pick.
    const promoted = targets.filter((u) => t.isQuarantined(u, now));
    expect(promoted.length).toBe(1);
  });

  test("promotion picks the LEAST-bad quarantined relay", () => {
    const t = tracker();
    const now = Date.now();
    for (const url of SEVEN.slice(0, 5)) strikeOut(t, url, now);
    // r1 has also confirmed plenty in its life; r2..r5 never confirmed at all.
    for (let i = 0; i < 50; i++) t.record("wss://r1.example", true, now);
    strikeOut(t, "wss://r1.example", now); // re-quarantine it, good ratio intact
    const targets = t.publishTargets(now);
    const promoted = targets.filter((u) => t.isQuarantined(u, now));
    expect(promoted).toEqual(["wss://r1.example"]);
  });

  test("with fewer relays configured than the floor, we use them all", () => {
    const two = ["wss://a.example", "wss://b.example"];
    const t = tracker(two);
    const now = Date.now();
    for (const url of two) strikeOut(t, url, now);
    expect(t.publishTargets(now).sort()).toEqual([...two].sort());
  });

  test("healthy relays are preferred over promoted ones", () => {
    const t = tracker();
    const now = Date.now();
    for (const url of SEVEN.slice(0, 4)) strikeOut(t, url, now);
    const targets = t.publishTargets(now);
    // Exactly the 3 survivors, no promotion needed.
    expect(targets.sort()).toEqual(
      ["wss://r5.example", "wss://r6.example", "wss://r7.example"],
    );
  });
});

describe("deterministic ranking", () => {
  test("same observations produce the same order (pure, no clock)", () => {
    const health = new Map<string, RelayHealthRecord>([
      ["wss://r1.example", { strikes: 0, confirmed: 10, dropped: 0, quarantinedUntil: 0, quarantineCount: 0 }],
      ["wss://r2.example", { strikes: 0, confirmed: 5, dropped: 5, quarantinedUntil: 0, quarantineCount: 0 }],
    ]);
    const a = rankRelays(SEVEN, health);
    const b = rankRelays([...SEVEN].reverse(), health);
    expect(a).toEqual(b);
  });

  test("url is the tiebreak, so unobserved relays still order identically", () => {
    const ranked = rankRelays(SEVEN, new Map());
    expect(ranked).toEqual([...SEVEN].sort());
  });

  test("a dropping relay ranks below a confirming one", () => {
    const health = new Map<string, RelayHealthRecord>([
      ["wss://r7.example", { strikes: 0, confirmed: 10, dropped: 0, quarantinedUntil: 0, quarantineCount: 0 }],
      ["wss://r1.example", { strikes: 0, confirmed: 0, dropped: 10, quarantinedUntil: 0, quarantineCount: 0 }],
    ]);
    const ranked = rankRelays(SEVEN, health);
    // r7 confirms everything, r1 drops everything. Note the unobserved relays
    // tie with r7 at score 1 (optimism) and break by url, so this asserts the
    // RELATIVE order that matters, not an absolute position.
    expect(ranked.indexOf("wss://r7.example"))
      .toBeLessThan(ranked.indexOf("wss://r1.example"));
    expect(ranked[ranked.length - 1]).toBe("wss://r1.example");
  });

  test("an unobserved relay is optimistically scored 1", () => {
    expect(relayScore(undefined)).toBe(1);
  });

  test("current strikes penalise an otherwise-good ratio", () => {
    const clean: RelayHealthRecord = { strikes: 0, confirmed: 10, dropped: 0, quarantinedUntil: 0, quarantineCount: 0 };
    const striking: RelayHealthRecord = { ...clean, strikes: 3 };
    expect(relayScore(striking)).toBeLessThan(relayScore(clean));
  });
});

describe("transport wiring", () => {
  const sk = generateSecretKey();
  const event = finalizeEvent(
    { kind: 1059, created_at: Math.floor(Date.now() / 1000), tags: [], content: "wrapped" },
    sk,
  ) as unknown as NTNostrEvent;

  /** Fake pool: `storedOn` decides which relays answer the read-back REQ. */
  function storedPool(storedOn: Set<string>, published: string[][] = []): RelayPool {
    return {
      subscribeMany(
        relays: string[],
        filter: NostrFilter,
        params: { onevent: (e: NTNostrEvent) => void; oneose?: () => void },
      ) {
        const [relay] = relays;
        if (filter.ids && relay && storedOn.has(relay)) {
          queueMicrotask(() => params.onevent(event));
        } else {
          queueMicrotask(() => params.oneose?.());
        }
        return { close() {} };
      },
      publish(relays: string[]) {
        published.push([...relays]);
        return relays.map(() => Promise.resolve("ok"));
      },
      close() {},
    } as unknown as RelayPool;
  }

  test("read-back results feed the tracker and quarantine a dropper", async () => {
    const relays = SEVEN;
    const transport = new SimplePoolPhantomchatTransport(
      sk,
      relays,
      // Only r5/r6/r7 actually store; r1..r4 ACK-and-drop (Jeroen's case).
      storedPool(new Set(["wss://r5.example", "wss://r6.example", "wss://r7.example"])),
    );
    for (let i = 0; i < READBACK_STRIKE_THRESHOLD; i++) {
      await transport.verifyStored(event, { settleMs: 0, timeoutMs: 50 });
    }
    expect(transport.relayHealth.isQuarantined("wss://r1.example")).toBe(true);
    expect(transport.relayHealth.isQuarantined("wss://r5.example")).toBe(false);
  });

  test("publishWrap narrows to the healthy set but keeps the floor", async () => {
    const published: string[][] = [];
    const transport = new SimplePoolPhantomchatTransport(
      sk,
      SEVEN,
      storedPool(
        new Set(["wss://r5.example", "wss://r6.example", "wss://r7.example"]),
        published,
      ),
    );
    for (let i = 0; i < READBACK_STRIKE_THRESHOLD; i++) {
      await transport.verifyStored(event, { settleMs: 0, timeoutMs: 50 });
    }
    published.length = 0;
    await transport.publishWrap(event);
    expect(published[0]?.sort()).toEqual(
      ["wss://r5.example", "wss://r6.example", "wss://r7.example"],
    );
  });

  test("the SUBSCRIPTION set is never narrowed — reads keep every relay", async () => {
    const transport = new SimplePoolPhantomchatTransport(
      sk,
      SEVEN,
      storedPool(new Set()),
    );
    for (let i = 0; i < READBACK_STRIKE_THRESHOLD; i++) {
      await transport.verifyStored(event, { settleMs: 0, timeoutMs: 50 });
    }
    // Every relay is now a dropper, yet `relays` (what we subscribe on) is
    // untouched — that's what makes promotion free, no reconnect required.
    expect(transport.relays.length).toBe(SEVEN.length);
  });
});

describe("setRelays — surviving a relay-config change", () => {
  test("relays that survive the change KEEP their health and quarantine", () => {
    const t = tracker();
    const now = Date.now();
    strikeOut(t, "wss://r1.example", now);
    expect(t.isQuarantined("wss://r1.example", now)).toBe(true);

    t.setRelays(SEVEN.slice(0, 5));
    // Same relay, same url, same verdict — a config reload is not an amnesty.
    expect(t.isQuarantined("wss://r1.example", now)).toBe(true);
    expect(t.publishTargets(now)).not.toContain("wss://r1.example");
  });

  test("records for relays dropped from the config are forgotten", () => {
    const t = tracker();
    const now = Date.now();
    strikeOut(t, "wss://r7.example", now);
    expect(t.isQuarantined("wss://r7.example", now)).toBe(true);

    // Removed from the config, then added back: it returns as a STRANGER, not
    // as a convict. Dropping the record is what keeps a process that rotates
    // its relay list from accumulating dead entries forever.
    t.setRelays(SEVEN.slice(0, 3));
    t.setRelays(SEVEN);
    expect(t.isQuarantined("wss://r7.example", now)).toBe(false);
    const row = t.report(now).find((r) => r.relay === "wss://r7.example");
    expect(row?.dropped).toBe(0);
    expect(row?.strikes).toBe(0);
  });

  test("newly-added relays are usable immediately (optimistic score)", () => {
    const t = tracker(SEVEN.slice(0, 3));
    const now = Date.now();
    t.setRelays([...SEVEN.slice(0, 3), "wss://r8.example"]);
    expect(t.publishTargets(now)).toContain("wss://r8.example");
  });

  test("ranking follows the new list, not the constructor's", () => {
    const t = tracker();
    const next = ["wss://r2.example", "wss://r3.example", "wss://r4.example"];
    t.setRelays(next);
    expect(t.publishTargets(Date.now()).sort()).toEqual([...next].sort());
  });
});
