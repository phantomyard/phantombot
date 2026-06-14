/**
 * Tests for the phantomchat server's AUTH GATE.
 *
 * Drives `runPhantomchatServer` over an in-memory fake relay pool: a message
 * from an ALLOWED npub produces a wrapped reply; a message from a NON-allowed
 * npub is dropped with no reply. The gate keys on the cryptographic sender
 * (rumor.pubkey), proving the allowlist works end-to-end through unwrap.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generateSecretKey, getPublicKey } from "nostr-tools/pure";

import { type Config } from "../src/config.ts";
import type { Harness, HarnessChunk, HarnessRequest } from "../src/harnesses/types.ts";
import { openMemoryStore, type MemoryStore } from "../src/memory/store.ts";
import { createPhantomchatChannel } from "../src/channels/phantomchat/channel.ts";
import { runPhantomchatServer } from "../src/channels/phantomchat/server.ts";
import {
  SimplePoolPhantomchatTransport,
  type NostrFilter,
  type RelayPool,
} from "../src/channels/phantomchat/transport.ts";
import {
  unwrapNip17Message,
  wrapGroupMessage,
  wrapNip17Message,
  type NTNostrEvent,
} from "../src/lib/nostrCrypto.ts";
import { npubEncode } from "../src/lib/nostrIdentity.ts";

/** A harness that always replies with a fixed final text. */
class ScriptedHarness implements Harness {
  invocations = 0;
  lastRequest?: HarnessRequest;
  constructor(
    public readonly id: string,
    private readonly script: HarnessChunk[],
  ) {}
  async available(): Promise<boolean> {
    return true;
  }
  async *invoke(req: HarnessRequest): AsyncGenerator<HarnessChunk> {
    this.invocations++;
    this.lastRequest = req;
    for (const c of this.script) yield c;
  }
}

/**
 * In-memory relay pool. `feed(event)` delivers a gift-wrap to the live
 * subscription; `published` records everything publish() saw. After the seeded
 * events are fed and `endFeed()` is called, the subscription is considered
 * exhausted so the channel's listen() loop can complete under oneShot.
 */
class FakePool implements RelayPool {
  published: NTNostrEvent[] = [];
  private onevent?: (event: NTNostrEvent) => void;

  subscribeMany(
    _relays: string[],
    _filter: NostrFilter,
    params: { onevent: (event: NTNostrEvent) => void; oneose?: () => void },
  ): { close(): void } {
    this.onevent = params.onevent;
    // Simulate an empty stored backlog: signal EOSE immediately so the
    // channel's live-gate opens and subsequently fed events are treated as
    // live (and therefore processed). Without this, the live-gate would skip
    // everything as pre-EOSE history.
    params.oneose?.();
    return {
      close: () => {
        this.onevent = undefined;
      },
    };
  }

  publish(_relays: string[], event: NTNostrEvent): Promise<string>[] {
    this.published.push(event);
    return [Promise.resolve("ok")];
  }

  close(_relays: string[]): void {}

  feed(event: NTNostrEvent): void {
    this.onevent?.(event);
  }
}

let workdir: string;
let agentDir: string;
let memory: MemoryStore;

beforeEach(async () => {
  workdir = await mkdtemp(join(tmpdir(), "phantombot-pc-"));
  agentDir = join(workdir, "personas", "phantom");
  await mkdir(agentDir, { recursive: true });
  await writeFile(join(agentDir, "BOOT.md"), "# Phantom", "utf8");
  memory = await openMemoryStore(":memory:");
});

afterEach(async () => {
  await memory.close();
  await rm(workdir, { recursive: true, force: true });
});

