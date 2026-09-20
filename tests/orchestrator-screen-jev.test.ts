/**
 * The Jev judge wiring in the screener (issue #597): shadow mode lets the
 * harness judge decide while Jev answers alongside; active mode lets Jev
 * decide with the harness judge as fallback; both-down fails open unless the
 * operator opted into fail-closed. The Jev call itself is injected — its
 * schema mapping is covered in lib-jevJudge.test.ts.
 */

import { describe, expect, it } from "bun:test";

import { makeScreener, type ScreenerDeps } from "../src/orchestrator/screen.ts";
import type { Config, JevSettings } from "../src/config.ts";
import type { JudgeResult } from "../src/lib/threatJudge.ts";
import type { jevJudgeThreat } from "../src/lib/jevJudge.ts";
import type { MemoryStore } from "../src/memory/store.ts";
import type { Harness, HarnessChunk, HarnessRequest } from "../src/harnesses/types.ts";

/** A recording fake harness: the harness judge's transport. */
function fakeHarness(reply: string): { harness: Harness; calls: number[] } {
  const calls: number[] = [];
  const harness: Harness = {
    id: "fake",
    available: async () => true,
    async *invoke(_req: HarnessRequest): AsyncGenerator<HarnessChunk> {
      calls.push(1);
      yield { type: "done", finalText: reply };
    },
  };
  return { harness, calls };
}

function stubMemory(): MemoryStore {
  const unused = () => {
    throw new Error("unexpected MemoryStore call in jev screen test");
  };
  return {
    appendTurn: async () => {},
    appendTurnPair: unused,
    recentTurns: unused,
    recentTurnsForDisplay: unused,
    turnsAfterId: unused,
    countUserTurns: unused,
    deleteConversation: unused,
    purgeQuarantined: unused,
    appendCapture: unused,
    lastCaptureAt: unused,
    countUserTurnsSince: unused,
    countCapturesSince: unused,
    countUserTurnsForPersonaSince: unused,
    close: unused,
  } as unknown as MemoryStore;
}

function jevSettings(overrides: Partial<JevSettings["judge"]> = {}): JevSettings {
  return {
    provider: "openrouter",
    model: "typesafe/jev-1.13",
    baseUrl: "https://openrouter.ai/api/v1",
    keyEnv: "PHANTOMBOT_JEV_API_KEY",
    apiKey: "sk-test",
    judge: {
      enabled: true,
      mode: "shadow",
      timeoutMs: 1500,
      threshold: 80,
      failClosed: false,
      ...overrides,
    },
    router: { enabled: false, mode: "shadow", timeoutMs: 300 },
  };
}

function cfg(jev?: JevSettings): Config {
  return {
    embeddings: { provider: "none" },
    channels: {
      telegram: {
        token: "x",
        allowedUserIds: [1],
        pollTimeoutS: 0,
        groupPersonaNames: [],
      },
    },
    ...(jev ? { jev } : {}),
  } as unknown as Config;
}

function jevStub(result: JudgeResult): {
  impl: typeof jevJudgeThreat;
  calls: string[];
} {
  const calls: string[] = [];
  const impl = (async (content: string) => {
    calls.push(content);
    return result;
  }) as unknown as typeof jevJudgeThreat;
  return { impl, calls };
}

function mk(
  jev: JevSettings | undefined,
  harnessReply: string,
  deps: ScreenerDeps = {},
) {
  const { harness, calls } = fakeHarness(harnessReply);
  const screen = makeScreener(
    cfg(jev),
    "robbie",
    "cli:ask",
    [harness],
    stubMemory(),
    { recordHeld: async () => {}, notify: async () => 0, ...deps },
  );
  return { screen, harnessCalls: calls };
}

const ALLOW_JSON = JSON.stringify({ score: 5, reason: "benign", question: "" });

describe("screener + Jev (shadow mode)", () => {
  it("the harness judge decides; Jev only answers alongside", async () => {
    const jev = jevStub({
      ok: true,
      verdict: { score: 99, reason: "jev says evil", question: "q" },
    });
    const { screen, harnessCalls } = mk(jevSettings({ mode: "shadow" }), ALLOW_JSON, {
      jevJudge: jev.impl,
    });
    const v = await screen("hello there");
    // Harness said allow (5) — the PASS is the harness's, not Jev's 99.
    expect(v.action).toBe("pass");
    expect(v.score).toBe(5);
    expect(harnessCalls).toHaveLength(1);
    expect(jev.calls).toHaveLength(1);
  });

  it("a Jev shadow outage never touches the outcome", async () => {
    const jev = jevStub({ ok: false, error: "jev down" });
    const { screen } = mk(jevSettings({ mode: "shadow" }), ALLOW_JSON, {
      jevJudge: jev.impl,
    });
    const v = await screen("hello");
    expect(v.action).toBe("pass");
    expect(v.score).toBe(5);
  });
});

