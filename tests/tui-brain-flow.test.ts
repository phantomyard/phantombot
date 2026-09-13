/**
 * The Brain flow: primary → fallback → (native only) provider/key/model slots.
 *
 * The assertions that matter:
 *   - The menu is detected LIVE: native is always offered (it is built in);
 *     Claude, Codex and "Pi — Use Host Configuration" appear only when their
 *     binary is installed. A missing harness is never a choice.
 *   - Host harnesses are CHAIN-ONLY: picking them collects nothing and makes
 *     no routing write — agents inherit the host's configuration.
 *   - The stored API key is idempotent: an empty answer with an unchanged
 *     provider writes no secret; a provider switch with an empty answer clears
 *     the stale key.
 *   - Vision is skipped when the primary is vision-capable; the coder slot
 *     defaults to the primary.
 *   - `undefined` from any question leaves the config untouched.
 */
import { describe, expect, test } from "bun:test";

import {
  configureBrain,
  offeredBrains,
  type BrainDeps,
  type BrainQuestions,
} from "../src/tui/brainFlow.ts";
import type { PiModel } from "../src/lib/piModels.ts";

const MODELS: PiModel[] = [
  { provider: "openrouter", model: "gpt-5.2", supportsImages: false },
  { provider: "openrouter", model: "gpt-5.2-vision", supportsImages: true },
  { provider: "google", model: "gemini-3-pro", supportsImages: true },
];

interface Harness {
  q: BrainQuestions;
  deps: BrainDeps;
  applied: {
    chains: string[][];
    routings: Array<{ choices: unknown; instanceId?: string }>;
    secrets: Array<string | "CLEARED">;
    authWrites: Array<{ provider: string; key: string }>;
    chooses: Array<{
      title: string;
      initial?: string;
      options: Array<{ value: string; label: string; hint?: string }>;
    }>;
    searches: Array<{
      title: string;
      banner?: string;
      initial?: string;
      options: Array<{ value: string; label: string }>;
    }>;
  };
}

function harness(over: {
  chain?: string[];
  availability?: Record<string, string | undefined>;
  routing?: BrainDeps["routing"];
  storedKey?: string;
  piInstances?: BrainDeps["piInstances"];
  personaScope?: boolean;
  models?: PiModel[];
  choose?: Array<string | undefined>;
  search?: Array<string | undefined>;
  value?: Array<string | undefined>;
  probeProviderKey?: BrainDeps["probeProviderKey"];
  fetchProviderModels?: BrainDeps["fetchProviderModels"];
}): Harness {
  const applied: Harness["applied"] = {
    chains: [],
    routings: [],
    secrets: [],
    authWrites: [],
    chooses: [],
    searches: [],
  };
  const c = [...(over.choose ?? [])];
  const s = [...(over.search ?? [])];
  const v = [...(over.value ?? [])];
  const q: BrainQuestions = {
    choose: async (input) => {
      applied.chooses.push({
        title: input.title,
        initial: input.initial,
        options: input.options.map((o) => ({ value: o.value, label: o.label, hint: o.hint })),
      });
      const answer = c.shift();
      return answer === "CURRENT" ? (input.initial ?? "") : answer;
    },
    search: async (input) => {
      applied.searches.push({
        title: input.title,
        banner: input.banner,
        initial: input.initial,
        options: input.options.map((o) => ({ value: o.value, label: o.label })),
      });
      const answer = s.shift();
      return answer === "CURRENT" ? (input.initial ?? "") : answer;
    },
    value: async () => v.shift(),
    note: () => {},
  };
  const models = over.models ?? MODELS;
  const deps: BrainDeps = {
    persona: "robbie",
    chain: over.chain ?? [],
    availability: over.availability ?? {
      native: process.execPath,
      "pi-host": "/usr/bin/pi",
      codex: "/usr/bin/codex",
      claude: undefined,
    },
    routing: over.routing ?? {},
    storedKey: over.storedKey,
    piInstances: over.piInstances,
    targetPath: "/tmp/personas/robbie/config.toml",
    personaScope: over.personaScope ?? true,
    listModels: async () => models,
    probeProviderKey: over.probeProviderKey ?? (async () => ({ status: "verified", detail: "" })),
    // Default: the provider's own API answers nothing, so a test that doesn't
    // opt in behaves exactly as it did before the live catalogue existed.
    fetchProviderModels: over.fetchProviderModels ?? (async () => []),
    setSecret: async (value) => {
      applied.secrets.push(value);
      return { ok: true, persona: "robbie" };
    },
    unsetSecret: async () => {
      applied.secrets.push("CLEARED");
    },
    writeAuth: async (provider, value) => {
      applied.authWrites.push({ provider, key: value });
      return { ok: true, path: "/tmp/.pi/agent/auth.json" };
    },
    applyChain: async (chain) => void applied.chains.push([...chain]),
    applyRouting: async (choices, instanceId) =>
      void applied.routings.push({ choices, instanceId }),
  };
  return { q, deps, applied };
}

