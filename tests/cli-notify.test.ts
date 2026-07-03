import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { runNotify } from "../src/cli/notify.ts";
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
  async getUpdates(): Promise<{
    updates: TelegramMessage[];
    nextOffset: number;
  }> {
    return { updates: [], nextOffset: 0 };
  }
  async ackUpdates(): Promise<void> {}
  async sendMessage(chatId: string, text: string): Promise<void> {
    this.sent.push({ chatId, text });
  }
  async sendTyping(): Promise<void> {}
  async sendRecording(): Promise<void> {}
  async sendVoice(
    chatId: string,
    audio: Buffer,
    mime: string,
  ): Promise<void> {
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

describe("runNotify text", () => {
  test("broadcasts --message to EVERY allowed user (fan-out)", async () => {
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
    // Fan-out: BOTH ids in [42, 99], not just the first.
    expect(transport.sent).toEqual([
      { chatId: "42", text: "important thing" },
      { chatId: "99", text: "important thing" },
    ]);
    expect(out.text).toContain("text=2");
  });

  test("dedups a repeated allowed user id to a single send", async () => {
    const cfg = baseConfig();
    cfg.channels.telegram!.allowedUserIds = [42, 99, 42];
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

  test("a mid-list recipient failure still delivers to the rest and is not surfaced", async () => {
    const cfg = baseConfig();
    cfg.channels.telegram!.allowedUserIds = [42, 99, 123];
    const transport = new FakeTransport();
    // Make the middle recipient (99) throw; 42 and 123 must still land.
    const origSend = transport.sendMessage.bind(transport);
    transport.sendMessage = async (chatId: string, text: string) => {
      if (chatId === "99") throw new Error("blocked by user");
      return origSend(chatId, text);
    };
    const err = new CaptureStream();
    const out = new CaptureStream();
    const code = await runNotify({
      config: cfg,
      transport,
      message: "resilient",
      out,
      err,
    });
    expect(code).toBe(0);
    // 42 and 123 delivered; 99 swallowed.
    expect(transport.sent).toEqual([
      { chatId: "42", text: "resilient" },
      { chatId: "123", text: "resilient" },
    ]);
    expect(out.text).toContain("text=2");
    // Failures live in logs only — never surfaced to the user via stderr.
    expect(err.text).toBe("");
  });
});

describe("runNotify persona routing", () => {
  test("--persona routes to that persona's bot + every allowed id", async () => {
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

  test("persona with no bot → falls back to the default bot's every id", async () => {
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
    // No bot for 'nobody' → default telegram, every id ([42, 99]).
    expect(code).toBe(0);
    expect(transport.sent).toEqual([
      { chatId: "42", text: "hi" },
      { chatId: "99", text: "hi" },
    ]);
    expect(out.text).toContain("text=2");
  });
});

describe("runNotify voice", () => {
  test("voice without TTS provider → text-only fallback when --message also given", async () => {
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
    expect(transport.sent.length).toBe(2); // text fanned out to both owners
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

  test("voice with valid TTS (openai + key) → fans out sendVoice + skips text", async () => {
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
      expect(transport.voiceSent.length).toBe(2); // voice fanned out to both owners
      expect(transport.sent.length).toBe(0);
      expect(out.text).toContain("voice=2");
    } finally {
      (globalThis as unknown as { fetch: typeof fetch }).fetch = origFetch;
    }
  });
});
