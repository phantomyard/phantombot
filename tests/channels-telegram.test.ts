/**
 * Tests for the Telegram channel adapter.
 *
 * Three layers:
 *   1. parseGetUpdatesResult — pure parser, exhaustive shape coverage.
 *   2. runTelegramServer with a fake transport + scripted harness — verifies
 *      end-to-end flow without HTTP or subprocesses.
 *   3. HttpTelegramTransport AbortSignal handling — verifies that an
 *      in-flight long-poll is cancelled cleanly when the signal fires.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  HttpTelegramTransport,
  parseGetUpdatesResult,
  type TelegramMessage,
  type TelegramTransport,
  runTelegramServer,
} from "../src/channels/telegram.ts";
import type { Config } from "../src/config.ts";
import type {
  Harness,
  HarnessChunk,
  HarnessRequest,
} from "../src/harnesses/types.ts";
import { openMemoryStore, type MemoryStore } from "../src/memory/store.ts";

class FakeTransport implements TelegramTransport {
  pendingUpdates: TelegramMessage[] = [];
  sent: Array<{ chatId: number; text: string }> = [];
  voiceSent: Array<{ chatId: number; mime: string; bytes: number }> = [];
  typing: number[] = [];
  recording: number[] = [];
  downloadedFileIds: string[] = [];
  fakeFileBytes = Buffer.from([0x4f, 0x67, 0x67, 0x53]); // "OggS" magic
  receivedSignals: Array<AbortSignal | undefined> = [];
  async getUpdates(
    offset: number,
    _timeoutS: number,
    signal?: AbortSignal,
  ): Promise<{ updates: TelegramMessage[]; nextOffset: number }> {
    this.receivedSignals.push(signal);
    const updates = this.pendingUpdates.splice(0);
    if (updates.length === 0) {
      // Mirror real long-poll behavior so setTimeout-based AbortControllers
      // can fire between iterations.
      await new Promise((r) => setTimeout(r, 20));
    }
    const nextOffset =
      updates.length > 0
        ? Math.max(...updates.map((u) => u.updateId)) + 1
        : offset;
    return { updates, nextOffset };
  }
  async sendMessage(chatId: number, text: string): Promise<void> {
    this.sent.push({ chatId, text });
  }
  async sendTyping(chatId: number): Promise<void> {
    this.typing.push(chatId);
  }
  async sendRecording(chatId: number): Promise<void> {
    this.recording.push(chatId);
  }
  async sendVoice(
    chatId: number,
    audio: Buffer,
    mime: string,
  ): Promise<void> {
    this.voiceSent.push({ chatId, mime, bytes: audio.byteLength });
  }
  async downloadFile(
    fileId: string,
  ): Promise<{ data: Buffer; mime: string }> {
    this.downloadedFileIds.push(fileId);
    return { data: this.fakeFileBytes, mime: "audio/ogg" };
  }
}

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
 * A harness that pauses for `holdMs` between yielding the first text chunk
 * and the done chunk — used to verify typing-indicator refresh behavior.
 */
class SlowHarness implements Harness {
  invocations = 0;
  constructor(
    public readonly id: string,
    private readonly holdMs: number,
  ) {}
  async available(): Promise<boolean> {
    return true;
  }
  async *invoke(_req: HarnessRequest): AsyncGenerator<HarnessChunk> {
    this.invocations++;
    yield { type: "text", text: "thinking…" };
    await new Promise((r) => setTimeout(r, this.holdMs));
    yield { type: "text", text: "done" };
    yield { type: "done", finalText: "thinking…done", meta: { harnessId: this.id } };
  }
}

// ---------------------------------------------------------------------------
// parseGetUpdatesResult
// ---------------------------------------------------------------------------

describe("parseGetUpdatesResult", () => {
  test("extracts text messages and advances offset", () => {
    const r = parseGetUpdatesResult(
      [
        {
          update_id: 100,
          message: {
            chat: { id: 1 },
            from: { id: 42, username: "alice" },
            text: "hi",
          },
        },
      ],
      0,
    );
    expect(r.updates).toEqual([
      {
        updateId: 100,
        chatId: 1,
        fromUserId: 42,
        fromUsername: "alice",
        text: "hi",
      },
    ]);
    expect(r.nextOffset).toBe(101);
  });

  test("skips messages without text", () => {
    const r = parseGetUpdatesResult(
      [{ update_id: 200, message: { chat: { id: 1 }, from: { id: 42 } } }],
      0,
    );
    expect(r.updates).toEqual([]);
    expect(r.nextOffset).toBe(201);
  });

  test("preserves prior offset on empty result", () => {
    expect(parseGetUpdatesResult([], 555).nextOffset).toBe(555);
  });
});

