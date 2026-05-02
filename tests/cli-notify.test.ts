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
  sent: Array<{ chatId: number; text: string }> = [];
  voiceSent: Array<{ chatId: number; mime: string; bytes: number }> = [];
  async getUpdates(): Promise<{
    updates: TelegramMessage[];
    nextOffset: number;
  }> {
    return { updates: [], nextOffset: 0 };
  }
  async sendMessage(chatId: number, text: string): Promise<void> {
    this.sent.push({ chatId, text });
  }
  async sendTyping(): Promise<void> {}
  async sendRecording(): Promise<void> {}
  async sendVoice(
    chatId: number,
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
    turnTimeoutMs: 1000,
    personasDir: "/tmp",
    memoryDbPath: ":memory:",
    configPath: "/tmp/c.toml",
    harnesses: {
      chain: ["claude"],
      claude: { bin: "claude", model: "opus", fallbackModel: "sonnet" },
      pi: { bin: "pi", maxPayloadBytes:1 },
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

  test("no telegram configured → exit 2 with hint", async () => {
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
    expect(err.text).toContain("phantombot telegram");
  });

  test("empty allowed_user_ids → exit 2 (refuse to broadcast)", async () => {
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
    expect(err.text).toContain("allowed_user_ids is empty");
  });
});

describe("runNotify text", () => {
  test("fans out --message to every allowed user", async () => {
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
    expect(transport.sent).toEqual([
      { chatId: 42, text: "important thing" },
      { chatId: 99, text: "important thing" },
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
    expect(transport.sent.length).toBe(2); // text fan-out
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
      expect(transport.voiceSent.length).toBe(2); // fanned to both users
      expect(transport.sent.length).toBe(0);
      expect(out.text).toContain("voice=2");
    } finally {
      (globalThis as unknown as { fetch: typeof fetch }).fetch = origFetch;
    }
  });
});
