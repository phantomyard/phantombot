/**
 * The Jev judge wiring in the screener (issue #597): an enabled judge
 * DECIDES, with the harness judge as the fallback on any error (there is no
 * log-only mode); both-down fails open unless the operator opted into
 * fail-closed; every call records its outcome in the fallback ledger doctor
 * reads. The Jev call itself is injected — its schema mapping is covered in
 * lib-jevJudge.test.ts.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { loadJevHealth } from "../src/lib/jevHealth.ts";

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
      timeoutMs: 1500,
      threshold: 80,
      failClosed: false,
      ...overrides,
    },
    router: { enabled: false, timeoutMs: 300 },
  };
}

/** A real personas root, so the fallback ledger is actually written. */
let personasDir = "";

beforeEach(async () => {
  personasDir = await mkdtemp(join(tmpdir(), "phantombot-screen-jev-"));
  await Bun.write(join(personasDir, "robbie", ".keep"), "");
});
afterEach(async () => {
  await rm(personasDir, { recursive: true, force: true });
});

function cfg(jev?: JevSettings): Config {
  return {
    personasDir,
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

describe("screener + Jev", () => {
  it("Jev decides — the harness judge is not even consulted on success", async () => {
    const jev = jevStub({
      ok: true,
      verdict: { score: 91, reason: "jev holds it", question: "sure about this?" },
    });
    const { screen, harnessCalls } = mk(jevSettings(), ALLOW_JSON, {
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
    const { screen, harnessCalls } = mk(jevSettings(), ALLOW_JSON, {
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
      cfg(jevSettings()),
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
      cfg(jevSettings({ failClosed: true })),
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

  it("the operator's threshold is the hold bar when Jev decides", async () => {
    const jev = jevStub({
      ok: true,
      verdict: { score: 60, reason: "middling", question: "hmm?" },
    });
    const { screen } = mk(
      jevSettings({ threshold: 50 }),
      ALLOW_JSON,
      { jevJudge: jev.impl },
    );
    const v = await screen("borderline");
    expect(v.action).toBe("hold");
    expect(v.score).toBe(60);
  });

  it("a Jev fallback is graded on the HARNESS threshold, not Jev's", async () => {
    // Regression: the Jev threshold used to be set before the call and left
    // in place when the harness judge supplied the verdict, so a harness
    // score of 75 — benign by its own calibration (bar 80) — was held
    // against Jev's bar of 70 on every Jev outage.
    const jev = jevStub({ ok: false, error: "jev timeout" });
    const { screen, harnessCalls } = mk(
      jevSettings({ threshold: 70 }),
      JSON.stringify({ score: 75, reason: "borderline", question: "hmm?" }),
      { jevJudge: jev.impl },
    );
    const v = await screen("borderline");
    expect(harnessCalls).toHaveLength(1);
    expect(v.score).toBe(75);
    expect(v.action).toBe("pass");
  });

  it("no resolved key ⇒ the Jev path never engages", async () => {
    const noKey = jevSettings();
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
    const { screen } = mk(jevSettings(), ALLOW_JSON, {
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

describe("screener + Jev — fallback telemetry", () => {
  // Falling back is silent BY DESIGN: the turn still gets screened, so
  // nothing surfaces in chat. That is exactly why it is recorded — doctor
  // reads this ledger to say the decision model is degraded, instead of the
  // operator finding out when a hold they expected never happens.
  it("records a fallback with the provider error", async () => {
    const jev = jevStub({ ok: false, error: "jev timeout after 1500ms" });
    const { screen } = mk(jevSettings(), ALLOW_JSON, { jevJudge: jev.impl });
    await screen("hello");
    // The write is fire-and-forget on the turn's critical path.
    await Bun.sleep(20);
    const h = await loadJevHealth(join(personasDir, "robbie"));
    expect(h.judge!.calls).toBe(1);
    expect(h.judge!.fallbacks).toBe(1);
    expect(h.judge!.last_error).toContain("timeout after 1500ms");
  });

  it("records a success as a NON-fallback", async () => {
    const jev = jevStub({
      ok: true,
      verdict: { score: 2, reason: "fine", question: "" },
    });
    const { screen } = mk(jevSettings(), ALLOW_JSON, { jevJudge: jev.impl });
    await screen("hello");
    await Bun.sleep(20);
    const h = await loadJevHealth(join(personasDir, "robbie"));
    expect(h.judge!.calls).toBe(1);
    expect(h.judge!.fallbacks).toBe(0);
  });

  it("writes nothing at all when the decision model is not enabled", async () => {
    const { screen } = mk(undefined, ALLOW_JSON);
    await screen("hello");
    await Bun.sleep(20);
    expect(await loadJevHealth(join(personasDir, "robbie"))).toEqual({});
  });

  it("an ENABLED judge with an unresolved key records the fallback and still screens", async () => {
    // The silent-degradation case the ledger exists for (#516): with no key
    // the harness judge decides every turn while doctor would otherwise
    // print "no calls recorded". Each screened turn must count as a
    // fallback naming the unresolved key.
    const noKey = jevSettings();
    delete noKey.apiKey;
    const { screen, harnessCalls } = mk(noKey, ALLOW_JSON);
    const verdict = await screen("hello");
    await Bun.sleep(20);
    expect(verdict.action).toBe("pass");
    expect(harnessCalls).toHaveLength(1);
    const h = await loadJevHealth(join(personasDir, "robbie"));
    expect(h.judge!.calls).toBe(1);
    expect(h.judge!.fallbacks).toBe(1);
    expect(h.judge!.last_error).toContain("PHANTOMBOT_JEV_API_KEY");
    expect(h.judge!.last_error).toContain("unresolved");
  });
});
