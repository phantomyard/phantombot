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

import { runBridgeTurn } from "../src/connectors/acp/turnBridge.ts";
import { runTurn } from "../src/orchestrator/turn.ts";
import { type MemoryStore, openMemoryStore } from "../src/memory/store.ts";
import {
  ANSWER_LENGTH_INSTRUCTION,
  ARE_YOU_SURE_INSTRUCTION,
  CONFIRM_BEFORE_LONG_JOBS_INSTRUCTION,
} from "../src/persona/builder.ts";
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
    // The owner is on the line by default: the confirm gate is for turns the
    // OWNER can answer. Untrusted cases override this explicitly.
    trusted: true,
    ...extra,
  } as Parameters<typeof runTurn>[0])) {
    // drain
  }
  return harness.lastRequest?.systemPrompt ?? "";
}

/**
 * A real ACP editor turn — driven through the connector's own bridge, not
 * through runTurn with an `acp:` conversation id. The bridge is what sets
 * `trusted`/`replyAudience` and (deliberately) leaves `origin` alone, so
 * only this path proves an editor turn actually receives the gate.
 */
async function acpBridgePrompt(): Promise<string> {
  const harness = new CapturingHarness();
  await runBridgeTurn(
    {
      persona: "phantom",
      conversation: "acp:abc123",
      userMessage: "refactor the parser",
      agentDir,
      workingDir: agentDir,
      harnesses: [harness],
      memory,
      idleTimeoutMs: 1_000,
      hardTimeoutMs: 5_000,
    },
    { text: () => {}, progress: () => {}, replay: () => {} },
  );
  return harness.lastRequest?.systemPrompt ?? "";
}

describe("confirm-before-long-jobs overlay", () => {
  test("an ACP editor turn gets the same gate a chat turn gets", async () => {
    const prompt = await acpBridgePrompt();
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

  test("the 50-word rule yields to a stricter rule (e.g. voice)", async () => {
    const prompt = await promptFor({});
    expect(prompt).toContain("This is a CEILING, never a licence to write more");
  });

  test("withheld from a nightly / internal turn — nobody is there to answer", async () => {
    const prompt = await promptFor({ origin: "internal" });
    expect(prompt).not.toContain("Confirm before long jobs");
  });

  test("withheld from a scheduled task wake", async () => {
    const prompt = await promptFor({ origin: "task" });
    expect(prompt).not.toContain("Confirm before long jobs");
  });

  test("withheld from a notification turn", async () => {
    const prompt = await promptFor({ origin: "notification" });
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

  // One gate per channel. An UNTRUSTED turn with an interactive origin is an
  // email- or webhook-woken `phantombot ask`: the threat judge already passed
  // it and the owner is not on the line, so "outline your plan and STOP" (or
  // "ask once before deleting") would stall autonomous work behind a second
  // gate nobody can open.
  test("withheld from an untrusted turn — the judge is the gate there, and nobody can answer", async () => {
    const prompt = await promptFor({ trusted: false }, "cli:ask");
    expect(prompt).not.toContain("Confirm before long jobs");
    expect(prompt).not.toContain("Are you sure?");
    expect(prompt).not.toContain(ARE_YOU_SURE_INSTRUCTION);
  });

  test("an untrusted turn a human reads still gets the answer-length rule", async () => {
    const prompt = await promptFor({ trusted: false }, "cli:ask");
    expect(prompt).toContain(ANSWER_LENGTH_INSTRUCTION);
  });
});

describe("the 'Are you sure?' prompt — the owner's second chance", () => {
  test("rides with the confirm gate on a trusted interactive turn", async () => {
    const prompt = await promptFor({});
    expect(CONFIRM_BEFORE_LONG_JOBS_INSTRUCTION).toContain(
      ARE_YOU_SURE_INSTRUCTION,
    );
    expect(prompt).toContain(ARE_YOU_SURE_INSTRUCTION);
  });

  test("withheld from nightly, which is trusted but has nobody on the line", async () => {
    const prompt = await promptFor({ origin: "internal" });
    expect(prompt).not.toContain("Are you sure?");
  });

  test("is the ONE irreversibility rule — the confirm list no longer carries its own", () => {
    expect(CONFIRM_BEFORE_LONG_JOBS_INSTRUCTION).not.toContain(
      "cannot easily undo",
    );
  });

  test("is narrow: irreversible damage asks, reversible work does not", () => {
    expect(ARE_YOU_SURE_INSTRUCTION).toMatch(/CANNOT be undone/);
    expect(ARE_YOU_SURE_INSTRUCTION).toMatch(/brick you/);
    // Pushing code and editing config were on the old ESCALATE list; here
    // they are named as things this rule never asks about.
    expect(ARE_YOU_SURE_INSTRUCTION).toMatch(
      /commits, pushes to\s+a branch, merges, config edits you backed up/,
    );
    expect(ARE_YOU_SURE_INSTRUCTION).toMatch(/not this\s+rule's business/);
  });

  test("asks once per job, and is not waived by a blanket go-ahead", () => {
    expect(ARE_YOU_SURE_INSTRUCTION).toMatch(/ask once/);
    expect(ARE_YOU_SURE_INSTRUCTION).toMatch(/do not ask again\s+for that job/);
    expect(ARE_YOU_SURE_INSTRUCTION).toMatch(/does not cover this/);
  });
});
