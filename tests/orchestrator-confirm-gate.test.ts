/**
 * Tests for the channel-agnostic plan-then-confirm overlay
 * (CONFIRM_BEFORE_LONG_JOBS_INSTRUCTION, AGENTS invariant 29).
 *
 * The point of the block is that it is NOT a channel suffix: it comes from
 * the orchestrator, so an ACP editor turn and a bare `phantombot ask` turn
 * see exactly what a Telegram turn sees. These tests pin that, and pin the
 * three withholdings — nightly, task wakes and silent reaction turns can't
 * answer a question, so they must not be told to stop and ask one.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { runTurn } from "../src/orchestrator/turn.ts";
import { type MemoryStore, openMemoryStore } from "../src/memory/store.ts";
import { CONFIRM_BEFORE_LONG_JOBS_INSTRUCTION } from "../src/persona/builder.ts";
import type {
  Harness,
  HarnessChunk,
  HarnessRequest,
} from "../src/harnesses/types.ts";

let agentDir: string;
let memory: MemoryStore;

beforeEach(async () => {
  agentDir = await mkdtemp(join(tmpdir(), "phantombot-confirm-"));
  await writeFile(join(agentDir, "BOOT.md"), "# I am Phantom", "utf8");
  memory = await openMemoryStore(":memory:");
});

afterEach(async () => {
  await memory.close();
  await rm(agentDir, { recursive: true, force: true });
});

class CapturingHarness implements Harness {
  readonly id = "fake";
  lastRequest?: HarnessRequest;
  async available(): Promise<boolean> {
    return true;
  }
  async *invoke(req: HarnessRequest): AsyncGenerator<HarnessChunk> {
    this.lastRequest = req;
    yield { type: "done", finalText: "ok" };
  }
}

async function promptFor(
  extra: Record<string, unknown>,
  conversation = "acp:abc123",
): Promise<string> {
  const harness = new CapturingHarness();
  for await (const _ of runTurn({
    persona: "phantom",
    conversation,
    agentDir,
    workingDir: agentDir,
    memory,
    idleTimeoutMs: 1_000,
    hardTimeoutMs: 5_000,
    userMessage: "refactor the parser",
    harnesses: [harness],
    ...extra,
  } as Parameters<typeof runTurn>[0])) {
    // drain
  }
  return harness.lastRequest?.systemPrompt ?? "";
}

describe("confirm-before-long-jobs overlay", () => {
  test("an ACP editor turn gets the same gate a chat turn gets", async () => {
    const prompt = await promptFor({ trusted: true });
    expect(prompt).toContain(CONFIRM_BEFORE_LONG_JOBS_INSTRUCTION);
  });

  test("a plain CLI turn gets it too — the gate is not channel-scoped", async () => {
    const prompt = await promptFor({}, "cli:default");
    expect(prompt).toContain("Confirm before long jobs");
  });

  test("the threshold is more than three tool calls, not more than one", async () => {
    const prompt = await promptFor({});
    expect(prompt).toContain("more than three tool calls");
    expect(prompt).not.toContain("more than one tool call");
  });

  test("the block says the user can override it — #443's complaint", async () => {
    const prompt = await promptFor({});
    expect(prompt).toContain("This is a default, not a cage");
    expect(prompt).toMatch(/rest of the conversation/);
  });

  test("the 50-word answer-length rule travels with it", async () => {
    const prompt = await promptFor({});
    expect(prompt).toContain("Answer length");
    expect(prompt).toContain("50 words or");
  });

  test("withheld from a nightly / internal turn — nobody is there to answer", async () => {
    const prompt = await promptFor({ origin: "internal" });
    expect(prompt).not.toContain("Confirm before long jobs");
  });

  test("withheld from a scheduled task wake", async () => {
    const prompt = await promptFor({ origin: "task" });
    expect(prompt).not.toContain("Confirm before long jobs");
  });

  test("withheld from a wake-but-silent reaction turn", async () => {
    const prompt = await promptFor({ replyAudience: "silent" });
    expect(prompt).not.toContain("Confirm before long jobs");
  });

  test("still applied to a shared (group) turn — the humans there can answer", async () => {
    const prompt = await promptFor({ replyAudience: "shared" });
    expect(prompt).toContain("Confirm before long jobs");
  });
});
