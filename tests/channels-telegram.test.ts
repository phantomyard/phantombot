/**
 * Tests for the Telegram channel adapter.
 *
 * Three layers:
 *   1. parseGetUpdatesResult — pure parser, exhaustive shape coverage.
 *   2. runTelegramServer with a fake transport + scripted harness — verifies
 *      end-to-end flow without HTTP or subprocesses.
 *   3. runServe — early-exit failure paths.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  parseGetUpdatesResult,
  type TelegramMessage,
  type TelegramTransport,
  runTelegramServer,
} from "../src/channels/telegram.ts";
import { runServe } from "../src/cli/serve.ts";
import type { Config } from "../src/config.ts";
import type {
  Harness,
  HarnessChunk,
  HarnessRequest,
} from "../src/harnesses/types.ts";
import { openMemoryStore, type MemoryStore } from "../src/memory/store.ts";

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
  /** Set this before calling getUpdates; it's drained on first call. */
  pendingUpdates: TelegramMessage[] = [];
  sent: Array<{ chatId: number; text: string }> = [];
  typing: number[] = [];
  async getUpdates(
    offset: number,
    _timeoutS: number,
  ): Promise<{ updates: TelegramMessage[]; nextOffset: number }> {
    const updates = this.pendingUpdates.splice(0);
    // Real Telegram getUpdates blocks server-side. Simulate that with a
    // small macrotask delay when there are no updates so the runtime's
    // setTimeout-based AbortControllers can fire (a microtask-only loop
    // can starve them).
    if (updates.length === 0) {
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
    const raw = [
      {
        update_id: 100,
        message: {
          chat: { id: 1 },
          from: { id: 42, username: "alice" },
          text: "hi",
        },
      },
      {
        update_id: 101,
        message: {
          chat: { id: 1 },
          from: { id: 42 },
          text: "again",
        },
      },
    ];
    const r = parseGetUpdatesResult(raw, 0);
    expect(r.updates).toEqual([
      {
        updateId: 100,
        chatId: 1,
        fromUserId: 42,
        fromUsername: "alice",
        text: "hi",
      },
      {
        updateId: 101,
        chatId: 1,
        fromUserId: 42,
        fromUsername: undefined,
        text: "again",
      },
    ]);
    expect(r.nextOffset).toBe(102);
  });

  test("skips non-message updates (e.g., callback_query) but still advances offset", () => {
    const raw = [
      { update_id: 200, callback_query: {} },
      {
        update_id: 201,
        message: {
          chat: { id: 1 },
          from: { id: 42 },
          text: "hello",
        },
      },
    ];
    const r = parseGetUpdatesResult(raw, 0);
    expect(r.updates).toHaveLength(1);
    expect(r.updates[0]?.text).toBe("hello");
    expect(r.nextOffset).toBe(202);
  });

  test("skips messages without text (e.g., photos, stickers)", () => {
    const raw = [
      {
        update_id: 300,
        message: {
          chat: { id: 1 },
          from: { id: 42 },
        },
      },
    ];
    const r = parseGetUpdatesResult(raw, 0);
    expect(r.updates).toEqual([]);
    expect(r.nextOffset).toBe(301);
  });

  test("preserves prior offset when no updates", () => {
    const r = parseGetUpdatesResult([], 555);
    expect(r.nextOffset).toBe(555);
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
  overrides: Partial<Config["channels"]["telegram"]> = {},
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
  },
  channels: {
    telegram: {
      token: "fake-token",
      pollTimeoutS: 30,
      allowedUserIds: [],
      ...overrides,
    },
  },
});

