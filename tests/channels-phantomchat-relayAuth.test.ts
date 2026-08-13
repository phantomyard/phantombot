/**
 * Tests for NIP-42 relay AUTH + publish read-back verification (issue #368).
 *
 * THE BUG: on a relay with `nip42_auth = true` (nostr-rs-relay), every bot
 * publish was answered `OK:true` and then silently DROPPED — the turn
 * completed cleanly, the recipient never saw the reply, and nothing failed
 * loudly. Two layers pin the fix:
 *
 *   1. The signer (`makeRelayAuthSigner`) must produce a valid, verifiable
 *      kind-22242 auth event from the persona key, and the transport must
 *      hand it to the pool on EVERY publish/subscribe so nostr-tools can
 *      answer `auth-required:` rejections and AUTH challenges.
 *   2. The read-back check (`verifyStored`) must re-query each relay for a
 *      freshly published event id and name the relays that never stored it —
 *      catching the non-conformant `OK:true`-then-drop relays that AUTH
 *      alone can't.
 */

import { describe, expect, test } from "bun:test";
import {
  finalizeEvent,
  generateSecretKey,
  getPublicKey,
  verifyEvent,
} from "nostr-tools/pure";
import type { EventTemplate } from "nostr-tools/core";
import {
  automaticallyAuthWith,
  makeRelayAuthSigner,
} from "../src/channels/phantomchat/relayAuth.ts";
import {
  SimplePoolPhantomchatTransport,
  type NostrFilter,
  type RelayPool,
} from "../src/channels/phantomchat/transport.ts";
import type { NTNostrEvent } from "../src/lib/nostrCrypto.ts";
import type { RelayAuthSigner } from "../src/channels/phantomchat/relayAuth.ts";

describe("NIP-42 relay auth signer", () => {
  test("signs the auth event template with the persona key", async () => {
    const sk = generateSecretKey();
    const signer = makeRelayAuthSigner(sk);
    // The shape nostr-tools hands us: makeAuthEvent(relayURL, challenge).
    const template: EventTemplate = {
      kind: 22242,
      created_at: Math.floor(Date.now() / 1000),
      tags: [
        ["relay", "wss://relay.example"],
        ["challenge", "abc123"],
      ],
      content: "",
    };
    const signed = await signer(template);
    expect(signed.kind).toBe(22242);
    expect(signed.pubkey).toBe(getPublicKey(sk));
    expect(signed.tags).toContainEqual(["relay", "wss://relay.example"]);
    expect(signed.tags).toContainEqual(["challenge", "abc123"]);
    expect(verifyEvent(signed)).toBe(true);
  });

  test("automaticallyAuthWith returns a working signer for any relay", async () => {
    const sk = generateSecretKey();
    const factory = automaticallyAuthWith(sk);
    const signer = factory("wss://any.relay");
    expect(typeof signer).toBe("function");
    const signed = await signer({
      kind: 22242,
      created_at: Math.floor(Date.now() / 1000),
      tags: [
        ["relay", "wss://any.relay"],
        ["challenge", "xyz"],
      ],
      content: "",
    });
    expect(verifyEvent(signed)).toBe(true);
  });
});

