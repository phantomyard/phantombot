import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generateSecretKey, getPublicKey } from "nostr-tools/pure";
import { nip19 } from "nostr-tools";
import { runNotify, type PhantomchatNotifySend } from "../src/cli/notify.ts";
import type {
  TelegramMessage,
  TelegramTransport,
} from "../src/channels/telegram.ts";
import type { Config } from "../src/config.ts";

class CaptureStream {
  chunks: string[] = [];
  write(s: string | Uint8Array): boolean {
    this.chunks.push(typeof s === "string" ? s : new TextDecoder().decode(s));
    return true;
  }
  get text(): string {
    return this.chunks.join("");
  }
}

class FakeTransport implements TelegramTransport {
  // Core ids are channel-neutral strings (#168); notify stringifies the
  // numeric config recipients at the transport boundary.
  sent: Array<{ chatId: string; text: string }> = [];
  voiceSent: Array<{ chatId: string; mime: string; bytes: number }> = [];
  // chatIds for which sends should throw (simulates a blocked/failed recipient).
  failFor: Set<string>;
  constructor(failFor: string[] = []) {
    this.failFor = new Set(failFor);
  }
  async getUpdates(): Promise<{
    updates: TelegramMessage[];
    nextOffset: number;
  }> {
    return { updates: [], nextOffset: 0 };
  }
  async ackUpdates(): Promise<void> {}
  async sendMessage(chatId: string, text: string): Promise<void> {
    if (this.failFor.has(chatId)) throw new Error(`blocked: ${chatId}`);
    this.sent.push({ chatId, text });
  }
  async sendTyping(): Promise<void> {}
  async sendRecording(): Promise<void> {}
  async sendVoice(
    chatId: string,
    audio: Buffer,
    mime: string,
  ): Promise<void> {
    if (this.failFor.has(chatId)) throw new Error(`blocked: ${chatId}`);
    this.voiceSent.push({ chatId, mime, bytes: audio.byteLength });
  }
  async downloadFile(): Promise<{ data: Buffer; mime: string }> {
    return { data: Buffer.alloc(0), mime: "" };
  }
}

const SAVED_KEY = process.env.PHANTOMBOT_OPENAI_API_KEY;

beforeEach(() => {
  delete process.env.PHANTOMBOT_OPENAI_API_KEY;
});
afterEach(() => {
  if (SAVED_KEY === undefined) delete process.env.PHANTOMBOT_OPENAI_API_KEY;
  else process.env.PHANTOMBOT_OPENAI_API_KEY = SAVED_KEY;
});

function baseConfig(): Config {
  return {
    defaultPersona: "phantom",
    harnessIdleTimeoutMs: 1000, harnessHardTimeoutMs: 1000,
    personasDir: "/tmp",
    memoryDbPath: ":memory:",
    configPath: "/tmp/c.toml",
    harnesses: {
      chain: ["claude"],
      claude: { bin: "claude", model: "opus", fallbackModel: "sonnet" },
      pi: { bin: "pi", maxPayloadBytes: 1 },
      gemini: { bin: "gemini", model: "" },
    },
    channels: {
      telegram: {
        token: "fake-token",
        pollTimeoutS: 30,
        allowedUserIds: [42, 99],
      },
    },
    embeddings: { provider: "none" },
    voice: { provider: "none" },
  };
}

describe("runNotify input validation", () => {
  test("neither --message nor --voice → exit 2", async () => {
    const err = new CaptureStream();
    const code = await runNotify({
      config: baseConfig(),
      transport: new FakeTransport(),
      err,
      out: new CaptureStream(),
    });
    expect(code).toBe(2);
    expect(err.text).toContain("nothing to notify");
  });

  test("no channel configured at all → exit 2 with hint", async () => {
    const cfg = baseConfig();
    cfg.channels.telegram = undefined;
    const err = new CaptureStream();
    const code = await runNotify({
      config: cfg,
      message: "hi",
      err,
      out: new CaptureStream(),
    });
    expect(code).toBe(2);
    expect(err.text).toContain("no notify channel configured");
  });

  test("empty allowed_user_ids + no phantomchat → exit 2 (nothing to notify)", async () => {
    const cfg = baseConfig();
    cfg.channels.telegram!.allowedUserIds = [];
    const err = new CaptureStream();
    const code = await runNotify({
      config: cfg,
      message: "hi",
      err,
      out: new CaptureStream(),
    });
    expect(code).toBe(2);
    expect(err.text).toContain("no notify channel configured");
  });
});

