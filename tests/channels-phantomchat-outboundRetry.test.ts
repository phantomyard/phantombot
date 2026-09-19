import { describe, expect, test } from "bun:test";
import { generateSecretKey, getPublicKey } from "nostr-tools/pure";
import {
  OUTBOUND_RETRY_DELAYS_MS,
  SimplePoolPhantomchatTransport,
} from "../src/channels/phantomchat/transport.ts";
import { rewrapV2, unwrapV2, wrapV2 } from "../src/lib/nostrCrypto.ts";
import type { NostrEvent as NTNostrEvent } from "nostr-tools/pure";
import type { Filter as NostrFilter } from "nostr-tools/filter";

const RELAYS = ["wss://a.example", "wss://b.example", "wss://c.example"];

/** Tiny delays so the ladder runs in milliseconds instead of 73 seconds. */
const FAST = {
  retryDelaysMs: [2, 2, 2] as const,
  readback: { settleMs: 0, timeoutMs: 20 },
};

interface FakePool {
  pool: unknown;
  published: NTNostrEvent[];
  /** Event ids the relays will admit to storing on read-back. */
  stored: Set<string>;
}

/**
 * Relay pool where storage is decided per EVENT ID, which is the whole point:
 * a retry is a different outer event, so a pool keyed on "did we publish"
 * could not tell an accepted retry from a dropped one.
 */
function fakePool(storeFrom?: (e: NTNostrEvent) => boolean): FakePool {
  const published: NTNostrEvent[] = [];
  const stored = new Set<string>();
  const byId = new Map<string, NTNostrEvent>();
  const pool = {
    subscribeMany(
      _relays: string[],
      filter: NostrFilter,
      params: { onevent: (e: NTNostrEvent) => void; oneose?: () => void },
    ) {
      const id = filter.ids?.[0];
      const event = id ? byId.get(id) : undefined;
      if (id && event && stored.has(id)) {
        queueMicrotask(() => params.onevent(event));
      } else {
        queueMicrotask(() => params.oneose?.());
      }
      return { close() {} };
    },
    publish(relays: string[], event: NTNostrEvent) {
      published.push(event);
      byId.set(event.id, event);
      if (storeFrom?.(event)) stored.add(event.id);
      return relays.map(() => Promise.resolve("ok"));
    },
    close() {},
  };
  return { pool, published, stored };
}

/** Wait until `check()` holds, or fail loudly rather than hang the suite. */
async function until(
  check: () => boolean,
  what: string,
  timeoutMs = 2000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 5));
  }
}

/** Nothing further happens — used to assert the ABSENCE of a retry. */
async function settle(ms = 120): Promise<void> {
  await new Promise((r) => setTimeout(r, ms));
}

function transportFor(
  sk: Uint8Array,
  pool: unknown,
): SimplePoolPhantomchatTransport {
  return new SimplePoolPhantomchatTransport(
    sk,
    RELAYS,
    pool as ConstructorParameters<typeof SimplePoolPhantomchatTransport>[2],
    undefined,
    FAST,
  );
}

describe("rewrapV2", () => {
  test("changes the outer event but not the inner rumor", async () => {
    const sender = generateSecretKey();
    const recipient = generateSecretKey();
    const to = getPublicKey(recipient);

    const { event, rumorId, rumor } = await wrapV2(sender, to, "hello");
    const again = await rewrapV2(sender, to, rumor);

    // Fresh envelope: relays dedup by event id, so a retry MUST be a new one.
    expect(again.id).not.toBe(event.id);
    expect(again.pubkey).not.toBe(event.pubkey); // fresh ephemeral key
    expect(again.content).not.toBe(event.content); // fresh AES nonce

    // Same message: the recipient dedups by rumor id, so a retry MUST NOT be.
    const first = await unwrapV2(event, recipient);
    const second = await unwrapV2(again, recipient);
    expect(second.id).toBe(rumorId);
    expect(second.id).toBe(first.id);
    expect(second.content).toBe("hello");
  });
});

