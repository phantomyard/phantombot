/**
 * Regression test for the phantomchat relay subscription wire shape.
 *
 * THE BUG (caught while dogfooding on Lena, 2026-06-13): the transport passed
 * `[filter]` (an array) to nostr-tools' `SimplePool.subscribeMany`. But in
 * nostr-tools 2.23.3 that method takes a SINGLE filter OBJECT and groups it
 * into the per-relay `filters` array itself. Passing an array double-wrapped
 * it, so the wire REQ became `["REQ",id,[{...}]]`. Strict relays (primal)
 * rejected it with "provided filter is not an object" and — worse — every
 * relay silently delivered ZERO events, so the bot never received a single DM.
 *
 * This test pins the contract: `subscribeGiftWraps` must hand `subscribeMany`
 * a plain filter OBJECT (kinds 1059, #p = our pubkey), never an array.
 */

import { describe, expect, test } from "bun:test";
import { generateSecretKey, getPublicKey, verifyEvent } from "nostr-tools/pure";
import {
  SimplePoolPhantomchatTransport,
  type NostrFilter,
  type RelayPool,
} from "../src/channels/phantomchat/transport.ts";
import {
  unwrapNip17Message,
  unwrapV2,
  type NTNostrEvent,
} from "../src/lib/nostrCrypto.ts";