describe("runNotify text (broadcast)", () => {
  test("sends --message to EVERY allowed user (fan-out)", async () => {
    const transport = new FakeTransport();
    const out = new CaptureStream();
    const code = await runNotify({
      config: baseConfig(),
      transport,
      message: "important thing",
      out,
      err: new CaptureStream(),
    });
    expect(code).toBe(0);
    // Broadcast: BOTH id 42 and id 99, not just the first.
    expect(transport.sent).toEqual([
      { chatId: "42", text: "important thing" },
      { chatId: "99", text: "important thing" },
    ]);
    expect(out.text).toContain("text=2");
  });

  test("dedups repeated allowed ids to a single send", async () => {
    const cfg = baseConfig();
    cfg.channels.telegram!.allowedUserIds = [42, 42, 99, 99, 99];
    const transport = new FakeTransport();
    const out = new CaptureStream();
    const code = await runNotify({
      config: cfg,
      transport,
      message: "once each",
      out,
      err: new CaptureStream(),
    });
    expect(code).toBe(0);
    expect(transport.sent).toEqual([
      { chatId: "42", text: "once each" },
      { chatId: "99", text: "once each" },
    ]);
    expect(out.text).toContain("text=2");
  });

  test("a mid-list failure still delivers to the rest and is not surfaced", async () => {
    const cfg = baseConfig();
    cfg.channels.telegram!.allowedUserIds = [42, 99, 123];
    // Recipient 99 is blocked; 42 and 123 must still get it.
    const transport = new FakeTransport(["99"]);
    const out = new CaptureStream();
    const err = new CaptureStream();
    const code = await runNotify({
      config: cfg,
      transport,
      message: "resilient",
      out,
      err,
    });
    // Partial failure is NOT fatal — something landed, so exit 0.
    expect(code).toBe(0);
    expect(transport.sent).toEqual([
      { chatId: "42", text: "resilient" },
      { chatId: "123", text: "resilient" },
    ]);
    expect(out.text).toContain("text=2");
    // The failure is logged (log.warn), never written to stderr for the user.
    expect(err.text).toBe("");
  });

  test("every recipient failing → exit 1 (nothing landed)", async () => {
    const cfg = baseConfig();
    cfg.channels.telegram!.allowedUserIds = [42, 99];
    const transport = new FakeTransport(["42", "99"]);
    const out = new CaptureStream();
    const err = new CaptureStream();
    const code = await runNotify({
      config: cfg,
      transport,
      message: "all blocked",
      out,
      err,
    });
    expect(code).toBe(1);
    expect(transport.sent).toEqual([]);
    expect(err.text).toBe("");
  });
});

describe("runNotify persona routing (broadcast)", () => {
  test("--persona routes to that persona's bot + ALL its allowed ids", async () => {
    const cfg = baseConfig();
    cfg.channels.telegramPersonas = {
      amanda: {
        token: "amanda-token",
        pollTimeoutS: 30,
        allowedUserIds: [7, 8],
      },
    };
    const transport = new FakeTransport();
    const out = new CaptureStream();
    const code = await runNotify({
      config: cfg,
      transport,
      persona: "amanda",
      message: "amanda ping",
      out,
      err: new CaptureStream(),
    });
    expect(code).toBe(0);
    // The persona's bot, ALL ids ([7, 8]) — not the default ([42, 99]).
    expect(transport.sent).toEqual([
      { chatId: "7", text: "amanda ping" },
      { chatId: "8", text: "amanda ping" },
    ]);
    expect(out.text).toContain("text=2");
  });

  test("persona with no bot → falls back to the default bot's ids", async () => {
    const cfg = baseConfig();
    cfg.channels.telegramPersonas = {
      amanda: { token: "t", pollTimeoutS: 30, allowedUserIds: [7] },
    };
    const transport = new FakeTransport();
    const out = new CaptureStream();
    const code = await runNotify({
      config: cfg,
      transport,
      persona: "nobody",
      message: "hi",
      out,
      err: new CaptureStream(),
    });
    // No bot for 'nobody' → default telegram, all ids (42, 99).
    expect(code).toBe(0);
    expect(transport.sent).toEqual([
      { chatId: "42", text: "hi" },
      { chatId: "99", text: "hi" },
    ]);
    expect(out.text).toContain("text=2");
  });
});