describe("runTelegramServer (fake transport)", () => {
  test("dispatches a message through runTurn and replies on Telegram", async () => {
    const transport = new FakeTransport();
    transport.pendingUpdates.push({
      updateId: 1,
      chatId: 1001,
      fromUserId: 42,
      fromUsername: "alice",
      text: "hello",
    });
    const harness = new ScriptedHarness("fake", [
      { type: "text", text: "hi " },
      { type: "text", text: "alice" },
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
    expect(harness.invocations).toBe(1);
    expect(harness.lastRequest?.userMessage).toBe("hello");

    // Persisted to telegram:1001 namespace, NOT cli:default.
    const tgTurns = await memory.recentTurns("phantom", "telegram:1001", 10);
    expect(tgTurns).toEqual([
      { role: "user", text: "hello" },
      { role: "assistant", text: "hi alice" },
    ]);
    const cliTurns = await memory.recentTurns("phantom", "cli:default", 10);
    expect(cliTurns).toEqual([]);
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
      { type: "done", finalText: "should not run" },
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
    expect(transport.typing).toEqual([]);
  });

  test("allowed users still get answered when allowlist is set", async () => {
    const transport = new FakeTransport();
    transport.pendingUpdates.push({
      updateId: 1,
      chatId: 1001,
      fromUserId: 42,
      text: "hi",
    });
    const harness = new ScriptedHarness("fake", [
      { type: "done", finalText: "yes" },
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
    expect(harness.invocations).toBe(1);
    expect(transport.sent).toEqual([{ chatId: 1001, text: "yes" }]);
  });

  test("on harness error, sends error message back to chat", async () => {
    const transport = new FakeTransport();
    transport.pendingUpdates.push({
      updateId: 1,
      chatId: 1001,
      fromUserId: 42,
      text: "hi",
    });
    const harness = new ScriptedHarness("fake", [
      { type: "error", error: "rate limited", recoverable: false },
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
    expect(transport.sent).toEqual([
      { chatId: 1001, text: "(error: rate limited)" },
    ]);
    // Should NOT have persisted on error.
    const turns = await memory.recentTurns("phantom", "telegram:1001", 10);
    expect(turns).toEqual([]);
  });

  test("isolates conversations by chatId", async () => {
    const transport = new FakeTransport();
    transport.pendingUpdates.push(
      {
        updateId: 1,
        chatId: 100,
        fromUserId: 42,
        text: "from chat A",
      },
      {
        updateId: 2,
        chatId: 200,
        fromUserId: 42,
        text: "from chat B",
      },
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
    expect(a.map((t) => t.text)).toEqual(["from chat A", "ok"]);
    expect(b.map((t) => t.text)).toEqual(["from chat B", "ok"]);
  });

  test("aborts cleanly when signal fires (no oneShot)", async () => {
    const transport = new FakeTransport();
    const ac = new AbortController();
    const harness = new ScriptedHarness("fake", [
      { type: "done", finalText: "ok" },
    ]);
    // Fire abort almost immediately so the loop exits on the second poll.
    setTimeout(() => ac.abort(), 50);
    await runTelegramServer({
      config: baseConfig(),
      memory,
      harnesses: [harness],
      agentDir,
      persona: "phantom",
      transport,
      signal: ac.signal,
    });
    expect(harness.invocations).toBe(0); // no updates ever queued
  });
});

// ---------------------------------------------------------------------------
// runServe — failure paths (success path is covered by the server test above)
// ---------------------------------------------------------------------------

describe("runServe", () => {
  test("returns 2 when --telegram is not set", async () => {
    const out = new CaptureStream();
    const err = new CaptureStream();
    const code = await runServe({ out, err });
    expect(code).toBe(2);
    expect(err.text).toContain("specify a channel");
  });

  test("returns 2 when telegram token is not configured", async () => {
    const out = new CaptureStream();
    const err = new CaptureStream();
    const code = await runServe({
      telegram: true,
      config: { ...baseConfig(), channels: {} },
      out,
      err,
    });
    expect(code).toBe(2);
    expect(err.text).toContain("no telegram bot token configured");
  });

  test("returns 2 when the persona dir doesn't exist", async () => {
    const out = new CaptureStream();
    const err = new CaptureStream();
    await rm(agentDir, { recursive: true, force: true });
    const code = await runServe({
      telegram: true,
      config: baseConfig(),
      out,
      err,
    });
    expect(code).toBe(2);
    expect(err.text).toContain("persona 'phantom' not found");
  });
});