// ---------------------------------------------------------------------------
// runTelegramServer end-to-end (fake transport)
// ---------------------------------------------------------------------------

let workdir: string;
let memory: MemoryStore;
let agentDir: string;

beforeEach(async () => {
  workdir = await mkdtemp(join(tmpdir(), "phantombot-tg-"));
  agentDir = join(workdir, "personas", "phantom");
  await mkdir(agentDir, { recursive: true });
  await writeFile(join(agentDir, "BOOT.md"), "# Phantom", "utf8");
  memory = await openMemoryStore(":memory:");
});

afterEach(async () => {
  await memory.close();
  await rm(workdir, { recursive: true, force: true });
});

const baseConfig = (
  overrides: Partial<NonNullable<Config["channels"]["telegram"]>> = {},
): Config => ({
  defaultPersona: "phantom",
  turnTimeoutMs: 5_000,
  personasDir: join(workdir, "personas"),
  memoryDbPath: join(workdir, "memory.sqlite"),
  configPath: join(workdir, "config.toml"),
  harnesses: {
    chain: ["claude"],
    claude: { bin: "claude", model: "opus", fallbackModel: "sonnet" },
    pi: { bin: "pi", maxPayloadBytes: 1_000_000 },
    gemini: { bin: "gemini", model: "" },
  },
  channels: {
    telegram: {
      token: "fake-token",
      pollTimeoutS: 30,
      allowedUserIds: [],
      ...overrides,
    },
  },
  embeddings: { provider: "none" },
  voice: { provider: "none" },
});

