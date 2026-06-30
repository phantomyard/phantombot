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

import {
  type Config,
  DEFAULT_TELEGRAM_STREAMING,
  type TelegramStreamingSettings,
} from "../src/config.ts";
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
  unwrapV2,
  wrapGroupMessage,
  wrapNip17Message,
  type NTNostrEvent,
} from "../src/lib/nostrCrypto.ts";
import { npubEncode } from "../src/lib/nostrIdentity.ts";

/**
 * Check if a kind-1059 gift-wrap is a MESSAGE (not a typing indicator).
 * Typing gift-wraps carry a ['t', 'typing'] marker on the outer wrap.
 */
function isMessageWrap(wrap: NTNostrEvent): boolean {
  return !wrap.tags?.some((t: string[]) => t[0] === 't' && t[1] === 'typing');
}

/** Filter published kind-1059 events to only message wraps (exclude typing). */
function messageWraps(pool: FakePool): NTNostrEvent[] {
  return pool.published.filter((e) => e.kind === 1059 && isMessageWrap(e as NTNostrEvent));
}

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
  // Override the streaming config (bubble sizing / delays). Streaming tests set
  // bubbleMaxSentences=1 + bubbleDelayMs=0 + narrationFlushMs=0 so each sentence
  // is its own bubble and narration flushes at once — deterministic and fast.
  streaming?: TelegramStreamingSettings;
  // How long to let listen() enqueue + the handler drain before aborting.
  waitMs?: number;
  // Stub kind-0 resolver (lowercased hex → {name, bot}). Lets a DM test exercise
  // the GLOBAL "never reply to a bot" rule via the sender's profile bot flag.
  profiles?: Record<string, { name?: string; bot?: boolean }>;
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

  const config = baseConfig();
  if (opts.streaming) config.telegramStreaming = opts.streaming;

  const ac = new AbortController();
  const serverPromise = runPhantomchatServer({
    config,
    memory,
    harnesses: [opts.harness],
    agentDir,
    persona: "phantom",
    channel,
    secretKey: opts.botSk,
    allowedHex: opts.allowedHex,
    tofu: opts.tofu,
    persistTrust: opts.persistTrust,
    fetchProfiles: opts.profiles
      ? async (authors: string[]) => {
          const out = new Map<string, { name?: string; bot?: boolean }>();
          for (const a of authors) {
            const meta = opts.profiles![a.toLowerCase()];
            if (meta) out.set(a.toLowerCase(), meta);
          }
          return out;
        }
      : undefined,
    oneShot: true,
    signal: ac.signal,
  });

  // Deliver the wrap, then end the stream so the oneShot loop completes.
  pool.feed(wraps[0] as NTNostrEvent);
  // Give the microtask queue a tick so the channel enqueues the message before
  // we abort the listen loop.
  await new Promise((r) => setTimeout(r, opts.waitMs ?? 80));
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
    // kind-1059 events: a delivery RECEIPT (post-gate, NIP-17 gift-wrap)
    // plus the v2 REPLY (single event, no self-wrap). The pool may also carry
    // ephemeral kind-20001 typing ticks (deferred timer, timing-dependent), so
    // filter to the kind-1059 events.
    const wraps = messageWraps(pool);
    expect(wraps.length).toBe(2);

    // Receipt is NIP-17 (gift-wrapped to sender); reply is v2 (AES-GCM).
    const receiptWrap = wraps.find((w) =>
      !w.tags.some((t) => t[0] === "v" && t[1] === "pc-v2"),
    );
    const replyWrap = wraps.find((w) =>
      w.tags.some((t) => t[0] === "v" && t[1] === "pc-v2"),
    );
    expect(receiptWrap).toBeDefined();
    expect(replyWrap).toBeDefined();

    // The delivery receipt references the inbound envelope id ("in-1") so the
    // PWA's DeliveryTracker can flip that exact message to "delivered".
    const receipt = unwrapNip17Message(receiptWrap! as NTNostrEvent, senderSk);
    expect(receipt.tags.some((t) => t[0] === "receipt-type")).toBe(true);
    expect(receipt.tags.find((t) => t[0] === "receipt-type")![1]).toBe("delivery");
    expect(receipt.tags.find((t) => t[0] === "e")![1]).toBe("in-1");

    // The recipient (original sender) can unwrap the v2 reply and read "pong".
    const reply = await unwrapV2(replyWrap! as NTNostrEvent, senderSk);
    expect(reply.content).toBe("pong");
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
    // delivery receipt + v2 reply (single event, no self-wrap).
    expect(messageWraps(pool).length).toBe(2);
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
    // delivery receipt + v2 reply (single event, no self-wrap).
    expect(messageWraps(pool).length).toBe(2);
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
      secretKey: botSk,
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
    // delivery receipt + v2 reply (single event, no self-wrap) for the FIRST sender only;
    // the gated-out stranger gets nothing (no receipt, no reply).
    expect(messageWraps(pool).length).toBe(2);
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
      secretKey: botSk,
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
    // member) plus Lena's self-wrap = 3 kind-1059 wraps. Filter out typing
    // gift-wraps (also kind-1059) by checking the inner rumor content.
    const allWraps = pool.published.filter((e) => e.kind === 1059);
    const replyWraps = allWraps.filter((w) => isMessageWrap(w as NTNostrEvent));
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

    // Typing indicators for a GROUP turn are now kind-1059 gift-wraps
    // (NIP-17). Each member gets their own wrap with an ephemeral signing key.
    // The inner kind-14 rumor carries ['d', groupId] and ['group', groupId]
    // tags, but those are encrypted — we can only verify the outer shape.
    const typingEvents = pool.published.filter((e) => e.kind === 1059 && e.tags?.some((t: string[]) => t[0] === 't' && t[1] === 'typing'));
    expect(typingEvents.length).toBeGreaterThan(0);
    for (const ev of typingEvents) {
      // Each wrap is tagged with a member's pubkey (for relay routing).
      const pTags = ev.tags.filter((t) => t[0] === "p").map((t) => t[1]);
      expect(pTags).not.toContain(botHex.toLowerCase());
      // Content is non-empty (encrypted rumor payload).
      expect(ev.content.length).toBeGreaterThan(0);
    }
    // At least one wrap for Andrew and one for the member.
    const allPTags = typingEvents.flatMap((ev) => ev.tags.filter((t) => t[0] === "p").map((t) => t[1]));
    expect(new Set(allPTags)).toEqual(
        new Set([andrewHex.toLowerCase(), memberHex.toLowerCase()]),
      );
    // The turn ends with an explicit STOP so the dots clear at once.
    // (STOP markers are inside encrypted rumors, so we can't check content directly.)
  });

  test("group voice note with STT unavailable: failure notice broadcasts to the GROUP, not a DM", async () => {
    // Regression (review #187): the voice STT error paths early-returned with a
    // 1:1 DM to the sender, so a group voice-note failure surfaced privately
    // instead of in the group. The notice must go back into the group.
    const andrewSk = generateSecretKey();
    const botSk = generateSecretKey();
    const memberSk = generateSecretKey();
    const andrewHex = getPublicKey(andrewSk);
    const botHex = getPublicKey(botSk);
    const memberHex = getPublicKey(memberSk);
    const groupId = "hq-voice-fail";

    // The turn must NOT run — STT-unavailable returns before the harness.
    const harness = new ScriptedHarness("fake", [{ type: "done", finalText: "should not run" }]);
    const pool = new FakePool();
    const transport = new SimplePoolPhantomchatTransport(botSk, ["wss://test.relay"], pool);
    const channel = createPhantomchatChannel({ secretKey: botSk, publicKeyHex: botHex, transport });

    // A GROUP voice note in the GroupAPI.sendFile shape (fileMetadata object).
    const payload = JSON.stringify({
      content: "",
      type: "voice",
      id: `grp-${Date.now()}-voice`,
      timestamp: Date.now(),
      fileMetadata: {
        url: "https://blossom.primal.net/voicenote",
        sha256: "ab".repeat(32),
        keyHex: "11".repeat(32),
        ivHex: "22".repeat(12),
        mimeType: "audio/ogg",
        size: 26050,
        duration: 9,
      },
    });
    const { wraps } = wrapGroupMessage(andrewSk, [botHex, memberHex], payload, groupId);
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
      config: baseConfig(), // voice.provider = "none" → STT unavailable
      memory,
      harnesses: [harness],
      agentDir,
      persona: "phantom",
      channel,
      secretKey: botSk,
      allowedHex: [andrewHex],
      oneShot: true,
      signal: ac.signal,
    });
    pool.feed(inboundForBot!);
    await new Promise((r) => setTimeout(r, 100));
    ac.abort();
    await serverPromise;

    // No turn ran (STT unavailable → early return).
    expect(harness.invocations).toBe(0);

    // The notice is a GROUP broadcast — 3 kind-1059 wraps (Andrew + member +
    // Lena's self-wrap) carrying the group tag — NOT a 1:1 DM (2 wraps, no tag).
    // Filter out typing gift-wraps (also kind-1059) by checking inner content.
    const allWraps2 = pool.published.filter((e) => e.kind === 1059);
    const replyWraps = allWraps2.filter((w) => isMessageWrap(w as NTNostrEvent));
    expect(replyWraps.length).toBe(3);
    let andrewNotice: ReturnType<typeof unwrapNip17Message> | undefined;
    for (const w of replyWraps) {
      try {
        andrewNotice = unwrapNip17Message(w as NTNostrEvent, andrewSk);
        break;
      } catch {
        /* not for Andrew */
      }
    }
    expect(andrewNotice).toBeDefined();
    expect(andrewNotice!.tags.find((t) => t[0] === "group")).toEqual(["group", groupId]);
    expect(JSON.parse(andrewNotice!.content).content.length).toBeGreaterThan(0);
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

    // kind-1059 = delivery receipt + v2 reply = 2 events. The
    // REPLY event carries NO group tag (plain 1:1 DM behaviour unchanged).
    const wraps = messageWraps(pool);
    expect(wraps.length).toBe(2);
    const replyWrap = wraps.find((w) =>
      w.tags.some((t) => t[0] === "v" && t[1] === "pc-v2"),
    );
    expect(replyWrap).toBeDefined();
    const reply = await unwrapV2(replyWrap! as NTNostrEvent, senderSk);
    expect(reply.tags.find((t) => t[0] === "group")).toBeUndefined();
  });
});