const baseConfig = (): Config => ({
  defaultPersona: "phantom",
  harnessIdleTimeoutMs: 5_000,
  harnessHardTimeoutMs: 5_000,
  personasDir: join(workdir, "personas"),
  memoryDbPath: join(workdir, "memory.sqlite"),
  configPath: join(workdir, "config.toml"),
  harnesses: {
    chain: ["claude"],
    claude: { bin: "claude", model: "opus", fallbackModel: "sonnet" },
    pi: { bin: "pi", maxPayloadBytes: 1_000_000 },
    gemini: { bin: "gemini", model: "" },
  },
  channels: {},
  embeddings: { provider: "none" },
  // Retrieval disabled so the test doesn't need an embeddings index.
  retrieval: undefined,
  voice: { provider: "none" },
});

/**
 * Run the server against one inbound message from `senderSk` and return the
 * fake pool so the caller can inspect what was published.
 */
async function runOnce(opts: {
  senderSk: Uint8Array;
  botSk: Uint8Array;
  allowedHex: string[];
  harness: Harness;
  text: string;
  tofu?: boolean;
  persistTrust?: (senderHex: string) => Promise<void>;
}): Promise<FakePool> {
  const botHex = getPublicKey(opts.botSk);
  const pool = new FakePool();
  const transport = new SimplePoolPhantomchatTransport(
    opts.botSk,
    ["wss://test.relay"],
    pool,
  );
  const channel = createPhantomchatChannel({
    secretKey: opts.botSk,
    publicKeyHex: botHex,
    transport,
  });

  // Build the inbound gift-wrap the PWA would send: a text envelope wrapped to
  // the bot. wraps[0] is the recipient wrap (the one that reaches the bot).
  const envelope = JSON.stringify({
    id: "in-1",
    from: getPublicKey(opts.senderSk),
    to: botHex,
    type: "text",
    content: opts.text,
    timestamp: Date.now(),
  });
  const { wraps } = wrapNip17Message(opts.senderSk, botHex, envelope);

  const ac = new AbortController();
  const serverPromise = runPhantomchatServer({
    config: baseConfig(),
    memory,
    harnesses: [opts.harness],
    agentDir,
    persona: "phantom",
    channel,
    allowedHex: opts.allowedHex,
    tofu: opts.tofu,
    persistTrust: opts.persistTrust,
    oneShot: true,
    signal: ac.signal,
  });

  // Deliver the wrap, then end the stream so the oneShot loop completes.
  pool.feed(wraps[0] as NTNostrEvent);
  // Give the microtask queue a tick so the channel enqueues the message before
  // we abort the listen loop.
  await new Promise((r) => setTimeout(r, 80));
  ac.abort();
  await serverPromise;

  return pool;
}

describe("phantomchat auth gate", () => {
  test("allowed npub: turn runs and a reply is published", async () => {
    const senderSk = generateSecretKey();
    const botSk = generateSecretKey();
    const senderNpub = npubEncode(getPublicKey(senderSk));
    const harness = new ScriptedHarness("fake", [
      { type: "done", finalText: "pong" },
    ]);

    const pool = await runOnce({
      senderSk,
      botSk,
      allowedHex: [
        // Decode the allowed npub to hex the way run.ts does.
        getPublicKey(senderSk),
      ],
      harness,
      text: "ping",
    });

    expect(senderNpub.startsWith("npub1")).toBe(true);
    expect(harness.invocations).toBe(1);
    // Two REPLY wraps published (recipient + self), both kind 1059. The pool
    // may also carry ephemeral kind-20001 typing ticks (driven off the turn's
    // critical path via a deferred timer, so their presence here is timing-
    // dependent — emission is covered deterministically by the transport unit
    // test), so filter to the reply wraps.
    const wraps = pool.published.filter((e) => e.kind === 1059);
    expect(wraps.length).toBe(2);

    // The recipient (original sender) can unwrap the reply and read "pong".
    const reply = unwrapNip17Message(wraps[0] as NTNostrEvent, senderSk);
    expect(JSON.parse(reply.content).content).toBe("pong");
    expect(JSON.parse(reply.content).type).toBe("text");
  });

  test("non-allowed npub: message is dropped, no turn, no reply", async () => {
    const senderSk = generateSecretKey();
    const botSk = generateSecretKey();
    const otherSk = generateSecretKey(); // the only allowed key
    const harness = new ScriptedHarness("fake", [
      { type: "done", finalText: "should not happen" },
    ]);

    const pool = await runOnce({
      senderSk,
      botSk,
      allowedHex: [getPublicKey(otherSk)],
      harness,
      text: "let me in",
    });

    expect(harness.invocations).toBe(0);
    expect(pool.published.length).toBe(0);
  });

  test("empty allowlist answers anyone (open-bot parity with Telegram)", async () => {
    const senderSk = generateSecretKey();
    const botSk = generateSecretKey();
    const harness = new ScriptedHarness("fake", [
      { type: "done", finalText: "open" },
    ]);

    const pool = await runOnce({
      senderSk,
      botSk,
      allowedHex: [],
      harness,
      text: "anyone home",
    });

    expect(harness.invocations).toBe(1);
    expect(pool.published.filter((e) => e.kind === 1059).length).toBe(2);
  });
});

