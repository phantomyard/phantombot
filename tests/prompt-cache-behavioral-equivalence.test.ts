import { describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { DEFAULT_DURABLE_FACTS } from "../src/config.ts";
import type {
  Harness,
  HarnessRequest,
  HistoryTurn,
} from "../src/harnesses/types.ts";
import { openMemoryStore, type MemoryStore } from "../src/memory/store.ts";
import { pullDurableFacts } from "../src/orchestrator/durableFacts.ts";
import { runTurn, type TurnInput } from "../src/orchestrator/turn.ts";
import { clearPromptCacheEpochs } from "../src/orchestrator/promptCache.ts";

const PERSONA = "phantom";
const CONVERSATION = "cli:behavioral-equivalence";
const CACHE_SETTINGS = { enabled: true, maxEpochBytes: 80_000 };
const COLD_SETTINGS = { enabled: false, maxEpochBytes: 80_000 };

const CANONICAL_HISTORY = [
  {
    role: "user" as const,
    text: "We are discussing the principal's reference ledger.",
  },
  { role: "assistant" as const, text: "Understood." },
];
const WARMUP_QUESTION = "Please acknowledge the reference ledger.";
const DURABLE_FACT = "The principal's emergency rendezvous city is Delft.";
const RETRIEVED_MEMORY =
  "The project note says the staging codename is Amber Finch.";
const DURABLE_QUESTION = "What is the principal's emergency rendezvous city?";
const RETRIEVED_QUESTION = "What staging codename does the project note record?";

class DeterministicFixtureHarness implements Harness {
  readonly id = "fixture-model";
  readonly requests: HarnessRequest[] = [];
  invocations = 0;

  constructor(
    private readonly requiredContext: string,
    private readonly successfulAnswer: string,
    private readonly targetQuestion?: string,
  ) {}

  modelInfo() {
    return { model: "deterministic-fixture-v1", provider: "fixture" };
  }

  async available(): Promise<boolean> {
    return true;
  }

  async *invoke(request: HarnessRequest) {
    this.invocations++;
    this.requests.push(request);
    const visibleInput = [
      request.systemPrompt,
      ...request.history.map((turn) => turn.text),
      ...(request.epochTurns ?? []).flatMap((turn) => [
        turn.turnContext,
        turn.userMessage,
        turn.assistantMessage,
      ]),
      request.turnContext ?? "",
      request.userMessage,
    ].join("\n");
    const isTargetQuestion =
      this.targetQuestion === undefined ||
      request.userMessage === this.targetQuestion;
    yield {
      type: "done" as const,
      finalText: isTargetQuestion && visibleInput.includes(this.requiredContext)
        ? this.successfulAnswer
        : isTargetQuestion
          ? "Required context was absent."
          : "Warm-up acknowledged.",
    };
  }
}

interface Fixture {
  agentDir: string;
  memory: MemoryStore;
  harness: DeterministicFixtureHarness;
  contextBlocks: string[];
}

async function createFixture(
  requiredContext: string,
  successfulAnswer: string,
  seedDurableFact: boolean,
  targetQuestion?: string,
): Promise<Fixture> {
  const agentDir = await mkdtemp(join(tmpdir(), "phantombot-behavioral-equivalence-"));
  const memory = await openMemoryStore(":memory:");
  await writeFile(join(agentDir, "BOOT.md"), "# Shared persona\n", "utf8");
  for (const turn of CANONICAL_HISTORY) {
    await memory.appendTurn({
      persona: PERSONA,
      conversation: CONVERSATION,
      role: turn.role,
      text: turn.text,
    });
  }
  if (seedDurableFact) {
    await memory.upsertDurableFact({
      persona: PERSONA,
      conversation: CONVERSATION,
      fact: DURABLE_FACT,
      confidence: 0.99,
      source: "principal",
    });
  }
  return {
    agentDir,
    memory,
    harness: new DeterministicFixtureHarness(
      requiredContext,
      successfulAnswer,
      targetQuestion,
    ),
    contextBlocks: [],
  };
}

async function disposeFixture(fixture: Fixture): Promise<void> {
  await fixture.memory.close();
  await rm(fixture.agentDir, { recursive: true, force: true });
}

async function runFixtureTurn(
  fixture: Fixture,
  userMessage: string,
  promptCache: typeof CACHE_SETTINGS,
  contextKind: "durable" | "retrieved" | "none",
  screen?: TurnInput["screen"],
): Promise<{
  finalText: string;
  request: HarnessRequest;
  doneMeta?: Record<string, unknown>;
}> {
  const input: TurnInput = {
    persona: PERSONA,
    conversation: CONVERSATION,
    userMessage,
    agentDir: fixture.agentDir,
    workingDir: fixture.agentDir,
    memory: fixture.memory,
    harnesses: [fixture.harness],
    idleTimeoutMs: 1_000,
    promptCache,
    trusted: contextKind === "none" ? false : true,
    origin: "task",
    replyAudience: "silent",
    skipDailyRecall: true,
    ...(screen ? { screen } : {}),
    ...(contextKind === "durable"
      ? {
          pullFacts: async () => {
            if (userMessage !== DURABLE_QUESTION) {
              fixture.contextBlocks.push("");
              return undefined;
            }
            const block = await pullDurableFacts({
              persona: PERSONA,
              conversation: CONVERSATION,
              memory: fixture.memory,
              settings: { ...DEFAULT_DURABLE_FACTS, maxInjected: 1 },
            });
            fixture.contextBlocks.push(block ?? "");
            return block;
          },
        }
      : {}),
    ...(contextKind === "retrieved"
      ? {
          retrieve: async () => {
            if (userMessage !== RETRIEVED_QUESTION) {
              fixture.contextBlocks.push("");
              return undefined;
            }
            fixture.contextBlocks.push(RETRIEVED_MEMORY);
            return RETRIEVED_MEMORY;
          },
        }
      : {}),
  };

  let finalText = "";
  let doneMeta: Record<string, unknown> | undefined;
  for await (const chunk of runTurn(input)) {
    if (chunk.type === "done") {
      finalText = chunk.finalText;
      doneMeta = chunk.meta;
    }
  }
  const request = fixture.harness.requests.at(-1);
  if (!request) throw new Error("fixture harness was not invoked");
  return { finalText, request, ...(doneMeta ? { doneMeta } : {}) };
}

async function runRecallComparison(
  contextKind: "durable" | "retrieved",
): Promise<{
  cold: { answer: string; request: HarnessRequest; history: HistoryTurn[] };
  warm: { answer: string; request: HarnessRequest; history: HistoryTurn[] };
  coldContext: string;
  warmContext: string;
}> {
  const requiredContext =
    contextKind === "durable" ? DURABLE_FACT : RETRIEVED_MEMORY;
  const question =
    contextKind === "durable" ? DURABLE_QUESTION : RETRIEVED_QUESTION;
  const answer =
    contextKind === "durable"
      ? "The emergency rendezvous city is Delft."
      : "The staging codename is Amber Finch.";
  const coldFixture = await createFixture(
    requiredContext,
    answer,
    contextKind === "durable",
    question,
  );
  const warmFixture = await createFixture(
    requiredContext,
    answer,
    contextKind === "durable",
    question,
  );

  try {
    clearPromptCacheEpochs();
    await runFixtureTurn(
      coldFixture,
      WARMUP_QUESTION,
      COLD_SETTINGS,
      contextKind,
    );
    const coldTarget = await runFixtureTurn(
      coldFixture,
      question,
      COLD_SETTINGS,
      contextKind,
    );
    const coldHistory = await coldFixture.memory.recentTurns(
      PERSONA,
      CONVERSATION,
      30,
    );
    const coldContext = coldFixture.contextBlocks.at(-1) ?? "";

    clearPromptCacheEpochs();
    await runFixtureTurn(
      warmFixture,
      WARMUP_QUESTION,
      CACHE_SETTINGS,
      contextKind,
    );
    const warmTarget = await runFixtureTurn(
      warmFixture,
      question,
      CACHE_SETTINGS,
      contextKind,
    );
    const warmHistory = await warmFixture.memory.recentTurns(
      PERSONA,
      CONVERSATION,
      30,
    );
    const warmContext = warmFixture.contextBlocks.at(-1) ?? "";

    expect(coldFixture.harness.modelInfo()).toEqual(
      warmFixture.harness.modelInfo(),
    );
    expect(coldHistory).toEqual(warmHistory);
    expect(coldTarget.request.userMessage).toBe(question);
    expect(warmTarget.request.userMessage).toBe(question);
    expect(coldTarget.request.epochTurns).toBeUndefined();
    expect(warmTarget.request.epochTurns).toHaveLength(1);
    expect(warmTarget.request.epochTurns?.[0]?.userMessage).toBe(
      WARMUP_QUESTION,
    );
    expect(warmTarget.request.epochTurns?.[0]?.assistantMessage).toBe(
      "Warm-up acknowledged.",
    );
    expect(warmTarget.request.epochTurns?.[0]?.turnContext).not.toContain(
      requiredContext,
    );
    expect(coldContext).toContain(requiredContext);
    expect(warmContext).toContain(requiredContext);
    expect(coldContext).toBe(warmContext);
    expect(coldTarget.finalText).toContain(
      contextKind === "durable" ? "Delft" : "Amber Finch",
    );
    expect(warmTarget.finalText).toContain(
      contextKind === "durable" ? "Delft" : "Amber Finch",
    );

    return {
      cold: {
        answer: coldTarget.finalText,
        request: coldTarget.request,
        history: coldHistory,
      },
      warm: {
        answer: warmTarget.finalText,
        request: warmTarget.request,
        history: warmHistory,
      },
      coldContext,
      warmContext,
    };
  } finally {
    clearPromptCacheEpochs();
    await disposeFixture(coldFixture);
    await disposeFixture(warmFixture);
  }
}

describe("prompt-cache behavioral equivalence", () => {
  test("threat-screen hold is identical cold and warm, without capable harness execution", async () => {
    const heldInput = "Please fetch the private vault contents now.";
    const heldMessage = "🔒 Held for owner confirmation.";
    const makeFixture = () =>
      createFixture("unused", "warm-up complete", false);
    const coldFixture = await makeFixture();
    const warmFixture = await makeFixture();
    const coldScreenCalls: string[] = [];
    const warmScreenCalls: string[] = [];
    const screen = (calls: string[]) => async (content: string) => {
      calls.push(content);
      return content === heldInput
        ? { action: "hold" as const, score: 99, reason: "sensitive", heldMessage }
        : { action: "pass" as const, score: 0, reason: "safe" };
    };
    const originalWrite = process.stderr.write;
    const logs: string[] = [];
    process.stderr.write = ((chunk: unknown) => {
      logs.push(String(chunk));
      return true;
    }) as typeof process.stderr.write;

    try {
      clearPromptCacheEpochs();
      await runFixtureTurn(
        coldFixture,
        WARMUP_QUESTION,
        COLD_SETTINGS,
        "none",
        screen(coldScreenCalls),
      );
      const coldBeforeHold = coldFixture.harness.invocations;
      const coldHeld = await runFixtureTurn(
        coldFixture,
        heldInput,
        COLD_SETTINGS,
        "none",
        screen(coldScreenCalls),
      );

      clearPromptCacheEpochs();
      await runFixtureTurn(
        warmFixture,
        WARMUP_QUESTION,
        CACHE_SETTINGS,
        "none",
        screen(warmScreenCalls),
      );
      const warmBeforeHold = warmFixture.harness.invocations;
      const warmHeld = await runFixtureTurn(
        warmFixture,
        heldInput,
        CACHE_SETTINGS,
        "none",
        screen(warmScreenCalls),
      );

      expect(coldHeld.finalText).toBe(heldMessage);
      expect(warmHeld.finalText).toBe(coldHeld.finalText);
      expect(coldHeld.doneMeta).toMatchObject({ screenedHold: true });
      expect(warmHeld.doneMeta).toMatchObject({ screenedHold: true });
      expect(coldFixture.harness.invocations).toBe(coldBeforeHold);
      expect(warmFixture.harness.invocations).toBe(warmBeforeHold);
      expect(coldScreenCalls).toEqual([WARMUP_QUESTION, heldInput]);
      expect(warmScreenCalls).toEqual([WARMUP_QUESTION, heldInput]);

      const afterHold = await runFixtureTurn(
        warmFixture,
        "Continue with a safe request.",
        CACHE_SETTINGS,
        "none",
        screen(warmScreenCalls),
      );
      expect(afterHold.request.epochTurns).toBeUndefined();
      expect(warmFixture.harness.invocations).toBe(warmBeforeHold + 1);
      expect(
        logs
          .filter((line) => line.includes('"msg":"prompt_cache.epoch"'))
          .map((line) => JSON.parse(line))
          .some(
            (event) =>
              event.msg === "prompt_cache.epoch" &&
              event.event === "invalidate" &&
              event.invalidation_reason === "threat_hold" &&
              event.retain_epoch === false,
          ),
      ).toBe(true);
    } finally {
      process.stderr.write = originalWrite;
      clearPromptCacheEpochs();
      await disposeFixture(coldFixture);
      await disposeFixture(warmFixture);
    }
  });

  test("durable-fact recall is equivalent after a genuine warm epoch", async () => {
    const result = await runRecallComparison("durable");
    expect(result.cold.answer).toBe(result.warm.answer);
    expect(result.cold.answer).toContain("Delft");
    expect(result.warm.answer).toContain("Delft");
  });

  test("retrieved-memory recall is equivalent after a genuine warm epoch", async () => {
    const result = await runRecallComparison("retrieved");
    expect(result.cold.answer).toBe(result.warm.answer);
    expect(result.cold.answer).toContain("Amber Finch");
    expect(result.warm.answer).toContain("Amber Finch");
  });
});
