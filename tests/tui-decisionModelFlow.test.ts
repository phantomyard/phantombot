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

describe("configureDecisionModel — a custom vendor with NO base_url is never probed at a guessed endpoint (PR #605)", () => {
  // The shape config loads with both consumers off: an unknown vendor and
  // no base_url. `baseUrl` is absent — a transport default is NOT stood in.
  const existing: DecisionModelSettings = {
    provider: "openrouter",
    statedProvider: "acme",
    model: "acme/decision-v2",
    keyEnv: "ACME_API_KEY",
    apiKey: "sk-acme",
    judge: { enabled: false, timeoutMs: 1500, threshold: 70, failClosed: false },
    router: { enabled: false, timeoutMs: 800 },
  };

  test("keeping it asks for the endpoint and validates ONLY there — openrouter.ai never sees the key", async () => {
    const validated: { baseUrl: string; apiKey: string }[] = [];
    const { q, asked } = fakeQ(["custom", "judge"], ["https://api.acme.dev/v1/"]);
    const r = await configureDecisionModel(
      "robbie",
      q as never,
      deps({
        existing,
        validate: async (s) => {
          validated.push({ baseUrl: s.baseUrl, apiKey: s.apiKey });
          return { ok: true };
        },
      }),
    );
    expect(asked.chooses[0]?.options).toContain("custom");
    expect(asked.values).toEqual(["acme decisions API base URL (the /v1 part)"]);
    expect(validated).toEqual([
      { baseUrl: "https://api.acme.dev/v1", apiKey: "sk-acme" },
    ]);
    expect(validated.some((v) => v.baseUrl.includes("openrouter.ai"))).toBe(false);
    expect(r && "update" in r).toBe(true);
    if (r && "update" in r) {
      expect(r.update.statedProvider).toBe("acme");
      expect(r.update.baseUrl).toBe("https://api.acme.dev/v1");
      expect(r.update.keyEnv).toBe("ACME_API_KEY");
      expect(r.update.model).toBe("acme/decision-v2");
      expect(r.update.judge.enabled).toBe(true);
    }
  });

  test("an empty endpoint rejects before any call; esc cancels", async () => {
    let calls = 0;
    const probe = deps({
      existing,
      validate: async () => {
        calls += 1;
        return { ok: true };
      },
    });
    const { q } = fakeQ(["custom", "judge"], [""]);
    const r = await configureDecisionModel("robbie", q as never, probe);
    expect(r && "rejected" in r ? r.rejected : "").toContain("base URL is required");

    const { q: q2 } = fakeQ(["custom", "judge"], [undefined]);
    expect(await configureDecisionModel("robbie", q2 as never, probe)).toBeUndefined();
    expect(calls).toBe(0);
  });

  test("a missing key rejects first — no endpoint question, no call", async () => {
    let calls = 0;
    const { q, asked } = fakeQ(["custom", "judge"], ["https://api.acme.dev/v1"]);
    const r = await configureDecisionModel(
      "robbie",
      q as never,
      deps({
        existing: { ...existing, apiKey: undefined },
        validate: async () => {
          calls += 1;
          return { ok: true };
        },
      }),
    );
    expect(r && "rejected" in r ? r.rejected : "").toContain("ACME_API_KEY");
    expect(asked.values).toHaveLength(0);
    expect(calls).toBe(0);
  });

  test("off carries the absence through — the update names no endpoint to write", async () => {
    const { q } = fakeQ(["off"]);
    const r = await configureDecisionModel("robbie", q as never, deps({ existing }));
    if (r && "update" in r) {
      expect(r.update.statedProvider).toBe("acme");
      expect(r.update.baseUrl).toBeUndefined();
      expect(r.update.keyEnv).toBe("ACME_API_KEY");
    } else throw new Error("expected an update");
  });
});

