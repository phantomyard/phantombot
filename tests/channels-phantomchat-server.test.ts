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
    oneShot: true,
    signal: ac.signal,
  });

  // Deliver the wrap, then end the stream so the oneShot loop completes.
  pool.feed(wraps[0] as NTNostrEvent);
  // Give the microtask queue a tick so the channel enqueues the message before
  // we abort the listen loop.
  await new Promise((r) => setTimeout(r, 10));
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
    // Two wraps published (recipient + self), both kind 1059.
    expect(pool.published.length).toBe(2);
    expect(pool.published.every((e) => e.kind === 1059)).toBe(true);

    // The recipient (original sender) can unwrap the reply and read "pong".
    const reply = unwrapNip17Message(pool.published[0] as NTNostrEvent, senderSk);
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
    expect(pool.published.length).toBe(2);
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
    await new Promise((r) => setTimeout(r, 10));
    // Relays finish replaying history → go live.
    pool.fireEose!();
    // Live message (post-EOSE) — must be delivered.
    pool.onevent!(wrapFor("live"));
    await new Promise((r) => setTimeout(r, 10));

    ac.abort();
    await drain;

    expect(got).toEqual(["live"]);
  });
});