describe("phantomchat TOFU (trust-on-first-use)", () => {
  test("empty allowlist + tofu: first sender is answered and persisted", async () => {
    const senderSk = generateSecretKey();
    const botSk = generateSecretKey();
    const harness = new ScriptedHarness("fake", [
      { type: "done", finalText: "welcome" },
    ]);
    const trusted: string[] = [];

    const pool = await runOnce({
      senderSk,
      botSk,
      allowedHex: [],
      tofu: true,
      persistTrust: async (hex) => {
        trusted.push(hex);
      },
      harness,
      text: "first contact",
    });

    // First sender is trusted: turn runs, reply published, and the sender hex
    // is persisted (the run.ts callback would encode it to npub + clear tofu).
    expect(harness.invocations).toBe(1);
    expect(pool.published.filter((e) => e.kind === 1059).length).toBe(2);
    expect(trusted).toEqual([getPublicKey(senderSk).toLowerCase()]);
  });

  test("tofu locks to the first sender: a later stranger is dropped", async () => {
    const firstSk = generateSecretKey();
    const strangerSk = generateSecretKey();
    const botSk = generateSecretKey();
    const botHex = getPublicKey(botSk);
    const harness = new ScriptedHarness("fake", [
      { type: "done", finalText: "hi first" },
      { type: "done", finalText: "should not reach stranger" },
    ]);
    const trusted: string[] = [];

    const pool = new FakePool();
    const transport = new SimplePoolPhantomchatTransport(
      botSk,
      ["wss://test.relay"],
      pool,
    );
    const channel = createPhantomchatChannel({
      secretKey: botSk,
      publicKeyHex: botHex,
      transport,
    });

    const mkWrap = (sk: Uint8Array, id: string, text: string) => {
      const envelope = JSON.stringify({
        id,
        from: getPublicKey(sk),
        to: botHex,
        type: "text",
        content: text,
        timestamp: Date.now(),
      });
      return wrapNip17Message(sk, botHex, envelope).wraps[0] as NTNostrEvent;
    };

    const ac = new AbortController();
    const serverPromise = runPhantomchatServer({
      config: baseConfig(),
      memory,
      harnesses: [harness],
      agentDir,
      persona: "phantom",
      channel,
      allowedHex: [],
      tofu: true,
      persistTrust: async (hex) => {
        trusted.push(hex);
      },
      oneShot: true,
      signal: ac.signal,
    });

    // First sender claims TOFU; the stranger arrives after and must be dropped.
    pool.feed(mkWrap(firstSk, "a-1", "i am first"));
    await new Promise((r) => setTimeout(r, 80));
    pool.feed(mkWrap(strangerSk, "b-1", "let me in too"));
    await new Promise((r) => setTimeout(r, 80));
    ac.abort();
    await serverPromise;

    // Only the first sender ran + got a reply; the stranger was gated out.
    expect(harness.invocations).toBe(1);
    expect(pool.published.filter((e) => e.kind === 1059).length).toBe(2); // recipient + self wrap for first only
    expect(trusted).toEqual([getPublicKey(firstSk).toLowerCase()]);
  });
});