/**
 * Streaming progress bubbles (PR #197). The phantomchat channel now consumes
 * runTurn's chunks the way Telegram does: text is split into markdown-aware
 * bubbles by the shared StreamSegmenter, pre-tool narration is flushed as its
 * own bubble, and the post-loop send emits only the not-yet-seen suffix.
 *
 * The existing auth/group tests above use single-`done` scripts, which produce
 * exactly one bubble through the same path. These exercise the multi-chunk
 * streaming behaviour directly. All use a 1-sentence-per-bubble config with no
 * delays so each sentence is its own bubble and narration flushes at once —
 * deterministic and fast.
 */
const STREAM_ONE_PER_SENTENCE: TelegramStreamingSettings = {
  ...DEFAULT_TELEGRAM_STREAMING,
  bubbleMaxSentences: 1,
  bubbleDelayMs: 0,
  narrationFlushMs: 0,
};

/** Trimmed contents of the v2 reply bubbles a DM recipient can unwrap, in order. */
async function dmBubbles(
  pool: FakePool,
  recipientSk: Uint8Array,
): Promise<string[]> {
  const v2 = pool.published.filter(
    (e) =>
      e.kind === 1059 && e.tags.some((t) => t[0] === "v" && t[1] === "pc-v2"),
  );
  const out: string[] = [];
  for (const w of v2) {
    const r = await unwrapV2(w as NTNostrEvent, recipientSk);
    out.push(r.content.trim());
  }
  return out;
}

