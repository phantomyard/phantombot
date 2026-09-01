import { describe, expect, test } from "bun:test";

import {
  hostedPromptCacheKey,
  PromptCacheEpochManager,
  promptCacheSecurityFingerprint,
} from "../src/orchestrator/promptCache.ts";
import type { HistoryTurn } from "../src/harnesses/types.ts";

const settings = { enabled: true, maxEpochBytes: 100_000 } as const;

const base = {
  settings,
  persona: "phantom",
  conversation: "telegram:504",
  systemPrompt: "stable system",
  trusted: true,
  userMessage: "hello",
} as const;

function turn(
  manager: PromptCacheEpochManager,
  overrides: Partial<Parameters<PromptCacheEpochManager["prepare"]>[0]> = {},
) {
  return manager.prepare({ ...base, history: [], ...overrides })!;
}

/**
 * Issue #504: a hosted provider's cache key must follow a PhantomBot context
 * epoch, never the lifetime of a chat conversation. These tests pin that as a
 * behavioural rule rather than a comment.
 */
describe("hosted prompt cache key", () => {
  test("is stable while an epoch only appends", () => {
    const manager = new PromptCacheEpochManager();
    const history: HistoryTurn[] = [];

    const first = turn(manager, { history: [...history] });
    const firstKey = hostedPromptCacheKey(first);
    expect(firstKey).toMatch(/^pb-[0-9a-f]{32}$/);
    manager.complete(first, "answer one");
    history.push(
      { role: "user", text: base.userMessage },
      { role: "assistant", text: "answer one" },
    );

    const second = turn(manager, { history: [...history], userMessage: "two" });
    expect(second.event).toBe("append");
    expect(hostedPromptCacheKey(second)).toBe(firstKey!);
    manager.complete(second, "answer two");
    history.push(
      { role: "user", text: "two" },
      { role: "assistant", text: "answer two" },
    );

    const third = turn(manager, { history: [...history], userMessage: "three" });
    expect(third.event).toBe("append");
    expect(hostedPromptCacheKey(third)).toBe(firstKey!);
  });

  test("rotates on every rebase boundary", () => {
    const rebases: Array<{
      name: string;
      next: Partial<Parameters<PromptCacheEpochManager["prepare"]>[0]>;
      expected: string;
    }> = [
      {
        name: "history_changed",
        // This is the shape /reset produces: the watermark moves, so the
        // canonical tail PhantomBot reads back no longer matches the epoch.
        next: { history: [{ role: "user", text: "unrelated" }] },
        expected: "history_changed",
      },
      {
        name: "system_changed",
        next: { systemPrompt: "different system" },
        expected: "system_changed",
      },
      {
        name: "trust_changed",
        next: { trusted: false },
        expected: "trust_changed",
      },
      {
        name: "security_changed",
        next: {
          securityFingerprint: promptCacheSecurityFingerprint({
            trusted: true,
            screening: "trusted",
            mcpMode: "none",
            tools: ["read"],
          }),
        },
        expected: "security_changed",
      },
    ];

    for (const scenario of rebases) {
      const manager = new PromptCacheEpochManager();
      const first = turn(manager);
      const firstKey = hostedPromptCacheKey(first);
      manager.complete(first, "answer");
      const history: HistoryTurn[] = [
        { role: "user", text: base.userMessage },
        { role: "assistant", text: "answer" },
      ];

      const second = turn(manager, { history, ...scenario.next });
      expect(second.event, scenario.name).toBe("rebase");
      expect(second.reason, scenario.name).toBe(scenario.expected as never);
      expect(hostedPromptCacheKey(second), scenario.name).not.toBe(firstKey!);
    }
  });

  test("rotates when a budget rebase drops the warm epoch", () => {
    const manager = new PromptCacheEpochManager();
    // A short history limit lets the epoch grow past the canonical tail the
    // store reads back, so the budget can be exceeded by the epoch alone.
    const tight = { enabled: true, maxEpochBytes: 400 } as const;
    const answer = "answer ".repeat(10);
    const history: HistoryTurn[] = [];
    let previousKey: string | undefined;
    let budgetRebases = 0;

    for (let index = 0; index < 12; index++) {
      const plan = manager.prepare({
        ...base,
        settings: tight,
        historyLimit: 2,
        history: history.slice(-2),
        userMessage: `turn ${index}`,
      })!;
      const key = hostedPromptCacheKey(plan);
      if (plan.reason === "budget") {
        budgetRebases++;
        expect(plan.retainEpoch).toBe(true);
        expect(key).not.toBe(previousKey!);
      }
      previousKey = key;
      manager.complete(plan, answer);
      history.push(
        { role: "user", text: `turn ${index}` },
        { role: "assistant", text: answer },
      );
    }

    expect(budgetRebases).toBeGreaterThan(0);
  });

  test("never reuses a key after a threat hold discards the epoch", () => {
    const manager = new PromptCacheEpochManager();
    const first = turn(manager);
    const firstKey = hostedPromptCacheKey(first);
    manager.complete(first, "answer");
    const history: HistoryTurn[] = [
      { role: "user", text: base.userMessage },
      { role: "assistant", text: "answer" },
    ];

    manager.invalidate(
      { settings, persona: base.persona, conversation: base.conversation },
      "threat_hold",
    );

    // Byte-identical history: only the fresh epoch identity prevents the
    // discarded prefix from being pinned again under its old key.
    const second = turn(manager, { history });
    expect(second.reason).toBe("no_state");
    expect(hostedPromptCacheKey(second)).not.toBe(firstKey!);
  });

  test("gives no key to a request that is not retained in an epoch", () => {
    const manager = new PromptCacheEpochManager();
    const plan = manager.prepare({
      ...base,
      settings: { enabled: true, maxEpochBytes: 5 },
      history: [],
      userMessage: "an oversized single turn",
    })!;
    expect(plan.retainEpoch).toBe(false);
    expect(hostedPromptCacheKey(plan)).toBeUndefined();
  });

  test("two personas on one conversation never share a key", () => {
    const manager = new PromptCacheEpochManager();
    const first = turn(manager);
    const firstKey = hostedPromptCacheKey(first);
    manager.complete(first, "answer");

    const other = turn(manager, { persona: "lena" });
    expect(hostedPromptCacheKey(other)).not.toBe(firstKey!);
  });

  test("leaks no persona, conversation or prompt text", () => {
    const manager = new PromptCacheEpochManager();
    const plan = turn(manager, {
      persona: "phantom",
      conversation: "telegram:7995070089",
      userMessage: "my bank details are secret",
    });
    const key = hostedPromptCacheKey(plan)!;
    for (const secret of [
      "phantom",
      "telegram",
      "7995070089",
      "bank",
      plan.epochId,
    ]) {
      expect(key).not.toContain(secret);
    }
    expect(key).toMatch(/^pb-[0-9a-f]{32}$/);
  });

  test("rejects a malformed epoch identity instead of emitting a key", () => {
    expect(
      hostedPromptCacheKey({ epochId: "not-a-digest", retainEpoch: true }),
    ).toBeUndefined();
  });
});