describe("offeredBrains — live detection decides the menu", () => {
  test("native is always offered, first, even with nothing installed", () => {
    expect(offeredBrains({})).toEqual(["native"]);
    expect(
      offeredBrains({ "pi-host": undefined, codex: undefined, claude: undefined }),
    ).toEqual(["native"]);
  });

  test("host harnesses appear only when their binary resolved", () => {
    expect(offeredBrains({ "pi-host": "/usr/bin/pi", claude: undefined, codex: "/bin/codex" }))
      .toEqual(["native", "pi-host", "codex"]);
  });
});

describe("the brain flow", () => {
  test("codex primary + no fallback: chain-only, nothing collected, no routing", async () => {
    const h = harness({
      choose: ["codex", "CURRENT"], // primary, fallback (none)
    });
    const notice = await configureBrain(h.q, h.deps);
    expect(notice).toBe("brain saved: codex");
    expect(h.applied.chains).toEqual([["codex"]]);
    expect(h.applied.routings).toEqual([]);
    expect(h.applied.secrets).toEqual([]);
    expect(h.applied.searches).toEqual([]);
  });

  test("pi-host primary: chain-only — the host's pi keeps its own configuration", async () => {
    const h = harness({ choose: ["pi-host", "CURRENT"] });
    const notice = await configureBrain(h.q, h.deps);
    expect(notice).toBe("brain saved: pi-host");
    expect(h.applied.chains).toEqual([["pi-host"]]);
    expect(h.applied.routings).toEqual([]);
    expect(h.applied.secrets).toEqual([]);
    expect(h.applied.authWrites).toEqual([]);
    expect(h.applied.searches).toEqual([]);
  });

  test("labels: native configures here; host harnesses say the host owns their config", async () => {
    const h = harness({
      availability: {
        native: process.execPath,
        "pi-host": "/usr/bin/pi",
        codex: "/usr/bin/codex",
        claude: "/usr/bin/claude",
      },
    });
    h.q.choose = async (input) => {
      h.applied.chooses.push({ title: input.title, options: [...input.options] });
      return undefined;
    };
    await configureBrain(h.q, h.deps);
    const options = h.applied.chooses[0]!.options;
    expect(options.map((o) => o.value)).toEqual(["native", "pi-host", "codex", "claude"]);
    const byValue = (v: string) => options.find((o) => o.value === v)!;
    expect(byValue("native").label).toContain("Configure Provider and Model Swap Settings");
    expect(byValue("pi-host").label).toBe("Pi — Use Host Configuration");
    expect(byValue("pi-host").hint).toContain("uses this host's pi configuration");
    expect(byValue("codex").hint).toContain("uses this host's Codex configuration");
    expect(byValue("claude").hint).toContain("uses this host's Claude configuration");
  });

  test("a host harness that is not installed is not offered, and a stale chain entry is not pre-selected", async () => {
    const h = harness({
      chain: ["claude"], // configured once, since uninstalled
      availability: { native: process.execPath, "pi-host": undefined, codex: undefined, claude: undefined },
    });
    h.q.choose = async (input) => {
      h.applied.chooses.push({ title: input.title, initial: input.initial, options: [...input.options] });
      return undefined;
    };
    await configureBrain(h.q, h.deps);
    const first = h.applied.chooses[0]!;
    expect(first.options.map((o) => o.value)).toEqual(["native"]);
    expect(first.initial).toBe("native");
  });

  test("a native → native chain pre-selects native for both slots", async () => {
    const h = harness({ chain: ["pi-primary", "pi-fallback"] });
    h.q.choose = async (input) => {
      h.applied.chooses.push({ title: input.title, initial: input.initial, options: [...input.options] });
      return h.applied.chooses.length === 1 ? input.initial : undefined;
    };
    await configureBrain(h.q, h.deps);
    expect(h.applied.chooses.map((c) => c.initial)).toEqual(["native", "native"]);
  });

  test("esc at the fallback leaves the config untouched", async () => {
    const h = harness({ choose: ["native", undefined] });
    const notice = await configureBrain(h.q, h.deps);
    expect(notice).toBe("brain unchanged");
    expect(h.applied.chains).toEqual([]);
    expect(h.applied.routings).toEqual([]);
  });

  test("native never asks a configure-vs-host question: straight to the provider", async () => {
    const h = harness({
      choose: ["native", "CURRENT"],
      search: ["openrouter", "gpt-5.2", "gpt-5.2-vision", "gpt-5.2"],
      value: ["sk-new"],
    });
    await configureBrain(h.q, h.deps);
    // Two chooses only: primary and fallback.
    expect(h.applied.chooses.map((c) => c.title)).toEqual([
      "Primary brain",
      "Fallback brain (optional)",
    ]);
    expect(h.applied.searches[0]!.title.toLowerCase()).toContain("provider");
  });

  test("pi lists no models for the provider: the picker is filled from the provider's own API", async () => {
    // THE REGRESSION. `pi --list-models` only enumerates providers Pi has
    // already keyed, so choosing openrouter with a fresh key left every model
    // slot showing a lone "(none)" row — the user had to type a model id from
    // memory. The provider's own catalogue now fills the list.
    const asked: Array<{ provider: string; key: string }> = [];
    const h = harness({
      models: [], // pi knows nothing
      choose: ["native", "CURRENT"],
      search: ["openrouter", "anthropic/claude-sonnet-4.6", ""], // provider, primary (vision-capable ⇒ no vision slot), coder
      value: ["sk-or-new"],
      fetchProviderModels: async (provider, key) => {
        asked.push({ provider, key });
        return [
          { provider: "openrouter", model: "anthropic/claude-sonnet-4.6", supportsImages: true },
          { provider: "openrouter", model: "deepseek/deepseek-v4-pro", supportsImages: false },
        ];
      },
    });
    const notice = await configureBrain(h.q, h.deps);
    expect(notice).toBe("brain saved: native");
    // Asked with the key just entered — that is what authenticates the fetch.
    expect(asked).toEqual([{ provider: "openrouter", key: "sk-or-new" }]);
    const primary = h.applied.searches.find((x) => x.banner?.includes("PRIMARY"));
    expect(primary?.options.map((o) => o.value)).toEqual([
      "",
      "anthropic/claude-sonnet-4.6",
      "deepseek/deepseek-v4-pro",
    ]);
    expect(h.applied.routings.map((r) => r.choices)).toEqual([
      {
        provider: "openrouter",
        primaryModel: "anthropic/claude-sonnet-4.6",
        imageModel: "anthropic/claude-sonnet-4.6",
        codingModel: undefined,
      },
    ]);
  });

  test("the live catalogue is not consulted when pi already listed the provider", async () => {
    let calls = 0;
    const h = harness({
      choose: ["native", "CURRENT"],
      search: ["openrouter", "gpt-5.2", "gpt-5.2-vision", "gpt-5.2"],
      value: [""],
      storedKey: "sk-existing",
      routing: { provider: "openrouter" },
      fetchProviderModels: async () => {
        calls += 1;
        return [];
      },
    });
    await configureBrain(h.q, h.deps);
    expect(calls).toBe(0);
  });

  test("native configured: key kept when blank and provider unchanged (idempotent)", async () => {
    const h = harness({
      choose: ["native", "CURRENT"], // primary, fallback (none)
      search: ["openrouter", "gpt-5.2", "gpt-5.2-vision", "gpt-5.2"], // provider, primary, vision, coder
      value: [""], // blank key = keep
      storedKey: "sk-existing",
      routing: { provider: "openrouter" },
    });
    const notice = await configureBrain(h.q, h.deps);
    expect(notice).toBe("brain saved: native");
    expect(h.applied.secrets).toEqual([]); // nothing written, nothing cleared
    expect(h.applied.routings).toEqual([
      {
        choices: {
          provider: "openrouter",
          primaryModel: "gpt-5.2",
          imageModel: "gpt-5.2-vision",
          codingModel: "gpt-5.2",
        },
        instanceId: undefined,
      },
    ]);
  });

  test("native configured: provider switch with a blank key clears the stale key", async () => {
    const h = harness({
      choose: ["native", "CURRENT"],
      search: ["google", "gemini-3-pro", "gemini-3-pro"],
      value: [""], // blank after a provider switch = clear
      storedKey: "sk-old",
      routing: { provider: "openrouter" },
    });
    await configureBrain(h.q, h.deps);
    expect(h.applied.secrets).toEqual(["CLEARED"]);
  });

  test("native configured: a typed key is set in the vault and Pi's own store", async () => {
    const h = harness({
      choose: ["native", "CURRENT"],
      search: ["openrouter", "gpt-5.2", "gpt-5.2-vision", "gpt-5.2"],
      value: ["sk-new"],
    });
    await configureBrain(h.q, h.deps);
    expect(h.applied.secrets).toEqual(["sk-new"]);
    expect(h.applied.authWrites).toEqual([{ provider: "openrouter", key: "sk-new" }]);
    expect(h.applied.routings[0]!.choices).toMatchObject({ provider: "openrouter" });
  });

  test("a key the provider rejects is re-asked and saved only once valid", async () => {
    let calls = 0;
    const h = harness({
      choose: ["native", "CURRENT"],
      search: ["openai", "gpt-5.2", "gpt-5.2-vision", "gpt-5.2"],
      value: ["sk-bad", "sk-good"],
      probeProviderKey: async () =>
        ++calls === 1
          ? { status: "invalid", detail: "rejected (HTTP 401)" }
          : { status: "verified", detail: "ok" },
    });
    await configureBrain(h.q, h.deps);
    // The rejected key never reached the vault — only the accepted one did.
    expect(h.applied.secrets).toEqual(["sk-good"]);
    expect(calls).toBe(2);
  });

  test("an unverifiable key warns but does not block the flow", async () => {
    const h = harness({
      choose: ["native", "CURRENT"],
      search: ["zai", "gpt-5.2", "gpt-5.2-vision", "gpt-5.2"],
      value: ["sk-mystery"],
      probeProviderKey: async () => ({
        status: "unverified",
        detail: "no known check for provider 'zai'",
      }),
    });
    await configureBrain(h.q, h.deps);
    expect(h.applied.secrets).toEqual(["sk-mystery"]);
    expect(h.applied.routings[0]!.choices).toMatchObject({ provider: "zai" });
  });

  test("a kept (stored) key is validated too, before any write", async () => {
    let probed: string | undefined;
    const h = harness({
      choose: ["native", "CURRENT"],
      search: ["openai", "gpt-5.2", "gpt-5.2-vision", "gpt-5.2"],
      value: [""], // blank = keep stored
      routing: { provider: "openai" },
      storedKey: "sk-stored",
      probeProviderKey: async (_p, key) => {
        probed = key;
        return { status: "verified", detail: "" };
      },
    });
    await configureBrain(h.q, h.deps);
    expect(probed).toBe("sk-stored");
    expect(h.applied.secrets).toEqual([]); // keep = no new write
    expect(h.applied.routings[0]!.choices).toMatchObject({ provider: "openai" });
  });

  test("a vision-capable primary skips the vision slot", async () => {
    const h = harness({
      choose: ["native", "CURRENT"],
      search: ["google", "gemini-3-pro", "gemini-3-pro"], // provider, primary, coder
      value: [""],
    });
    await configureBrain(h.q, h.deps);
    const banners = h.applied.searches.map((s) => s.banner ?? "");
    expect(banners.filter((b) => b.includes("PRIMARY"))).toHaveLength(1);
    expect(banners.filter((b) => b.includes("VISION"))).toHaveLength(0);
    expect(banners.filter((b) => b.includes("CODER"))).toHaveLength(1);
  });

  test("a text-only primary asks for vision, narrowed to vision-capable models", async () => {
    let visionOptions: readonly unknown[] = [];
    const h = harness({
      choose: ["native", "CURRENT"],
      search: ["openrouter", "gpt-5.2", "gpt-5.2-vision", "gpt-5.2"],
      value: [""],
    });
    const realSearch = h.q.search;
    h.q.search = async (input) => {
      if (input.banner?.includes("VISION")) visionOptions = input.options;
      return realSearch(input);
    };
    await configureBrain(h.q, h.deps);
    const labels = (visionOptions as Array<{ label: string }>).map((o) => o.label);
    expect(labels).toContain("openrouter/gpt-5.2-vision");
    expect(labels).not.toContain("openrouter/gpt-5.2"); // not vision-capable
    // The one vision-capable option plus "(none)".
    expect(visionOptions).toHaveLength(2);
  });

  test("the coder slot's initial defaults to the primary model", async () => {
    const h = harness({
      choose: ["native", "CURRENT"],
      search: ["google", "gemini-3-pro", "gemini-3-pro"],
      value: [""],
    });
    await configureBrain(h.q, h.deps);
    const coder = h.applied.searches.find((s) => s.banner?.includes("CODER"));
    expect(coder?.initial).toBe("gemini-3-pro");
  });

  test("every native question names its slot and the provider list searches", async () => {
    const h = harness({
      choose: ["native", "CURRENT"],
      search: ["openrouter", "gpt-5.2", "gpt-5.2", "gpt-5.2"],
      value: ["sk-new"],
    });
    await configureBrain(h.q, h.deps);
    expect(h.applied.searches[0]?.title.toLowerCase()).toContain("provider");
    expect(h.applied.searches[0]?.title).toContain("primary");
    expect(h.applied.searches[1]?.banner).toContain("PRIMARY");
    expect(h.applied.searches[2]?.banner).toContain("VISION");
    expect(h.applied.searches[3]?.banner).toContain("CODER");
  });

  test("an empty catalogue still completes via free-text model entry", async () => {
    const h = harness({
      models: [],
      choose: ["native", "CURRENT"],
      search: ["openrouter", "gpt-5.2", "", ""],
      value: ["sk-new"],
    });
    const notice = await configureBrain(h.q, h.deps);
    expect(notice).toBe("brain saved: native");
    expect(h.applied.routings[0]!.choices).toMatchObject({
      provider: "openrouter",
      primaryModel: "gpt-5.2",
    });
  });

  test("keeping a stored key refreshes models if initially empty for provider", async () => {
    let listCalls = 0;
    const h = harness({
      choose: ["native", "CURRENT"],
      search: ["openrouter", "gpt-5.2", "gpt-5.2-vision", "gpt-5.2"],
      value: [""], // keep stored key
      storedKey: "sk-stored",
      routing: { provider: "openrouter" },
      models: [], // empty initial models
    });
    h.deps.listModels = async (extraEnv) => {
      listCalls++;
      return extraEnv?.OPENROUTER_API_KEY === "sk-stored" ? MODELS : [];
    };
    const notice = await configureBrain(h.q, h.deps);
    expect(notice).toBe("brain saved: native");
    expect(listCalls).toBeGreaterThanOrEqual(2);
    expect(h.applied.routings[0]!.choices).toMatchObject({
      provider: "openrouter",
      primaryModel: "gpt-5.2",
    });
  });

  test("cancelling the wizard before completion does not mutate Pi's shared auth store", async () => {
    const h = harness({
      choose: ["native", "CURRENT"],
      search: [undefined], // Esc / cancel at the provider selection prompt
      storedKey: "sk-instance-key",
      routing: { provider: "openrouter" },
      models: [],
    });
    const notice = await configureBrain(h.q, h.deps);
    expect(notice).toBe("brain unchanged");
    expect(h.applied.authWrites).toEqual([]);
  });

  test("native primary and native fallback: each slot is its own named instance, configured separately", async () => {
    const h = harness({
      choose: ["native", "native"],
      search: [
        "openrouter", "gpt-5.2", "gpt-5.2-vision", "gpt-5.2", // primary slot
        "google", "gemini-3-pro", "gemini-3-pro", // fallback slot
      ],
      value: ["sk-primary", "sk-fallback"],
    });
    const notice = await configureBrain(h.q, h.deps);
    expect(notice).toBe("brain saved: pi-primary → pi-fallback");
    expect(h.applied.chains).toEqual([["pi-primary", "pi-fallback"]]);
    expect(h.applied.routings.map((r) => r.instanceId)).toEqual(["pi-primary", "pi-fallback"]);
    expect(h.applied.routings[1]!.choices).toMatchObject({ provider: "google" });
    expect(h.applied.secrets).toEqual(["sk-primary", "sk-fallback"]);
  });

  test("named native instances: kept keys are each slot's OWN instance key, never the global one", async () => {
    let listCalls = 0;
    const h = harness({
      choose: ["native", "native"],
      search: [
        "openrouter", "gpt-5.2", "gpt-5.2-vision", "gpt-5.2",
        "openrouter", "gpt-5.2", "gpt-5.2-vision", "gpt-5.2",
      ],
      value: ["", ""], // keep stored keys on both slots
      storedKey: "sk-global-wrong-key",
      piInstances: {
        primary: { routing: { provider: "openrouter" }, storedKey: "sk-primary-instance-key" },
        fallback: { routing: { provider: "openrouter" }, storedKey: "sk-fallback-instance-key" },
      },
      models: [],
    });
    h.deps.listModels = async (extraEnv) => {
      listCalls++;
      const key = extraEnv?.OPENROUTER_API_KEY;
      return key === "sk-primary-instance-key" || key === "sk-fallback-instance-key" ? MODELS : [];
    };
    const notice = await configureBrain(h.q, h.deps);
    expect(notice).toBe("brain saved: pi-primary → pi-fallback");
    expect(h.applied.authWrites).toEqual([
      { provider: "openrouter", key: "sk-primary-instance-key" },
      { provider: "openrouter", key: "sk-fallback-instance-key" },
    ]);
    expect(listCalls).toBeGreaterThanOrEqual(2);
  });
});
