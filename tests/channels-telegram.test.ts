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
  harnessIdleTimeoutMs: 5_000, harnessHardTimeoutMs: 5_000,
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

    // 1+ typing actions (initial + chunk-driven refresh on text), all
    // for the right chat. Exact count varies with chunk timing — the
    // contract is "the user saw `typing…`," not a precise sequence.
    expect(transport.typing.length).toBeGreaterThanOrEqual(1);
    expect(transport.typing.every((c) => c === 1001)).toBe(true);
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
// Channel-layer system-prompt suffixes:
//   - TELEGRAM_REPLY_INSTRUCTION applies to every Telegram turn
//     (short conversational + plan-then-confirm before long jobs)
//   - VOICE_REPLY_INSTRUCTION stacks on top for voice-in/voice-out
//     (stricter 1-3 sentence limit + no markdown for TTS)
// ---------------------------------------------------------------------------

describe("runTelegramServer system-prompt suffixes", () => {
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

  test("voice-in + voice-out: harness sees BOTH the chat-style and the voice-brevity instructions", async () => {
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
      const prompt = harness.lastRequest?.systemPrompt ?? "";
      // Telegram chat-style suffix is present.
      expect(prompt).toContain("Reply style (Telegram chat)");
      expect(prompt).toContain("Confirm before long jobs");
      // Voice overlay is also present (stacked on top).
      expect(prompt).toContain("Reply length (this turn only)");
      expect(prompt).toContain("text-to-speech");
      expect(prompt).toMatch(/1-3\s+sentences/);
    } finally {
      (globalThis as unknown as { fetch: typeof fetch }).fetch = originalFetch;
    }
  });

  test("text-in + text-out: harness sees ONLY the chat-style instruction (no voice overlay)", async () => {
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
    const prompt = harness.lastRequest?.systemPrompt ?? "";
    // The chat-style instruction is always applied for Telegram turns.
    expect(prompt).toContain("Reply style (Telegram chat)");
    expect(prompt).toContain("Confirm before long jobs");
    // The voice-only overlay must NOT leak into text replies.
    expect(prompt).not.toContain("text-to-speech");
    expect(prompt).not.toContain("Reply length (this turn only)");
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

// ---------------------------------------------------------------------------
// Typing indicator: chunk-driven only (no timers, no random pulses)
// ---------------------------------------------------------------------------

describe("runTelegramServer typing indicator", () => {
  test("initial nudge fires once at turn start", async () => {
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
      oneShot: true,
    });
    // Just the initial sendStatus — the harness emitted no streamable
    // chunks (only `done`).
    expect(transport.typing).toEqual([1001]);
  });

  test("refreshes on text + heartbeat + progress chunks (with throttle disabled)", async () => {
    class StreamingHarness implements Harness {
      readonly id = "streaming";
      async available(): Promise<boolean> {
        return true;
      }
      async *invoke(_req: HarnessRequest): AsyncGenerator<HarnessChunk> {
        yield { type: "heartbeat" };
        await new Promise((r) => setTimeout(r, 10));
        yield { type: "text", text: "hi " };
        await new Promise((r) => setTimeout(r, 10));
        yield { type: "progress", note: "tool: BashTool" };
        await new Promise((r) => setTimeout(r, 10));
        yield { type: "text", text: "there" };
        yield { type: "done", finalText: "hi there", meta: { harnessId: this.id } };
      }
    }
    const transport = new FakeTransport();
    transport.pendingUpdates.push({
      updateId: 1,
      chatId: 1001,
      fromUserId: 42,
      text: "stream me",
    });
    await runTelegramServer({
      config: baseConfig(),
      memory,
      harnesses: [new StreamingHarness()],
      agentDir,
      persona: "phantom",
      transport,
      typingThrottleMs: 0, // disable throttle for this test
      oneShot: true,
    });
    // 1 initial + 4 chunks (heartbeat, text, progress, text). `done`
    // doesn't refresh.
    expect(transport.typing.length).toBeGreaterThanOrEqual(5);
    expect(transport.typing.every((c) => c === 1001)).toBe(true);
  });

  test("throttle: rapid chunks within the window collapse to one sendStatus", async () => {
    class BurstHarness implements Harness {
      readonly id = "burst";
      async available(): Promise<boolean> {
        return true;
      }
      async *invoke(_req: HarnessRequest): AsyncGenerator<HarnessChunk> {
        for (let i = 0; i < 10; i++) {
          yield { type: "heartbeat" };
        }
        yield { type: "done", finalText: "" };
      }
    }
    const transport = new FakeTransport();
    transport.pendingUpdates.push({
      updateId: 1,
      chatId: 1001,
      fromUserId: 42,
      text: "x",
    });
    await runTelegramServer({
      config: baseConfig(),
      memory,
      harnesses: [new BurstHarness()],
      agentDir,
      persona: "phantom",
      transport,
      typingThrottleMs: 5_000,
      oneShot: true,
    });
    // Initial nudge sets lastSendStatusAt; all 10 burst chunks fall
    // inside the 5_000ms window and get throttled out → just the initial.
    expect(transport.typing.length).toBe(1);
  });

  test("no background timer: no sendStatus calls land after the turn completes", async () => {
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
      oneShot: true,
    });
    const baseline = transport.typing.length;
    // Wait well past anything that could plausibly be a stale timer.
    await new Promise((r) => setTimeout(r, 200));
    expect(transport.typing.length).toBe(baseline);
  });
});

