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
  QUARANTINE_JITTER,
  QUARANTINE_MAX_MS,
  READBACK_STRIKE_THRESHOLD,
  RelayHealthTracker,
  SLOW_RELAY_ACCEPT_MS,
  SLOW_RELAY_MIN_SAMPLES,
  rankRelays,
  relayScore,
  type RelayHealthRecord,
} from "../src/channels/phantomchat/relayHealth.ts";
import {
  PUBLISH_CONFIRM_QUORUM,
  RELAY_HEALTH_PROBE_INTERVAL_MS,
  RELAY_HEALTH_PROBE_JITTER,
  SimplePoolPhantomchatTransport,
  type NostrFilter,
  type RelayPool,
} from "../src/channels/phantomchat/transport.ts";
import type { NTNostrEvent } from "../src/lib/nostrCrypto.ts";
import { setLogSink } from "../src/lib/logSink.ts";

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

  test("jitter spans the full ±25% policy bounds", () => {
    const now = 1_000;
    const early = new RelayHealthTracker(
      SEVEN,
      quietLog,
      () => 1 - QUARANTINE_JITTER,
    );
    const late = new RelayHealthTracker(
      SEVEN,
      quietLog,
      () => 1 + QUARANTINE_JITTER,
    );
    strikeOut(early, SEVEN[0]!, now);
    strikeOut(late, SEVEN[0]!, now);
    expect(
      early.isQuarantined(SEVEN[0]!, now + QUARANTINE_BASE_MS * 0.75 - 1),
    ).toBe(true);
    expect(
      early.isQuarantined(SEVEN[0]!, now + QUARANTINE_BASE_MS * 0.75 + 1),
    ).toBe(false);
    expect(
      late.isQuarantined(SEVEN[0]!, now + QUARANTINE_BASE_MS * 1.25 - 1),
    ).toBe(true);
    expect(
      late.isQuarantined(SEVEN[0]!, now + QUARANTINE_BASE_MS * 1.25 + 1),
    ).toBe(false);
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
      ["wss://r1.example", { strikes: 0, confirmed: 10, dropped: 0, quarantinedUntil: 0, quarantineCount: 0, quarantineReason: null, acceptEwmaMs: 0, acceptSamples: 0 }],
      ["wss://r2.example", { strikes: 0, confirmed: 5, dropped: 5, quarantinedUntil: 0, quarantineCount: 0, quarantineReason: null, acceptEwmaMs: 0, acceptSamples: 0 }],
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
      ["wss://r7.example", { strikes: 0, confirmed: 10, dropped: 0, quarantinedUntil: 0, quarantineCount: 0, quarantineReason: null, acceptEwmaMs: 0, acceptSamples: 0 }],
      ["wss://r1.example", { strikes: 0, confirmed: 0, dropped: 10, quarantinedUntil: 0, quarantineCount: 0, quarantineReason: null, acceptEwmaMs: 0, acceptSamples: 0 }],
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
    const clean: RelayHealthRecord = { strikes: 0, confirmed: 10, dropped: 0, quarantinedUntil: 0, quarantineCount: 0, quarantineReason: null, acceptEwmaMs: 0, acceptSamples: 0 };
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

describe("cadence-owned warm-spare probe", () => {
  const sk = generateSecretKey();
  const event = finalizeEvent(
    { kind: 1059, created_at: 1, tags: [], content: "probe" },
    sk,
  ) as unknown as NTNostrEvent;
  const relays = [
    "wss://a.example",
    "wss://b.example",
    "wss://c.example",
    "wss://d.example",
  ];

  function probePool(queries: string[]): RelayPool {
    return {
      subscribeMany(urls, filter: NostrFilter, params) {
        const relay = urls[0]!;
        if (filter.ids) {
          queries.push(relay);
          queueMicrotask(() => params.onevent(event));
        } else {
          queueMicrotask(() => params.oneose?.());
        }
        return { close() {} };
      },
      publish(urls) {
        return urls.map(() => Promise.resolve("ok"));
      },
      close() {},
    };
  }

  test("a successful probe releases a dropping relay early", async () => {
    const queries: string[] = [];
    const transport = new SimplePoolPhantomchatTransport(
      sk,
      relays,
      probePool(queries),
      () => 1,
    );
    await transport.verifyStored(event, { settleMs: 0, timeoutMs: 50 });
    const now = Date.now();
    strikeOut(transport.relayHealth, relays[3]!, now);
    expect(transport.relayHealth.isQuarantined(relays[3]!, now)).toBe(true);

    expect(await transport.probeQuarantinedRelay(now)).toBe(false); // arms cadence
    expect(
      await transport.probeQuarantinedRelay(
        now + RELAY_HEALTH_PROBE_INTERVAL_MS,
      ),
    ).toBe(true);
    expect(
      transport.relayHealth.isQuarantined(
        relays[3]!,
        now + RELAY_HEALTH_PROBE_INTERVAL_MS,
      ),
    ).toBe(false);
  });

  test("a read probe never releases a slow quarantine", async () => {
    const queries: string[] = [];
    const transport = new SimplePoolPhantomchatTransport(
      sk,
      relays,
      probePool(queries),
      () => 1,
    );
    await transport.verifyStored(event, { settleMs: 0, timeoutMs: 50 });
    const slow = relays[3]!;
    const now = Date.now();
    for (let i = 0; i < SLOW_RELAY_MIN_SAMPLES; i++) {
      transport.relayHealth.recordAccept(
        slow,
        SLOW_RELAY_ACCEPT_MS * 2,
        true,
        now,
      );
    }
    const before = queries.filter((r) => r === slow).length;
    await transport.probeQuarantinedRelay(now);
    expect(await transport.probeQuarantinedRelay(
      now + RELAY_HEALTH_PROBE_INTERVAL_MS,
    )).toBe(false);
    expect(queries.filter((r) => r === slow)).toHaveLength(before);
    expect(transport.relayHealth.isQuarantined(slow, now)).toBe(true);
  });

  test("publish volume never creates quarantined-relay probes", async () => {
    const queries: string[] = [];
    const transport = new SimplePoolPhantomchatTransport(
      sk,
      relays,
      probePool(queries),
      () => 1,
    );
    await transport.verifyStored(event, { settleMs: 0, timeoutMs: 50 });
    const quarantined = relays[3]!;
    const now = Date.now();
    strikeOut(transport.relayHealth, quarantined, now);
    const before = queries.filter((r) => r === quarantined).length;
    for (let i = 0; i < 20; i++) await transport.publishWrap(event);
    await transport.flush();
    expect(queries.filter((r) => r === quarantined)).toHaveLength(before);

    await transport.probeQuarantinedRelay(now);
    await transport.probeQuarantinedRelay(now + RELAY_HEALTH_PROBE_INTERVAL_MS);
    expect(queries.filter((r) => r === quarantined)).toHaveLength(before + 1);
  });

  test("probe cadence applies the full jitter factor", async () => {
    const queries: string[] = [];
    const transport = new SimplePoolPhantomchatTransport(
      sk,
      relays,
      probePool(queries),
      () => 1 - RELAY_HEALTH_PROBE_JITTER,
    );
    await transport.verifyStored(event, { settleMs: 0, timeoutMs: 50 });
    const quarantined = relays[3]!;
    const now = Date.now();
    strikeOut(transport.relayHealth, quarantined, now);
    const before = queries.filter((r) => r === quarantined).length;
    await transport.probeQuarantinedRelay(now);
    expect(await transport.probeQuarantinedRelay(
      now + RELAY_HEALTH_PROBE_INTERVAL_MS * (1 - RELAY_HEALTH_PROBE_JITTER) - 1,
    )).toBe(false);
    expect(await transport.probeQuarantinedRelay(
      now + RELAY_HEALTH_PROBE_INTERVAL_MS * (1 - RELAY_HEALTH_PROBE_JITTER),
    )).toBe(true);
    expect(queries.filter((r) => r === quarantined)).toHaveLength(before + 1);
  });

  test("the inbound catch-up path owns probe opportunities", async () => {
    const queries: string[] = [];
    const transport = new SimplePoolPhantomchatTransport(
      sk,
      relays,
      probePool(queries),
      () => 0,
    );
    await transport.verifyStored(event, { settleMs: 0, timeoutMs: 50 });
    const quarantined = relays[3]!;
    const now = Date.now();
    strikeOut(transport.relayHealth, quarantined, now);

    await transport.fetchGiftWrapsSince("pubkey", 0); // arm cadence
    await transport.fetchGiftWrapsSince("pubkey", 0); // due immediately
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(transport.relayHealth.isQuarantined(quarantined)).toBe(false);
  });
});

describe("publish confirmation quorum", () => {
  const sk = generateSecretKey();
  const event = finalizeEvent(
    { kind: 1059, created_at: 1, tags: [], content: "quorum" },
    sk,
  ) as unknown as NTNostrEvent;
  const relays = ["wss://a.example", "wss://b.example", "wss://c.example"];

  function pool(stored: Set<string>): RelayPool {
    return {
      subscribeMany(urls, filter: NostrFilter, params) {
        const relay = urls[0]!;
        if (filter.ids && stored.has(relay)) {
          queueMicrotask(() => params.onevent(event));
        } else {
          queueMicrotask(() => params.oneose?.());
        }
        return { close() {} };
      },
      publish() {
        return [];
      },
      close() {},
    };
  }

  test("two verified copies log delivered even when another relay misses", async () => {
    const lines: string[] = [];
    const restore = setLogSink((line) => lines.push(line));
    try {
      const transport = new SimplePoolPhantomchatTransport(
        sk,
        relays,
        pool(new Set(relays.slice(0, PUBLISH_CONFIRM_QUORUM))),
      );
      expect(await transport.verifyStored(event, { settleMs: 0, timeoutMs: 50 }))
        .toEqual([relays[2]!]);
      const row = lines.map((line) => JSON.parse(line)).find((x) =>
        x.msg === "phantomchat: publish confirmed delivered via 2 relays"
      );
      expect(row?.level).toBe("info");
      expect(row?.confirmed).toBe(2);
    } finally {
      restore();
    }
  });

  test("one verified copy keeps the loud quorum warning", async () => {
    const lines: string[] = [];
    const restore = setLogSink((line) => lines.push(line));
    try {
      const transport = new SimplePoolPhantomchatTransport(
        sk,
        relays,
        pool(new Set([relays[0]!])),
      );
      await transport.verifyStored(event, { settleMs: 0, timeoutMs: 50 });
      const row = lines.map((line) => JSON.parse(line)).find((x) =>
        x.msg === "phantomchat: publish NOT confirmed stored — relay quorum not met"
      );
      expect(row?.level).toBe("warn");
      expect(row?.confirmed).toBe(1);
      expect(row?.quorum).toBe(PUBLISH_CONFIRM_QUORUM);
    } finally {
      restore();
    }
  });

  test("one configured relay logs stored-but-below-quorum truthfully", async () => {
    const lines: string[] = [];
    const restore = setLogSink((line) => lines.push(line));
    try {
      const transport = new SimplePoolPhantomchatTransport(
        sk,
        [relays[0]!],
        pool(new Set([relays[0]!])),
      );
      expect(await transport.verifyStored(event, { settleMs: 0, timeoutMs: 50 }))
        .toEqual([]);
      const row = lines.map((line) => JSON.parse(line)).find((x) =>
        x.msg === "phantomchat: publish confirmed by 1 relay — below quorum"
      );
      expect(row?.level).toBe("warn");
      expect(row?.confirmed).toBe(1);
      expect(row?.quorum).toBe(PUBLISH_CONFIRM_QUORUM);
    } finally {
      restore();
    }
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


describe("slow-relay quarantine (publish-accept latency)", () => {
  const RELAYS = ["wss://a.example", "wss://b.example", "wss://c.example", "wss://d.example"];
  const quiet = { info: () => {}, debug: () => {} };
  const fresh = () => new RelayHealthTracker(RELAYS, quiet, () => 1);

  test("a consistently slow relay leaves the publish set", () => {
    const t = fresh();
    const now = Date.now();
    for (let i = 0; i < SLOW_RELAY_MIN_SAMPLES; i++) {
      t.recordAccept("wss://d.example", SLOW_RELAY_ACCEPT_MS * 2, true, now);
    }
    expect(t.isQuarantined("wss://d.example", now)).toBe(true);
    expect(t.publishTargets(now)).not.toContain("wss://d.example");
  });

  test("one cold-connect spike never quarantines (needs the minimum samples)", () => {
    const t = fresh();
    const now = Date.now();
    for (let i = 0; i < SLOW_RELAY_MIN_SAMPLES - 1; i++) {
      t.recordAccept("wss://d.example", SLOW_RELAY_ACCEPT_MS * 5, true, now);
    }
    expect(t.isQuarantined("wss://d.example", now)).toBe(false);
  });

  test("a fast relay is never quarantined", () => {
    const t = fresh();
    const now = Date.now();
    for (let i = 0; i < 50; i++) t.recordAccept("wss://a.example", 120, true, now);
    expect(t.isQuarantined("wss://a.example", now)).toBe(false);
  });

  test("an instant rejection scores as slow, not fast", () => {
    const t = fresh();
    const now = Date.now();
    for (let i = 0; i < SLOW_RELAY_MIN_SAMPLES + 1; i++) {
      t.recordAccept("wss://d.example", 5, false, now);
    }
    expect(t.isQuarantined("wss://d.example", now)).toBe(true);
  });

  test("a read-back confirmation does not release a SLOW quarantine", () => {
    const t = fresh();
    const now = Date.now();
    for (let i = 0; i < SLOW_RELAY_MIN_SAMPLES; i++) {
      t.recordAccept("wss://d.example", SLOW_RELAY_ACCEPT_MS * 2, true, now);
    }
    t.record("wss://d.example", true, now);
    expect(t.isQuarantined("wss://d.example", now)).toBe(true);
  });

  test("below the floor, a slow relay is promoted before a dropping one", () => {
    const t = fresh();
    const now = Date.now();
    // b + c drop (read-back strikes), d is slow — only a is healthy.
    for (const url of ["wss://b.example", "wss://c.example"]) {
      for (let i = 0; i < READBACK_STRIKE_THRESHOLD; i++) t.record(url, false, now);
    }
    for (let i = 0; i < SLOW_RELAY_MIN_SAMPLES; i++) {
      t.recordAccept("wss://d.example", SLOW_RELAY_ACCEPT_MS * 2, true, now);
    }
    const targets = t.publishTargets(now);
    expect(targets).toHaveLength(MIN_PUBLISH_RELAYS);
    expect(targets).toContain("wss://a.example");
    expect(targets).toContain("wss://d.example");
  });
});