describe("runNotify voice (broadcast)", () => {
  test("voice without TTS provider → text-only fallback fans out to all owners", async () => {
    const cfg = baseConfig();
    // voice provider stays "none"; voice synth fails, but message still sends.
    const transport = new FakeTransport();
    const err = new CaptureStream();
    const out = new CaptureStream();
    const code = await runNotify({
      config: cfg,
      transport,
      message: "fallback ok",
      voice: "would synth this",
      out,
      err,
    });
    expect(code).toBe(0);
    expect(err.text).toContain("voice synthesis unavailable");
    expect(transport.sent.length).toBe(2); // text to both owners
    expect(transport.voiceSent.length).toBe(0);
  });

  test("voice without TTS and without --message → exit 1 (nothing to fall back to)", async () => {
    const cfg = baseConfig();
    const err = new CaptureStream();
    const code = await runNotify({
      config: cfg,
      transport: new FakeTransport(),
      voice: "would synth",
      out: new CaptureStream(),
      err,
    });
    expect(code).toBe(1);
    expect(err.text).toContain("voice notification not possible");
  });

  test("voice with valid TTS (openai + key) → fans out sendVoice to ALL owners + skips text", async () => {
    const cfg = baseConfig();
    cfg.voice = {
      provider: "openai",
      openai: { model: "tts-1", voice: "nova", speed: 1 },
    };
    process.env.PHANTOMBOT_OPENAI_API_KEY = "k";
    // Mock global fetch for the TTS POST.
    const origFetch = globalThis.fetch;
    (globalThis as unknown as { fetch: typeof fetch }).fetch = (async () =>
      new Response(Buffer.from([1, 2, 3, 4]), {
        status: 200,
        headers: { "content-type": "audio/ogg" },
      })) as unknown as typeof fetch;
    try {
      const transport = new FakeTransport();
      const out = new CaptureStream();
      const code = await runNotify({
        config: cfg,
        transport,
        voice: "synth me",
        out,
        err: new CaptureStream(),
      });
      expect(code).toBe(0);
      // Broadcast: voice note to both owners (42 and 99).
      expect(transport.voiceSent.length).toBe(2);
      expect(transport.voiceSent.map((v) => v.chatId)).toEqual(["42", "99"]);
      expect(transport.sent.length).toBe(0);
      expect(out.text).toContain("voice=2");
    } finally {
      (globalThis as unknown as { fetch: typeof fetch }).fetch = origFetch;
    }
  });
});

describe("runNotify phantomchat (broadcast)", () => {
  // Build a temp persona dir with a valid phantomchat.json (real nsec + npubs)
  // so runNotify's on-disk loader resolves the identity + allowlist. The send
  // is injected, so no sockets/relays are touched.
  function makePersona(
    persona: string,
    npubs: string[],
  ): { personasDir: string } {
    const root = mkdtempSync(join(tmpdir(), "pc-notify-"));
    const dir = join(root, persona);
    mkdirSync(dir, { recursive: true });
    const nsec = nip19.nsecEncode(generateSecretKey());
    writeFileSync(
      join(dir, "phantomchat.json"),
      JSON.stringify({ nsec, relays: ["wss://relay.example"], allowed_npubs: npubs }),
      { mode: 0o600 },
    );
    return { personasDir: root };
  }

  function npub(): string {
    return nip19.npubEncode(getPublicKey(generateSecretKey()));
  }

  test("fans out the text to EVERY allowed npub (deduped)", async () => {
    const a = npub();
    const b = npub();
    const { personasDir } = makePersona("phantom", [a, a, b]); // a duplicated
    const cfg = baseConfig();
    cfg.personasDir = personasDir;
    cfg.channels.telegram = undefined; // phantomchat-only

    const got: string[] = [];
    const phantomchatSend: PhantomchatNotifySend = async ({ recipientHex }) => {
      got.push(recipientHex);
    };
    const out = new CaptureStream();
    const code = await runNotify({
      config: cfg,
      message: "pc broadcast",
      phantomchatSend,
      out,
      err: new CaptureStream(),
    });
    expect(code).toBe(0);
    const aHex = nip19.decode(a).data as string;
    const bHex = nip19.decode(b).data as string;
    // Both recipients, each once (dup collapsed).
    expect(new Set(got)).toEqual(new Set([aHex, bHex]));
    expect(got.length).toBe(2);
    expect(out.text).toContain("phantomchat(text=2)");
  });

  test("a failing phantomchat recipient doesn't abort the rest, exit 0, not surfaced", async () => {
    const a = npub();
    const b = npub();
    const { personasDir } = makePersona("phantom", [a, b]);
    const cfg = baseConfig();
    cfg.personasDir = personasDir;
    cfg.channels.telegram = undefined;

    const aHex = nip19.decode(a).data as string;
    const got: string[] = [];
    const phantomchatSend: PhantomchatNotifySend = async ({ recipientHex }) => {
      if (recipientHex === aHex) throw new Error("dead relay");
      got.push(recipientHex);
    };
    const err = new CaptureStream();
    const out = new CaptureStream();
    const code = await runNotify({
      config: cfg,
      message: "resilient pc",
      phantomchatSend,
      out,
      err,
    });
    expect(code).toBe(0); // b still landed
    const bHex = nip19.decode(b).data as string;
    expect(got).toEqual([bHex]);
    expect(err.text).toBe("");
    expect(out.text).toContain("phantomchat(text=1)");
  });
});
