/**
 * The Jev flow (issue #597): the frictionless rule is the headline — a user
 * with an existing OpenRouter key configures Jev with NO token prompt and
 * nothing new stored. Also: provider-first ordering, independent consumers,
 * validation gating, and esc-cancels-everything.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { configureDecisionModel, type DecisionModelFlowDeps } from "../src/tui/decisionModelFlow.ts";
import type { DecisionModelSettings } from "../src/config.ts";

interface Asked {
  chooses: { title: string; options: string[]; initial?: string }[];
  values: string[];
}

/**
 * A scripted question harness. `script` holds the choose() answers IN ORDER;
 * value() answers `typed` (or the per-call queue in `typedQueue`). Every
 * question is recorded so tests can assert what was — and was NOT — asked.
 */
function fakeQ(script: string[], typed: (string | undefined)[] = []) {
  const asked: Asked = { chooses: [], values: [] };
  const chooses = [...script];
  const values = [...typed];
  const q = {
    choose: async (input: {
      title: string;
      initial?: string;
      options: readonly { value: string; label: string; hint?: string }[];
    }) => {
      asked.chooses.push({
        title: input.title,
        options: input.options.map((o) => o.value),
        initial: input.initial,
      });
      return chooses.shift();
    },
    value: async (input: { title: string }) => {
      asked.values.push(input.title);
      return values.shift();
    },
  };
  return { q, asked };
}

const EMBED_KEY_ENV = "PHANTOMBOT_OPENAI_COMPATIBLE_API_KEY";
const savedEmbedKey = process.env[EMBED_KEY_ENV];
const savedDecisionModelKey = process.env.PHANTOMBOT_JEV_API_KEY;

beforeEach(() => {
  process.env[EMBED_KEY_ENV] = "sk-or-embeddings";
  process.env.PHANTOMBOT_JEV_API_KEY = "sk-jev-stored";
});

afterEach(() => {
  if (savedEmbedKey === undefined) delete process.env[EMBED_KEY_ENV];
  else process.env[EMBED_KEY_ENV] = savedEmbedKey;
  if (savedDecisionModelKey === undefined) delete process.env.PHANTOMBOT_JEV_API_KEY;
  else process.env.PHANTOMBOT_JEV_API_KEY = savedDecisionModelKey;
});

function deps(overrides: Partial<DecisionModelFlowDeps> = {}): DecisionModelFlowDeps {
  return {
    existing: undefined,
    reusableKeys: [
      { env: EMBED_KEY_ENV, label: "the OpenRouter key already used for embeddings" },
    ],
    validate: async () => ({ ok: true }),
    ...overrides,
  };
}

describe("configureDecisionModel — frictionless OpenRouter reuse", () => {
  test("an existing key means NO token prompt and nothing new stored", async () => {
    const { q, asked } = fakeQ([
      "openrouter",
      `reuse:${EMBED_KEY_ENV}`,
      "both",
    ]);
    const r = await configureDecisionModel("robbie", q as never, deps());
    expect(r).toBeDefined();
    expect("rejected" in r!).toBe(false);
    if (r && "update" in r) {
      expect(r.update.provider).toBe("openrouter");
      expect(r.update.keyEnv).toBe(EMBED_KEY_ENV);
      expect(r.update.apiKey).toBeUndefined(); // nothing new stored
      expect(r.update.judge).toEqual({ enabled: true });
      expect(r.update.router).toEqual({ enabled: true });
      expect(r.summary).toContain(`reusing ${EMBED_KEY_ENV}`);
    }
    // Provider FIRST, then credential, then consumers — three screens, no
    // mode step (an enabled consumer decides), and not a single value
    // (token/URL) prompt anywhere.
    expect(asked.values).toHaveLength(0);
    expect(asked.chooses.map((c) => c.title)).toEqual([
      "Decision model for robbie",
      "OpenRouter credential for robbie",
      "What should the decision model do for robbie?",
    ]);
    // The reusable key is the DEFAULT.
    expect(asked.chooses[1]!.initial).toBe(`reuse:${EMBED_KEY_ENV}`);
  });

  test("with nothing to reuse, the token prompt appears and the key is stored", async () => {
    const { q, asked } = fakeQ(
      ["openrouter", "new", "router"],
      ["sk-or-typed"],
    );
    const r = await configureDecisionModel(
      "robbie",
      q as never,
      deps({ reusableKeys: [] }),
    );
    expect(r && "update" in r).toBe(true);
    if (r && "update" in r) {
      expect(r.update.apiKey).toBe("sk-or-typed");
      expect(r.update.keyEnv).toBe("PHANTOMBOT_JEV_API_KEY");
      expect(r.update.judge.enabled).toBe(false);
      expect(r.update.router).toEqual({ enabled: true });
    }
    expect(asked.values).toHaveLength(1);
  });

  test("validation runs even on a reused key, and a failure rejects", async () => {
    let validatedWith = "";
    const { q } = fakeQ(["openrouter", `reuse:${EMBED_KEY_ENV}`, "both"]);
    const r = await configureDecisionModel(
      "robbie",
      q as never,
      deps({
        validate: async (s) => {
          validatedWith = s.apiKey;
          return { ok: false, error: "401 Unauthorized" };
        },
      }),
    );
    expect(validatedWith).toBe("sk-or-embeddings");
    expect(r && "rejected" in r && r.rejected).toContain("401");
  });
});

