/**
 * Tests for runTurn — the single-turn coordinator.
 *
 * Uses real persona files (mkdtemp), a real in-memory SQLite store,
 * and scripted fake harnesses (no subprocesses) so we test the wiring
 * deterministically.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runTurn } from "../src/orchestrator/turn.ts";
import {
  type MemoryStore,
  openMemoryStore,
} from "../src/memory/store.ts";
import type {
  Harness,
  HarnessChunk,
  HarnessRequest,
} from "../src/harnesses/types.ts";

let agentDir: string;
let memory: MemoryStore;

beforeEach(async () => {
  agentDir = await mkdtemp(join(tmpdir(), "phantombot-turn-"));
  await writeFile(join(agentDir, "BOOT.md"), "# I am Phantom", "utf8");
  memory = await openMemoryStore(":memory:");
});

afterEach(async () => {
  await memory.close();
  await rm(agentDir, { recursive: true, force: true });
});

class ScriptedHarness implements Harness {
  constructor(
    public readonly id: string,
    private readonly script: HarnessChunk[],
    private readonly capture?: (req: HarnessRequest) => void,
  ) {}
  async available(): Promise<boolean> {
    return true;
  }
  async *invoke(req: HarnessRequest): AsyncGenerator<HarnessChunk> {
    this.capture?.(req);
    for (const c of this.script) yield c;
  }
}

async function collect(
  iter: AsyncIterable<HarnessChunk>,
): Promise<HarnessChunk[]> {
  const chunks: HarnessChunk[] = [];
  for await (const c of iter) chunks.push(c);
  return chunks;
}

const baseInput = () => ({
  persona: "phantom",
  conversation: "cli:default",
  agentDir,
  memory,
  idleTimeoutMs: 1_000,
  hardTimeoutMs: 5_000,
});

describe("runTurn — successful path", () => {
  test("streams chunks and persists user + assistant turns", async () => {
    const harness = new ScriptedHarness("fake", [
      { type: "text", text: "hi " },
      { type: "text", text: "there" },
      { type: "done", finalText: "hi there" },
    ]);

    const chunks = await collect(
      runTurn({
        ...baseInput(),
        userMessage: "hello",
        harnesses: [harness],
      }),
    );

    expect(chunks.map((c) => c.type)).toEqual(["text", "text", "done"]);

    const stored = await memory.recentTurns("phantom", "cli:default", 10);
    expect(stored).toEqual([
      { role: "user", text: "hello" },
      { role: "assistant", text: "hi there" },
    ]);
  });

  test("passes loaded history to the harness", async () => {
    await memory.appendTurn({
      persona: "phantom",
      conversation: "cli:default",
      role: "user",
      text: "earlier user msg",
    });
    await memory.appendTurn({
      persona: "phantom",
      conversation: "cli:default",
      role: "assistant",
      text: "earlier reply",
    });

    let captured: HarnessRequest | undefined;
    const harness = new ScriptedHarness(
      "fake",
      [{ type: "done", finalText: "ok" }],
      (req) => {
        captured = req;
      },
    );

    await collect(
      runTurn({
        ...baseInput(),
        userMessage: "now",
        harnesses: [harness],
      }),
    );

    expect(captured?.history).toEqual([
      { role: "user", text: "earlier user msg" },
      { role: "assistant", text: "earlier reply" },
    ]);
    expect(captured?.userMessage).toBe("now");
  });

  test("system prompt includes the persona identity", async () => {
    let captured: HarnessRequest | undefined;
    const harness = new ScriptedHarness(
      "fake",
      [{ type: "done", finalText: "ok" }],
      (req) => {
        captured = req;
      },
    );

    await collect(
      runTurn({
        ...baseInput(),
        userMessage: "hi",
        harnesses: [harness],
      }),
    );

    expect(captured?.systemPrompt).toContain("# Identity");
    expect(captured?.systemPrompt).toContain("# I am Phantom");
  });

  test("uses the done chunk's finalText (not the running text accumulation) for persistence", async () => {
    const harness = new ScriptedHarness("fake", [
      { type: "text", text: "draft " },
      { type: "text", text: "answer" },
      // Harness reformats final reply; we must persist the canonical version.
      { type: "done", finalText: "Final answer." },
    ]);

    await collect(
      runTurn({
        ...baseInput(),
        userMessage: "q?",
        harnesses: [harness],
      }),
    );

    const stored = await memory.recentTurns("phantom", "cli:default", 10);
    expect(stored[1]?.text).toBe("Final answer.");
  });
});

describe("runTurn — failure path", () => {
  test("when the harness emits a terminal error, nothing is persisted", async () => {
    const harness = new ScriptedHarness("fake", [
      {
        type: "error",
        error: "boom",
        recoverable: false,
      },
    ]);

    const chunks = await collect(
      runTurn({
        ...baseInput(),
        userMessage: "hi",
        harnesses: [harness],
      }),
    );

    expect(chunks.map((c) => c.type)).toEqual(["error"]);
    const stored = await memory.recentTurns("phantom", "cli:default", 10);
    expect(stored).toEqual([]);
  });
});

describe("runTurn — noHistory option", () => {
  test("skips loading prior turns AND skips persisting this turn", async () => {
    await memory.appendTurn({
      persona: "phantom",
      conversation: "cli:default",
      role: "user",
      text: "earlier",
    });
    await memory.appendTurn({
      persona: "phantom",
      conversation: "cli:default",
      role: "assistant",
      text: "earlier reply",
    });

    let captured: HarnessRequest | undefined;
    const harness = new ScriptedHarness(
      "fake",
      [{ type: "done", finalText: "ok" }],
      (req) => {
        captured = req;
      },
    );

    await collect(
      runTurn({
        ...baseInput(),
        userMessage: "isolated",
        harnesses: [harness],
        noHistory: true,
      }),
    );

    expect(captured?.history).toEqual([]);
    const stored = await memory.recentTurns("phantom", "cli:default", 10);
    // Only the original two turns; no new ones.
    expect(stored.map((t) => t.text)).toEqual(["earlier", "earlier reply"]);
  });
});

describe("runTurn — fallback chain", () => {
  test("when the first harness emits a recoverable error, the second handles it and gets persisted", async () => {
    const failing = new ScriptedHarness("fail", [
      { type: "error", error: "rate limited", recoverable: true },
    ]);
    const succeeding = new ScriptedHarness("ok", [
      { type: "text", text: "fallback wins" },
      { type: "done", finalText: "fallback wins" },
    ]);

    const chunks = await collect(
      runTurn({
        ...baseInput(),
        userMessage: "hi",
        harnesses: [failing, succeeding],
      }),
    );

    expect(chunks.map((c) => c.type)).toEqual(["text", "done"]);
    const stored = await memory.recentTurns("phantom", "cli:default", 10);
    expect(stored[1]?.text).toBe("fallback wins");
  });
});

describe("runTurn — historyLimit", () => {
  test("respects historyLimit when loading prior turns", async () => {
    for (let i = 1; i <= 5; i++) {
      await memory.appendTurn({
        persona: "phantom",
        conversation: "cli:default",
        role: "user",
        text: `msg ${i}`,
      });
    }
    let captured: HarnessRequest | undefined;
    const harness = new ScriptedHarness(
      "fake",
      [{ type: "done", finalText: "ok" }],
      (req) => {
        captured = req;
      },
    );

    await collect(
      runTurn({
        ...baseInput(),
        userMessage: "now",
        harnesses: [harness],
        historyLimit: 2,
      }),
    );

    expect(captured?.history).toEqual([
      { role: "user", text: "msg 4" },
      { role: "user", text: "msg 5" },
    ]);
  });
});
