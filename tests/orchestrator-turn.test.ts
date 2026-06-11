/**
 * Tests for runTurn — the single-turn coordinator.
 *
 * Uses real persona files (mkdtemp), a real in-memory SQLite store,
 * and scripted fake harnesses (no subprocesses) so we test the wiring
 * deterministically.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_HISTORY_LIMIT, runTurn } from "../src/orchestrator/turn.ts";
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

  test("runs post-persist turn index hook after a successful turn", async () => {
    let sawPersistedTurns = 0;
    const harness = new ScriptedHarness("fake", [
      { type: "done", finalText: "reply" },
    ]);

    await collect(
      runTurn({
        ...baseInput(),
        userMessage: "hello",
        harnesses: [harness],
        indexTurns: async () => {
          sawPersistedTurns = (
            await memory.recentTurns("phantom", "cli:default", 10)
          ).length;
        },
      }),
    );

    expect(sawPersistedTurns).toBe(2);
  });

  test("workingDir defaults to the running user's home dir (gemini sandbox spans the whole user account)", async () => {
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
        userMessage: "x",
        harnesses: [harness],
      }),
    );

    expect(captured?.workingDir).toBe(homedir());
  });

  test("workingDir override is respected (callers can scope down)", async () => {
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
        userMessage: "x",
        harnesses: [harness],
        workingDir: agentDir,
      }),
    );

    expect(captured?.workingDir).toBe(agentDir);
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

  test("toolNarration off by default — narration block is NOT in the prompt", async () => {
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

    expect(captured?.systemPrompt).not.toContain("Narration before tool calls");
  });

  test("toolNarration: true appends PRE_TOOL_NARRATION_INSTRUCTION", async () => {
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
        toolNarration: true,
      }),
    );

    const prompt = captured?.systemPrompt ?? "";
    expect(prompt).toContain("Narration before tool calls");
    // Multilingual nudge: the rule must explicitly say "use the user's
    // language" so non-English speakers don't get English filler leaking
    // into their conversations.
    expect(prompt).toMatch(/user'?s language/i);
  });

  test("toolNarration coexists with systemPromptSuffix — both land in the prompt", async () => {
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
        systemPromptSuffix: "# CUSTOM SUFFIX MARKER",
        toolNarration: true,
      }),
    );

    const prompt = captured?.systemPrompt ?? "";
    expect(prompt).toContain("# CUSTOM SUFFIX MARKER");
    expect(prompt).toContain("Narration before tool calls");
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

describe("runTurn — purge-after-ruling (trusted success)", () => {
  /** Wrap the real store, counting purgeQuarantined calls. */
  function spyStore(inner: MemoryStore): {
    store: MemoryStore;
    purgeCalls: Array<{ persona: string; conversation: string }>;
  } {
    const purgeCalls: Array<{ persona: string; conversation: string }> = [];
    const store = new Proxy(inner, {
      get(target, prop, receiver) {
        if (prop === "purgeQuarantined") {
          return async (persona: string, conversation: string) => {
            purgeCalls.push({ persona, conversation });
            return inner.purgeQuarantined(persona, conversation);
          };
        }
        return Reflect.get(target, prop, receiver);
      },
    });
    return { store, purgeCalls };
  }

  test("a successful TRUSTED turn calls purgeQuarantined for this conversation", async () => {
    const { store, purgeCalls } = spyStore(memory);
    const harness = new ScriptedHarness("fake", [
      { type: "done", finalText: "ok" },
    ]);

    await collect(
      runTurn({
        ...baseInput(),
        memory: store,
        userMessage: "approve it",
        harnesses: [harness],
        trusted: true,
      }),
    );

    expect(purgeCalls).toEqual([
      { persona: "phantom", conversation: "cli:default" },
    ]);
  });

  test("an UNTRUSTED successful turn does NOT purge", async () => {
    const { store, purgeCalls } = spyStore(memory);
    const harness = new ScriptedHarness("fake", [
      { type: "done", finalText: "ok" },
    ]);

    await collect(
      runTurn({
        ...baseInput(),
        memory: store,
        userMessage: "ambient input",
        harnesses: [harness],
        // trusted omitted → untrusted; no purge.
      }),
    );

    expect(purgeCalls).toEqual([]);
  });

  test("a FAILED trusted turn does NOT purge (nothing was persisted to rule on)", async () => {
    const { store, purgeCalls } = spyStore(memory);
    const harness = new ScriptedHarness("fake", [
      { type: "error", error: "boom", recoverable: false },
    ]);

    await collect(
      runTurn({
        ...baseInput(),
        memory: store,
        userMessage: "approve it",
        harnesses: [harness],
        trusted: true,
      }),
    );

    expect(purgeCalls).toEqual([]);
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

describe("runTurn — auto-retrieval (line-111 instinct)", () => {
  test("no retrieve fn → no 'Retrieved context' section (backward compatible)", async () => {
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

    expect(captured?.systemPrompt).not.toContain("# Retrieved context for this turn");
  });

  test("retrieve fn result is injected under the 'Retrieved context' slot", async () => {
    let captured: HarnessRequest | undefined;
    let seenQuery: string | undefined;
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
        userMessage: "what inverter did we pick?",
        harnesses: [harness],
        retrieve: async (query) => {
          seenQuery = query;
          return "## memory/decisions.md\nWe chose the deye inverter.";
        },
      }),
    );

    // Called with the user message.
    expect(seenQuery).toBe("what inverter did we pick?");
    const prompt = captured?.systemPrompt ?? "";
    expect(prompt).toContain("# Retrieved context for this turn");
    expect(prompt).toContain("We chose the deye inverter.");
  });

  test("retrieve returning undefined → no 'Retrieved context' section", async () => {
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
        retrieve: async () => undefined,
      }),
    );

    expect(captured?.systemPrompt).not.toContain("# Retrieved context for this turn");
  });

  test("a throwing retriever is swallowed — the turn still completes", async () => {
    let captured: HarnessRequest | undefined;
    const harness = new ScriptedHarness(
      "fake",
      [{ type: "text", text: "answer" }, { type: "done", finalText: "answer" }],
      (req) => {
        captured = req;
      },
    );

    const chunks = await collect(
      runTurn({
        ...baseInput(),
        userMessage: "hi",
        harnesses: [harness],
        retrieve: async () => {
          throw new Error("retriever blew up");
        },
      }),
    );

    // Turn proceeds normally; no retrieved context; reply persisted.
    expect(chunks.map((c) => c.type)).toEqual(["text", "done"]);
    expect(captured?.systemPrompt).not.toContain("# Retrieved context for this turn");
    const stored = await memory.recentTurns("phantom", "cli:default", 10);
    expect(stored[1]?.text).toBe("answer");
  });
});

describe("runTurn — historyLimit", () => {
  test("defaults to the 30-turn rolling window", async () => {
    for (let i = 1; i <= DEFAULT_HISTORY_LIMIT + 5; i++) {
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
      }),
    );

    expect(captured?.history).toHaveLength(DEFAULT_HISTORY_LIMIT);
    expect(captured?.history[0]?.text).toBe("msg 6");
    expect(captured?.history.at(-1)?.text).toBe("msg 35");
  });

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