/**
 * Live-gate regression (the restart-replay bug). On (re)connect the relays
 * replay up to 49h of stored gift-wraps; the channel must IGNORE that backlog
 * (everything before EOSE) and only act on messages that arrive live (after
 * EOSE). Without this, a restart re-replies to every past DM.
 */
describe("phantomchat channel live-gate", () => {
  // A pool that does NOT auto-fire EOSE, so the test controls backlog vs live.
  class DeferredEosePool implements RelayPool {
    onevent?: (event: NTNostrEvent) => void;
    fireEose?: () => void;
    published: NTNostrEvent[] = [];
    subscribeMany(
      _relays: string[],
      _filter: NostrFilter,
      params: { onevent: (event: NTNostrEvent) => void; oneose?: () => void },
    ): { close(): void } {
      this.onevent = params.onevent;
      this.fireEose = params.oneose;
      return { close: () => {} };
    }
    publish(_relays: string[], event: NTNostrEvent): Promise<string>[] {
      this.published.push(event);
      return [Promise.resolve("ok")];
    }
    close(): void {}
  }

  test("pre-EOSE backlog is skipped; post-EOSE live message is delivered", async () => {
    const botSk = generateSecretKey();
    const botHex = getPublicKey(botSk);
    const senderSk = generateSecretKey();
    const pool = new DeferredEosePool();
    const transport = new SimplePoolPhantomchatTransport(
      botSk,
      ["wss://test.relay"],
      pool,
    );
    const channel = createPhantomchatChannel({
      secretKey: botSk,
      publicKeyHex: botHex,
      transport,
    });

    const ac = new AbortController();
    const got: string[] = [];
    const drain = (async () => {
      for await (const msg of channel.listen!(ac.signal)) got.push(msg.text);
    })();

    const wrapFor = (text: string): NTNostrEvent => {
      const env = JSON.stringify({
        id: text,
        from: getPublicKey(senderSk),
        to: botHex,
        type: "text",
        content: text,
        timestamp: Date.now(),
      });
      return wrapNip17Message(senderSk, botHex, env).wraps[0] as NTNostrEvent;
    };

    // Backlog (pre-EOSE) — must be ignored.
    pool.onevent!(wrapFor("historical"));
    await new Promise((r) => setTimeout(r, 80));
    // Relays finish replaying history → go live.
    pool.fireEose!();
    // Live message (post-EOSE) — must be delivered.
    pool.onevent!(wrapFor("live"));
    await new Promise((r) => setTimeout(r, 80));

    ac.abort();
    await drain;

    expect(got).toEqual(["live"]);
  });
});

/**
 * Group-routing regression (the "HQ" bug, 2026-06-14). Andrew said hi to Lena
 * in a GROUP, but Lena's bridge ignored the rumor's `['group', ...]` tag and
 * replied in her 1:1 DM. The fix: detect the group tag on inbound, thread the
 * turn under `group:<id>`, and broadcast the reply back as a GROUP wrap (one
 * gift-wrap per member + self-wrap, group tag preserved) so the PWA routes it
 * into the group instead of a DM.
 *
 * These tests drive a full inbound→reply round trip with a real group wrap and
 * assert: (a) the turn is threaded under the group conversation, and (b) every
 * group member — including the original sender — can unwrap the reply and the
 * reply carries the same group tag the PWA routes on.
 */