describe("configureDecisionModel — direct TypeSafe", () => {
  test("asks for endpoint and token on a fresh setup", async () => {
    const { q, asked } = fakeQ(
      ["typesafe", "both"],
      ["https://ts.example/v1", "ts-token-1"],
    );
    const r = await configureDecisionModel("robbie", q as never, deps());
    expect(r && "update" in r).toBe(true);
    if (r && "update" in r) {
      expect(r.update.provider).toBe("typesafe");
      expect(r.update.baseUrl).toBe("https://ts.example/v1");
      expect(r.update.apiKey).toBe("ts-token-1");
      expect(r.update.judge.enabled).toBe(true);
    }
    expect(asked.values).toHaveLength(2);
  });

  test("an existing TypeSafe token is offered back, keep stores nothing", async () => {
    const existing: DecisionModelSettings = {
      provider: "typesafe",
      model: "typesafe/jev-1.13",
      baseUrl: "https://api.typesafe.ai/v1",
      keyEnv: "PHANTOMBOT_JEV_API_KEY",
      judge: { enabled: true, timeoutMs: 1500, threshold: 80, failClosed: false },
      router: { enabled: false, timeoutMs: 300 },
    };
    const { q, asked } = fakeQ(
      ["typesafe", "keep", "judge"],
      ["https://api.typesafe.ai/v1"],
    );
    const r = await configureDecisionModel("robbie", q as never, deps({ existing }));
    expect(r && "update" in r).toBe(true);
    if (r && "update" in r) {
      expect(r.update.apiKey).toBeUndefined();
      expect(r.update.keyEnv).toBe("PHANTOMBOT_JEV_API_KEY");
    }
    // Only the base-URL box — no token prompt on keep.
    expect(asked.values).toHaveLength(1);
  });
});

describe("configureDecisionModel — off, consumers and cancel", () => {
  test("off disables both consumers and keeps the block for re-enabling", async () => {
    const existing: DecisionModelSettings = {
      provider: "openrouter",
      model: "typesafe/jev-1.13",
      baseUrl: "https://openrouter.ai/api/v1",
      keyEnv: "PHANTOMBOT_JEV_API_KEY",
      judge: { enabled: true, timeoutMs: 1500, threshold: 80, failClosed: false },
      router: { enabled: true, timeoutMs: 300 },
    };
    const { q } = fakeQ(["off"]);
    const r = await configureDecisionModel("robbie", q as never, deps({ existing }));
    expect(r && "update" in r).toBe(true);
    if (r && "update" in r) {
      expect(r.update.judge.enabled).toBe(false);
      expect(r.update.router.enabled).toBe(false);
      expect(r.summary).toContain("off");
    }
  });

  test("consumers are independent: judge only, no router", async () => {
    const { q } = fakeQ(["openrouter", `reuse:${EMBED_KEY_ENV}`, "judge"]);
    const r = await configureDecisionModel("robbie", q as never, deps());
    if (r && "update" in r) {
      expect(r.update.judge.enabled).toBe(true);
      expect(r.update.router.enabled).toBe(false);
    } else {
      throw new Error("expected an update");
    }
  });

  test("esc anywhere cancels the whole flow and writes nothing", async () => {
    const { q } = fakeQ([undefined as unknown as string]);
    const r = await configureDecisionModel("robbie", q as never, deps());
    expect(r).toBeUndefined();

    const { q: q2 } = fakeQ(["openrouter", undefined as unknown as string]);
    expect(await configureDecisionModel("robbie", q2 as never, deps())).toBeUndefined();
  });
});

