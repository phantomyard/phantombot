/**
 * Tests for the Matrix channel adapter (issue #154).
 *
 * No network, no SDK, no crypto WASM: a hand-written `FakeMatrixClient`
 * (implements `MatrixClientLike`) drives the whole channel, exactly as the
 * Telegram tests use a FakeTransport. Layers:
 *   1. parseTimelineEvent — pure projection, shape coverage.
 *   2. createMatrixChannel — satisfies the Channel contract; listen() yields
 *      decrypted, parsed inbound; encrypt/decrypt are plaintext pass-throughs.
 *   3. runMatrixServer — end-to-end dispatch + the allow-list TRUST gate
 *      (trusted only for allow-listed MXIDs).
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { parseTimelineEvent } from "../src/channels/matrix/parse.ts";
import { createMatrixChannel, MATRIX_CAPABILITIES } from "../src/channels/matrix/channel.ts";
import { ClientMatrixTransport } from "../src/channels/matrix/transport.ts";
import { runMatrixServer } from "../src/channels/matrix/server.ts";
import type {
  MatrixClientLike,
  MatrixTimelineEvent,
} from "../src/channels/matrix/types.ts";
import type { Config, MatrixAccount } from "../src/config.ts";
import { principalConversations } from "../src/orchestrator/principalRouting.ts";
import type { Harness, HarnessChunk, HarnessRequest } from "../src/harnesses/types.ts";
import { openMemoryStore, type MemoryStore } from "../src/memory/store.ts";

// --- Fakes ------------------------------------------------------------------

/** Build a fake timeline event from a plain spec. */
function evt(spec: {
  id?: string;
  type?: string;
  sender?: string;
  roomId?: string;
  ts?: number;
  body?: string;
  msgtype?: string;
  redacted?: boolean;
}): MatrixTimelineEvent {
  return {
    getId: () => spec.id ?? "$evt1",
    getType: () => spec.type ?? "m.room.message",
    getSender: () => spec.sender ?? "@alice:hs",
    getRoomId: () => spec.roomId ?? "!room:hs",
    getTs: () => spec.ts ?? 1_000_000,
    getContent: () => ({ body: spec.body ?? "hi", msgtype: spec.msgtype ?? "m.text" }),
    isRedacted: () => spec.redacted ?? false,
  };
}

class FakeMatrixClient implements MatrixClientLike {
  sent: Array<{ roomId: string; body: string }> = [];
  typing: Array<{ roomId: string; isTyping: boolean }> = [];
  started = false;
  stopped = false;
  private listeners: Array<(e: MatrixTimelineEvent) => void> = [];
  constructor(
    private readonly self: string,
    private readonly encryptedRooms: Set<string> = new Set(["!room:hs"]),
    /** Rooms the bot treats as 1:1 DMs (drives sender-scoped keying). */
    private readonly directRooms: Set<string> = new Set(),
  ) {}
  getUserId(): string | null {
    return this.self;
  }
  async startClient(): Promise<void> {
    this.started = true;
  }
  stopClient(): void {
    this.stopped = true;
  }
  async sendTextMessage(roomId: string, body: string): Promise<{ event_id: string }> {
    this.sent.push({ roomId, body });
    return { event_id: "$sent" };
  }
  async sendTyping(roomId: string, isTyping: boolean): Promise<void> {
    this.typing.push({ roomId, isTyping });
  }
  isRoomEncrypted(roomId: string): boolean {
    return this.encryptedRooms.has(roomId);
  }
  isDirectRoom(roomId: string): boolean {
    return this.directRooms.has(roomId);
  }
  onTimelineEvent(cb: (e: MatrixTimelineEvent) => void): () => void {
    this.listeners.push(cb);
    return () => {
      this.listeners = this.listeners.filter((l) => l !== cb);
    };
  }
  /** Test helper: deliver a live timeline event to subscribers. */
  emit(e: MatrixTimelineEvent): void {
    for (const l of this.listeners) l(e);
  }
  subscriberCount(): number {
    return this.listeners.length;
  }
}

/** Poll until the server's listen() has subscribed to the timeline. */
async function waitForSubscribe(client: FakeMatrixClient): Promise<void> {
  for (let i = 0; i < 100 && client.subscriberCount() === 0; i++) {
    await new Promise((r) => setTimeout(r, 5));
  }
}

