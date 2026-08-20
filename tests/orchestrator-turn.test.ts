/**
 * Tests for runTurn — the single-turn coordinator.
 *
 * Uses real persona files (mkdtemp), a real in-memory SQLite store,
 * and scripted fake harnesses (no subprocesses) so we test the wiring
 * deterministically.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_HISTORY_LIMIT, runTurn } from "../src/orchestrator/turn.ts";
import { type MemoryStore, openMemoryStore } from "../src/memory/store.ts";
import { MAX_DIGESTS_PER_TURN } from "../src/lib/turnDigest.ts";
import { nightlyConversationKey } from "../src/lib/nightly.ts";
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
  workingDir: agentDir,
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

  // #387: workingDir used to default to homedir() when a caller omitted it.
  // Every background caller omitted it, so nightly stages woke up in $HOME
  // with their own memory/ invisible from cwd and went hunting for it —
  // recursive walks that trip the macOS TCC "access data from other apps"
  // prompt once per spawned process. There is now NO default: the field is
  // required, and runTurn hands it to the harness verbatim.
  test("workingDir is passed to the harness verbatim — no homedir() fallback", async () => {
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
    expect(captured?.workingDir).not.toBe(homedir());
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

  test("toolsMode allowlist reaches the harness; omitted stays undefined", async () => {
    const seen: HarnessRequest[] = [];
    const mk = () =>
      new ScriptedHarness(
        "fake",
        [{ type: "done", finalText: "ok" }],
        (req) => {
          seen.push(req);
        },
      );

    await collect(
      runTurn({
        ...baseInput(),
        userMessage: "x",
        harnesses: [mk()],
        toolsMode: { allow: ["Bash", "Read"] },
      }),
    );
    await collect(
      runTurn({ ...baseInput(), userMessage: "y", harnesses: [mk()] }),
    );

    expect(seen).toHaveLength(2);
    expect(seen[0]?.toolsMode).toEqual({ allow: ["Bash", "Read"] });
    expect(seen[1]?.toolsMode).toBeUndefined();
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

describe("runTurn — user-turn provenance (userSource / trusted)", () => {
  /** Wrap the store, capturing the user + assistant records passed to appendTurnPair. */
  function spyPair(inner: MemoryStore): {
    store: MemoryStore;
    calls: Array<{ user: { source?: string }; assistant: { source?: string } }>;
  } {
    const calls: Array<{
      user: { source?: string };
      assistant: { source?: string };
    }> = [];
    const store = new Proxy(inner, {
      get(target, prop, receiver) {
        if (prop === "appendTurnPair") {
          return async (
            user: { source?: string },
            assistant: { source?: string },
          ) => {
            calls.push({ user, assistant });
            return (
              inner.appendTurnPair as (u: unknown, a: unknown) => Promise<void>
            )(user, assistant);
          };
        }
        return Reflect.get(target, prop, receiver);
      },
    });
    return { store, calls };
  }

  const okHarness = () =>
    new ScriptedHarness("fake", [{ type: "done", finalText: "ok" }]);

  test("defaults to `other` for an untrusted turn (no userSource)", async () => {
    const { store, calls } = spyPair(memory);
    await collect(
      runTurn({
        ...baseInput(),
        memory: store,
        userMessage: "ambient",
        harnesses: [okHarness()],
      }),
    );
    expect(calls).toHaveLength(1);
    expect(calls[0]!.user.source).toBe("other");
    expect(calls[0]!.assistant.source).toBe("unverified");
  });

  test("stamps `principal` for a trusted turn (no userSource)", async () => {
    const { store, calls } = spyPair(memory);
    await collect(
      runTurn({
        ...baseInput(),
        memory: store,
        userMessage: "do it",
        harnesses: [okHarness()],
        trusted: true,
      }),
    );
    expect(calls[0]!.user.source).toBe("principal");
  });

  test("userSource + assistantSource down-tier BOTH turns to `other` (task wake)", async () => {
    const { store, calls } = spyPair(memory);
    await collect(
      runTurn({
        ...baseInput(),
        memory: store,
        userMessage: "scheduled work",
        harnesses: [okHarness()],
        // A tick task wake: may ingest untrusted content mid-turn, so every
        // fact it produces is pinned to the untrusted tier. NOT trusted.
        userSource: "other",
        assistantSource: "other",
      }),
    );
    expect(calls[0]!.user.source).toBe("other");
    // The assistant reply is down-tiered too — this is the laundering vector.
    expect(calls[0]!.assistant.source).toBe("other");
  });

  test("assistantSource alone overrides only the assistant turn", async () => {
    const { store, calls } = spyPair(memory);
    await collect(
      runTurn({
        ...baseInput(),
        memory: store,
        userMessage: "hi",
        harnesses: [okHarness()],
        assistantSource: "other",
      }),
    );
    // User turn keeps its default (untrusted → other here); assistant overridden.
    expect(calls[0]!.user.source).toBe("other");
    expect(calls[0]!.assistant.source).toBe("other");
  });

  test("assistant turn defaults to `unverified`, even on a trusted turn (#327)", async () => {
    const { store, calls } = spyPair(memory);
    await collect(
      runTurn({
        ...baseInput(),
        memory: store,
        userMessage: "hi",
        harnesses: [okHarness()],
        trusted: true,
      }),
    );
    // The reply may relay untrusted tool-ingested bytes we can't separate from
    // the persona's own reasoning, so it is NOT stamped first-hand `self` even
    // when the principal drove the turn — trust is earned by engagement, not by
    // the `trusted` bit. The principal's confirming turn is what promotes it.
    expect(calls[0]!.assistant.source).toBe("unverified");
  });

  test("userSource wins over the trusted default", async () => {
    const { store, calls } = spyPair(memory);
    await collect(
      runTurn({
        ...baseInput(),
        memory: store,
        userMessage: "scheduled work",
        harnesses: [okHarness()],
        trusted: true,
        userSource: "other",
      }),
    );
    // Explicit override beats the trusted→principal default.
    expect(calls[0]!.user.source).toBe("other");
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

    expect(captured?.systemPrompt).not.toContain(
      "# Retrieved context for this turn",
    );
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

    expect(captured?.systemPrompt).not.toContain(
      "# Retrieved context for this turn",
    );
  });

  test("a throwing retriever is swallowed — the turn still completes", async () => {
    let captured: HarnessRequest | undefined;
    const harness = new ScriptedHarness(
      "fake",
      [
        { type: "text", text: "answer" },
        { type: "done", finalText: "answer" },
      ],
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
    expect(captured?.systemPrompt).not.toContain(
      "# Retrieved context for this turn",
    );
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

describe("runTurn — concurrent-turn awareness (issue #391)", () => {
  // The registry is inert under NODE_ENV=test by default so unrelated suites
  // can't write live-looking entries into the developer's real state dir.
  // These tests opt in and isolate it to a temp dir.
  let turnsDir: string;
  let prevEnabled: string | undefined;

  beforeEach(async () => {
    prevEnabled = process.env.PHANTOMBOT_TURN_REGISTRY;
    turnsDir = await mkdtemp(join(tmpdir(), "phantombot-turns-"));
    process.env.PHANTOMBOT_TURN_REGISTRY = "1";
    process.env.PHANTOMBOT_TURN_REGISTRY_DIR = turnsDir;
  });

  afterEach(async () => {
    await rm(turnsDir, { recursive: true, force: true });
    if (prevEnabled === undefined) delete process.env.PHANTOMBOT_TURN_REGISTRY;
    else process.env.PHANTOMBOT_TURN_REGISTRY = prevEnabled;
    delete process.env.PHANTOMBOT_TURN_REGISTRY_DIR;
  });

  /** An in-flight turn owned by THIS process, so the pid probe sees it alive. */
  async function seedSibling(
    over: Record<string, unknown> = {},
  ): Promise<void> {
    await writeFile(
      join(turnsDir, `${(over.id as string) ?? "sib"}.json`),
      JSON.stringify({
        id: "sib",
        persona: "phantom",
        conversation: "tick:42",
        origin: "task",
        pid: process.pid,
        started_at: new Date().toISOString(),
        ...over,
      }),
      "utf8",
    );
  }

  test("a live sibling injects the concurrency notice into the system prompt", async () => {
    await seedSibling();
    let captured: HarnessRequest | undefined;
    const harness = new ScriptedHarness(
      "fake",
      [{ type: "done", finalText: "ok" }],
      (req) => {
        captured = req;
      },
    );

    await collect(
      runTurn({ ...baseInput(), userMessage: "hi", harnesses: [harness] }),
    );

    const prompt = captured?.systemPrompt ?? "";
    expect(prompt).toContain("# Concurrent turn in progress");
    expect(prompt).toContain("tick:42");
  });

  test("no sibling means no notice — the ordinary turn is unchanged", async () => {
    let captured: HarnessRequest | undefined;
    const harness = new ScriptedHarness(
      "fake",
      [{ type: "done", finalText: "ok" }],
      (req) => {
        captured = req;
      },
    );

    await collect(
      runTurn({ ...baseInput(), userMessage: "hi", harnesses: [harness] }),
    );

    expect(captured?.systemPrompt ?? "").not.toContain(
      "# Concurrent turn in progress",
    );
  });

  test("a turn never sees ITSELF as a sibling", async () => {
    // runTurn registers before it builds the prompt, so without the self-filter
    // every single turn would announce itself as concurrent with itself.
    let captured: HarnessRequest | undefined;
    const harness = new ScriptedHarness(
      "fake",
      [{ type: "done", finalText: "ok" }],
      (req) => {
        captured = req;
      },
    );

    await collect(
      runTurn({ ...baseInput(), userMessage: "hi", harnesses: [harness] }),
    );

    // Registration really did happen (so the filter is what suppressed it,
    // not an inert registry).
    const { readRegistry } = await import("../src/lib/turnRegistry.ts");
    expect(readRegistry({ now: new Date() }).recent).toHaveLength(1);
    expect(captured?.systemPrompt ?? "").not.toContain(
      "# Concurrent turn in progress",
    );
  });

  test("another persona's live turn is not a sibling", async () => {
    await seedSibling({ persona: "lena" });
    let captured: HarnessRequest | undefined;
    const harness = new ScriptedHarness(
      "fake",
      [{ type: "done", finalText: "ok" }],
      (req) => {
        captured = req;
      },
    );

    await collect(
      runTurn({ ...baseInput(), userMessage: "hi", harnesses: [harness] }),
    );

    expect(captured?.systemPrompt ?? "").not.toContain(
      "# Concurrent turn in progress",
    );
  });

  test("the entry is released when the turn ends, even if the harness throws", async () => {
    const exploding: Harness = {
      id: "boom",
      available: async () => true,
      // eslint-disable-next-line require-yield
      async *invoke(): AsyncGenerator<HarnessChunk> {
        throw new Error("harness died");
      },
    };

    await expect(
      collect(
        runTurn({ ...baseInput(), userMessage: "hi", harnesses: [exploding] }),
      ),
    ).rejects.toThrow();

    // A turn that blew up must not leave an entry that looks in-flight — that
    // is what would park every scheduled task behind a corpse.
    const { readRegistry } = await import("../src/lib/turnRegistry.ts");
    const snap = readRegistry({ now: new Date() });
    expect(snap.running).toHaveLength(0);
    expect(snap.recent).toHaveLength(1);
  });
});

/**
 * #405 — post-turn digest and workspace claims.
 *
 * The two halves of "a background turn is invisible": what it DID (digest) and
 * what it is HOLDING (workspace locks) while it does it.
 */
describe("runTurn — background-turn visibility (#405)", () => {
  let digestDir: string;
  let turnsDir: string;
  let locksDir: string;
  const prev = {
    digest: process.env.PHANTOMBOT_TURN_DIGEST,
    registry: process.env.PHANTOMBOT_TURN_REGISTRY,
    locks: process.env.PHANTOMBOT_WORKSPACE_LOCKS,
  };

  beforeEach(async () => {
    digestDir = await mkdtemp(join(tmpdir(), "phantombot-digests-"));
    turnsDir = await mkdtemp(join(tmpdir(), "phantombot-turns-"));
    locksDir = await mkdtemp(join(tmpdir(), "phantombot-ws-"));
    process.env.PHANTOMBOT_TURN_DIGEST = "1";
    process.env.PHANTOMBOT_TURN_DIGEST_DIR = digestDir;
    process.env.PHANTOMBOT_TURN_REGISTRY = "1";
    process.env.PHANTOMBOT_TURN_REGISTRY_DIR = turnsDir;
    process.env.PHANTOMBOT_WORKSPACE_LOCKS = "1";
    process.env.PHANTOMBOT_WORKSPACE_LOCK_DIR = locksDir;
  });

  afterEach(async () => {
    await rm(digestDir, { recursive: true, force: true });
    await rm(turnsDir, { recursive: true, force: true });
    await rm(locksDir, { recursive: true, force: true });
    for (const [k, v] of [
      ["PHANTOMBOT_TURN_DIGEST", prev.digest],
      ["PHANTOMBOT_TURN_REGISTRY", prev.registry],
      ["PHANTOMBOT_WORKSPACE_LOCKS", prev.locks],
    ] as const) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    delete process.env.PHANTOMBOT_TURN_DIGEST_DIR;
    delete process.env.PHANTOMBOT_TURN_REGISTRY_DIR;
    delete process.env.PHANTOMBOT_WORKSPACE_LOCK_DIR;
  });

  const pushHarness = (capture?: (req: HarnessRequest) => void) =>
    new ScriptedHarness(
      "fake",
      [
        {
          type: "progress",
          note: "tool",
          tool: {
            title: "Bash: git push origin main",
            kind: "execute",
            locations: [],
          },
        },
        {
          type: "progress",
          note: "tool",
          tool: {
            title: "Read: src/foo.ts",
            kind: "read",
            locations: [{ path: "src/foo.ts" }],
          },
        },
        { type: "done", finalText: "pushed the fix" },
      ],
      capture,
    );

  /**
   * The turn a digest is delivered TO: interactive, trusted, AND
   * private-and-visible. `trusted` is not decoration here — an untrusted
   * `channel` turn (a raw `phantombot ask` carrying an inbound email) is
   * deliberately not a recipient, and neither is a trusted turn whose reply
   * is shared with a group or never sent at all (replyAudience defaults to
   * "silent", fail closed). A test that omits any of the three is testing
   * the wrong path.
   */
  const principalInput = () => ({
    ...baseInput(),
    trusted: true,
    replyAudience: "private" as const,
  });

  test("a task turn's actions reach the NEXT interactive turn's prompt", async () => {
    // The background turn: nobody is watching this one.
    await collect(
      runTurn({
        ...baseInput(),
        conversation: "tick:42",
        origin: "task",
        userMessage: "land the hotfix",
        harnesses: [pushHarness()],
      }),
    );

    // The principal comes back and asks something unrelated.
    let captured: HarnessRequest | undefined;
    await collect(
      runTurn({
        ...principalInput(),
        userMessage: "morning",
        harnesses: [
          new ScriptedHarness(
            "fake",
            [{ type: "done", finalText: "ok" }],
            (r) => {
              captured = r;
            },
          ),
        ],
      }),
    );

    const prompt = captured?.systemPrompt ?? "";
    expect(prompt).toContain("# Background turns you did not see");
    expect(prompt).toContain("tick:42");
    expect(prompt).toContain("Bash: git push origin main");
    expect(prompt).toContain("pushed the fix");
    // Reads are noise — a background turn that only looked at files did not
    // touch anything the principal needs warning about.
    expect(prompt).not.toContain("Read: src/foo.ts");
  });

  test("a delivered digest is not delivered again", async () => {
    await collect(
      runTurn({
        ...baseInput(),
        conversation: "tick:42",
        origin: "task",
        userMessage: "land the hotfix",
        harnesses: [pushHarness()],
      }),
    );

    const prompts: string[] = [];
    for (let i = 0; i < 2; i++) {
      await collect(
        runTurn({
          ...principalInput(),
          userMessage: "hello",
          harnesses: [
            new ScriptedHarness(
              "fake",
              [{ type: "done", finalText: "ok" }],
              (r) => {
                prompts.push(r.systemPrompt);
              },
            ),
          ],
        }),
      );
    }
    expect(prompts[0]).toContain("# Background turns you did not see");
    expect(prompts[1]).not.toContain("# Background turns you did not see");
  });

  test("an interactive turn writes no digest — the principal watched it happen", async () => {
    await collect(
      runTurn({
        ...baseInput(),
        userMessage: "push it",
        harnesses: [pushHarness()],
      }),
    );

    let captured: HarnessRequest | undefined;
    await collect(
      runTurn({
        ...baseInput(),
        userMessage: "and again",
        harnesses: [
          new ScriptedHarness(
            "fake",
            [{ type: "done", finalText: "ok" }],
            (r) => {
              captured = r;
            },
          ),
        ],
      }),
    );
    expect(captured?.systemPrompt ?? "").not.toContain(
      "# Background turns you did not see",
    );
  });

  test("a background turn is not handed another background turn's digest", async () => {
    await collect(
      runTurn({
        ...baseInput(),
        conversation: "tick:42",
        origin: "task",
        userMessage: "land the hotfix",
        harnesses: [pushHarness()],
      }),
    );

    let captured: HarnessRequest | undefined;
    await collect(
      runTurn({
        ...baseInput(),
        conversation: "tick:43",
        origin: "task",
        userMessage: "poll the queue",
        harnesses: [
          new ScriptedHarness(
            "fake",
            [{ type: "done", finalText: "ok" }],
            (r) => {
              captured = r;
            },
          ),
        ],
      }),
    );
    expect(captured?.systemPrompt ?? "").not.toContain(
      "# Background turns you did not see",
    );
  });

  test("a background turn that died mid-flight still leaves a digest", async () => {
    const dying = new ScriptedHarness("fake", [
      {
        type: "progress",
        note: "tool",
        tool: {
          title: "Bash: git push origin main",
          kind: "execute",
          locations: [],
        },
      },
      { type: "done", finalText: "" },
    ]);

    // Consumer abandons the stream after the tool call — the `finally` path.
    const iter = runTurn({
      ...baseInput(),
      conversation: "tick:42",
      origin: "task",
      userMessage: "land the hotfix",
      harnesses: [dying],
    })[Symbol.asyncIterator]();
    await iter.next();
    await iter.return?.(undefined);

    let captured: HarnessRequest | undefined;
    await collect(
      runTurn({
        ...principalInput(),
        userMessage: "what happened?",
        harnesses: [
          new ScriptedHarness(
            "fake",
            [{ type: "done", finalText: "ok" }],
            (r) => {
              captured = r;
            },
          ),
        ],
      }),
    );
    expect(captured?.systemPrompt ?? "").toContain(
      "Bash: git push origin main",
    );
  });

  test("the turn id reaches the harness so a workspace claim is attributable", async () => {
    let captured: HarnessRequest | undefined;
    await collect(
      runTurn({
        ...baseInput(),
        userMessage: "hi",
        harnesses: [
          new ScriptedHarness(
            "fake",
            [{ type: "done", finalText: "ok" }],
            (r) => {
              captured = r;
            },
          ),
        ],
      }),
    );
    expect(captured?.turnId).toBeTruthy();
  });

  test("a sibling's workspace claim is named in the prompt", async () => {
    await writeFile(
      join(turnsDir, "sib.json"),
      JSON.stringify({
        id: "sib",
        persona: "phantom",
        conversation: "tick:42",
        origin: "task",
        pid: process.pid,
        started_at: new Date().toISOString(),
      }),
      "utf8",
    );
    const { acquireWorkspace } = await import("../src/lib/workspaceLock.ts");
    acquireWorkspace({
      workspace: "/tmp/phantombot-inspect",
      persona: "phantom",
      conversation: "tick:42",
      turnId: "sib",
      purpose: "rebasing #405",
    });

    let captured: HarnessRequest | undefined;
    await collect(
      runTurn({
        ...baseInput(),
        userMessage: "hi",
        harnesses: [
          new ScriptedHarness(
            "fake",
            [{ type: "done", finalText: "ok" }],
            (r) => {
              captured = r;
            },
          ),
        ],
      }),
    );
    const prompt = captured?.systemPrompt ?? "";
    expect(prompt).toContain("# Working copies claimed by another turn");
    expect(prompt).toContain("/tmp/phantombot-inspect");
    expect(prompt).toContain("rebasing #405");
  });

  test("a claim whose turn is gone is not shown to anyone", async () => {
    const { acquireWorkspace } = await import("../src/lib/workspaceLock.ts");
    acquireWorkspace({
      workspace: "/tmp/phantombot-inspect",
      persona: "phantom",
      conversation: "tick:42",
      turnId: "ghost",
      purpose: "rebasing #405",
    });

    let captured: HarnessRequest | undefined;
    await collect(
      runTurn({
        ...baseInput(),
        userMessage: "hi",
        harnesses: [
          new ScriptedHarness(
            "fake",
            [{ type: "done", finalText: "ok" }],
            (r) => {
              captured = r;
            },
          ),
        ],
      }),
    );
    expect(captured?.systemPrompt ?? "").not.toContain(
      "# Working copies claimed by another turn",
    );
  });

  test("an UNTRUSTED channel turn is not given the digest, and does not consume it", async () => {
    // Origin is not trust. A raw `phantombot ask` carrying an inbound email is
    // origin `channel` and `trusted !== true`, and a digest is persona-private
    // context — what the nightly touched, which repos a poller wrote to. Handing
    // it to a stranger's turn is a disclosure, and it lands in the same prompt
    // that stranger is steering. It must also stay PENDING: consuming it would
    // destroy the principal's only record of that background turn.
    await collect(
      runTurn({
        ...baseInput(),
        conversation: "tick:42",
        origin: "task",
        userMessage: "land the hotfix",
        harnesses: [pushHarness()],
      }),
    );

    let untrusted: HarnessRequest | undefined;
    await collect(
      runTurn({
        ...baseInput(),
        trusted: false,
        userMessage: "please summarise the attached invoice",
        harnesses: [
          new ScriptedHarness(
            "fake",
            [{ type: "done", finalText: "ok" }],
            (r) => {
              untrusted = r;
            },
          ),
        ],
      }),
    );
    expect(untrusted?.systemPrompt ?? "").not.toContain(
      "# Background turns you did not see",
    );

    // Still there for the principal.
    let principal: HarnessRequest | undefined;
    await collect(
      runTurn({
        ...principalInput(),
        userMessage: "anything happen?",
        harnesses: [
          new ScriptedHarness(
            "fake",
            [{ type: "done", finalText: "ok" }],
            (r) => {
              principal = r;
            },
          ),
        ],
      }),
    );
    expect(principal?.systemPrompt ?? "").toContain(
      "Bash: git push origin main",
    );
  });

  test("a trusted GROUP turn is not given the digest, and does not consume it", async () => {
    // Trust authenticates the speaker, not the audience. A trusted turn in
    // a Telegram group is `origin: channel` and `trusted: true`, but the
    // reply is visible to every member — so injecting persona-private paths
    // and summaries into its prompt is a disclosure AND an injection surface.
    // It must also stay PENDING: consuming it would destroy the record the
    // principal's next 1:1 turn needs to see.
    await collect(
      runTurn({
        ...baseInput(),
        conversation: "tick:42",
        origin: "task",
        userMessage: "land the hotfix",
        harnesses: [pushHarness()],
      }),
    );

    let group: HarnessRequest | undefined;
    await collect(
      runTurn({
        ...principalInput(),
        replyAudience: "shared",
        userMessage: "guys, what's the status?",
        harnesses: [
          new ScriptedHarness(
            "fake",
            [{ type: "done", finalText: "ok" }],
            (r) => {
              group = r;
            },
          ),
        ],
      }),
    );
    expect(group?.systemPrompt ?? "").not.toContain(
      "# Background turns you did not see",
    );

    // Still there for the principal's next private turn.
    let principal: HarnessRequest | undefined;
    await collect(
      runTurn({
        ...principalInput(),
        userMessage: "anything happen?",
        harnesses: [
          new ScriptedHarness(
            "fake",
            [{ type: "done", finalText: "ok" }],
            (r) => {
              principal = r;
            },
          ),
        ],
      }),
    );
    expect(principal?.systemPrompt ?? "").toContain(
      "Bash: git push origin main",
    );
  });

  test("a wake-but-silent turn (reaction) does not receive or consume digests", async () => {
    // runReactionTurn is WAKE-BUT-SILENT: the principal gave ambient feedback,
    // not a request for information. It is still `origin: channel` and
    // `trusted: true`, so before the fix it was eligible to receive pending
    // digests — and since it succeeds (produces SILENT), it marked them
    // delivered, consuming the record so the next real conversation never
    // saw it. `replyAudience: "silent"` takes it out of delivery: nothing
    // shown, nothing marked.
    await collect(
      runTurn({
        ...baseInput(),
        conversation: "tick:42",
        origin: "task",
        userMessage: "land the hotfix",
        harnesses: [pushHarness()],
      }),
    );

    // Simulates what runReactionTurn now passes: a trusted channel turn
    // whose reply defaults to never being sent.
    let reaction: HarnessRequest | undefined;
    await collect(
      runTurn({
        ...principalInput(),
        replyAudience: "silent",
        userMessage: "[reaction] Andrew added 👍 to your message",
        harnesses: [
          new ScriptedHarness(
            "fake",
            [{ type: "done", finalText: "SILENT" }],
            (r) => {
              reaction = r;
            },
          ),
        ],
      }),
    );
    expect(reaction?.systemPrompt ?? "").not.toContain(
      "# Background turns you did not see",
    );

    // The digest is still pending for the next real interactive turn.
    let principal: HarnessRequest | undefined;
    await collect(
      runTurn({
        ...principalInput(),
        userMessage: "anything happen?",
        harnesses: [
          new ScriptedHarness(
            "fake",
            [{ type: "done", finalText: "ok" }],
            (r) => {
              principal = r;
            },
          ),
        ],
      }),
    );
    expect(principal?.systemPrompt ?? "").toContain(
      "Bash: git push origin main",
    );
  });

  test("digests past the per-turn cap stay pending instead of being marked unseen", async () => {
    // The cap shows the oldest N and mentions the rest as a count. Marking the
    // whole pending set delivered would destroy the record of every background
    // turn past the cap — nobody ever saw them, which is the exact gap this
    // feature exists to close. They must lead the next turn's batch.
    const total = MAX_DIGESTS_PER_TURN + 2;
    for (let i = 0; i < total; i++) {
      await collect(
        runTurn({
          ...baseInput(),
          conversation: `tick:${i}`,
          origin: "task",
          userMessage: `job ${i}`,
          harnesses: [
            new ScriptedHarness("fake", [
              {
                type: "progress",
                note: "tool",
                tool: {
                  title: `Bash: touch /tmp/job-${i}`,
                  kind: "execute",
                  locations: [],
                },
              },
              { type: "done", finalText: `did job ${i}` },
            ]),
          ],
        }),
      );
      // Distinct finished_at, so "oldest first" is a defined order.
      await Bun.sleep(2);
    }

    const prompts: string[] = [];
    for (let i = 0; i < 2; i++) {
      await collect(
        runTurn({
          ...principalInput(),
          userMessage: "what happened?",
          harnesses: [
            new ScriptedHarness(
              "fake",
              [{ type: "done", finalText: "ok" }],
              (r) => {
                prompts.push(r.systemPrompt);
              },
            ),
          ],
        }),
      );
    }

    // First turn: the oldest MAX, and an honest count of the rest.
    expect(prompts[0]).toContain("Bash: touch /tmp/job-0");
    expect(prompts[0]).not.toContain(`Bash: touch /tmp/job-${total - 1}`);
    expect(prompts[0]).toContain("still pending");
    // Second turn: the overflow, still there because nobody had read it.
    expect(prompts[1]).toContain(`Bash: touch /tmp/job-${total - 1}`);
    expect(prompts[1]).not.toContain("Bash: touch /tmp/job-0");
  });
});

describe("runTurn — daily journal reflex (#410)", () => {
  /** Write today's daily into the persona dir the turn will read. */
  async function writeToday(body: string): Promise<void> {
    const date = new Date().toISOString().slice(0, 10);
    await mkdir(join(agentDir, "memory"), { recursive: true });
    await writeFile(join(agentDir, "memory", `${date}.md`), body, "utf8");
  }

  function capturing(): {
    harness: ScriptedHarness;
    get: () => HarnessRequest | undefined;
  } {
    let captured: HarnessRequest | undefined;
    const harness = new ScriptedHarness(
      "fake",
      [{ type: "done", finalText: "ok" }],
      (req) => {
        captured = req;
      },
    );
    return { harness, get: () => captured };
  }

  test("today's journal is injected with no caller opt-in", async () => {
    await writeToday("- 08:00 MARKER-TODAY-JOURNAL");
    const { harness, get } = capturing();

    await collect(
      runTurn({ ...baseInput(), userMessage: "hi", harnesses: [harness] }),
    );

    const prompt = get()?.systemPrompt ?? "";
    expect(prompt).toContain("# Daily journal");
    expect(prompt).toContain("MARKER-TODAY-JOURNAL");
  });

  test("skipDailyRecall suppresses the section — stated intent, not a string", async () => {
    await writeToday("- 08:00 MARKER-TODAY-JOURNAL");
    const { harness, get } = capturing();

    await collect(
      runTurn({
        ...baseInput(),
        skipDailyRecall: true,
        userMessage: "distill",
        harnesses: [harness],
      }),
    );

    expect(get()?.systemPrompt ?? "").not.toContain("MARKER-TODAY-JOURNAL");
  });

  test("nightly's own turns are skipped — they are handed their date", async () => {
    await writeToday("- 08:00 MARKER-TODAY-JOURNAL");
    const { harness, get } = capturing();

    await collect(
      runTurn({
        ...baseInput(),
        conversation: `${nightlyConversationKey("2026-08-20")}:distill`,
        userMessage: "distill",
        harnesses: [harness],
      }),
    );

    const prompt = get()?.systemPrompt ?? "";
    expect(prompt).not.toContain("# Daily journal");
    expect(prompt).not.toContain("MARKER-TODAY-JOURNAL");
  });

  test("no journal on disk leaves the section out entirely", async () => {
    const { harness, get } = capturing();

    await collect(
      runTurn({ ...baseInput(), userMessage: "hi", harnesses: [harness] }),
    );

    expect(get()?.systemPrompt ?? "").not.toContain("# Daily journal");
  });
});