describe("phantomchat group routing (HQ bug)", () => {
  test("channel.listen surfaces the group tag: conversationId is group:<id> and member hexes ride inbound", async () => {
    const andrewSk = generateSecretKey();
    const botSk = generateSecretKey();
    const memberSk = generateSecretKey();
    const botHex = getPublicKey(botSk);
    const memberHex = getPublicKey(memberSk);
    const groupId = "hq-detect-test";

    const pool = new FakePool();
    const transport = new SimplePoolPhantomchatTransport(
      botSk,
      ["wss://test.relay"],
      pool,
    );
    const channel = createPhantomchatChannel({
      secretKey: botSk,
      publicKeyHex: botHex,
      transport,
    });

    const payload = JSON.stringify({
      content: "hi Lena",
      type: "text",
      id: `grp-${Date.now()}-zzz`,
      timestamp: Date.now(),
    });
    const { wraps } = wrapGroupMessage(
      andrewSk,
      [botHex, memberHex],
      payload,
      groupId,
    );
    let inboundForBot: NTNostrEvent | undefined;
    for (const w of wraps) {
      try {
        unwrapNip17Message(w as NTNostrEvent, botSk);
        inboundForBot = w as NTNostrEvent;
        break;
      } catch {
        /* not ours */
      }
    }

    const ac = new AbortController();
    const got: import("../src/channels/core/types.ts").ChannelMessage[] = [];
    const drain = (async () => {
      for await (const m of channel.listen!(ac.signal)) got.push(m);
    })();
    pool.feed(inboundForBot!);
    await new Promise((r) => setTimeout(r, 80));
    ac.abort();
    await drain;

    expect(got.length).toBe(1);
    const m = got[0]!;
    // Threaded under the GROUP, not the sender's DM.
    expect(m.conversationId).toBe(`group:${groupId}`);
    // senderId is still the proven sender (auth gate is per-person).
    expect(m.senderId).toBe(getPublicKey(andrewSk));
    expect(m.text).toBe("hi Lena");
    expect(m.groupId).toBe(groupId);
    // Member hexes carried from the rumor's p-tags (the bot + the other member,
    // lowercased), so the server can broadcast the reply with no group DB.
    expect(new Set(m.groupMemberHexes)).toEqual(
      new Set([botHex.toLowerCase(), memberHex.toLowerCase()]),
    );
  });

  test("inbound group message → group-threaded turn + group-wrapped reply to all members", async () => {
    // Cast: Andrew (sender) + Lena (the bot) + a second member, in group "HQ".
    const andrewSk = generateSecretKey();
    const botSk = generateSecretKey(); // Lena
    const memberSk = generateSecretKey(); // another HQ member
    const andrewHex = getPublicKey(andrewSk);
    const botHex = getPublicKey(botSk);
    const memberHex = getPublicKey(memberSk);
    const groupId = "hq-group-id-deadbeef";

    const harness = new ScriptedHarness("fake", [
      { type: "done", finalText: "hey Andrew, in HQ" },
    ]);

    const pool = new FakePool();
    const transport = new SimplePoolPhantomchatTransport(
      botSk,
      ["wss://test.relay"],
      pool,
    );
    const channel = createPhantomchatChannel({
      secretKey: botSk,
      publicKeyHex: botHex,
      transport,
    });

    // Andrew sends a GROUP message to HQ exactly as the PWA does: otherMembers
    // (everyone but Andrew) = [Lena, member], wrapped via wrapGroupMessage with
    // the group tag. wraps reaching Lena are the ones p-tagged to her.
    const groupPayload = JSON.stringify({
      content: "hi Lena",
      type: "text",
      id: `grp-${Date.now()}-abc123`,
      timestamp: Date.now(),
    });
    const { wraps } = wrapGroupMessage(
      andrewSk,
      [botHex, memberHex],
      groupPayload,
      groupId,
    );
    // Find the wrap Lena (the bot) can unwrap — that's the one the relay would
    // deliver to her #p subscription.
    let inboundForBot: NTNostrEvent | undefined;
    for (const w of wraps) {
      try {
        unwrapNip17Message(w as NTNostrEvent, botSk);
        inboundForBot = w as NTNostrEvent;
        break;
      } catch {
        /* not ours */
      }
    }
    expect(inboundForBot).toBeDefined();

    const ac = new AbortController();
    const serverPromise = runPhantomchatServer({
      config: baseConfig(),
      memory,
      harnesses: [harness],
      agentDir,
      persona: "phantom",
      channel,
      allowedHex: [andrewHex], // Andrew is allowlisted
      oneShot: true,
      signal: ac.signal,
    });

    pool.feed(inboundForBot!);
    await new Promise((r) => setTimeout(r, 100));
    ac.abort();
    await serverPromise;

    // The turn ran on the inbound group text.
    expect(harness.invocations).toBe(1);
    expect(harness.lastRequest?.userMessage).toBe("hi Lena");

    // The reply is a group broadcast: one wrap per OTHER member (Andrew +
    // member) plus Lena's self-wrap = 3 kind-1059 wraps.
    const replyWraps = pool.published.filter((e) => e.kind === 1059);
    expect(replyWraps.length).toBe(3);

    // Andrew (the original sender) can unwrap the reply, read the text, and see
    // the SAME group tag — so his PWA routes it into HQ, not a DM from Lena.
    let andrewReply: ReturnType<typeof unwrapNip17Message> | undefined;
    for (const w of replyWraps) {
      try {
        andrewReply = unwrapNip17Message(w as NTNostrEvent, andrewSk);
        break;
      } catch {
        /* not for Andrew */
      }
    }
    expect(andrewReply).toBeDefined();
    expect(JSON.parse(andrewReply!.content).content).toBe("hey Andrew, in HQ");
    expect(andrewReply!.tags.find((t) => t[0] === "group")).toEqual([
      "group",
      groupId,
    ]);
    // The reply's p-tags reach the other live member too (Andrew + member),
    // never Lena herself.
    const replyPTags = andrewReply!.tags
      .filter((t) => t[0] === "p")
      .map((t) => t[1]);
    expect(new Set(replyPTags)).toEqual(new Set([andrewHex, memberHex]));
    expect(replyPTags).not.toContain(botHex);

    // The other HQ member can also unwrap the reply (full broadcast).
    let memberReply: ReturnType<typeof unwrapNip17Message> | undefined;
    for (const w of replyWraps) {
      try {
        memberReply = unwrapNip17Message(w as NTNostrEvent, memberSk);
        break;
      } catch {
        /* not for member */
      }
    }
    expect(memberReply).toBeDefined();
    expect(JSON.parse(memberReply!.content).content).toBe("hey Andrew, in HQ");

    // Typing indicators for a GROUP turn are kind-20001 events that carry the
    // group tag (so the PWA renders the dots in HQ, not in Lena's DM), NOT a
    // bare `['p', sender]` DM typing tick.
    const typingEvents = pool.published.filter((e) => e.kind === 20001);
    expect(typingEvents.length).toBeGreaterThan(0);
    for (const ev of typingEvents) {
      expect(ev.tags.find((t) => t[0] === "group")).toEqual(["group", groupId]);
      // p-tags reach the other members (Andrew + member), never Lena herself.
      const pTags = ev.tags.filter((t) => t[0] === "p").map((t) => t[1]);
      expect(pTags).not.toContain(botHex.toLowerCase());
      expect(new Set(pTags)).toEqual(
        new Set([andrewHex.toLowerCase(), memberHex.toLowerCase()]),
      );
    }
    // The turn ends with an explicit STOP so the dots clear at once.
    expect(typingEvents.some((e) => e.content === "stop")).toBe(true);
  });

  test("a plain DM still replies 1:1 (no group tag → unchanged DM behaviour)", async () => {
    const senderSk = generateSecretKey();
    const botSk = generateSecretKey();
    const harness = new ScriptedHarness("fake", [
      { type: "done", finalText: "dm reply" },
    ]);

    const pool = await runOnce({
      senderSk,
      botSk,
      allowedHex: [getPublicKey(senderSk)],
      harness,
      text: "hi in DM",
    });

    // DM reply = recipient wrap + self wrap = 2, and NO group tag on the rumor.
    const wraps = pool.published.filter((e) => e.kind === 1059);
    expect(wraps.length).toBe(2);
    const reply = unwrapNip17Message(wraps[0] as NTNostrEvent, senderSk);
    expect(reply.tags.find((t) => t[0] === "group")).toBeUndefined();
  });
});