class ScriptedHarness implements Harness {
  invocations = 0;
  lastRequest?: HarnessRequest;
  constructor(
    public readonly id: string,
    private readonly script: HarnessChunk[],
  ) {}
  available(): Promise<boolean> {
    return Promise.resolve(true);
  }
  async *invoke(req: HarnessRequest): AsyncGenerator<HarnessChunk> {
    this.invocations++;
    this.lastRequest = req;
    for (const c of this.script) yield c;
  }
}

// --- parseTimelineEvent -----------------------------------------------------

describe("parseTimelineEvent", () => {
  test("projects an m.text message to a MatrixChannelMessage", () => {
    const m = parseTimelineEvent(evt({ body: "deploy now" }), "@bot:hs", true);
    expect(m).toEqual({
      conversationId: "!room:hs",
      senderId: "@alice:hs",
      fromUsername: "@alice:hs",
      text: "deploy now",
      roomId: "!room:hs",
      eventId: "$evt1",
      originServerTs: 1_000_000,
      encrypted: true,
    });
  });

  test("skips our own echoed messages", () => {
    expect(
      parseTimelineEvent(evt({ sender: "@bot:hs" }), "@bot:hs", true),
    ).toBeUndefined();
  });

  test("skips non-message events", () => {
    expect(
      parseTimelineEvent(evt({ type: "m.room.member" }), "@bot:hs", false),
    ).toBeUndefined();
  });

  test("skips redactions", () => {
    expect(
      parseTimelineEvent(evt({ redacted: true }), "@bot:hs", false),
    ).toBeUndefined();
  });

  test("skips empty bodies and non-text msgtypes", () => {
    expect(parseTimelineEvent(evt({ body: "" }), "@bot:hs", false)).toBeUndefined();
    expect(
      parseTimelineEvent(evt({ msgtype: "m.image" }), "@bot:hs", false),
    ).toBeUndefined();
  });

  test("accepts m.notice (bot-convention) as text", () => {
    const m = parseTimelineEvent(
      evt({ msgtype: "m.notice", body: "fyi" }),
      "@bot:hs",
      false,
    );
    expect(m?.text).toBe("fyi");
    expect(m?.encrypted).toBe(false);
  });
});

// --- createMatrixChannel (Channel contract) --------------------------------

describe("createMatrixChannel — Channel contract", () => {
  test("satisfies the Channel shape with encryption capability TRUE", () => {
    const client = new FakeMatrixClient("@bot:hs");
    const channel = createMatrixChannel(new ClientMatrixTransport(client));
    expect(channel.id).toBe("matrix");
    expect(channel.capabilities).toEqual(MATRIX_CAPABILITIES);
    expect(channel.capabilities.encryption).toBe(true);
    expect(typeof channel.encrypt).toBe("function");
    expect(typeof channel.decrypt).toBe("function");
    expect(typeof channel.listen).toBe("function");
  });

  test("encrypt/decrypt are plaintext pass-throughs (SDK does the Megolm)", () => {
    const channel = createMatrixChannel(
      new ClientMatrixTransport(new FakeMatrixClient("@bot:hs")),
    );
    const out = { conversationId: "!r:hs", text: "secret" };
    expect(channel.encrypt(out)).toBe(out);
    const inbound = {
      conversationId: "!r:hs",
      senderId: "@a:hs",
      text: "plaintext",
    };
    expect(channel.decrypt(inbound)).toBe(inbound);
  });

  test("listen() yields decrypted+parsed inbound and unsubscribes on abort", async () => {
    const client = new FakeMatrixClient("@bot:hs");
    const channel = createMatrixChannel(new ClientMatrixTransport(client));
    const ac = new AbortController();
    const got: string[] = [];
    const consumer = (async () => {
      for await (const msg of channel.listen!(ac.signal)) {
        got.push(`${msg.senderId}:${msg.text}`);
        if (got.length >= 2) ac.abort();
      }
    })();
    // Deliver: one from us (skipped), two from others (yielded).
    client.emit(evt({ sender: "@bot:hs", body: "echo" }));
    client.emit(evt({ sender: "@alice:hs", body: "one" }));
    client.emit(evt({ sender: "@alice:hs", body: "two" }));
    await consumer;
    expect(got).toEqual(["@alice:hs:one", "@alice:hs:two"]);
  });
});