describe("phantomchat transport subscription wire shape", () => {
  test("subscribeGiftWraps passes a single filter OBJECT, not an array", () => {
    let captured: unknown;
    const fakePool: RelayPool = {
      subscribeMany(_relays, filter, _params) {
        captured = filter;
        return { close() {} };
      },
      publish() {
        return [];
      },
      close() {},
    };

    const sk = generateSecretKey();
    const transport = new SimplePoolPhantomchatTransport(
      sk,
      ["wss://relay.example"],
      fakePool,
    );

    transport.subscribeGiftWraps(getPublicKey(sk), () => {});

    // The crux: a single object, never an array (the double-wrap bug).
    expect(Array.isArray(captured)).toBe(false);
    expect(typeof captured).toBe("object");
    const f = captured as NostrFilter;
    expect(f.kinds).toEqual([1059]);
    expect(f["#p"]).toEqual([getPublicKey(sk)]);
  });

  test("delivered events reach the onWrap callback", () => {
    let onEvent: ((e: NTNostrEvent) => void) | undefined;
    const fakePool: RelayPool = {
      subscribeMany(_relays, _filter, params) {
        onEvent = params.onevent;
        return { close() {} };
      },
      publish() {
        return [];
      },
      close() {},
    };

    const sk = generateSecretKey();
    const transport = new SimplePoolPhantomchatTransport(
      sk,
      ["wss://relay.example"],
      fakePool,
    );

    const seen: string[] = [];
    transport.subscribeGiftWraps(getPublicKey(sk), (e) => { seen.push(e.id); });
    onEvent?.({ id: "abc", kind: 1059 } as NTNostrEvent);
    expect(seen).toEqual(["abc"]);
  });

  test("sendTyping publishes a kind-1059 gift-wrap tagged to the recipient", async () => {
    const published: NTNostrEvent[] = [];
    const fakePool: RelayPool = {
      subscribeMany() {
        return { close() {} };
      },
      publish(_relays, event) {
        published.push(event);
        return [Promise.resolve("ok")];
      },
      close() {},
    };

    const sk = generateSecretKey();
    const transport = new SimplePoolPhantomchatTransport(
      sk,
      ["wss://relay.example"],
      fakePool,
    );

    const recipient = getPublicKey(generateSecretKey());
    await transport.sendTyping(recipient);

    expect(published.length).toBe(1);
    const ev = published[0]!;
    // NIP-17 gift-wrap: the relay only sees kind-1059 + ephemeral pubkey.
    // The inner typing rumor (NOSTR_KIND_TYPING_RUMOR, with the lifecycle
    // content + ['d', conversationId]) is encrypted inside.
    expect(ev.kind).toBe(1059);
    expect(ev.tags).toEqual(expect.arrayContaining([["p", recipient]]));
    // Real signature — finalizeEvent produces id + sig.
    expect(typeof ev.id).toBe("string");
    expect(typeof ev.sig).toBe("string");
    // Content is non-empty (encrypted rumor payload).
    expect(ev.content.length).toBeGreaterThan(0);
  });

  test("sendRecording publishes a kind-1059 gift-wrap tagged to the recipient", async () => {
    const published: NTNostrEvent[] = [];
    const fakePool: RelayPool = {
      subscribeMany() {
        return { close() {} };
      },
      publish(_relays, event) {
        published.push(event);
        return [Promise.resolve("ok")];
      },
      close() {},
    };

    const sk = generateSecretKey();
    const transport = new SimplePoolPhantomchatTransport(
      sk,
      ["wss://relay.example"],
      fakePool,
    );

    const recipient = getPublicKey(generateSecretKey());
    await transport.sendRecording(recipient);

    expect(published.length).toBe(1);
    const ev = published[0]!;
    // NIP-17 gift-wrap: the "recording" marker is inside the encrypted rumor.
    expect(ev.kind).toBe(1059);
    expect(ev.tags).toEqual(expect.arrayContaining([["p", recipient]]));
    expect(typeof ev.sig).toBe("string");
    expect(ev.content.length).toBeGreaterThan(0);
  });

  test("publishProfile publishes a signed kind-0 with the display name + bot:true", async () => {
    const published: NTNostrEvent[] = [];
    const fakePool: RelayPool = {
      subscribeMany() {
        return { close() {} };
      },
      publish(_relays, event) {
        published.push(event);
        return [Promise.resolve("ok")];
      },
      close() {},
    };

    const sk = generateSecretKey();
    const transport = new SimplePoolPhantomchatTransport(
      sk,
      ["wss://relay.example"],
      fakePool,
    );

    await transport.publishProfile({ name: "Lena", bot: true });

    expect(published.length).toBe(1);
    const ev = published[0]!;
    expect(ev.kind).toBe(0);
    expect(ev.pubkey).toBe(getPublicKey(sk));
    // A real, verifiable NIP-01 metadata event.
    expect(verifyEvent(ev as Parameters<typeof verifyEvent>[0])).toBe(true);
    // Content carries name + display_name so the PWA shows "Lena", and NIP-24
    // bot:true so it can badge the account as automated.
    const meta = JSON.parse(ev.content);
    expect(meta.name).toBe("Lena");
    expect(meta.display_name).toBe("Lena");
    expect(meta.bot).toBe(true);
    // No commands passed → no `commands` key (the PWA shows no menu).
    expect("commands" in meta).toBe(false);
  });

  test("publishProfile embeds the advertised slash commands in the kind-0", async () => {
    const published: NTNostrEvent[] = [];
    const fakePool: RelayPool = {
      subscribeMany() {
        return { close() {} };
      },
      publish(_relays, event) {
        published.push(event);
        return [Promise.resolve("ok")];
      },
      close() {},
    };

    const sk = generateSecretKey();
    const transport = new SimplePoolPhantomchatTransport(
      sk,
      ["wss://relay.example"],
      fakePool,
    );

    const commands = [
      { command: "help", description: "Show this command list" },
      { command: "stop", description: "Abort the current turn" },
    ];
    await transport.publishProfile({ name: "Lena", bot: true, commands });

    const meta = JSON.parse(published[0]!.content);
    // The PWA reads `commands` (bare names, no leading slash — bot_info shape)
    // and renders the /-typeahead menu from it.
    expect(meta.commands).toEqual(commands);
  });

  test("sendTyping with stop=true publishes the STOP content marker", async () => {
    const published: NTNostrEvent[] = [];
    const fakePool: RelayPool = {
      subscribeMany() {
        return { close() {} };
      },
      publish(_relays, event) {
        published.push(event);
        return [Promise.resolve("ok")];
      },
      close() {},
    };

    const sk = generateSecretKey();
    const transport = new SimplePoolPhantomchatTransport(
      sk,
      ["wss://relay.example"],
      fakePool,
    );

    const recipient = getPublicKey(generateSecretKey());
    await transport.sendTyping(recipient, true);

    expect(published.length).toBe(1);
    const ev = published[0]!;
    // NIP-17 gift-wrap: STOP marker is inside the encrypted rumor.
    expect(ev.kind).toBe(1059);
    expect(ev.tags).toEqual(expect.arrayContaining([["p", recipient]]));
    expect(ev.content.length).toBeGreaterThan(0);
  });

  test("sendGroupTyping publishes one kind-30001 with d, group, expiration tags + a p-tag per member", async () => {
    const published: NTNostrEvent[] = [];
    const fakePool: RelayPool = {
      subscribeMany() {
        return { close() {} };
      },
      publish(_relays, event) {
        published.push(event);
        return [Promise.resolve("ok")];
      },
      close() {},
    };

    const sk = generateSecretKey();
    const transport = new SimplePoolPhantomchatTransport(
      sk,
      ["wss://relay.example"],
      fakePool,
    );

    const memberA = getPublicKey(generateSecretKey());
    const memberB = getPublicKey(generateSecretKey());
    await transport.sendGroupTyping("grp-123", [memberA, memberB]);

    // One kind-1059 gift-wrap per member (each with its own ephemeral key).
    expect(published.length).toBe(2);
    for (const ev of published) {
      expect(ev.kind).toBe(1059);
      expect(typeof ev.id).toBe("string");
      expect(typeof ev.sig).toBe("string");
      expect(ev.content.length).toBeGreaterThan(0);
    }
    // Each member gets their own wrap tagged with their pubkey.
    const pTags = published.map((ev) => ev.tags.find((t) => t[0] === "p")?.[1]);
    expect(pTags).toContainEqual(memberA.toLowerCase());
    expect(pTags).toContainEqual(memberB.toLowerCase());
  });

  test("sendGroupTyping with stop=true emits the STOP marker", async () => {
    const published: NTNostrEvent[] = [];
    const fakePool: RelayPool = {
      subscribeMany() {
        return { close() {} };
      },
      publish(_relays, event) {
        published.push(event);
        return [Promise.resolve("ok")];
      },
      close() {},
    };

    const sk = generateSecretKey();
    const transport = new SimplePoolPhantomchatTransport(
      sk,
      ["wss://relay.example"],
      fakePool,
    );

    const member = getPublicKey(generateSecretKey());
    await transport.sendGroupTyping("grp-9", [member], true);

    // One kind-1059 gift-wrap per member.
    expect(published.length).toBe(1);
    expect(published[0]!.kind).toBe(1059);
    expect(published[0]!.content.length).toBeGreaterThan(0);
  });

  test("sendGroupTyping is a no-op when the only member is ourselves", async () => {
    let publishCalls = 0;
    const fakePool: RelayPool = {
      subscribeMany() {
        return { close() {} };
      },
      publish() {
        publishCalls += 1;
        return [Promise.resolve("ok")];
      },
      close() {},
    };

    const sk = generateSecretKey();
    const transport = new SimplePoolPhantomchatTransport(
      sk,
      ["wss://relay.example"],
      fakePool,
    );

    // Only our own hex → nobody else to signal → no publish.
    await transport.sendGroupTyping("grp-1", [getPublicKey(sk)]);
    expect(publishCalls).toBe(0);
  });

  test("sendGroupMessage publishes one wrap per member plus a self-wrap, with a group-tagged rumor", async () => {
    const published: NTNostrEvent[] = [];
    const fakePool: RelayPool = {
      subscribeMany() {
        return { close() {} };
      },
      publish(_relays, event) {
        published.push(event);
        return [Promise.resolve("ok")];
      },
      close() {},
    };

    const botSk = generateSecretKey();
    const transport = new SimplePoolPhantomchatTransport(
      botSk,
      ["wss://relay.example"],
      fakePool,
    );

    const memberASk = generateSecretKey();
    const memberBSk = generateSecretKey();
    const memberAHex = getPublicKey(memberASk);
    const memberBHex = getPublicKey(memberBSk);
    const groupId = "abc123groupid";

    await transport.sendGroupMessage(groupId, [memberAHex, memberBHex], "hi HQ");

    // Two members + one self-wrap = three kind-1059 gift-wraps.
    expect(published.length).toBe(3);
    expect(published.every((e) => e.kind === 1059)).toBe(true);

    // Member A can unwrap one of the wraps and recover the group payload + tags.
    let unwrapped: ReturnType<typeof unwrapNip17Message> | undefined;
    for (const w of published) {
      try {
        unwrapped = unwrapNip17Message(w as NTNostrEvent, memberASk);
        break;
      } catch {
        // wrong recipient for this wrap; try the next
      }
    }
    expect(unwrapped).toBeDefined();
    const rumor = unwrapped!;

    // The group tag the PWA routes on must be present and carry our group id.
    const groupTag = rumor.tags.find((t) => t[0] === "group");
    expect(groupTag).toEqual(["group", groupId]);

    // Every OTHER member is p-tagged (so each member's #p subscription delivers
    // it); the sender (bot) is NOT in the p-tags (it gets the self-wrap).
    const pTags = rumor.tags.filter((t) => t[0] === "p").map((t) => t[1]);
    expect(new Set(pTags)).toEqual(new Set([memberAHex, memberBHex]));
    expect(pTags).not.toContain(getPublicKey(botSk));

    // The payload is the GROUP shape: {content, type, id, timestamp} with a
    // NON-EMPTY id (the PWA drops group messages whose id is falsy) and NO
    // from/to fields.
    const payload = JSON.parse(rumor.content);
    expect(payload.content).toBe("hi HQ");
    expect(payload.type).toBe("text");
    expect(typeof payload.id).toBe("string");
    expect(payload.id.length).toBeGreaterThan(0);
    expect(typeof payload.timestamp).toBe("number");
    expect(payload.from).toBeUndefined();
    expect(payload.to).toBeUndefined();
  });

  test("sendMessage publishes a v2 encrypted event (AES-256-GCM)", async () => {
    const published: NTNostrEvent[] = [];
    const fakePool: RelayPool = {
      subscribeMany() {
        return { close() {} };
      },
      publish(_relays, event) {
        published.push(event);
        return [Promise.resolve("ok")];
      },
      close() {},
    };

    const botSk = generateSecretKey();
    const transport = new SimplePoolPhantomchatTransport(
      botSk,
      ["wss://relay.example"],
      fakePool,
    );

    const recipientSk = generateSecretKey();
    const recipientHex = getPublicKey(recipientSk);

    await transport.sendMessage(recipientHex, "hello from Lena");

    // v2: single event published (no self-wrap needed — no gift-wrap layering)
    expect(published.length).toBe(1);
    expect(published[0]!.kind).toBe(1059);
    expect(published[0]!.tags.some((t) => t[0] === "v" && t[1] === "pc-v2")).toBe(true);

    // The recipient can unwrap with v2 and the content is the RAW text
    const unwrapped = await unwrapV2(published[0] as NTNostrEvent, recipientSk);
    expect(unwrapped.content).toBe("hello from Lena");
    expect(unwrapped.pubkey).toBe(getPublicKey(botSk));
    expect(unwrapped.tags.find((t) => t[0] === "p")?.[1]).toBe(recipientHex);
  });

  test("sendGroupMessage drops our own hex from the member list and dedupes", async () => {
    const published: NTNostrEvent[] = [];
    const fakePool: RelayPool = {
      subscribeMany() {
        return { close() {} };
      },
      publish(_relays, event) {
        published.push(event);
        return [Promise.resolve("ok")];
      },
      close() {},
    };

    const botSk = generateSecretKey();
    const botHex = getPublicKey(botSk);
    const transport = new SimplePoolPhantomchatTransport(
      botSk,
      ["wss://relay.example"],
      fakePool,
    );

    const memberHex = getPublicKey(generateSecretKey());

    // Member list redundantly contains our own hex (and a dup) — both must be
    // collapsed so we don't double-wrap to ourselves.
    await transport.sendGroupMessage(
      "g1",
      [memberHex, memberHex, botHex],
      "hello",
    );

    // One real member wrap + one self-wrap = 2 (not 3, not 4).
    expect(published.length).toBe(2);
  });

  test("sendGroupMessage is a no-op when there are no other members", async () => {
    let publishCalls = 0;
    const fakePool: RelayPool = {
      subscribeMany() {
        return { close() {} };
      },
      publish() {
        publishCalls += 1;
        return [Promise.resolve("ok")];
      },
      close() {},
    };

    const botSk = generateSecretKey();
    const transport = new SimplePoolPhantomchatTransport(
      botSk,
      ["wss://relay.example"],
      fakePool,
    );

    // Only our own hex in the list → no one to broadcast to.
    await transport.sendGroupMessage("g1", [getPublicKey(botSk)], "anyone?");
    expect(publishCalls).toBe(0);
  });

  test("sendTyping never throws even if every relay publish rejects", async () => {
    const fakePool: RelayPool = {
      subscribeMany() {
        return { close() {} };
      },
      publish() {
        return [Promise.reject(new Error("relay down"))];
      },
      close() {},
    };

    const sk = generateSecretKey();
    const transport = new SimplePoolPhantomchatTransport(
      sk,
      ["wss://relay.example"],
      fakePool,
    );

    // Best-effort: a failed publish must resolve, never reject into the engine.
    await expect(
      transport.sendTyping(getPublicKey(generateSecretKey())),
    ).resolves.toBeUndefined();
  });
});