describe("phantomchat streaming bubbles", () => {
  test("multi-sentence reply streams as one bubble per sentence", async () => {
    const senderSk = generateSecretKey();
    const botSk = generateSecretKey();
    const harness = new ScriptedHarness("fake", [
      { type: "text", text: "First sentence. Second sentence. Third sentence." },
      {
        type: "done",
        finalText: "First sentence. Second sentence. Third sentence.",
      },
    ]);

    const pool = await runOnce({
      senderSk,
      botSk,
      allowedHex: [getPublicKey(senderSk)],
      harness,
      text: "go",
      streaming: STREAM_ONE_PER_SENTENCE,
      waitMs: 150,
    });

    expect(await dmBubbles(pool, senderSk)).toEqual([
      "First sentence.",
      "Second sentence.",
      "Third sentence.",
    ]);
  });

  test("text before a progress chunk is flushed as a separate narration bubble", async () => {
    const senderSk = generateSecretKey();
    const botSk = generateSecretKey();
    // "Checking your calendar" has no sentence terminator, so the segmenter
    // never sends it as a final bubble. The progress chunk classifies it as
    // narration and the (unthrottled) flush sends it as its own bubble.
    const harness = new ScriptedHarness("fake", [
      { type: "text", text: "Checking your calendar" },
      { type: "progress", note: "running calendar tool" },
      { type: "text", text: "You are free at 3pm." },
      {
        type: "done",
        finalText: "Checking your calendarYou are free at 3pm.",
      },
    ]);

    const pool = await runOnce({
      senderSk,
      botSk,
      allowedHex: [getPublicKey(senderSk)],
      harness,
      text: "am I free at 3?",
      streaming: STREAM_ONE_PER_SENTENCE,
      waitMs: 150,
    });

    // Narration bubble first, answer second — and the narration is consumed,
    // not duplicated into the final answer.
    expect(await dmBubbles(pool, senderSk)).toEqual([
      "Checking your calendar",
      "You are free at 3pm.",
    ]);
  });

  test("final send emits only the unseen suffix (no duplicated bubbles)", async () => {
    const senderSk = generateSecretKey();
    const botSk = generateSecretKey();
    // "First. " is streamed live; the done chunk's authoritative finalText is
    // longer. The post-loop send must emit only "Second.", not the whole reply.
    const harness = new ScriptedHarness("fake", [
      { type: "text", text: "First. " },
      { type: "done", finalText: "First. Second." },
    ]);

    const pool = await runOnce({
      senderSk,
      botSk,
      allowedHex: [getPublicKey(senderSk)],
      harness,
      text: "go",
      streaming: STREAM_ONE_PER_SENTENCE,
      waitMs: 150,
    });

    expect(await dmBubbles(pool, senderSk)).toEqual(["First.", "Second."]);
  });

  test("group reply streams as multiple group broadcasts", async () => {
    const andrewSk = generateSecretKey();
    const botSk = generateSecretKey();
    const memberSk = generateSecretKey();
    const andrewHex = getPublicKey(andrewSk);
    const botHex = getPublicKey(botSk);
    const memberHex = getPublicKey(memberSk);
    const groupId = "hq-stream-test";

    const harness = new ScriptedHarness("fake", [
      { type: "text", text: "Hello team. Working on it now." },
      { type: "done", finalText: "Hello team. Working on it now." },
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

    const payload = JSON.stringify({
      content: "status?",
      type: "text",
      id: `grp-${Date.now()}-stream`,
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
    expect(inboundForBot).toBeDefined();

    const config = baseConfig();
    config.telegramStreaming = STREAM_ONE_PER_SENTENCE;

    const ac = new AbortController();
    const serverPromise = runPhantomchatServer({
      config,
      memory,
      harnesses: [harness],
      agentDir,
      persona: "phantom",
      channel,
      secretKey: botSk,
      allowedHex: [andrewHex],
      oneShot: true,
      signal: ac.signal,
    });
    pool.feed(inboundForBot!);
    await new Promise((r) => setTimeout(r, 150));
    ac.abort();
    await serverPromise;

    // Two sentences → two group broadcasts. Each broadcast is one wrap per
    // OTHER member (Andrew + member) + Lena's self-wrap = 3 wraps, so two
    // broadcasts = 6 kind-1059 reply wraps. Filter out typing gift-wraps.
    const allWraps3 = pool.published.filter((e) => e.kind === 1059);
    const replyWraps = allWraps3.filter((w) => isMessageWrap(w as NTNostrEvent));
    expect(replyWraps.length).toBe(6);

    // Andrew can unwrap exactly one wrap per broadcast; the two he reads are
    // the two sentences, in order, each carrying the group tag.
    const andrewContents: string[] = [];
    for (const w of replyWraps) {
      try {
        const m = unwrapNip17Message(w as NTNostrEvent, andrewSk);
        expect(m.tags.find((t) => t[0] === "group")).toEqual([
          "group",
          groupId,
        ]);
        andrewContents.push(JSON.parse(m.content).content.trim());
      } catch {
        /* not for Andrew */
      }
    }
    expect(andrewContents).toEqual(["Hello team.", "Working on it now."]);
  });
});

/**
 * Slash commands (PR: Telegram-style /commands on phantomchat). The shared
 * `handleSlashCommand` dispatcher is wired into the phantomchat server, handled
 * inline (off the per-peer turn chain) so /stop reaches a hung turn. DM-only.
 *
 * Replies are sent via transport.sendMessage (a v2 wrap), so `dmBubbles` reads
 * them. Recognized commands never invoke the harness; unknown commands fall
 * through to a normal turn.
 */

const slashSleep = (ms: number): Promise<void> =>
  new Promise((r) => setTimeout(r, ms));

/** A harness that emits one text chunk then blocks until its signal aborts —
 *  lets a test hold a turn "in flight" so /stop has something to abort. */
class BlockingHarness implements Harness {
  invocations = 0;
  constructor(public readonly id: string) {}
  async available(): Promise<boolean> {
    return true;
  }
  async *invoke(req: HarnessRequest): AsyncGenerator<HarnessChunk> {
    this.invocations++;
    yield { type: "text", text: "working" };
    await new Promise<void>((resolve) => {
      if (req.signal?.aborted) return resolve();
      req.signal?.addEventListener("abort", () => resolve(), { once: true });
    });
    // No `done` — the turn was interrupted, nothing to finalize.
  }
}

/**
 * Start a long-lived phantomchat server (oneShot off) and return handles to
 * feed messages mid-run and to stop it. Needed for /stop and /reset, which
 * require a turn to be in flight / already persisted before the command lands —
 * the single-shot `runOnce` can't express that ordering.
 */
function makeServer(opts: {
  botSk: Uint8Array;
  allowedHex: string[];
  harness: Harness;
  serviceControl?: import("../src/lib/systemd.ts").ServiceControl;
}): { pool: FakePool; feed: (sk: Uint8Array, text: string) => void; stop: () => Promise<void> } {
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
  const ac = new AbortController();
  const done = runPhantomchatServer({
    config: baseConfig(),
    memory,
    harnesses: [opts.harness],
    agentDir,
    persona: "phantom",
    channel,
    secretKey: opts.botSk,
    allowedHex: opts.allowedHex,
    serviceControl: opts.serviceControl,
    oneShot: false,
    signal: ac.signal,
  });
  let n = 0;
  const feed = (sk: Uint8Array, text: string) => {
    const envelope = JSON.stringify({
      id: `slash-${++n}`,
      from: getPublicKey(sk),
      to: botHex,
      type: "text",
      content: text,
      timestamp: Date.now(),
    });
    const { wraps } = wrapNip17Message(sk, botHex, envelope);
    pool.feed(wraps[0] as NTNostrEvent);
  };
  const stop = async () => {
    ac.abort();
    await done;
  };
  return { pool, feed, stop };
}

describe("phantomchat slash commands", () => {
  test("/help lists the commands and runs no turn", async () => {
    const senderSk = generateSecretKey();
    const botSk = generateSecretKey();
    const harness = new ScriptedHarness("fake", [
      { type: "done", finalText: "should not run" },
    ]);
    const pool = await runOnce({
      senderSk,
      botSk,
      allowedHex: [getPublicKey(senderSk)],
      harness,
      text: "/help",
    });
    expect(harness.invocations).toBe(0);
    const replies = await dmBubbles(pool, senderSk);
    expect(replies.length).toBe(1);
    expect(replies[0]).toContain("available commands");
    expect(replies[0]).toContain("/stop");
    expect(replies[0]).toContain("/reset");
  });

  test("/status reports harness + uptime + idle, runs no turn", async () => {
    const senderSk = generateSecretKey();
    const botSk = generateSecretKey();
    const harness = new ScriptedHarness("fake", [
      { type: "done", finalText: "should not run" },
    ]);
    const pool = await runOnce({
      senderSk,
      botSk,
      allowedHex: [getPublicKey(senderSk)],
      harness,
      text: "/status",
    });
    expect(harness.invocations).toBe(0);
    const r = (await dmBubbles(pool, senderSk))[0]!;
    expect(r).toContain("harness: fake");
    expect(r).toContain("uptime:");
    expect(r).toMatch(/active:\s+no/);
  });

  test("/harness with no arg lists the chain, runs no turn", async () => {
    const senderSk = generateSecretKey();
    const botSk = generateSecretKey();
    const harness = new ScriptedHarness("fake", [
      { type: "done", finalText: "should not run" },
    ]);
    const pool = await runOnce({
      senderSk,
      botSk,
      allowedHex: [getPublicKey(senderSk)],
      harness,
      text: "/harness",
    });
    expect(harness.invocations).toBe(0);
    const r = (await dmBubbles(pool, senderSk))[0]!;
    expect(r).toContain("→ fake");
  });

  test("unknown /command falls through to a normal turn", async () => {
    const senderSk = generateSecretKey();
    const botSk = generateSecretKey();
    const harness = new ScriptedHarness("fake", [
      { type: "done", finalText: "noted" },
    ]);
    const pool = await runOnce({
      senderSk,
      botSk,
      allowedHex: [getPublicKey(senderSk)],
      harness,
      text: "/remember buy milk",
    });
    // Not a command we own → runTurn handled it.
    expect(harness.invocations).toBe(1);
    expect(await dmBubbles(pool, senderSk)).toContain("noted");
  });

  test("a non-allowed sender's /status is dropped (no reply)", async () => {
    const senderSk = generateSecretKey();
    const botSk = generateSecretKey();
    const otherSk = generateSecretKey(); // the only allowed key
    const harness = new ScriptedHarness("fake", [
      { type: "done", finalText: "should not run" },
    ]);
    const pool = await runOnce({
      senderSk,
      botSk,
      allowedHex: [getPublicKey(otherSk)],
      harness,
      text: "/status",
    });
    expect(harness.invocations).toBe(0);
    expect(messageWraps(pool).length).toBe(0);
  });

  test("/stop aborts an in-flight turn", async () => {
    const senderSk = generateSecretKey();
    const botSk = generateSecretKey();
    const harness = new BlockingHarness("fake");
    const srv = makeServer({
      botSk,
      allowedHex: [getPublicKey(senderSk)],
      harness,
    });
    srv.feed(senderSk, "do a long thing");
    await slashSleep(120); // let the turn register + block
    srv.feed(senderSk, "/stop");
    await slashSleep(120);
    await srv.stop();

    expect(harness.invocations).toBe(1);
    const replies = await dmBubbles(srv.pool, senderSk);
    expect(replies.some((r) => r.startsWith("stopped (was running"))).toBe(true);
  });

  test("/reset clears the conversation history", async () => {
    const senderSk = generateSecretKey();
    const botSk = generateSecretKey();
    const conversation = `phantomchat:${getPublicKey(senderSk)}`;
    const harness = new ScriptedHarness("fake", [
      { type: "done", finalText: "hi there" },
    ]);
    const srv = makeServer({
      botSk,
      allowedHex: [getPublicKey(senderSk)],
      harness,
    });
    srv.feed(senderSk, "hello"); // a normal turn persists history for this peer
    await slashSleep(150);
    expect(
      (await memory.recentTurns("phantom", conversation, 50)).length,
    ).toBeGreaterThan(0);
    srv.feed(senderSk, "/reset");
    await slashSleep(120);
    await srv.stop();

    const replies = await dmBubbles(srv.pool, senderSk);
    expect(
      replies.some((r) => /^reset: cleared \d+ turns? from this chat/.test(r)),
    ).toBe(true);
    // History is empty afterwards.
    expect((await memory.recentTurns("phantom", conversation, 50)).length).toBe(
      0,
    );
  });

  test("/restart replies then fires serviceControl.restart via afterSend", async () => {
    const senderSk = generateSecretKey();
    const botSk = generateSecretKey();
    let restarted = false;
    const serviceControl = {
      isActive: async () => true,
      restart: async () => {
        restarted = true;
        return { ok: true };
      },
    } as unknown as import("../src/lib/systemd.ts").ServiceControl;
    const harness = new ScriptedHarness("fake", [
      { type: "done", finalText: "should not run" },
    ]);
    const srv = makeServer({
      botSk,
      allowedHex: [getPublicKey(senderSk)],
      harness,
      serviceControl,
    });
    srv.feed(senderSk, "/restart");
    await slashSleep(120);
    await srv.stop();

    expect(harness.invocations).toBe(0);
    expect(restarted).toBe(true);
    expect(await dmBubbles(srv.pool, senderSk)).toContain("restarting…");
  });
});

/**
 * Group name-addressing gate (issue: multi-bot groups). When several bots share
 * a group, only the bot addressed BY NAME (or the one currently holding the
 * thread) replies — instead of all of them piling on. The gate reuses the
 * channel-agnostic decideGroupReply/matchPersonaNames (core/routing.ts), the
 * same logic Telegram uses, driven from the shared human message stream.
 *
 * Option (a): a bot NEVER reacts to another bot's message (cascade kill) — only
 * humans drive addressing. The gate engages ONLY when sibling bots are
 * configured (group_bots); a lone/unconfigured bot still answers everything, so
 * this is a no-op for single-bot groups (proven by the HQ tests above).
 */
describe("phantomchat group addressing gate (multi-bot)", () => {
  /**
   * A long-lived group server for one bot persona, aware of its sibling bots.
   * feedGroup() wraps a group message from `senderSk` to `otherMemberHexes` and
   * feeds the bot the wrap it can unwrap — exactly how a relay would deliver it.
   */
  function makeGroupServer(opts: {
    botSk: Uint8Array;
    persona: string;
    allowedHex: string[];
    groupPersonaNames?: string[];
    siblingBotHex?: string[];
    /** Stub kind-0 resolver: lowercased hex → {name, bot}. Models what the bot
     *  would fetch from relays, so auto bot-detection / name resolution can be
     *  tested with no config seeds. */
    profiles?: Record<string, { name?: string; bot?: boolean }>;
    harness: Harness;
  }): {
    pool: FakePool;
    feedGroup: (
      senderSk: Uint8Array,
      otherMemberHexes: string[],
      text: string,
      groupId: string,
    ) => void;
    stop: () => Promise<void>;
  } {
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
    const ac = new AbortController();
    const done = runPhantomchatServer({
      config: baseConfig(),
      memory,
      harnesses: [opts.harness],
      agentDir,
      persona: opts.persona,
      channel,
      secretKey: opts.botSk,
      allowedHex: opts.allowedHex,
      groupPersonaNames: opts.groupPersonaNames,
      siblingBotHex: opts.siblingBotHex,
      fetchProfiles: opts.profiles
        ? async (authors: string[]) => {
            const out = new Map<string, { name?: string; bot?: boolean }>();
            for (const a of authors) {
              const meta = opts.profiles![a.toLowerCase()];
              if (meta) out.set(a.toLowerCase(), meta);
            }
            return out;
          }
        : undefined,
      oneShot: false,
      signal: ac.signal,
    });
    let n = 0;
    const feedGroup = (
      senderSk: Uint8Array,
      otherMemberHexes: string[],
      text: string,
      groupId: string,
    ) => {
      const payload = JSON.stringify({
        content: text,
        type: "text",
        id: `g-${++n}`,
        timestamp: Date.now(),
      });
      const { wraps } = wrapGroupMessage(
        senderSk,
        otherMemberHexes,
        payload,
        groupId,
      );
      let forBot: NTNostrEvent | undefined;
      for (const w of wraps) {
        try {
          unwrapNip17Message(w as NTNostrEvent, opts.botSk);
          forBot = w as NTNostrEvent;
          break;
        } catch {
          /* not ours */
        }
      }
      if (forBot) pool.feed(forBot);
    };
    const stop = async () => {
      ac.abort();
      await done;
    };
    return { pool, feedGroup, stop };
  }

  const groupSleep = (ms: number): Promise<void> =>
    new Promise((r) => setTimeout(r, ms));

  // Cast for these tests: Andrew (human) + Lena (this bot) + Kai (sibling bot).
  function cast() {
    const andrewSk = generateSecretKey();
    const lenaSk = generateSecretKey();
    const kaiSk = generateSecretKey();
    return {
      andrewSk,
      lenaSk,
      kaiSk,
      andrewHex: getPublicKey(andrewSk),
      lenaHex: getPublicKey(lenaSk),
      kaiHex: getPublicKey(kaiSk),
    };
  }

  const replyWraps = (pool: FakePool, ...keys: Uint8Array[]) =>
    messageWraps(pool);

  test("addressed by name → this bot replies", async () => {
    const c = cast();
    const harness = new ScriptedHarness("fake", [
      { type: "done", finalText: "on it, Andrew" },
    ]);
    const srv = makeGroupServer({
      botSk: c.lenaSk,
      persona: "lena",
      allowedHex: [c.andrewHex, c.kaiHex],
      groupPersonaNames: ["lena", "kai"],
      siblingBotHex: [c.kaiHex],
      harness,
    });
    srv.feedGroup(c.andrewSk, [c.lenaHex, c.kaiHex], "hey lena, status?", "HQ");
    await groupSleep(150);
    await srv.stop();

    expect(harness.invocations).toBe(1);
    // Group broadcast: Andrew + Kai + Lena's self-wrap = 3 wraps (no DM receipt).
    expect(replyWraps(srv.pool, c.lenaSk, c.andrewSk).length).toBe(3);
  });

  test("another bot addressed by name → this bot stays quiet", async () => {
    const c = cast();
    const harness = new ScriptedHarness("fake", [
      { type: "done", finalText: "should not run" },
    ]);
    const srv = makeGroupServer({
      botSk: c.lenaSk,
      persona: "lena",
      allowedHex: [c.andrewHex, c.kaiHex],
      groupPersonaNames: ["lena", "kai"],
      siblingBotHex: [c.kaiHex],
      harness,
    });
    srv.feedGroup(c.andrewSk, [c.lenaHex, c.kaiHex], "hey kai, status?", "HQ");
    await groupSleep(150);
    await srv.stop();

    expect(harness.invocations).toBe(0);
    expect(replyWraps(srv.pool, c.lenaSk, c.andrewSk).length).toBe(0);
  });

  test("option (a): a sibling bot's message is ignored even if it names this bot", async () => {
    const c = cast();
    const harness = new ScriptedHarness("fake", [
      { type: "done", finalText: "should not run" },
    ]);
    const srv = makeGroupServer({
      botSk: c.lenaSk,
      persona: "lena",
      // Kai is allowlisted (so the auth gate would admit him) — the bot-ignore
      // must drop him at the group gate regardless.
      allowedHex: [c.andrewHex, c.kaiHex],
      groupPersonaNames: ["lena", "kai"],
      siblingBotHex: [c.kaiHex],
      harness,
    });
    // Kai (a bot) sends a message that explicitly names Lena. Without option (a)
    // this would trigger Lena and start a bot-to-bot cascade.
    srv.feedGroup(c.kaiSk, [c.lenaHex, c.andrewHex], "good point, lena!", "HQ");
    await groupSleep(150);
    await srv.stop();

    expect(harness.invocations).toBe(0);
    expect(replyWraps(srv.pool, c.lenaSk, c.andrewSk).length).toBe(0);
  });

  test("sticky: a no-name follow-up still reaches the bot that holds the thread", async () => {
    const c = cast();
    const harness = new ScriptedHarness("fake", [
      { type: "done", finalText: "first" },
      { type: "done", finalText: "second" },
    ]);
    const srv = makeGroupServer({
      botSk: c.lenaSk,
      persona: "lena",
      allowedHex: [c.andrewHex, c.kaiHex],
      groupPersonaNames: ["lena", "kai"],
      siblingBotHex: [c.kaiHex],
      harness,
    });
    srv.feedGroup(c.andrewSk, [c.lenaHex, c.kaiHex], "lena, do X", "HQ");
    await groupSleep(150);
    // No name — but Lena holds the thread, so she answers the follow-up.
    srv.feedGroup(c.andrewSk, [c.lenaHex, c.kaiHex], "thanks, and also Y?", "HQ");
    await groupSleep(150);
    await srv.stop();

    expect(harness.invocations).toBe(2);
    expect(replyWraps(srv.pool, c.lenaSk, c.andrewSk).length).toBe(6); // two 3-wrap broadcasts
  });

  test("hand-off: once Andrew addresses the sibling, this bot falls quiet", async () => {
    const c = cast();
    const harness = new ScriptedHarness("fake", [
      { type: "done", finalText: "first" },
    ]);
    const srv = makeGroupServer({
      botSk: c.lenaSk,
      persona: "lena",
      allowedHex: [c.andrewHex, c.kaiHex],
      groupPersonaNames: ["lena", "kai"],
      siblingBotHex: [c.kaiHex],
      harness,
    });
    srv.feedGroup(c.andrewSk, [c.lenaHex, c.kaiHex], "lena, do X", "HQ");
    await groupSleep(150);
    // Andrew hands the thread to Kai. Lena must go quiet (only her own first
    // reply ran) — she needs "kai" in her roster to detect the hand-off.
    srv.feedGroup(c.andrewSk, [c.lenaHex, c.kaiHex], "kai, your turn", "HQ");
    await groupSleep(150);
    await srv.stop();

    expect(harness.invocations).toBe(1);
    expect(replyWraps(srv.pool, c.lenaSk, c.andrewSk).length).toBe(3); // only the first reply
  });

  test("no sibling bots configured → lone bot still answers every group message", async () => {
    const c = cast();
    const harness = new ScriptedHarness("fake", [
      { type: "done", finalText: "sure" },
    ]);
    const srv = makeGroupServer({
      botSk: c.lenaSk,
      persona: "lena",
      allowedHex: [c.andrewHex],
      groupPersonaNames: [], // no roster → gate inactive (backward compat)
      siblingBotHex: [],
      harness,
    });
    // A message that does NOT name the bot still gets a reply (old behaviour).
    srv.feedGroup(c.andrewSk, [c.lenaHex], "what's the weather?", "HQ");
    await groupSleep(150);
    await srv.stop();

    expect(harness.invocations).toBe(1);
    expect(replyWraps(srv.pool, c.lenaSk, c.andrewSk).length).toBeGreaterThan(0);
  });

  // ===== auto bot-detection / name resolution from kind-0 (no config) =====
  // These tests pass NO group_bots config — the bot must discover that Kai is a
  // sibling bot (and his name) purely from his kind-0 profile (bot:true), so a
  // zero-config multi-bot group behaves correctly.

  test("auto: human addresses a sibling resolved from kind-0 → this bot stays quiet", async () => {
    const c = cast();
    const harness = new ScriptedHarness("fake", [
      { type: "done", finalText: "should not run" },
    ]);
    const srv = makeGroupServer({
      botSk: c.lenaSk,
      persona: "lena",
      allowedHex: [c.andrewHex, c.kaiHex],
      // No groupPersonaNames / siblingBotHex — Kai is discovered via his profile.
      profiles: {
        [c.kaiHex.toLowerCase()]: { name: "kai", bot: true },
        [c.andrewHex.toLowerCase()]: { name: "andrew" }, // human: no bot flag
      },
      harness,
    });
    srv.feedGroup(c.andrewSk, [c.lenaHex, c.kaiHex], "hey kai, status?", "HQ");
    await groupSleep(150);
    await srv.stop();

    // "kai" was in the auto-derived roster, so Lena recognised the hand-off.
    expect(harness.invocations).toBe(0);
    expect(replyWraps(srv.pool, c.lenaSk, c.andrewSk).length).toBe(0);
  });

  test("auto: human addresses THIS bot in a zero-config multi-bot group → it replies", async () => {
    const c = cast();
    const harness = new ScriptedHarness("fake", [
      { type: "done", finalText: "on it" },
    ]);
    const srv = makeGroupServer({
      botSk: c.lenaSk,
      persona: "lena",
      allowedHex: [c.andrewHex, c.kaiHex],
      profiles: {
        [c.kaiHex.toLowerCase()]: { name: "kai", bot: true },
        [c.andrewHex.toLowerCase()]: { name: "andrew" },
      },
      harness,
    });
    srv.feedGroup(c.andrewSk, [c.lenaHex, c.kaiHex], "lena, what's up?", "HQ");
    await groupSleep(150);
    await srv.stop();

    expect(harness.invocations).toBe(1);
    expect(replyWraps(srv.pool, c.lenaSk, c.andrewSk).length).toBe(3);
  });

  test("auto: a sibling bot's message is ignored via its kind-0 bot flag (cascade kill, no config)", async () => {
    const c = cast();
    const harness = new ScriptedHarness("fake", [
      { type: "done", finalText: "should not run" },
    ]);
    const srv = makeGroupServer({
      botSk: c.lenaSk,
      persona: "lena",
      allowedHex: [c.andrewHex, c.kaiHex],
      profiles: {
        [c.kaiHex.toLowerCase()]: { name: "kai", bot: true },
      },
      harness,
    });
    // Kai (a bot, by profile) names Lena. The global bot-gate must drop it.
    srv.feedGroup(c.kaiSk, [c.lenaHex, c.andrewHex], "good point, lena!", "HQ");
    await groupSleep(150);
    await srv.stop();

    expect(harness.invocations).toBe(0);
    expect(replyWraps(srv.pool, c.lenaSk, c.andrewSk).length).toBe(0);
  });

  test("auto: a bot is ignored even in a 1:1 DM (global rule)", async () => {
    const c = cast();
    const harness = new ScriptedHarness("fake", [
      { type: "done", finalText: "should not run" },
    ]);
    // Kai (a bot) DMs Lena directly. allowlisted, so auth passes — but the
    // global bot-gate must still drop him with no reply.
    const pool = await runOnce({
      senderSk: c.kaiSk,
      botSk: c.lenaSk,
      allowedHex: [c.andrewHex, c.kaiHex],
      harness,
      text: "hey lena, ping",
      profiles: { [c.kaiHex.toLowerCase()]: { name: "kai", bot: true } },
    });

    expect(harness.invocations).toBe(0);
    expect(messageWraps(pool).length).toBe(0);
  });

  test("auto: a human DM is still answered (bot-gate doesn't over-block)", async () => {
    const c = cast();
    const harness = new ScriptedHarness("fake", [
      { type: "done", finalText: "hi Andrew" },
    ]);
    const pool = await runOnce({
      senderSk: c.andrewSk,
      botSk: c.lenaSk,
      allowedHex: [c.andrewHex],
      harness,
      text: "hey lena",
      profiles: { [c.andrewHex.toLowerCase()]: { name: "andrew" } }, // no bot flag
    });

    expect(harness.invocations).toBe(1);
    expect(messageWraps(pool).length).toBeGreaterThan(0);
  });

  test("auto: cold cache (no profile resolves) → lone bot answers, no false mute", async () => {
    const c = cast();
    const harness = new ScriptedHarness("fake", [
      { type: "done", finalText: "sure" },
    ]);
    // Profiles map is empty: nothing resolves, so no OTHER bot is detected. The
    // group must behave like a lone-bot group (answer everything) rather than
    // go mute on an unaddressed message.
    const srv = makeGroupServer({
      botSk: c.lenaSk,
      persona: "lena",
      allowedHex: [c.andrewHex, c.kaiHex],
      profiles: {}, // resolver present but returns nothing
      harness,
    });
    srv.feedGroup(c.andrewSk, [c.lenaHex, c.kaiHex], "what's the weather?", "HQ");
    await groupSleep(150);
    await srv.stop();

    expect(harness.invocations).toBe(1);
    expect(replyWraps(srv.pool, c.lenaSk, c.andrewSk).length).toBeGreaterThan(0);
  });
});