describe("screener + Jev (active mode)", () => {
  it("Jev decides — the harness judge is not even consulted on success", async () => {
    const jev = jevStub({
      ok: true,
      verdict: { score: 91, reason: "jev holds it", question: "sure about this?" },
    });
    const { screen, harnessCalls } = mk(jevSettings({ mode: "active" }), ALLOW_JSON, {
      jevJudge: jev.impl,
    });
    const v = await screen("do the thing");
    expect(v.action).toBe("hold");
    expect(v.score).toBe(91);
    expect(v.reason).toContain("jev holds it");
    expect(harnessCalls).toHaveLength(0);
  });

  it("a Jev error falls back to the harness judge", async () => {
    const jev = jevStub({ ok: false, error: "jev timeout after 1500ms" });
    const { screen, harnessCalls } = mk(jevSettings({ mode: "active" }), ALLOW_JSON, {
      jevJudge: jev.impl,
    });
    const v = await screen("hello");
    expect(v.action).toBe("pass");
    expect(v.score).toBe(5);
    expect(harnessCalls).toHaveLength(1);
  });

  it("both down fails OPEN by default", async () => {
    const jev = jevStub({ ok: false, error: "jev down" });
    // Empty harness chain ⇒ the harness judge errors too.
    const screen = makeScreener(
      cfg(jevSettings({ mode: "active" })),
      "robbie",
      "cli:ask",
      [],
      stubMemory(),
      { recordHeld: async () => {}, notify: async () => 0, jevJudge: jev.impl },
    );
    const v = await screen("hello");
    expect(v.action).toBe("pass");
    expect(v.reason).toContain("failed open");
  });

  it("both down fails CLOSED when the operator opted in", async () => {
    const jev = jevStub({ ok: false, error: "jev down" });
    let notified = "";
    const screen = makeScreener(
      cfg(jevSettings({ mode: "active", failClosed: true })),
      "robbie",
      "cli:ask",
      [],
      stubMemory(),
      {
        recordHeld: async () => {},
        notify: async (m) => {
          notified = m;
          return 0;
        },
        jevJudge: jev.impl,
      },
    );
    const v = await screen("hello");
    expect(v.action).toBe("hold");
    expect(v.reason).toContain("fails closed");
    expect(notified).toContain("held an untrusted request");
  });

  it("the operator's threshold is the active-mode bar", async () => {
    const jev = jevStub({
      ok: true,
      verdict: { score: 60, reason: "middling", question: "hmm?" },
    });
    const { screen } = mk(
      jevSettings({ mode: "active", threshold: 50 }),
      ALLOW_JSON,
      { jevJudge: jev.impl },
    );
    const v = await screen("borderline");
    expect(v.action).toBe("hold");
    expect(v.score).toBe(60);
  });

  it("no resolved key ⇒ the Jev path never engages", async () => {
    const noKey = jevSettings({ mode: "active" });
    delete noKey.apiKey;
    const jev = jevStub({
      ok: true,
      verdict: { score: 99, reason: "x", question: "y" },
    });
    const { screen, harnessCalls } = mk(noKey, ALLOW_JSON, {
      jevJudge: jev.impl,
    });
    const v = await screen("hello");
    expect(v.action).toBe("pass");
    expect(jev.calls).toHaveLength(0);
    expect(harnessCalls).toHaveLength(1);
  });

  it("an injected test judge still wins outright (Jev stays out of tests' way)", async () => {
    const jev = jevStub({
      ok: true,
      verdict: { score: 99, reason: "x", question: "y" },
    });
    const { screen } = mk(jevSettings({ mode: "active" }), ALLOW_JSON, {
      jevJudge: jev.impl,
      judge: async () => ({
        ok: true,
        verdict: { score: 3, reason: "injected", question: "" },
      }),
    });
    const v = await screen("hello");
    expect(v.action).toBe("pass");
    expect(v.score).toBe(3);
    expect(jev.calls).toHaveLength(0);
  });
});