describe("configureDecisionModel — a provider SWITCH never reaches into the previous provider's state (PR #605)", () => {
  const acme: DecisionModelSettings = {
    provider: "openrouter",
    statedProvider: "acme",
    model: "acme/decision-v2",
    baseUrl: "https://api.acme.dev/v1",
    keyEnv: "ACME_API_KEY",
    apiKey: "sk-acme",
    judge: { enabled: true, timeoutMs: 1500, threshold: 70, failClosed: false },
    router: { enabled: false, timeoutMs: 800 },
  };

  test("acme -> Direct TypeSafe: the new token lands in the DEFAULT slot, never over ACME_API_KEY", async () => {
    let validatedModel: string | undefined;
    const { q, asked } = fakeQ(
      ["typesafe", "both"],
      ["https://api.typesafe.ai/v1", "ts-token-new"],
    );
    const r = await configureDecisionModel(
      "robbie",
      q as never,
      deps({
        existing: acme,
        validate: async (s) => {
          validatedModel = s.model;
          return { ok: true };
        },
      }),
    );
    // No keep/replace question: there is no TypeSafe token to keep.
    expect(asked.chooses.map((c) => c.title)).toEqual([
      "Decision model for robbie",
      "What should the decision model do for robbie?",
    ]);
    expect(r && "update" in r).toBe(true);
    if (r && "update" in r) {
      expect(r.update.provider).toBe("typesafe");
      expect(r.update.statedProvider).toBeUndefined();
      expect(r.update.keyEnv).toBe("PHANTOMBOT_JEV_API_KEY");
      expect(r.update.apiKey).toBe("ts-token-new");
      // The custom vendor's model id means nothing at TypeSafe.
      expect(r.update.model).toBe("typesafe/jev-1.13");
      expect(r.update.baseUrl).toBe("https://api.typesafe.ai/v1");
    }
    expect(validatedModel).toBe("typesafe/jev-1.13");
  });

  test("acme -> OpenRouter: validates and persists the default model, not acme/decision-v2", async () => {
    let validatedModel: string | undefined;
    const { q } = fakeQ(["openrouter", `reuse:${EMBED_KEY_ENV}`, "judge"]);
    const r = await configureDecisionModel(
      "robbie",
      q as never,
      deps({
        existing: acme,
        validate: async (s) => {
          validatedModel = s.model;
          return { ok: true };
        },
      }),
    );
    expect(validatedModel).toBe("typesafe/jev-1.13");
    if (r && "update" in r) {
      expect(r.update.model).toBe("typesafe/jev-1.13");
      expect(r.update.keyEnv).toBe(EMBED_KEY_ENV);
      expect(r.update.apiKey).toBeUndefined();
    } else throw new Error("expected an update");
  });

  test("OpenRouter (reusing the embeddings key) -> Direct TypeSafe: the token is not stored over the embeddings key", async () => {
    const existing: DecisionModelSettings = {
      provider: "openrouter",
      model: "typesafe/jev-1.13",
      baseUrl: "https://openrouter.ai/api/v1",
      keyEnv: EMBED_KEY_ENV,
      judge: { enabled: true, timeoutMs: 1500, threshold: 70, failClosed: false },
      router: { enabled: true, timeoutMs: 800 },
    };
    const { q } = fakeQ(
      ["typesafe", "both"],
      ["https://api.typesafe.ai/v1", "ts-token-new"],
    );
    const r = await configureDecisionModel("robbie", q as never, deps({ existing }));
    if (r && "update" in r) {
      expect(r.update.keyEnv).toBe("PHANTOMBOT_JEV_API_KEY");
      expect(r.update.apiKey).toBe("ts-token-new");
    } else throw new Error("expected an update");
  });

  test("the SAME provider keeps its pin: an OpenRouter re-run preserves a non-default model, a TypeSafe keep preserves its key name", async () => {
    const pinned: DecisionModelSettings = {
      provider: "openrouter",
      model: "typesafe/jev-next",
      baseUrl: "https://openrouter.ai/api/v1",
      keyEnv: EMBED_KEY_ENV,
      judge: { enabled: true, timeoutMs: 1500, threshold: 70, failClosed: false },
      router: { enabled: true, timeoutMs: 800 },
    };
    let validatedModel: string | undefined;
    const { q } = fakeQ(["openrouter", `reuse:${EMBED_KEY_ENV}`, "both"]);
    const r = await configureDecisionModel(
      "robbie",
      q as never,
      deps({
        existing: pinned,
        validate: async (s) => {
          validatedModel = s.model;
          return { ok: true };
        },
      }),
    );
    expect(validatedModel).toBe("typesafe/jev-next");
    if (r && "update" in r) expect(r.update.model).toBe("typesafe/jev-next");
    else throw new Error("expected an update");

    const ts: DecisionModelSettings = {
      provider: "typesafe",
      model: "typesafe/jev-next",
      baseUrl: "https://api.typesafe.ai/v1",
      keyEnv: "MY_TS_TOKEN",
      judge: { enabled: true, timeoutMs: 1500, threshold: 70, failClosed: false },
      router: { enabled: false, timeoutMs: 800 },
    };
    process.env.MY_TS_TOKEN = "ts-stored";
    try {
      const { q: q2 } = fakeQ(["typesafe", "keep", "judge"], ["https://api.typesafe.ai/v1"]);
      const r2 = await configureDecisionModel("robbie", q2 as never, deps({ existing: ts }));
      if (r2 && "update" in r2) {
        expect(r2.update.keyEnv).toBe("MY_TS_TOKEN");
        expect(r2.update.apiKey).toBeUndefined();
        expect(r2.update.model).toBe("typesafe/jev-next");
      } else throw new Error("expected an update");
    } finally {
      delete process.env.MY_TS_TOKEN;
    }
  });
});
