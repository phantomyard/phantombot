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
  typing: number[] = [];
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
