/**
 * The Brain flow: primary → fallback → (Pi only) provider/key/model slots.
 *
 * The assertions that matter:
 *   - Codex/Claude are CHAIN-ONLY: picking them collects nothing and calls no
 *     Pi write — agents inherit the host's configuration.
 *   - The stored API key is idempotent: an empty answer with an unchanged
 *     provider writes no secret; a provider switch with an empty answer clears
 *     the stale key.
 *   - Vision is skipped when the primary is vision-capable; the coder slot
 *     defaults to the primary.
 *   - "Use Host Configuration" clears routing (tombstoned in persona scope).
 *   - `undefined` from any question leaves the config untouched.
 */
import { describe, expect, test } from "bun:test";

import {
  configureBrain,
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
    routings: unknown[];
    clears: Array<{ tombstone?: boolean } | undefined>;
    secrets: Array<string | "CLEARED">;
    searches: Array<{ title: string; banner?: string; initial?: string }>;
  };
}

function harness(over: {
  chain?: string[];
  availability?: Record<string, string | undefined>;
  routing?: BrainDeps["routing"];
  storedKey?: string;
  personaScope?: boolean;
  models?: PiModel[];
  choose?: Array<string | undefined>;
  search?: Array<string | undefined>;
  value?: Array<string | undefined>;
}): Harness {
  const applied = {
    chains: [] as string[][],
    routings: [] as unknown[],
    clears: [] as Array<{ tombstone?: boolean } | undefined>,
    secrets: [] as Array<string | "CLEARED">,
    searches: [] as Array<{ title: string; banner?: string; initial?: string }>,
  };
  const c = [...(over.choose ?? [])];
  const s = [...(over.search ?? [])];
  const v = [...(over.value ?? [])];
  const q: BrainQuestions = {
    choose: async (input) => {
      const answer = c.shift();
      return answer === "CURRENT" ? (input.initial ?? "") : answer;
    },
    search: async (input) => {
      applied.searches.push({
        title: input.title,
        banner: input.banner,
        initial: input.initial,
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
    availability: over.availability ?? { pi: "/usr/bin/pi", codex: "/usr/bin/codex", claude: undefined },
    routing: over.routing ?? {},
    storedKey: over.storedKey,
    targetPath: "/tmp/personas/robbie/config.toml",
    personaScope: over.personaScope ?? true,
    piBin: over.availability?.pi ?? "/usr/bin/pi",
    installCommand: "curl -fsSL https://pi.sh | bash",
    listModels: async () => models,
    setSecret: async (value) => {
      applied.secrets.push(value);
      return { ok: true, persona: "robbie" };
    },
    unsetSecret: async () => {
      applied.secrets.push("CLEARED");
    },
    writeAuth: async () => ({ ok: true, path: "/tmp/.pi/agent/auth.json" }),
    applyChain: async (chain) => void applied.chains.push([...chain]),
    applyRouting: async (choices) => void applied.routings.push(choices),
    clearRouting: async (opts) => void applied.clears.push(opts),
  };
  return { q, deps, applied };
}

describe("the brain flow", () => {
  test("codex primary + no fallback: chain-only, nothing collected, nothing for Pi", async () => {
    const h = harness({
      choose: ["codex", "CURRENT"], // primary, fallback (none)
    });
    const notice = await configureBrain(h.q, h.deps);
    expect(notice).toBe("brain saved: codex");
    expect(h.applied.chains).toEqual([["codex"]]);
    expect(h.applied.routings).toEqual([]);
    expect(h.applied.clears).toEqual([]);
    expect(h.applied.secrets).toEqual([]);
    expect(h.applied.searches).toEqual([]);
  });

  test("codex/claude options explain that the host owns their configuration", async () => {
    let options: Array<{ value: string; label: string; hint?: string }> = [];
    const h = harness({});
    h.q.choose = async (input) => {
      options = [...input.options];
      return undefined;
    };
    await configureBrain(h.q, h.deps);
    const codex = options.find((o) => o.value === "codex");
    const claude = options.find((o) => o.value === "claude");
    expect(codex?.hint).toContain("uses this host's Codex configuration");
    expect(claude?.hint).toContain("uses this host's Claude configuration");
  });

  test("esc at the fallback leaves the config untouched", async () => {
    const h = harness({ choose: ["pi", undefined] });
    const notice = await configureBrain(h.q, h.deps);
    expect(notice).toBe("brain unchanged");
    expect(h.applied.chains).toEqual([]);
    expect(h.applied.routings).toEqual([]);
  });

  test("pi primary with host configuration: routing cleared (tombstoned), chain still applied", async () => {
    const h = harness({
      choose: ["pi", "CURRENT", "host"], // primary, pi mode, fallback (none)
      routing: { provider: "openrouter", primaryModel: "gpt-5.2" },
    });
    const notice = await configureBrain(h.q, h.deps);
    expect(notice).toBe("brain saved: pi");
    expect(h.applied.clears).toEqual([{ tombstone: true }]);
    expect(h.applied.routings).toEqual([]);
    expect(h.applied.chains).toEqual([["pi"]]);
  });

  test("pi configured: key kept when blank and provider unchanged (idempotent)", async () => {
    const h = harness({
      choose: ["pi", "CURRENT", "configure"], // primary, mode, fallback (none)
      search: ["openrouter", "gpt-5.2", "gpt-5.2-vision", "gpt-5.2"], // provider, primary, vision, coder
      value: [""], // blank key = keep
      storedKey: "sk-existing",
      routing: { provider: "openrouter" },
    });
    const notice = await configureBrain(h.q, h.deps);
    expect(notice).toBe("brain saved: pi");
    expect(h.applied.secrets).toEqual([]); // nothing written, nothing cleared
    expect(h.applied.routings).toEqual([
      {
        provider: "openrouter",
        primaryModel: "gpt-5.2",
        imageModel: "gpt-5.2-vision",
        codingModel: "gpt-5.2",
      },
    ]);
  });

  test("pi configured: provider switch with a blank key clears the stale key", async () => {
    const h = harness({
      choose: ["pi", "CURRENT", "configure"],
      search: ["google", "gemini-3-pro", "gemini-3-pro"],
      value: [""], // blank after a provider switch = clear
      storedKey: "sk-old",
      routing: { provider: "openrouter" },
    });
    await configureBrain(h.q, h.deps);
    expect(h.applied.secrets).toEqual(["CLEARED"]);
  });

  test("pi configured: a typed key is set in the vault and Pi's own store", async () => {
    const h = harness({
      choose: ["pi", "CURRENT", "configure"],
      search: ["openrouter", "gpt-5.2", "gpt-5.2-vision", "gpt-5.2"],
      value: ["sk-new"],
    });
    await configureBrain(h.q, h.deps);
    expect(h.applied.secrets).toEqual(["sk-new"]);
    expect(h.applied.routings[0]).toMatchObject({ provider: "openrouter" });
  });

  test("a vision-capable primary skips the vision slot", async () => {
    const h = harness({
      choose: ["pi", "CURRENT", "configure"],
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
      choose: ["pi", "CURRENT", "configure"],
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
      choose: ["pi", "CURRENT", "configure"],
      search: ["google", "gemini-3-pro", "gemini-3-pro"],
      value: [""],
    });
    await configureBrain(h.q, h.deps);
    const coder = h.applied.searches.find((s) => s.banner?.includes("CODER"));
    expect(coder?.initial).toBe("gemini-3-pro");
  });

  test("every pi question names its slot and the provider list searches", async () => {
    const h = harness({
      choose: ["pi", "CURRENT", "configure"],
      search: ["openrouter", "gpt-5.2", "gpt-5.2", "gpt-5.2"],
      value: ["sk-new"],
    });
    await configureBrain(h.q, h.deps);
    expect(h.applied.searches[0]?.title).toContain("provider");
    expect(h.applied.searches[1]?.banner).toContain("PRIMARY");
    expect(h.applied.searches[2]?.banner).toContain("VISION");
    expect(h.applied.searches[3]?.banner).toContain("CODER");
  });

  test("no pi binary: the flow still completes via free-text model entry", async () => {
    const h = harness({
      choose: ["pi", "CURRENT", "configure"],
      search: ["openrouter", "gpt-5.2", "", ""],
      value: ["sk-new"],
      availability: { pi: undefined, codex: undefined, claude: undefined },
    });
    const notice = await configureBrain(h.q, h.deps);
    expect(notice).toBe("brain saved: pi");
    expect(h.applied.routings[0]).toMatchObject({
      provider: "openrouter",
      primaryModel: "gpt-5.2",
    });
  });
});