// ---------------------------------------------------------------------------
// Slash commands via the polling loop
// ---------------------------------------------------------------------------

describe("runTelegramServer slash commands", () => {
  test("/help is handled by the channel layer (no harness call)", async () => {
    const transport = new FakeTransport();
    transport.pendingUpdates.push({
      updateId: 1,
      chatId: 1001,
      fromUserId: 42,
      text: "/help",
    });
    const harness = new ScriptedHarness("fake", [
      { type: "done", finalText: "should not run" },
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
    expect(harness.invocations).toBe(0);
    expect(transport.sent).toHaveLength(1);
    expect(transport.sent[0]!.text).toContain("/stop");
    expect(transport.sent[0]!.text).toContain("/status");
  });

  test("/reset clears prior history for this chat (and only this chat)", async () => {
    await memory.appendTurn({
      persona: "phantom",
      conversation: "telegram:1001",
      role: "user",
      text: "old",
    });
    await memory.appendTurn({
      persona: "phantom",
      conversation: "telegram:9999",
      role: "user",
      text: "untouched",
    });
    const transport = new FakeTransport();
    transport.pendingUpdates.push({
      updateId: 1,
      chatId: 1001,
      fromUserId: 42,
      text: "/reset",
    });
    const harness = new ScriptedHarness("fake", [
      { type: "done", finalText: "x" },
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
    expect(harness.invocations).toBe(0);
    expect(
      await memory.recentTurns("phantom", "telegram:1001", 10),
    ).toEqual([]);
    expect(
      await memory.recentTurns("phantom", "telegram:9999", 10),
    ).toEqual([{ role: "user", text: "untouched" }]);
    expect(transport.sent[0]!.text).toContain("cleared 1 turn");
  });

  test("/stop aborts an in-flight turn and suppresses the would-be reply", async () => {
    // A harness that yields one text chunk then waits 5s (long enough that
    // the test-level abort is the only way it ever finishes within the
    // bun-test default timeout).
    class AbortableHarness implements Harness {
      readonly id = "abortable";
      lastSignalAborted: boolean | undefined;
      async available(): Promise<boolean> {
        return true;
      }
      async *invoke(req: HarnessRequest): AsyncGenerator<HarnessChunk> {
        yield { type: "text", text: "thinking…" };
        await new Promise<void>((resolve) => {
          if (req.signal?.aborted) return resolve();
          const onAbort = () => {
            this.lastSignalAborted = true;
            resolve();
          };
          req.signal?.addEventListener("abort", onAbort, { once: true });
          setTimeout(resolve, 5000);
        });
        yield {
          type: "error",
          error: "stopped",
          recoverable: false,
        };
      }
    }

    const transport = new FakeTransport();
    transport.pendingUpdates.push({
      updateId: 1,
      chatId: 1001,
      fromUserId: 42,
      text: "kick off something slow",
    });
    // /stop arrives ~30ms later, after the harness is already in-flight.
    setTimeout(() => {
      transport.pendingUpdates.push({
        updateId: 2,
        chatId: 1001,
        fromUserId: 42,
        text: "/stop",
      });
    }, 30);

    const harness = new AbortableHarness();
    const ac = new AbortController();
    // Stop the polling loop after a moment; the turn worker drain in the
    // server's `finally` will wait for the aborted turn to resolve.
    setTimeout(() => ac.abort(), 200);
    await runTelegramServer({
      config: baseConfig(),
      memory,
      harnesses: [harness],
      agentDir,
      persona: "phantom",
      transport,
      signal: ac.signal,
    });

    // The /stop reply lands. The aborted turn does NOT send a follow-up
    // (no "(error: stopped)" leak).
    const stopReplies = transport.sent.filter((s) =>
      s.text.startsWith("stopped"),
    );
    expect(stopReplies.length).toBe(1);
    const errorReplies = transport.sent.filter((s) =>
      s.text.includes("(error:"),
    );
    expect(errorReplies).toEqual([]);
    expect(harness.lastSignalAborted).toBe(true);
    // No turn was persisted (failed turn → no history).
    const stored = await memory.recentTurns("phantom", "telegram:1001", 10);
    expect(stored).toEqual([]);
  });

  test("a second non-slash message interrupts an in-flight turn (no reply for the aborted one)", async () => {
    // First message kicks off a slow harness; ~30ms later a second
    // message arrives. The first turn should be aborted — no reply
    // sent — and the second message's reply should land.
    class InterruptableHarness implements Harness {
      readonly id = "interruptable";
      invocations = 0;
      abortedSignals: boolean[] = [];
      async available(): Promise<boolean> {
        return true;
      }
      async *invoke(req: HarnessRequest): AsyncGenerator<HarnessChunk> {
        const turn = ++this.invocations;
        if (turn === 1) {
          // Slow turn — only ends when aborted.
          yield { type: "text", text: "thinking…" };
          await new Promise<void>((resolve) => {
            if (req.signal?.aborted) return resolve();
            req.signal?.addEventListener(
              "abort",
              () => {
                this.abortedSignals.push(true);
                resolve();
              },
              { once: true },
            );
            setTimeout(resolve, 5_000);
          });
          yield { type: "error", error: "stopped", recoverable: false };
          return;
        }
        // Second turn — a fresh, fast reply.
        yield { type: "text", text: "second reply" };
        yield { type: "done", finalText: "second reply" };
      }
    }

    const transport = new FakeTransport();
    transport.pendingUpdates.push({
      updateId: 1,
      chatId: 1001,
      fromUserId: 42,
      text: "kick off something slow",
    });
    setTimeout(() => {
      transport.pendingUpdates.push({
        updateId: 2,
        chatId: 1001,
        fromUserId: 42,
        text: "actually do this instead",
      });
    }, 30);

    const harness = new InterruptableHarness();
    const ac = new AbortController();
    setTimeout(() => ac.abort(), 300);
    await runTelegramServer({
      config: baseConfig(),
      memory,
      harnesses: [harness],
      agentDir,
      persona: "phantom",
      transport,
      signal: ac.signal,
    });

    // First turn was aborted (signal fired).
    expect(harness.abortedSignals).toEqual([true]);
    // Second turn ran.
    expect(harness.invocations).toBe(2);
    // Exactly one user-visible reply: the second turn's.
    const userReplies = transport.sent.filter(
      (s) => !s.text.startsWith("/"),
    );
    expect(userReplies.length).toBe(1);
    expect(userReplies[0]!.text).toBe("second reply");
    // No "(error:" leak from the aborted first turn.
    const errorReplies = transport.sent.filter((s) =>
      s.text.includes("(error:"),
    );
    expect(errorReplies).toEqual([]);
    // Only the second turn was persisted (aborted first turn never reached
    // the on-success persist branch, so its user message isn't in history).
    const stored = await memory.recentTurns("phantom", "telegram:1001", 10);
    expect(stored.map((t) => t.text)).toEqual([
      "actually do this instead",
      "second reply",
    ]);
  });

  test("/status reports the current primary harness", async () => {
    const transport = new FakeTransport();
    transport.pendingUpdates.push({
      updateId: 1,
      chatId: 1001,
      fromUserId: 42,
      text: "/status",
    });
    const claude = new ScriptedHarness("claude", []);
    const pi = new ScriptedHarness("pi", []);
    await runTelegramServer({
      config: baseConfig(),
      memory,
      harnesses: [claude, pi],
      agentDir,
      persona: "phantom",
      transport,
      oneShot: true,
    });
    expect(transport.sent).toHaveLength(1);
    expect(transport.sent[0]!.text).toContain("harness: claude");
    expect(transport.sent[0]!.text).toContain("claude → pi");
  });

  test("/harness <id> switches the primary so the next turn uses it", async () => {
    const claude = new ScriptedHarness("claude", [
      { type: "done", finalText: "from claude" },
    ]);
    const pi = new ScriptedHarness("pi", [
      { type: "done", finalText: "from pi" },
    ]);
    const transport = new FakeTransport();
    transport.pendingUpdates.push(
      { updateId: 1, chatId: 1001, fromUserId: 42, text: "/harness pi" },
      { updateId: 2, chatId: 1001, fromUserId: 42, text: "hi" },
    );
    await runTelegramServer({
      config: baseConfig(),
      memory,
      harnesses: [claude, pi],
      agentDir,
      persona: "phantom",
      transport,
      oneShot: true,
    });
    // After the switch, the second message hits pi, not claude.
    expect(pi.invocations).toBe(1);
    expect(claude.invocations).toBe(0);
    const userReply = transport.sent.find((s) => s.text === "from pi");
    expect(userReply).toBeDefined();
  });

  test("unknown /commands fall through to the LLM (so personas can own /remember etc.)", async () => {
    const transport = new FakeTransport();
    transport.pendingUpdates.push({
      updateId: 1,
      chatId: 1001,
      fromUserId: 42,
      text: "/remember the milk",
    });
    const harness = new ScriptedHarness("fake", [
      { type: "done", finalText: "noted" },
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
    expect(harness.invocations).toBe(1);
    expect(harness.lastRequest?.userMessage).toBe("/remember the milk");
    expect(transport.sent).toEqual([{ chatId: 1001, text: "noted" }]);
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