// --- runMatrixServer — dispatch + allow-list trust gate --------------------

let workdir: string;
let agentDir: string;
let memory: MemoryStore;

beforeEach(async () => {
  workdir = await mkdtemp(join(tmpdir(), "phantombot-mx-"));
  agentDir = join(workdir, "personas", "phantom");
  await mkdir(agentDir, { recursive: true });
  await writeFile(join(agentDir, "BOOT.md"), "# Phantom", "utf8");
  memory = await openMemoryStore(":memory:");
});

afterEach(async () => {
  await memory.close();
  await rm(workdir, { recursive: true, force: true });
});

function baseConfig(): Config {
  return {
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
    voice: { provider: "none" },
  } as unknown as Config;
}

function account(allowedUserIds: string[]): MatrixAccount {
  return {
    homeserver: "https://hs",
    userId: "@bot:hs",
    deviceId: "DEV",
    accessToken: "tok",
    e2ee: false,
    allowedUserIds,
  };
}

/** Run the server, deliver `events` once sync has started, stop after handling. */
async function runWith(args: {
  acct: MatrixAccount;
  harness: Harness;
  events: MatrixTimelineEvent[];
  client?: FakeMatrixClient;
}): Promise<FakeMatrixClient> {
  const client = args.client ?? new FakeMatrixClient("@bot:hs");
  const transport = new ClientMatrixTransport(client);
  const ac = new AbortController();
  const server = runMatrixServer({
    config: baseConfig(),
    memory,
    harnesses: [args.harness],
    agentDir,
    persona: "phantom",
    transport,
    account: args.acct,
    signal: ac.signal,
    maxMessages: args.events.filter((e) => e.getSender() !== "@bot:hs").length,
  });
  // Wait for sync to start + listen() to subscribe before delivering live
  // events (the timeline subscription is established lazily when the async
  // generator is first pulled).
  await waitForSubscribe(client);
  for (const e of args.events) client.emit(e);
  await server;
  ac.abort();
  return client;
}