describe("outbound delivery retry (#542)", () => {
  test("production ladder is the PWA's own 8s/20s/45s", () => {
    // The two sides of one conversation must give up at the same point.
    expect([...OUTBOUND_RETRY_DELAYS_MS]).toEqual([8_000, 20_000, 45_000]);
  });

  test("a wrap stored on no relay is re-sent as a new event with the same rumor", async () => {
    const sender = generateSecretKey();
    const recipient = generateSecretKey();
    const { pool, published } = fakePool(() => false); // every relay drops
    const t = transportFor(sender, pool);

    await t.sendMessage(getPublicKey(recipient), "are you there?");
    await until(() => published.length >= 2, "a retry publish");

    const [original, retry] = published;
    expect(retry!.id).not.toBe(original!.id);
    const a = await unwrapV2(original!, recipient);
    const b = await unwrapV2(retry!, recipient);
    expect(b.id).toBe(a.id);
    expect(b.content).toBe("are you there?");
    t.close();
  });

  test("no retry when a relay stored the original", async () => {
    const sender = generateSecretKey();
    const { pool, published } = fakePool(() => true);
    const t = transportFor(sender, pool);

    await t.sendMessage(getPublicKey(generateSecretKey()), "hello");
    await settle();
    expect(published.length).toBe(1);
    t.close();
  });

  test("no retry when the peer acknowledged over P2P", async () => {
    const sender = generateSecretKey();
    const { pool, published } = fakePool(() => false);
    const t = transportFor(sender, pool);
    // The peer HAS the message; relay storage failing is a redundancy problem.
    t.setPublishObserver(() => Promise.resolve(true));

    await t.sendMessage(getPublicKey(generateSecretKey()), "hello");
    await settle();
    expect(published.length).toBe(1);
    t.close();
  });

  test("stops as soon as one relay confirms the retry", async () => {
    const sender = generateSecretKey();
    let seen = 0;
    // First publish drops, the next one sticks.
    const { pool, published } = fakePool(() => ++seen > 1);
    const t = transportFor(sender, pool);

    await t.sendMessage(getPublicKey(generateSecretKey()), "hello");
    await until(() => published.length >= 2, "the first retry");
    await settle();
    expect(published.length).toBe(2);
    t.close();
  });

  test("gives up after the whole ladder rather than retrying forever", async () => {
    const sender = generateSecretKey();
    const { pool, published } = fakePool(() => false);
    const t = transportFor(sender, pool);

    await t.sendMessage(getPublicKey(generateSecretKey()), "hello");
    await until(() => published.length >= 4, "all three retries");
    await settle();
    // One original + exactly three attempts.
    expect(published.length).toBe(4);
    t.close();
  });

  test("close() cancels a pending retry instead of holding the process open", async () => {
    const sender = generateSecretKey();
    const { pool, published } = fakePool(() => false);
    const slow = new SimplePoolPhantomchatTransport(
      sender,
      RELAYS,
      pool as ConstructorParameters<typeof SimplePoolPhantomchatTransport>[2],
      undefined,
      { retryDelaysMs: [30_000], readback: { settleMs: 0, timeoutMs: 20 } },
    );

    await slow.sendMessage(getPublicKey(generateSecretKey()), "hello");
    await until(() => slow.pendingRetries === 1, "the retry sleep to start");

    slow.close();
    // The 30s timer was cleared and its sleep woken, not left to fire — that
    // is the difference between a clean shutdown and a process that lingers.
    expect(slow.pendingRetries).toBe(0);
    await settle(60);
    expect(published.length).toBe(1);
  });
});

/**
 * Teardown is only safe if the ladder re-checks `closed` at every await inside
 * an attempt, not just around its sleep. These two close mid-ATTEMPT — the
 * timer has already fired — and prove nothing further reaches the relays.
 */
describe("close() during an in-flight retry attempt", () => {
  test("a close while re-wrapping starts no publish", async () => {
    const sender = generateSecretKey();
    const { pool, published } = fakePool(() => false);
    const t = transportFor(sender, pool);

    // Drive the ladder directly so the close lands inside rewrap(), which is
    // otherwise a few unobservable milliseconds of crypto.
    const rewrap = async (): Promise<NTNostrEvent> => {
      const { event } = await wrapV2(sender, getPublicKey(sender), "hello");
      t.close();
      return event;
    };
    await (
      t as unknown as {
        retryOutbound(
          rewrap: () => Promise<NTNostrEvent>,
          originalEventId: string,
          label: string,
        ): Promise<void>;
      }
    ).retryOutbound(rewrap, "original-id", "dm");

    await settle(60);
    expect(published.length).toBe(0);
  });

  test("a close while the publish settles starts no read-back", async () => {
    const sender = generateSecretKey();
    const published: NTNostrEvent[] = [];
    const subscribedIds: string[] = [];
    let releasePublish: (() => void) | undefined;
    const pool = {
      subscribeMany(
        _relays: string[],
        filter: NostrFilter,
        params: { onevent: (e: NTNostrEvent) => void; oneose?: () => void },
      ) {
        if (filter.ids?.[0]) subscribedIds.push(filter.ids[0]);
        queueMicrotask(() => params.oneose?.());
        return { close() {} };
      },
      publish(relays: string[], event: NTNostrEvent) {
        published.push(event);
        if (published.length === 1)
          return relays.map(() => Promise.resolve("ok"));
        // The retry publish hangs until we close, so close lands between
        // publish settlement and read-back.
        return relays.map(
          () =>
            new Promise<string>((resolve) => {
              releasePublish = () => resolve("ok");
            }),
        );
      },
      close() {},
    };
    const t = transportFor(sender, pool);

    await t.sendMessage(getPublicKey(generateSecretKey()), "hello");
    await until(() => published.length >= 2, "the retry publish");
    const readBacksBefore = subscribedIds.length;

    t.close();
    releasePublish?.();
    await settle(80);

    // The retry's own event id was never read back: no relay query, no settle
    // timer, nothing holding the pool open after close().
    expect(subscribedIds.length).toBe(readBacksBefore);
    expect(subscribedIds).not.toContain(published[1]!.id);
    expect(published.length).toBe(2);
  });
});