describe("transport wires the auth signer into pool operations", () => {
  function capturePool(): {
    pool: RelayPool;
    publishParams: Array<{ onauth?: RelayAuthSigner } | undefined>;
    subParams: Array<{ onauth?: RelayAuthSigner } | undefined>;
  } {
    const publishParams: Array<{ onauth?: RelayAuthSigner } | undefined> = [];
    const subParams: Array<{ onauth?: RelayAuthSigner } | undefined> = [];
    const pool: RelayPool = {
      subscribeMany(_relays, _filter, params) {
        subParams.push(params);
        return { close() {} };
      },
      publish(_relays, _event, params) {
        publishParams.push(params);
        return [];
      },
      close() {},
    };
    return { pool, publishParams, subParams };
  }

  test("publishWrap hands the onauth signer to pool.publish", async () => {
    const { pool, publishParams } = capturePool();
    const sk = generateSecretKey();
    const transport = new SimplePoolPhantomchatTransport(
      sk,
      ["wss://relay.example"],
      pool,
    );
    const event = finalizeEvent(
      {
        kind: 1059,
        created_at: Math.floor(Date.now() / 1000),
        tags: [],
        content: "x",
      },
      sk,
    ) as unknown as NTNostrEvent;
    await transport.publishWrap(event);
    expect(publishParams.length).toBe(1);
    expect(typeof publishParams[0]?.onauth).toBe("function");
    // The wired signer must actually sign with OUR key.
    const signed = await publishParams[0]!.onauth!({
      kind: 22242,
      created_at: Math.floor(Date.now() / 1000),
      tags: [["relay", "wss://relay.example"], ["challenge", "c"]],
      content: "",
    });
    expect(signed.pubkey).toBe(getPublicKey(sk));
    expect(verifyEvent(signed)).toBe(true);
  });

  test("subscribeGiftWraps hands the onauth signer to subscribeMany", () => {
    const { pool, subParams } = capturePool();
    const sk = generateSecretKey();
    const transport = new SimplePoolPhantomchatTransport(
      sk,
      ["wss://relay.example"],
      pool,
    );
    transport.subscribeGiftWraps(getPublicKey(sk), () => {});
    expect(subParams.length).toBe(1);
    expect(typeof subParams[0]?.onauth).toBe("function");
  });
});

describe("publish read-back verification (verifyStored)", () => {
  const sk = generateSecretKey();
  const event = finalizeEvent(
    {
      kind: 1059,
      created_at: Math.floor(Date.now() / 1000),
      tags: [],
      content: "wrapped",
    },
    sk,
  ) as unknown as NTNostrEvent;

  /** A fake pool whose per-relay "storage" decides read-back results. */
  function storedPool(storedOn: Set<string>): RelayPool {
    return {
      subscribeMany(relays, filter: NostrFilter, params) {
        // The read-back query is a one-relay {ids:[...]} REQ — answer it from
        // the fake's storage set. Other REQs (none in these tests) get EOSE.
        const [relay] = relays;
        if (filter.ids && relay && storedOn.has(relay)) {
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

  test("returns [] when every relay stored the event", async () => {
    const relays = ["wss://a.example", "wss://b.example"];
    const transport = new SimplePoolPhantomchatTransport(
      sk,
      relays,
      storedPool(new Set(relays)),
    );
    const missing = await transport.verifyStored(event, {
      settleMs: 0,
      timeoutMs: 200,
    });
    expect(missing).toEqual([]);
  });

  test("names the relay that dropped the event", async () => {
    const transport = new SimplePoolPhantomchatTransport(
      sk,
      ["wss://a.example", "wss://b.example"],
      storedPool(new Set(["wss://a.example"])),
    );
    const missing = await transport.verifyStored(event, {
      settleMs: 0,
      timeoutMs: 200,
    });
    expect(missing).toEqual(["wss://b.example"]);
  });

  test("names relays that never answer (timeout)", async () => {
    // A pool that never calls onevent/oneose for the read-back REQ — the
    // timeout must turn that into "not stored", not a hang.
    const silentPool: RelayPool = {
      subscribeMany() {
        return { close() {} };
      },
      publish() {
        return [];
      },
      close() {},
    };
    const transport = new SimplePoolPhantomchatTransport(
      sk,
      ["wss://dead.example"],
      silentPool,
    );
    const missing = await transport.verifyStored(event, {
      settleMs: 0,
      timeoutMs: 100,
    });
    expect(missing).toEqual(["wss://dead.example"]);
  });

  test("skips ephemeral events (typing ticks are never stored by design)", async () => {
    const ephemeral = finalizeEvent(
      {
        kind: 20001,
        created_at: Math.floor(Date.now() / 1000),
        tags: [["p", getPublicKey(generateSecretKey())]],
        content: "",
      },
      sk,
    ) as unknown as NTNostrEvent;
    // A pool that records whether ANY read-back subscription was attempted.
    let queried = false;
    const pool: RelayPool = {
      subscribeMany() {
        queried = true;
        return { close() {} };
      },
      publish() {
        return [];
      },
      close() {},
    };
    const transport = new SimplePoolPhantomchatTransport(
      sk,
      ["wss://a.example"],
      pool,
    );
    const missing = await transport.verifyStored(ephemeral, {
      settleMs: 0,
      timeoutMs: 100,
    });
    expect(missing).toEqual([]);
    expect(queried).toBe(false);
  });
});
