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
  extensionFromMime,
  extractAttachment,
  formatAttachmentUserText,
  inboxDir,
  parseGetUpdatesResult,
  type TelegramAttachment,
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
import type { ServiceControl } from "../src/lib/systemd.ts";
import { openMemoryStore, type MemoryStore } from "../src/memory/store.ts";

class FakeTransport implements TelegramTransport {
  pendingUpdates: TelegramMessage[] = [];
  sent: Array<{ chatId: number; text: string }> = [];
  voiceSent: Array<{ chatId: number; mime: string; bytes: number }> = [];
  typing: number[] = [];
  recording: number[] = [];
  downloadedFileIds: string[] = [];
  fakeFileBytes = Buffer.from([0x4f, 0x67, 0x67, 0x53]); // "OggS" magic
  /** Per-fileId override for `downloadFile`. */
  fileResponses: Map<string, { data: Buffer; mime: string } | Error> = new Map();
  receivedSignals: Array<AbortSignal | undefined> = [];
  /**
   * Offsets passed to `ackUpdates`, in order. Tests assert on this to
   * verify /restart and /update ack the heads-up message offset to
   * Telegram before firing the destructive callback.
   */
  ackedOffsets: number[] = [];
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
  async ackUpdates(offset: number): Promise<void> {
    this.ackedOffsets.push(offset);
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
    const override = this.fileResponses.get(fileId);
    if (override instanceof Error) throw override;
    if (override) return override;
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

  test("extracts a document attachment with caption", () => {
    const r = parseGetUpdatesResult(
      [
        {
          update_id: 300,
          message: {
            message_id: 77,
            chat: { id: 1 },
            from: { id: 42 },
            caption: "look at this",
            document: {
              file_id: "doc-abc",
              file_name: "report.pdf",
              file_size: 12345,
              mime_type: "application/pdf",
            },
          },
        },
      ],
      0,
    );
    expect(r.updates).toHaveLength(1);
    expect(r.updates[0]).toMatchObject({
      updateId: 300,
      chatId: 1,
      fromUserId: 42,
      text: "",
      caption: "look at this",
      attachment: {
        kind: "document",
        fileId: "doc-abc",
        fileName: "report.pdf",
        fileSize: 12345,
        mimeType: "application/pdf",
      },
    });
  });

  test("extracts a photo and picks the largest size", () => {
    const r = parseGetUpdatesResult(
      [
        {
          update_id: 301,
          message: {
            message_id: 88,
            chat: { id: 1 },
            from: { id: 42 },
            photo: [
              { file_id: "small", file_size: 100, width: 90, height: 67 },
              { file_id: "medium", file_size: 8_000, width: 320, height: 240 },
              { file_id: "large", file_size: 50_000, width: 800, height: 600 },
            ],
          },
        },
      ],
      0,
    );
    expect(r.updates[0]?.attachment).toMatchObject({
      kind: "photo",
      fileId: "large",
      fileName: "88-photo.jpg",
      fileSize: 50_000,
      mimeType: "image/jpeg",
    });
  });

  test("attachment takes priority over plain text (text becomes caption)", () => {
    // Defensive: Telegram normally uses `caption` for media, not `text`,
    // but if we ever see both, the attachment is the main thing.
    const r = parseGetUpdatesResult(
      [
        {
          update_id: 302,
          message: {
            message_id: 91,
            chat: { id: 1 },
            from: { id: 42 },
            text: "fallback caption from text field",
            document: {
              file_id: "doc-x",
              file_name: "x.txt",
              mime_type: "text/plain",
            },
          },
        },
      ],
      0,
    );
    expect(r.updates[0]?.caption).toBe("fallback caption from text field");
    expect(r.updates[0]?.attachment?.fileId).toBe("doc-x");
  });

  test("voice still routes through the voice path, not attachment", () => {
    const r = parseGetUpdatesResult(
      [
        {
          update_id: 303,
          message: {
            chat: { id: 1 },
            from: { id: 42 },
            voice: { file_id: "voice-1", duration: 3, mime_type: "audio/ogg" },
          },
        },
      ],
      0,
    );
    expect(r.updates[0]?.voice?.fileId).toBe("voice-1");
    expect(r.updates[0]?.attachment).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// extractAttachment / extensionFromMime / formatAttachmentUserText
// ---------------------------------------------------------------------------

describe("extensionFromMime", () => {
  test("known images and docs", () => {
    expect(extensionFromMime("image/png")).toBe(".png");
    expect(extensionFromMime("application/pdf")).toBe(".pdf");
    expect(extensionFromMime("text/markdown")).toBe(".md");
    expect(extensionFromMime("audio/mpeg")).toBe(".mp3");
  });

  test("ignores parameters after the semicolon", () => {
    expect(extensionFromMime("text/plain; charset=utf-8")).toBe(".txt");
  });

  test("unknown mime falls back to alphanumeric subtype slice", () => {
    expect(extensionFromMime("application/x-custom-type")).toBe(".xcustomt");
  });

  test("missing or empty mime → .bin", () => {
    expect(extensionFromMime(undefined)).toBe(".bin");
    expect(extensionFromMime("")).toBe(".bin");
  });
});

describe("extractAttachment", () => {
  test("synthesizes filename when document has none", () => {
    const att = extractAttachment({
      message_id: 5,
      chat: { id: 1 },
      from: { id: 42 },
      document: { file_id: "d1", mime_type: "image/png" },
    });
    expect(att?.fileName).toBe("5-document.png");
  });

  test("returns undefined for plain-text-only messages", () => {
    expect(
      extractAttachment({ chat: { id: 1 }, from: { id: 42 }, text: "hi" }),
    ).toBeUndefined();
  });
});

describe("formatAttachmentUserText", () => {
  const att: TelegramAttachment = {
    fileId: "f1",
    fileName: "report.pdf",
    fileSize: 1024,
    mimeType: "application/pdf",
    kind: "document",
  };

  test("caption + saved path", () => {
    expect(
      formatAttachmentUserText({
        caption: "have a look",
        attachment: att,
        savedPath: "/inbox/1/55-report.pdf",
      }),
    ).toBe("have a look\n\n[attached: /inbox/1/55-report.pdf]");
  });

  test("no caption + saved path", () => {
    expect(
      formatAttachmentUserText({
        caption: undefined,
        attachment: att,
        savedPath: "/inbox/1/55-report.pdf",
      }),
    ).toBe("[attached: /inbox/1/55-report.pdf]");
  });

  test("oversize file surfaces the cap and the size", () => {
    const text = formatAttachmentUserText({
      caption: "big file",
      attachment: att,
      oversizeBytes: 50 * 1024 * 1024,
    });
    expect(text).toContain("big file");
    expect(text).toContain("[attached but too large to fetch: report.pdf");
    expect(text).toContain("50.0 MB > 20 MB");
  });

  test("download error surfaces the error message", () => {
    expect(
      formatAttachmentUserText({
        caption: undefined,
        attachment: att,
        downloadError: "ECONNRESET",
      }),
    ).toBe("[attached but couldn't download: report.pdf (ECONNRESET)]");
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

describe("runTelegramServer attachment dispatch", () => {
  let savedXdgDataHome: string | undefined;

  beforeEach(() => {
    // Isolate the inbox dir into the per-test workdir so tests don't
    // pollute the real ~/.local/share/phantombot/inbox/.
    savedXdgDataHome = process.env.XDG_DATA_HOME;
    process.env.XDG_DATA_HOME = workdir;
  });

  afterEach(() => {
    if (savedXdgDataHome === undefined) delete process.env.XDG_DATA_HOME;
    else process.env.XDG_DATA_HOME = savedXdgDataHome;
  });

  test("downloads document, saves to inbox, harness sees [attached: <path>]", async () => {
    const transport = new FakeTransport();
    transport.fileResponses.set("doc-abc", {
      data: Buffer.from("hello-pdf-bytes"),
      mime: "application/pdf",
    });
    transport.pendingUpdates.push({
      updateId: 555,
      chatId: 1001,
      fromUserId: 42,
      text: "",
      caption: "look at this report",
      attachment: {
        fileId: "doc-abc",
        fileName: "report.pdf",
        fileSize: 15,
        mimeType: "application/pdf",
        kind: "document",
      },
    });
    const harness = new ScriptedHarness("fake", [
      { type: "done", finalText: "got it" },
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

    expect(transport.downloadedFileIds).toEqual(["doc-abc"]);
    const expectedPath = join(
      inboxDir(1001),
      "555-report.pdf",
    );
    const onDisk = await import("node:fs/promises").then((m) =>
      m.readFile(expectedPath, "utf8"),
    );
    expect(onDisk).toBe("hello-pdf-bytes");
    expect(harness.lastRequest?.userMessage).toBe(
      `look at this report\n\n[attached: ${expectedPath}]`,
    );
    expect(transport.sent.map((s) => s.text)).toEqual(["got it"]);
  });

  test("oversize attachment skips download and surfaces the cap to the harness", async () => {
    const transport = new FakeTransport();
    transport.pendingUpdates.push({
      updateId: 556,
      chatId: 1001,
      fromUserId: 42,
      text: "",
      caption: "big one",
      attachment: {
        fileId: "huge",
        fileName: "huge.zip",
        fileSize: 50 * 1024 * 1024, // 50 MB > 20 MB cap
        mimeType: "application/zip",
        kind: "document",
      },
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

    expect(transport.downloadedFileIds).toEqual([]);
    expect(harness.lastRequest?.userMessage).toContain(
      "[attached but too large to fetch: huge.zip",
    );
    expect(harness.lastRequest?.userMessage).toContain("50.0 MB > 20 MB");
    expect(harness.lastRequest?.userMessage).toContain("big one");
  });

  test("download failure surfaces the error to the harness (no crash)", async () => {
    const transport = new FakeTransport();
    transport.fileResponses.set("flaky", new Error("ECONNRESET"));
    transport.pendingUpdates.push({
      updateId: 557,
      chatId: 1001,
      fromUserId: 42,
      text: "",
      attachment: {
        fileId: "flaky",
        fileName: "fail.png",
        mimeType: "image/png",
        kind: "photo",
      },
    });
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

    expect(transport.downloadedFileIds).toEqual(["flaky"]);
    expect(harness.lastRequest?.userMessage).toBe(
      "[attached but couldn't download: fail.png (ECONNRESET)]",
    );
  });

  test("malicious file_name with path separators is contained inside the inbox dir", async () => {
    // Sender controls Telegram's file_name field. Without basename()
    // sanitization, file_name="../../etc/passwd" would join to a path
    // outside the inbox — a real OOB write vulnerability. The
    // <updateId>- prefix doesn't help; it's the basename() call that
    // does. Verify the saved path stays under the per-chat inbox.
    const transport = new FakeTransport();
    transport.fileResponses.set("evil", {
      data: Buffer.from("evil-bytes"),
      mime: "text/plain",
    });
    transport.pendingUpdates.push({
      updateId: 559,
      chatId: 1001,
      fromUserId: 42,
      text: "",
      attachment: {
        fileId: "evil",
        fileName: "../../etc/passwd",
        mimeType: "text/plain",
        kind: "document",
      },
    });
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

    const dir = inboxDir(1001);
    const expectedPath = join(dir, "559-passwd");
    expect(harness.lastRequest?.userMessage).toBe(`[attached: ${expectedPath}]`);
    // The saved file must live under the inbox dir, not at /etc/passwd
    // or anywhere else.
    expect(expectedPath.startsWith(dir + "/")).toBe(true);
    const onDisk = await import("node:fs/promises").then((m) =>
      m.readFile(expectedPath, "utf8"),
    );
    expect(onDisk).toBe("evil-bytes");
  });

  test("attachment with no caption: user message is the bracketed line only", async () => {
    const transport = new FakeTransport();
    transport.fileResponses.set("photo-1", {
      data: Buffer.from([0xff, 0xd8, 0xff]),
      mime: "image/jpeg",
    });
    transport.pendingUpdates.push({
      updateId: 558,
      chatId: 1001,
      fromUserId: 42,
      text: "",
      attachment: {
        fileId: "photo-1",
        fileName: "558-photo.jpg",
        fileSize: 3,
        mimeType: "image/jpeg",
        kind: "photo",
      },
    });
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

    const expectedPath = join(inboxDir(1001), "558-558-photo.jpg");
    expect(harness.lastRequest?.userMessage).toBe(`[attached: ${expectedPath}]`);
  });
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

  test("text-in + text-out: pre-tool narration is enabled (streamed text fills tool-call silence)", async () => {
    const transport = new FakeTransport();
    transport.pendingUpdates.push({
      updateId: 1,
      chatId: 1001,
      fromUserId: 42,
      text: "hi",
    });
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
    const prompt = harness.lastRequest?.systemPrompt ?? "";
    expect(prompt).toContain("Narration before tool calls");
  });

  test("voice-in + voice-out: pre-tool narration is suppressed (one-shot synthesized clip, no live channel to fill)", async () => {
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
      const prompt = harness.lastRequest?.systemPrompt ?? "";
      expect(prompt).not.toContain("Narration before tool calls");
    } finally {
      (globalThis as unknown as { fetch: typeof fetch }).fetch = originalFetch;
    }
  });
});

// ---------------------------------------------------------------------------
// Pre-tool narration: flush buffered prose as a separate Telegram message
// before each tool call so the user sees "Checking your inboxes…" land
// during the silent tool-run window instead of stapled to the back of the
// final answer. Voice-out skips chunked flushing.
// ---------------------------------------------------------------------------

describe("runTelegramServer narration flush (text-out)", () => {
  test("text → progress → text → done sends two messages: narration first, answer second", async () => {
    class NarrationHarness implements Harness {
      readonly id = "narration";
      async available(): Promise<boolean> {
        return true;
      }
      async *invoke(_req: HarnessRequest): AsyncGenerator<HarnessChunk> {
        yield { type: "text", text: "Checking your inboxes…" };
        yield { type: "progress", note: "tool: gog mail-search" };
        yield { type: "text", text: "Found 3 threads from Turtle Crossing." };
        yield {
          type: "done",
          finalText:
            "Checking your inboxes…Found 3 threads from Turtle Crossing.",
        };
      }
    }

    const transport = new FakeTransport();
    transport.pendingUpdates.push({
      updateId: 1,
      chatId: 1001,
      fromUserId: 42,
      text: "any new email from turtle crossing?",
    });
    await runTelegramServer({
      config: baseConfig(),
      memory,
      harnesses: [new NarrationHarness()],
      agentDir,
      persona: "phantom",
      transport,
      oneShot: true,
    });

    expect(transport.sent.map((s) => s.text)).toEqual([
      "Checking your inboxes…",
      "Found 3 threads from Turtle Crossing.",
    ]);
    // Both bubbles land in the right chat.
    expect(transport.sent.every((s) => s.chatId === 1001)).toBe(true);
  });

  test("multi-tool turn: one narration bubble per tool, then the final answer", async () => {
    class MultiToolHarness implements Harness {
      readonly id = "multitool";
      async available(): Promise<boolean> {
        return true;
      }
      async *invoke(_req: HarnessRequest): AsyncGenerator<HarnessChunk> {
        yield { type: "text", text: "Checking your calendar…" };
        yield { type: "progress", note: "tool: gog calendar-list" };
        yield { type: "text", text: "Now scanning your inboxes…" };
        yield { type: "progress", note: "tool: gog mail-search" };
        yield {
          type: "text",
          text: "Calendar is clear; you have 2 unread emails.",
        };
        yield {
          type: "done",
          finalText:
            "Checking your calendar…Now scanning your inboxes…Calendar is clear; you have 2 unread emails.",
        };
      }
    }

    const transport = new FakeTransport();
    transport.pendingUpdates.push({
      updateId: 1,
      chatId: 1001,
      fromUserId: 42,
      text: "any urgent emails or calendar blockers?",
    });
    await runTelegramServer({
      config: baseConfig(),
      memory,
      harnesses: [new MultiToolHarness()],
      agentDir,
      persona: "phantom",
      transport,
      oneShot: true,
    });

    expect(transport.sent.map((s) => s.text)).toEqual([
      "Checking your calendar…",
      "Now scanning your inboxes…",
      "Calendar is clear; you have 2 unread emails.",
    ]);
  });

  test("no progress chunk: behaves like before — single bubble with full reply", async () => {
    // Regression guard: turns that don't trigger a tool (the agent
    // answers from context) shouldn't be split into multiple bubbles.
    class NoToolHarness implements Harness {
      readonly id = "no-tool";
      async available(): Promise<boolean> {
        return true;
      }
      async *invoke(_req: HarnessRequest): AsyncGenerator<HarnessChunk> {
        yield { type: "text", text: "The capital of France is Paris." };
        yield {
          type: "done",
          finalText: "The capital of France is Paris.",
        };
      }
    }

    const transport = new FakeTransport();
    transport.pendingUpdates.push({
      updateId: 1,
      chatId: 1001,
      fromUserId: 42,
      text: "what's the capital of France?",
    });
    await runTelegramServer({
      config: baseConfig(),
      memory,
      harnesses: [new NoToolHarness()],
      agentDir,
      persona: "phantom",
      transport,
      oneShot: true,
    });

    expect(transport.sent).toEqual([
      { chatId: 1001, text: "The capital of France is Paris." },
    ]);
  });

  test("whitespace-only buffer between text chunks does NOT flush an empty bubble", async () => {
    // The model could plausibly emit a stray space or newline before
    // the first real word. We don't want a Telegram bubble containing
    // just " " — that shows up as a blank message.
    class WhitespaceHarness implements Harness {
      readonly id = "whitespace";
      async available(): Promise<boolean> {
        return true;
      }
      async *invoke(_req: HarnessRequest): AsyncGenerator<HarnessChunk> {
        yield { type: "text", text: "  \n " };
        yield { type: "progress", note: "tool: noop" };
        yield { type: "text", text: "real answer" };
        yield { type: "done", finalText: "  \n real answer" };
      }
    }

    const transport = new FakeTransport();
    transport.pendingUpdates.push({
      updateId: 1,
      chatId: 1001,
      fromUserId: 42,
      text: "anything?",
    });
    await runTelegramServer({
      config: baseConfig(),
      memory,
      harnesses: [new WhitespaceHarness()],
      agentDir,
      persona: "phantom",
      transport,
      oneShot: true,
    });

    // No empty/whitespace narration bubble; the full reply lands as
    // one message. The leading whitespace was never flushed, so the
    // prefix-match path doesn't trigger and we send `fullReply` whole.
    expect(transport.sent).toHaveLength(1);
    expect(transport.sent[0]!.text).toBe("  \n real answer");
  });

  test("flushed prefix matches finalText: post-tool message is the suffix only (no duplication)", async () => {
    // Happy path: streamed text concatenated equals finalText. The
    // post-tool bubble must contain only the bytes the user hasn't
    // already seen — no echo of the narration sentence.
    class CleanFinalHarness implements Harness {
      readonly id = "clean-final";
      async available(): Promise<boolean> {
        return true;
      }
      async *invoke(_req: HarnessRequest): AsyncGenerator<HarnessChunk> {
        yield { type: "text", text: "Looking that up…\n" };
        yield { type: "progress", note: "tool: web-search" };
        yield { type: "text", text: "It's 42." };
        // finalText exactly equals the concatenation of text chunks.
        yield { type: "done", finalText: "Looking that up…\nIt's 42." };
      }
    }

    const transport = new FakeTransport();
    transport.pendingUpdates.push({
      updateId: 1,
      chatId: 1001,
      fromUserId: 42,
      text: "ultimate question?",
    });
    await runTelegramServer({
      config: baseConfig(),
      memory,
      harnesses: [new CleanFinalHarness()],
      agentDir,
      persona: "phantom",
      transport,
      oneShot: true,
    });

    expect(transport.sent.map((s) => s.text)).toEqual([
      "Looking that up…\n",
      "It's 42.",
    ]);
  });

  test("harness reformats final reply: send full final, accept duplication over truncation", async () => {
    // Pathological case: the harness reformatted finalText so it no
    // longer starts with what we flushed. Better to send the full
    // (slightly duplicated) answer than to slice off bytes the user
    // needs to see.
    class ReformatHarness implements Harness {
      readonly id = "reformat";
      async available(): Promise<boolean> {
        return true;
      }
      async *invoke(_req: HarnessRequest): AsyncGenerator<HarnessChunk> {
        yield { type: "text", text: "Checking…" };
        yield { type: "progress", note: "tool: search" };
        yield { type: "text", text: "Result is X." };
        // Harness reformatted — finalText doesn't start with "Checking…"
        yield { type: "done", finalText: "Result: X (after a check)." };
      }
    }

    const transport = new FakeTransport();
    transport.pendingUpdates.push({
      updateId: 1,
      chatId: 1001,
      fromUserId: 42,
      text: "any results?",
    });
    await runTelegramServer({
      config: baseConfig(),
      memory,
      harnesses: [new ReformatHarness()],
      agentDir,
      persona: "phantom",
      transport,
      oneShot: true,
    });

    // First bubble: the narration we flushed before the tool fired.
    // Second bubble: the full reformatted final, NOT a sliced suffix
    // (because the prefix didn't match). User sees a duplicated word
    // — acceptable. Truncating would be worse.
    expect(transport.sent).toHaveLength(2);
    expect(transport.sent[0]!.text).toBe("Checking…");
    expect(transport.sent[1]!.text).toBe("Result: X (after a check).");
  });

  test("narration flushed but model emits nothing further: no '(no reply)' tacked on", async () => {
    // Model said "Checking…", a tool ran, and… nothing came back.
    // We've already shown the user something — don't bolt
    // "(no reply)" onto the end. Stay quiet.
    class SilentAfterToolHarness implements Harness {
      readonly id = "silent-after-tool";
      async available(): Promise<boolean> {
        return true;
      }
      async *invoke(_req: HarnessRequest): AsyncGenerator<HarnessChunk> {
        yield { type: "text", text: "Checking…" };
        yield { type: "progress", note: "tool: search" };
        yield { type: "done", finalText: "Checking…" };
      }
    }

    const transport = new FakeTransport();
    transport.pendingUpdates.push({
      updateId: 1,
      chatId: 1001,
      fromUserId: 42,
      text: "anything?",
    });
    await runTelegramServer({
      config: baseConfig(),
      memory,
      harnesses: [new SilentAfterToolHarness()],
      agentDir,
      persona: "phantom",
      transport,
      oneShot: true,
    });

    // Just the narration bubble. No "(no reply)" follow-up.
    expect(transport.sent.map((s) => s.text)).toEqual(["Checking…"]);
  });

  test("error after a flushed narration bubble: error message follows the narration", async () => {
    // Narration landed, then the tool blew up. The error diagnostic
    // still has to surface — we suppress "(no reply)" specifically,
    // not real errors.
    class ErrorAfterToolHarness implements Harness {
      readonly id = "error-after-tool";
      async available(): Promise<boolean> {
        return true;
      }
      async *invoke(_req: HarnessRequest): AsyncGenerator<HarnessChunk> {
        yield { type: "text", text: "Checking…" };
        yield { type: "progress", note: "tool: search" };
        yield { type: "error", error: "boom", recoverable: false };
      }
    }

    const transport = new FakeTransport();
    transport.pendingUpdates.push({
      updateId: 1,
      chatId: 1001,
      fromUserId: 42,
      text: "anything?",
    });
    await runTelegramServer({
      config: baseConfig(),
      memory,
      harnesses: [new ErrorAfterToolHarness()],
      agentDir,
      persona: "phantom",
      transport,
      oneShot: true,
    });

    expect(transport.sent.map((s) => s.text)).toEqual([
      "Checking…",
      "(error: boom)",
    ]);
  });
});

describe("runTelegramServer narration flush (voice-out)", () => {
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

  test("voice-in/voice-out: progress chunks do NOT flush text bubbles; full reply synthesized at end", async () => {
    // Voice replies are one synthesized clip — chunked text flushes
    // would just bloat the audio AND leak text into a voice-only
    // conversation. The flush function is gated off for voice.
    const originalFetch = globalThis.fetch;
    let ttsBodyText: string | undefined;
    (globalThis as unknown as { fetch: typeof fetch }).fetch = (async (
      url: string | URL | Request,
      init?: RequestInit,
    ) => {
      const u = String(url);
      if (u.includes("audio/transcriptions")) {
        return new Response(JSON.stringify({ text: "hello" }), {
          status: 200,
        });
      }
      if (u.includes("audio/speech")) {
        // Capture the text we sent to TTS so the assertion can verify
        // we synthesized the FULL reply, not just the post-tool suffix.
        const body = init?.body && typeof init.body === "string"
          ? (JSON.parse(init.body) as { input?: string })
          : {};
        ttsBodyText = body.input;
        return new Response(Buffer.from([1, 2, 3]), {
          status: 200,
          headers: { "content-type": "audio/ogg" },
        });
      }
      throw new Error(`unexpected fetch: ${u}`);
    }) as unknown as typeof fetch;

    try {
      class NarrationHarness implements Harness {
        readonly id = "narration-voice";
        async available(): Promise<boolean> {
          return true;
        }
        async *invoke(_req: HarnessRequest): AsyncGenerator<HarnessChunk> {
          yield { type: "text", text: "Checking…" };
          yield { type: "progress", note: "tool: search" };
          yield { type: "text", text: "Done." };
          yield { type: "done", finalText: "Checking…Done." };
        }
      }

      const transport = new FakeTransport();
      transport.pendingUpdates.push({
        updateId: 1,
        chatId: 1001,
        fromUserId: 42,
        text: "",
        voice: { fileId: "abc", mimeType: "audio/ogg", durationS: 2 },
      });
      await runTelegramServer({
        config: withVoiceConfig(),
        memory,
        harnesses: [new NarrationHarness()],
        agentDir,
        persona: "phantom",
        transport,
        oneShot: true,
      });

      // No text bubbles emitted — voice-out path stays silent on text.
      expect(transport.sent).toEqual([]);
      // One voice clip went out with the FULL reply (not just the
      // suffix), since the voice path ignores `flushedReply`.
      expect(transport.voiceSent).toHaveLength(1);
      expect(ttsBodyText).toBe("Checking…Done.");
    } finally {
      (globalThis as unknown as { fetch: typeof fetch }).fetch = originalFetch;
    }
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
    // The aborted turn persists a synthetic interrupted-pair so the
    // next user message has context for follow-ups like "actually do X
    // instead." Skipped only when the abort reason is "reset" (history
    // was just wiped) or the message text is empty (voice STT aborted
    // before it ran).
    const stored = await memory.recentTurns("phantom", "telegram:1001", 10);
    expect(stored).toEqual([
      { role: "user", text: "kick off something slow" },
      { role: "assistant", text: "[interrupted before reply]" },
    ]);
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
    // History records the interrupted message + a synthetic "[interrupted
    // before reply]" so the model has context for the follow-up. Then
    // the second turn's successful user/assistant pair lands as normal.
    const stored = await memory.recentTurns("phantom", "telegram:1001", 10);
    expect(stored.map((t) => t.text)).toEqual([
      "kick off something slow",
      "[interrupted before reply]",
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

  test("/restart acks the offset to Telegram BEFORE the restart callback fires", async () => {
    // Bug fix: pre-fix, the polling loop's `offset = nextOffset` only
    // commits to Telegram on the NEXT getUpdates call. SIGTERM from the
    // self-triggered systemctl restart killed us before that next call
    // ran, so Telegram re-delivered the /restart to the freshly-started
    // process — restart loop. Fix: ack the offset (a timeout=0
    // getUpdates with offset = max(updateId)+1) BEFORE invoking the
    // afterSend that might kill us.
    const transport = new FakeTransport();
    transport.pendingUpdates.push({
      updateId: 5,
      chatId: 1001,
      fromUserId: 42,
      text: "/restart",
    });

    const restartOrder: string[] = [];
    let restartCalled = false;
    const stubServiceControl: ServiceControl = {
      async isActive() {
        return true;
      },
      async restart() {
        restartCalled = true;
        restartOrder.push("restart");
        return { ok: true };
      },
      async rerenderUnitIfStale() {
        return { rerendered: false };
      },
    };
    // Wrap ackUpdates so we can observe call order vs restart.
    const origAck = transport.ackUpdates.bind(transport);
    transport.ackUpdates = async (offset: number) => {
      restartOrder.push("ack");
      await origAck(offset);
    };

    await runTelegramServer({
      config: baseConfig(),
      memory,
      harnesses: [new ScriptedHarness("fake", [])],
      agentDir,
      persona: "phantom",
      transport,
      serviceControl: stubServiceControl,
      oneShot: true,
    });

    // The "restarting…" heads-up landed.
    expect(transport.sent.some((s) => s.text.includes("restarting"))).toBe(
      true,
    );
    // Ack was called with the post-update offset (max updateId 5 + 1 = 6).
    expect(transport.ackedOffsets).toContain(6);
    // And restart actually fired.
    expect(restartCalled).toBe(true);
    // Critical ordering: ack must come BEFORE restart. Otherwise SIGTERM
    // mid-restart leaves the /restart still on Telegram's wire and the
    // new process gets it again.
    expect(restartOrder).toEqual(["ack", "restart"]);
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

describe("HttpTelegramTransport HTML rendering", () => {
  type Captured = { url: string; body: Record<string, unknown> };
  function fakeFetch(
    captured: Captured[],
    statusFor: (url: string, body: Record<string, unknown>) => number,
  ): typeof fetch {
    return (async (url: string | URL | Request, init?: RequestInit) => {
      const u = String(url);
      const body =
        init?.body && typeof init.body === "string"
          ? (JSON.parse(init.body) as Record<string, unknown>)
          : {};
      captured.push({ url: u, body });
      const status = statusFor(u, body);
      const responseBody = status === 200
        ? JSON.stringify({ ok: true, result: {} })
        : JSON.stringify({ ok: false, description: "bad request" });
      return new Response(responseBody, { status });
    }) as unknown as typeof fetch;
  }

  test("sendMessage converts markdown to HTML and sets parse_mode=HTML", async () => {
    const captured: Captured[] = [];
    const originalFetch = globalThis.fetch;
    try {
      (globalThis as unknown as { fetch: typeof fetch }).fetch = fakeFetch(
        captured,
        () => 200,
      );
      const t = new HttpTelegramTransport("test-token");
      await t.sendMessage(7, "**hi** _there_ `code`");
      expect(captured).toHaveLength(1);
      expect(captured[0]!.body.parse_mode).toBe("HTML");
      expect(captured[0]!.body.text).toBe(
        "<b>hi</b> <i>there</i> <code>code</code>",
      );
    } finally {
      (globalThis as unknown as { fetch: typeof fetch }).fetch = originalFetch;
    }
  });

  test("falls back to plain text on 400 from the HTML attempt", async () => {
    const captured: Captured[] = [];
    const originalFetch = globalThis.fetch;
    try {
      (globalThis as unknown as { fetch: typeof fetch }).fetch = fakeFetch(
        captured,
        // First call (HTML) → 400; second call (fallback) → 200.
        (_url, body) => (body.parse_mode === "HTML" ? 400 : 200),
      );
      const t = new HttpTelegramTransport("test-token");
      await t.sendMessage(7, "**hi**");
      expect(captured).toHaveLength(2);
      expect(captured[0]!.body.parse_mode).toBe("HTML");
      expect(captured[1]!.body.parse_mode).toBeUndefined();
      // Fallback sends the original markdown, not the HTML.
      expect(captured[1]!.body.text).toBe("**hi**");
    } finally {
      (globalThis as unknown as { fetch: typeof fetch }).fetch = originalFetch;
    }
  });

  test("does NOT fall back when the HTML send succeeds", async () => {
    const captured: Captured[] = [];
    const originalFetch = globalThis.fetch;
    try {
      (globalThis as unknown as { fetch: typeof fetch }).fetch = fakeFetch(
        captured,
        () => 200,
      );
      const t = new HttpTelegramTransport("test-token");
      await t.sendMessage(7, "**hi**");
      expect(captured).toHaveLength(1);
    } finally {
      (globalThis as unknown as { fetch: typeof fetch }).fetch = originalFetch;
    }
  });

  test("does NOT fall back on non-400 errors (e.g. 500 / 429)", async () => {
    const captured: Captured[] = [];
    const originalFetch = globalThis.fetch;
    try {
      (globalThis as unknown as { fetch: typeof fetch }).fetch = fakeFetch(
        captured,
        () => 500,
      );
      const t = new HttpTelegramTransport("test-token");
      await t.sendMessage(7, "**hi**");
      // Just the one HTML attempt; we don't retry server errors as
      // plain text (the issue isn't our markup).
      expect(captured).toHaveLength(1);
      expect(captured[0]!.body.parse_mode).toBe("HTML");
    } finally {
      (globalThis as unknown as { fetch: typeof fetch }).fetch = originalFetch;
    }
  });

  test("truncates long source markdown before HTML conversion", async () => {
    const captured: Captured[] = [];
    const originalFetch = globalThis.fetch;
    try {
      (globalThis as unknown as { fetch: typeof fetch }).fetch = fakeFetch(
        captured,
        () => 200,
      );
      const t = new HttpTelegramTransport("test-token");
      const huge = "x".repeat(10_000);
      await t.sendMessage(7, huge);
      const sent = captured[0]!.body.text as string;
      expect(sent.length).toBeLessThan(4096);
      expect(sent.endsWith("\n…[truncated]")).toBe(true);
    } finally {
      (globalThis as unknown as { fetch: typeof fetch }).fetch = originalFetch;
    }
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