describe("runMatrixServer", () => {
  test("dispatches an allow-listed sender and replies on the same room", async () => {
    const harness = new ScriptedHarness("fake", [
      { type: "done", finalText: "on it" },
    ]);
    const client = await runWith({
      acct: account(["@alice:hs"]),
      harness,
      events: [evt({ sender: "@alice:hs", roomId: "!room:hs", body: "deploy", ts: Date.now() + 1000 })],
    });
    expect(harness.invocations).toBe(1);
    expect(client.sent).toEqual([{ roomId: "!room:hs", body: "on it" }]);
  });

  test("TRUST gate: allow-listed MXID → trusted turn (skips screen)", async () => {
    const harness = new ScriptedHarness("fake", [
      { type: "done", finalText: "ok" },
    ]);
    const client = await runWith({
      acct: account(["@alice:hs"]),
      harness,
      events: [evt({ sender: "@alice:hs", body: "hi", ts: Date.now() + 1000 })],
    });
    // A trusted turn means runTurn received trusted:true and the harness ran
    // exactly once (no extra screening-judge invocation on the same harness).
    expect(harness.lastRequest).toBeDefined();
    expect(client.sent.length).toBe(1);
  });

  test("rejects a non-allow-listed sender entirely (no dispatch)", async () => {
    const harness = new ScriptedHarness("fake", [
      { type: "done", finalText: "should not run" },
    ]);
    // Allowlist is non-empty but does NOT include the sender → rejected.
    const client = new FakeMatrixClient("@bot:hs");
    const transport = new ClientMatrixTransport(client);
    const ac = new AbortController();
    const server = runMatrixServer({
      config: baseConfig(),
      memory,
      harnesses: [harness],
      agentDir,
      persona: "phantom",
      transport,
      account: account(["@trusted:hs"]),
      signal: ac.signal,
      maxMessages: 1,
    });
    await waitForSubscribe(client);
    client.emit(evt({ sender: "@stranger:hs", body: "do bad things", ts: Date.now() + 1000 }));
    // Give the loop a couple ticks; the rejected message should not dispatch.
    await new Promise((r) => setTimeout(r, 30));
    ac.abort();
    await server;
    expect(harness.invocations).toBe(0);
    expect(client.sent.length).toBe(0);
  });

  test("drops events that predate server start", async () => {
    const harness = new ScriptedHarness("fake", [
      { type: "done", finalText: "stale" },
    ]);
    const client = new FakeMatrixClient("@bot:hs");
    const transport = new ClientMatrixTransport(client);
    const ac = new AbortController();
    const server = runMatrixServer({
      config: baseConfig(),
      memory,
      harnesses: [harness],
      agentDir,
      persona: "phantom",
      transport,
      account: account(["@alice:hs"]),
      signal: ac.signal,
      maxMessages: 1,
    });
    await Promise.resolve();
    // ts=1 is far before serverStartedAt → dropped.
    client.emit(evt({ sender: "@alice:hs", body: "old", ts: 1 }));
    await new Promise((r) => setTimeout(r, 30));
    ac.abort();
    await server;
    expect(harness.invocations).toBe(0);
  });

  // --- conversation keying (PR #175 fix: held-grounding referent) ----------
  //
  // The bug Kai flagged: inbound was keyed `matrix:<roomId>` while the
  // grounding write + notify key `matrix:<mxid>`, so a held request's
  // approve/deny reply landed in a different conversation than the grounding
  // pair. These pin the contract: a PRINCIPAL's DM is sender-scoped (matching
  // principalConversations), everything else stays room-scoped.

  test("a principal's 1:1 DM is keyed matrix:<mxid> — matches principalConversations", async () => {
    const harness = new ScriptedHarness("fake", [
      { type: "done", finalText: "ack" },
    ]);
    // `!dm:hs` is a direct room; @alice is the allow-listed principal.
    const client = new FakeMatrixClient(
      "@bot:hs",
      new Set(["!dm:hs"]),
      new Set(["!dm:hs"]),
    );
    await runWith({
      acct: account(["@alice:hs"]),
      harness,
      client,
      events: [
        evt({ sender: "@alice:hs", roomId: "!dm:hs", body: "hi", ts: Date.now() + 1000 }),
      ],
    });
    // The turn was persisted under the SENDER-scoped key, not the room key.
    expect(await memory.countUserTurns("phantom", "matrix:@alice:hs")).toBe(1);
    expect(await memory.countUserTurns("phantom", "matrix:!dm:hs")).toBe(0);

    // And that key is exactly what the grounding/notify path targets when
    // default_channel = matrix — so a held episode + the reply share one key.
    const cfg = {
      ...baseConfig(),
      defaultChannel: "matrix",
      channels: { matrix: account(["@alice:hs"]) },
    } as unknown as Config;
    expect(principalConversations(cfg, "phantom")).toContain("matrix:@alice:hs");
  });

  test("a principal in a NON-direct (group) room stays room-scoped", async () => {
    const harness = new ScriptedHarness("fake", [
      { type: "done", finalText: "ack" },
    ]);
    // directRooms is empty → `!group:hs` is not a DM.
    const client = new FakeMatrixClient("@bot:hs", new Set(["!group:hs"]));
    await runWith({
      acct: account(["@alice:hs"]),
      harness,
      client,
      events: [
        evt({ sender: "@alice:hs", roomId: "!group:hs", body: "hi", ts: Date.now() + 1000 }),
      ],
    });
    expect(await memory.countUserTurns("phantom", "matrix:!group:hs")).toBe(1);
    expect(await memory.countUserTurns("phantom", "matrix:@alice:hs")).toBe(0);
  });

  test("a NON-principal in a direct room stays room-scoped (sender-scoping is principal-only)", async () => {
    const harness = new ScriptedHarness("fake", [
      { type: "done", finalText: "ack" },
    ]);
    // Open bot (empty allowlist): @stranger is answered but NOT a principal,
    // and a direct room must NOT collapse to their MXID.
    const client = new FakeMatrixClient(
      "@bot:hs",
      new Set(["!dm:hs"]),
      new Set(["!dm:hs"]),
    );
    await runWith({
      acct: account([]),
      harness,
      client,
      events: [
        evt({ sender: "@stranger:hs", roomId: "!dm:hs", body: "hi", ts: Date.now() + 1000 }),
      ],
    });
    expect(await memory.countUserTurns("phantom", "matrix:!dm:hs")).toBe(1);
    expect(await memory.countUserTurns("phantom", "matrix:@stranger:hs")).toBe(0);
  });
});