describe("configureDecisionModel — an unknown vendor name is kept, never rewritten", () => {
  const existing: DecisionModelSettings = {
    provider: "openrouter",
    statedProvider: "acme",
    model: "typesafe/jev-1.13",
    baseUrl: "https://api.acme.dev/v1",
    keyEnv: "ACME_API_KEY",
    apiKey: "sk-acme",
    judge: { enabled: true, timeoutMs: 1500, threshold: 70, failClosed: false },
    router: { enabled: false, timeoutMs: 800 },
  };

  test("'Keep acme' is offered and preselected; keeping it asks nothing vendor-specific", async () => {
    const { q, asked } = fakeQ(["custom", "both"]);
    const r = await configureDecisionModel("robbie", q as never, deps({ existing }));
    expect(asked.chooses[0]?.options).toContain("custom");
    expect(asked.chooses[0]?.initial).toBe("custom");
    expect(asked.values).toHaveLength(0);
    expect(r && "update" in r).toBe(true);
    if (r && "update" in r) {
      expect(r.update.provider).toBe("openrouter");
      expect(r.update.statedProvider).toBe("acme");
      expect(r.update.baseUrl).toBe("https://api.acme.dev/v1");
      expect(r.update.keyEnv).toBe("ACME_API_KEY");
      expect(r.update.apiKey).toBeUndefined();
      expect(r.update.router.enabled).toBe(true);
      expect(r.summary.startsWith("acme")).toBe(true);
    }
  });

  test("keeping it still validates at the custom endpoint; a missing key rejects instead of prompting", async () => {
    const validated: string[] = [];
    const { q } = fakeQ(["custom", "judge"]);
    await configureDecisionModel(
      "robbie",
      q as never,
      deps({
        existing,
        validate: async (s) => {
          validated.push(s.baseUrl);
          return { ok: true };
        },
      }),
    );
    expect(validated).toEqual(["https://api.acme.dev/v1"]);

    const { q: q2, asked } = fakeQ(["custom", "judge"]);
    const r = await configureDecisionModel(
      "robbie",
      q2 as never,
      deps({ existing: { ...existing, apiKey: undefined } }),
    );
    expect(r && "rejected" in r ? r.rejected : "").toContain("ACME_API_KEY");
    expect(asked.values).toHaveLength(0);
  });

  test("off keeps the stated name too", async () => {
    const { q } = fakeQ(["off"]);
    const r = await configureDecisionModel("robbie", q as never, deps({ existing }));
    if (r && "update" in r) {
      expect(r.update.statedProvider).toBe("acme");
      expect(r.update.provider).toBe("openrouter");
    } else throw new Error("expected an update");
  });

  test("picking OpenRouter explicitly drops the stated name AND the custom endpoint", async () => {
    const { q, asked } = fakeQ(["openrouter", `reuse:${EMBED_KEY_ENV}`, "judge"]);
    const r = await configureDecisionModel("robbie", q as never, deps({ existing }));
    // Not "current": the current provider is acme, not OpenRouter.
    expect(asked.chooses[0]?.initial).toBe("custom");
    if (r && "update" in r) {
      expect(r.update.statedProvider).toBeUndefined();
      expect(r.update.provider).toBe("openrouter");
      expect(r.update.baseUrl).toBe("https://openrouter.ai/api/v1");
    } else throw new Error("expected an update");
  });
});