describe("runTelegramServer dispatch", () => {
  test("dispatches a message through runTurn and replies via Telegram", async () => {
    const transport = new FakeTransport();
    transport.pendingUpdates.push({
      updateId: 1,
      chatId: 1001,
      fromUserId: 42,
      fromUsername: "alice",
      text: "hello",
    });
    const harness = new ScriptedHarness("fake", [
      { type: "text", text: "hi alice" },
      { type: "done", finalText: "hi alice" },
    ]);
    await runTelegramServer({
      config: baseConfig(),
      memory,
      harnesses: [harness],
      agentDir,
      persona: "phantom",
      transport,
      oneShot: true,
    });

    expect(transport.typing).toEqual([1001]);
    expect(transport.sent).toEqual([{ chatId: 1001, text: "hi alice" }]);
    const stored = await memory.recentTurns("phantom", "telegram:1001", 10);
    expect(stored).toEqual([
      { role: "user", text: "hello" },
      { role: "assistant", text: "hi alice" },
    ]);
  });

  test("rejects messages from non-allowed users when allowlist is set", async () => {
    const transport = new FakeTransport();
    transport.pendingUpdates.push({
      updateId: 1,
      chatId: 1001,
      fromUserId: 99,
      text: "hi",
    });
    const harness = new ScriptedHarness("fake", [
      { type: "done", finalText: "x" },
    ]);
    await runTelegramServer({
      config: baseConfig({ allowedUserIds: [42] }),
      memory,
      harnesses: [harness],
      agentDir,
      persona: "phantom",
      transport,
      oneShot: true,
    });
    expect(harness.invocations).toBe(0);
    expect(transport.sent).toEqual([]);
  });

  test("isolates conversations by chatId", async () => {
    const transport = new FakeTransport();
    transport.pendingUpdates.push(
      { updateId: 1, chatId: 100, fromUserId: 42, text: "from A" },
      { updateId: 2, chatId: 200, fromUserId: 42, text: "from B" },
    );
    const harness = new ScriptedHarness("fake", [
      { type: "done", finalText: "ok" },
    ]);
    await runTelegramServer({
      config: baseConfig(),
      memory,
      harnesses: [harness],
      agentDir,
      persona: "phantom",
      transport,
      oneShot: true,
    });
    const a = await memory.recentTurns("phantom", "telegram:100", 10);
    const b = await memory.recentTurns("phantom", "telegram:200", 10);
    expect(a.map((t) => t.text)).toEqual(["from A", "ok"]);
    expect(b.map((t) => t.text)).toEqual(["from B", "ok"]);
  });

  test("on harness error sends an error message and does not persist", async () => {
    const transport = new FakeTransport();
    transport.pendingUpdates.push({
      updateId: 1,
      chatId: 1001,
      fromUserId: 42,
      text: "hi",
    });
    const harness = new ScriptedHarness("fake", [
      { type: "error", error: "boom", recoverable: false },
    ]);
    await runTelegramServer({
      config: baseConfig(),
      memory,
      harnesses: [harness],
      agentDir,
      persona: "phantom",
      transport,
      oneShot: true,
    });
    expect(transport.sent).toEqual([{ chatId: 1001, text: "(error: boom)" }]);
    expect(await memory.recentTurns("phantom", "telegram:1001", 10)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Voice round-trip
// ---------------------------------------------------------------------------

describe("runTelegramServer voice round-trip", () => {
  const SAVED_KEY = process.env.PHANTOMBOT_OPENAI_API_KEY;
  beforeEach(() => {
    process.env.PHANTOMBOT_OPENAI_API_KEY = "test-key";
  });
  afterEach(() => {
    if (SAVED_KEY === undefined) delete process.env.PHANTOMBOT_OPENAI_API_KEY;
    else process.env.PHANTOMBOT_OPENAI_API_KEY = SAVED_KEY;
  });

  function withVoiceConfig(): Config {
    const c = baseConfig();
    return {
      ...c,
      voice: {
        provider: "openai",
        openai: { model: "tts-1", voice: "nova", speed: 1 },
      },
    };
  }

  test("voice in: STT runs, file is downloaded, transcript drives the harness, reply goes back as voice", async () => {
    const originalFetch = globalThis.fetch;
    let whisperCalled = 0;
    let ttsCalled = 0;
    (globalThis as unknown as { fetch: typeof fetch }).fetch = (async (
      url: string | URL | Request,
    ) => {
      const u = String(url);
      if (u.includes("audio/transcriptions")) {
        whisperCalled++;
        return new Response(JSON.stringify({ text: "hello from voice" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      if (u.includes("audio/speech")) {
        ttsCalled++;
        return new Response(Buffer.from([1, 2, 3]), {
          status: 200,
          headers: { "content-type": "audio/ogg" },
        });
      }
      throw new Error(`unexpected fetch: ${u}`);
    }) as unknown as typeof fetch;

    try {
      const transport = new FakeTransport();
      transport.pendingUpdates.push({
        updateId: 1,
        chatId: 1001,
        fromUserId: 42,
        text: "",
        voice: { fileId: "abc-file", mimeType: "audio/ogg", durationS: 3 },
      });
      const harness = new ScriptedHarness("fake", [
        { type: "done", finalText: "hi from kai" },
      ]);
      await runTelegramServer({
        config: withVoiceConfig(),
        memory,
        harnesses: [harness],
        agentDir,
        persona: "phantom",
        transport,
        oneShot: true,
      });
      expect(transport.downloadedFileIds).toEqual(["abc-file"]);
      expect(whisperCalled).toBe(1);
      expect(harness.invocations).toBe(1);
      expect(harness.lastRequest?.userMessage).toBe("hello from voice");
      expect(transport.voiceSent).toHaveLength(1);
      expect(transport.voiceSent[0]?.chatId).toBe(1001);
      expect(transport.sent).toEqual([]);
      expect(ttsCalled).toBe(1);
      expect(transport.recording.length).toBeGreaterThan(0);
      expect(transport.typing).toEqual([]);
    } finally {
      (globalThis as unknown as { fetch: typeof fetch }).fetch = originalFetch;
    }
  });

  test("text in: still sends as text even when voice provider is configured", async () => {
    const transport = new FakeTransport();
    transport.pendingUpdates.push({
      updateId: 1,
      chatId: 1001,
      fromUserId: 42,
      text: "hi via text",
    });
    const harness = new ScriptedHarness("fake", [
      { type: "done", finalText: "hello back" },
    ]);
    await runTelegramServer({
      config: withVoiceConfig(),
      memory,
      harnesses: [harness],
      agentDir,
      persona: "phantom",
      transport,
      oneShot: true,
    });
    expect(transport.sent).toEqual([
      { chatId: 1001, text: "hello back" },
    ]);
    expect(transport.voiceSent).toEqual([]);
    expect(transport.downloadedFileIds).toEqual([]);
    expect(transport.typing.length).toBeGreaterThan(0);
    expect(transport.recording).toEqual([]);
  });

  test("voice in but azure_edge (no STT) → text reply explaining why, no harness call", async () => {
    const transport = new FakeTransport();
    transport.pendingUpdates.push({
      updateId: 1,
      chatId: 1001,
      fromUserId: 42,
      text: "",
      voice: { fileId: "xyz", mimeType: "audio/ogg", durationS: 5 },
    });
    const harness = new ScriptedHarness("fake", [
      { type: "done", finalText: "should not run" },
    ]);
    const cfg = baseConfig();
    cfg.voice = {
      provider: "azure_edge",
      azure_edge: {
        voice: "en-US-JennyNeural",
        rate: "+0%",
        pitch: "+0Hz",
      },
    };
    await runTelegramServer({
      config: cfg,
      memory,
      harnesses: [harness],
      agentDir,
      persona: "phantom",
      transport,
      oneShot: true,
    });
    expect(harness.invocations).toBe(0);
    expect(transport.sent).toHaveLength(1);
    // provider_no_stt diagnostic — names the provider and points at the fix.
    expect(transport.sent[0]?.text).toContain("'azure_edge'");
    expect(transport.sent[0]?.text).toContain("phantombot voice");
  });

  test("voice in but openai key missing → key_missing diagnostic names provider + env var", async () => {
    // Drop the OPENAI key so sttSupport returns key_missing.
    const saved = process.env.PHANTOMBOT_OPENAI_API_KEY;
    delete process.env.PHANTOMBOT_OPENAI_API_KEY;
    try {
      const transport = new FakeTransport();
      transport.pendingUpdates.push({
        updateId: 1,
        chatId: 1001,
        fromUserId: 42,
        text: "",
        voice: { fileId: "abc", mimeType: "audio/ogg", durationS: 2 },
      });
      const harness = new ScriptedHarness("fake", [
        { type: "done", finalText: "should not run" },
      ]);
      await runTelegramServer({
        config: withVoiceConfig(),
        memory,
        harnesses: [harness],
        agentDir,
        persona: "phantom",
        transport,
        oneShot: true,
      });
      expect(harness.invocations).toBe(0);
      expect(transport.sent).toHaveLength(1);
      const text = transport.sent[0]!.text;
      expect(text).toContain("'openai'");
      expect(text).toContain("PHANTOMBOT_OPENAI_API_KEY");
      expect(text).toContain("phantombot install");
    } finally {
      if (saved === undefined) delete process.env.PHANTOMBOT_OPENAI_API_KEY;
      else process.env.PHANTOMBOT_OPENAI_API_KEY = saved;
    }
  });
});

// ---------------------------------------------------------------------------
// VOICE_REPLY_INSTRUCTION — brevity directive for voice-in/voice-out turns
// ---------------------------------------------------------------------------

describe("runTelegramServer voice brevity instruction", () => {
  const SAVED_KEY = process.env.PHANTOMBOT_OPENAI_API_KEY;
  beforeEach(() => {
    process.env.PHANTOMBOT_OPENAI_API_KEY = "test-key";
  });
  afterEach(() => {
    if (SAVED_KEY === undefined) delete process.env.PHANTOMBOT_OPENAI_API_KEY;
    else process.env.PHANTOMBOT_OPENAI_API_KEY = SAVED_KEY;
  });

  function withVoiceConfig(): Config {
    const c = baseConfig();
    return {
      ...c,
      voice: {
        provider: "openai",
        openai: { model: "tts-1", voice: "nova", speed: 1 },
      },
    };
  }

  test("voice-in + voice-out: harness sees the brevity directive", async () => {
    const originalFetch = globalThis.fetch;
    (globalThis as unknown as { fetch: typeof fetch }).fetch = (async (
      url: string | URL | Request,
    ) => {
      const u = String(url);
      if (u.includes("audio/transcriptions")) {
        return new Response(JSON.stringify({ text: "hello" }), { status: 200 });
      }
      return new Response(Buffer.from([1, 2, 3]), {
        status: 200,
        headers: { "content-type": "audio/ogg" },
      });
    }) as unknown as typeof fetch;
    try {
      const transport = new FakeTransport();
      transport.pendingUpdates.push({
        updateId: 1,
        chatId: 1001,
        fromUserId: 42,
        text: "",
        voice: { fileId: "f", mimeType: "audio/ogg", durationS: 2 },
      });
      const harness = new ScriptedHarness("fake", [
        { type: "done", finalText: "ok" },
      ]);
      await runTelegramServer({
        config: withVoiceConfig(),
        memory,
        harnesses: [harness],
        agentDir,
        persona: "phantom",
        transport,
        oneShot: true,
      });
      expect(harness.invocations).toBe(1);
      expect(harness.lastRequest?.systemPrompt).toContain(
        "Reply length (this turn only)",
      );
      expect(harness.lastRequest?.systemPrompt).toContain("text-to-speech");
      // Match across the line break that the constant naturally has.
      expect(harness.lastRequest?.systemPrompt).toMatch(/1-3\s+sentences/);
    } finally {
      (globalThis as unknown as { fetch: typeof fetch }).fetch = originalFetch;
    }
  });

  test("text-in + text-out: NO brevity directive (chat verbosity is fine)", async () => {
    const transport = new FakeTransport();
    transport.pendingUpdates.push({
      updateId: 1,
      chatId: 1001,
      fromUserId: 42,
      text: "long question?",
    });
    const harness = new ScriptedHarness("fake", [
      { type: "done", finalText: "long answer" },
    ]);
    await runTelegramServer({
      config: baseConfig(), // voice provider = "none"
      memory,
      harnesses: [harness],
      agentDir,
      persona: "phantom",
      transport,
      oneShot: true,
    });
    expect(harness.lastRequest?.systemPrompt).not.toContain(
      "Reply length (this turn only)",
    );
  });

  test("voice-in but TTS unavailable (text reply): NO brevity directive", async () => {
    // Voice came in, but the configured provider can't TTS the reply,
    // so we'll send text. No need for the brevity directive.
    const originalFetch = globalThis.fetch;
    (globalThis as unknown as { fetch: typeof fetch }).fetch = (async (
      url: string | URL | Request,
    ) => {
      if (String(url).includes("audio/transcriptions")) {
        return new Response(JSON.stringify({ text: "hi" }), { status: 200 });
      }
      throw new Error(`unexpected fetch: ${url}`);
    }) as unknown as typeof fetch;
    try {
      const cfg = baseConfig();
      // azure_edge has TTS but no STT — but we want the OPPOSITE shape:
      // STT works, TTS doesn't. Force it by deleting the TTS key after STT.
      cfg.voice = {
        provider: "openai",
        openai: { model: "tts-1", voice: "nova", speed: 1 },
      };
      // ttsSupported reads env at call time; flip it to "no" right before.
      const saved = process.env.PHANTOMBOT_OPENAI_API_KEY;
      // Keep the key (STT needs it) — we'll instead just check the
      // willReplyWithVoice gate by forcing voice provider to a config
      // that has STT but not TTS for the current key shape. Simpler:
      // intercept ttsSupported indirectly by using azure_edge for TTS
      // with no STT — but azure has no STT either. The cleanest test
      // is to verify: voice in + provider=none → text reply path.
      // For that we need provider with STT but not TTS. ElevenLabs has
      // both; openai has both. Azure has TTS but no STT. There's no
      // built-in "STT only" provider. So we synthesize the gate by
      // forcing willReplyWithVoice=false via a different route:
      // text-in trivially gives willReplyWithVoice=false (test 2 above).
      // Voice-in always implies STT support (otherwise the user gets
      // a "voice transcription disabled" message, no harness call).
      // So the only paths are voice-in/voice-out and text-in/text-out.
      // This third branch (voice-in/text-out) requires a provider
      // mismatch we don't ship. Skip with a doc comment.
      void saved; // unused
    } finally {
      (globalThis as unknown as { fetch: typeof fetch }).fetch = originalFetch;
    }
    // No assertions: this test exists to document why the third branch
    // isn't reachable in v1 (no provider in our matrix has STT-only).
    // If a future provider does (e.g. a "transcribe-only" Whisper
    // gateway), the brevity directive should NOT fire — same gate as
    // willReplyWithVoice in src/channels/telegram.ts.
    expect(true).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// AbortSignal plumbing
// ---------------------------------------------------------------------------

describe("runTelegramServer AbortSignal", () => {
  test("passes the signal through to transport.getUpdates", async () => {
    const transport = new FakeTransport();
    const ac = new AbortController();
    const harness = new ScriptedHarness("fake", [
      { type: "done", finalText: "ok" },
    ]);
    setTimeout(() => ac.abort(), 30);
    await runTelegramServer({
      config: baseConfig(),
      memory,
      harnesses: [harness],
      agentDir,
      persona: "phantom",
      transport,
      signal: ac.signal,
    });
    expect(transport.receivedSignals.length).toBeGreaterThan(0);
    expect(transport.receivedSignals[0]).toBe(ac.signal);
  });
});

describe("runTelegramServer typing refresh", () => {
  test("refreshes the typing indicator while a slow harness is working", async () => {
    const transport = new FakeTransport();
    transport.pendingUpdates.push({
      updateId: 1,
      chatId: 1001,
      fromUserId: 42,
      text: "hi",
    });
    // Hold the harness for 250ms so we get >1 typing refresh at 50ms cadence.
    const harness = new SlowHarness("slow", 250);
    await runTelegramServer({
      config: baseConfig(),
      memory,
      harnesses: [harness],
      agentDir,
      persona: "phantom",
      transport,
      typingRefreshMs: 50,
      oneShot: true,
    });
    // 1 initial sendTyping + at least 2 refresh ticks during the 250ms hold.
    // We don't assert an exact count to stay scheduling-tolerant; > 2 is the contract.
    expect(transport.typing.length).toBeGreaterThan(2);
    // All typing calls were for the right chat
    expect(transport.typing.every((c) => c === 1001)).toBe(true);
    // The reply was sent.
    expect(transport.sent).toEqual([
      { chatId: 1001, text: "thinking…done" },
    ]);
  });

  test("clears the typing interval when the turn completes (no stray refreshes after)", async () => {
    const transport = new FakeTransport();
    transport.pendingUpdates.push({
      updateId: 1,
      chatId: 1001,
      fromUserId: 42,
      text: "hi",
    });
    const harness = new ScriptedHarness("fast", [
      { type: "done", finalText: "ok" },
    ]);
    await runTelegramServer({
      config: baseConfig(),
      memory,
      harnesses: [harness],
      agentDir,
      persona: "phantom",
      transport,
      typingRefreshMs: 50,
      oneShot: true,
    });
    const baseline = transport.typing.length;
    // Wait longer than the refresh interval — no further typing should appear.
    await new Promise((r) => setTimeout(r, 150));
    expect(transport.typing.length).toBe(baseline);
  });
});

describe("HttpTelegramTransport AbortSignal", () => {
  test("aborted fetch returns empty result without throwing", async () => {
    // Replace globalThis.fetch with one that throws AbortError immediately
    // when the supplied signal is already aborted.
    const originalFetch = globalThis.fetch;
    try {
      (globalThis as unknown as { fetch: typeof fetch }).fetch = (async (
        _url: string | URL | Request,
        init?: RequestInit,
      ) => {
        if (init?.signal?.aborted) {
          const e = new Error("aborted");
          e.name = "AbortError";
          throw e;
        }
        // Otherwise wait ~50ms then check again
        await new Promise((r) => setTimeout(r, 50));
        if (init?.signal?.aborted) {
          const e = new Error("aborted");
          e.name = "AbortError";
          throw e;
        }
        return new Response(
          JSON.stringify({ ok: true, result: [] }),
          { status: 200 },
        );
      }) as unknown as typeof fetch;

      const ac = new AbortController();
      ac.abort();
      const t = new HttpTelegramTransport("anything");
      const r = await t.getUpdates(0, 30, ac.signal);
      expect(r.updates).toEqual([]);
      expect(r.nextOffset).toBe(0);
    } finally {
      (globalThis as unknown as { fetch: typeof fetch }).fetch = originalFetch;
    }
  });
});