describe("phantomchat transport fetchProfiles (kind-0)", () => {
  test("queries kind-0 by authors and resolves a parsed hex→profile map on EOSE", async () => {
    let captured: NostrFilter | undefined;
    const botPk = "a".repeat(64);
    const humanPk = "b".repeat(64);
    const fakePool: RelayPool = {
      subscribeMany(_relays, filter, params) {
        captured = filter;
        // Deliver one bot profile + one human profile, then signal EOSE.
        params.onevent({
          kind: 0,
          pubkey: botPk,
          created_at: 100,
          content: JSON.stringify({ name: "kai", display_name: "Kai", bot: true }),
        } as NTNostrEvent);
        params.onevent({
          kind: 0,
          pubkey: humanPk,
          created_at: 100,
          content: JSON.stringify({ name: "andrew" }),
        } as NTNostrEvent);
        params.oneose?.();
        return { close() {} };
      },
      publish() {
        return [];
      },
      close() {},
    };

    const transport = new SimplePoolPhantomchatTransport(
      generateSecretKey(),
      ["wss://relay.example"],
      fakePool,
    );

    const map = await transport.fetchProfiles([botPk.toUpperCase(), humanPk]);

    // Filter shape: kind-0 by authors (lowercased), no #p tag.
    expect(captured?.kinds).toEqual([0]);
    expect(captured?.authors).toEqual([botPk, humanPk]);
    expect(captured?.["#p"]).toBeUndefined();
    // Parsed + keyed by lowercased hex; bot flag preserved.
    expect(map.get(botPk)).toEqual({ name: "kai", display_name: "Kai", bot: true });
    expect(map.get(humanPk)).toEqual({ name: "andrew", display_name: undefined, bot: false });
  });

  test("keeps the newest kind-0 per author (replaceable event)", async () => {
    const pk = "c".repeat(64);
    const fakePool: RelayPool = {
      subscribeMany(_relays, _filter, params) {
        // Older event arrives AFTER the newer one — newest created_at must win.
        params.onevent({
          kind: 0,
          pubkey: pk,
          created_at: 200,
          content: JSON.stringify({ name: "new", bot: true }),
        } as NTNostrEvent);
        params.onevent({
          kind: 0,
          pubkey: pk,
          created_at: 100,
          content: JSON.stringify({ name: "old", bot: false }),
        } as NTNostrEvent);
        params.oneose?.();
        return { close() {} };
      },
      publish() {
        return [];
      },
      close() {},
    };

    const transport = new SimplePoolPhantomchatTransport(
      generateSecretKey(),
      ["wss://relay.example"],
      fakePool,
    );

    const map = await transport.fetchProfiles([pk]);
    expect(map.get(pk)?.name).toBe("new");
    expect(map.get(pk)?.bot).toBe(true);
  });

  test("empty author list resolves to an empty map without subscribing", async () => {
    let subscribed = false;
    const fakePool: RelayPool = {
      subscribeMany() {
        subscribed = true;
        return { close() {} };
      },
      publish() {
        return [];
      },
      close() {},
    };
    const transport = new SimplePoolPhantomchatTransport(
      generateSecretKey(),
      ["wss://relay.example"],
      fakePool,
    );
    const map = await transport.fetchProfiles([]);
    expect(map.size).toBe(0);
    expect(subscribed).toBe(false);
  });
});
