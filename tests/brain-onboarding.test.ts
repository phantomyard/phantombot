/**
 * The wizard's Brain steps (`brainOnboarding.ts`) — decision-table tests over
 * the six-step flow with fake screens and fake deps. The real screens and
 * writes are covered by the TUI suites; here we pin the LANDING semantics,
 * which are the contract:
 *
 *   skip                  → configure, nothing written
 *   test fails            → configure, nothing written (error surfaced)
 *   test passes           → chat, chain written
 *   skip test             → configure, chain written (saved untested)
 *   cancel (esc) anywhere → configure, nothing written
 */

import { describe, expect, test } from "bun:test";

import {
  restoreBrainWrites,
  runBrainOnboarding,
  snapshotBrainWrites,
  type BrainOnboardingDeps,
  type BrainRestoreStores,
} from "../src/tui/brainOnboarding.ts";
import type { BrainQuestions } from "../src/tui/brainFlow.ts";

/** Scripted choose answers; esc is `undefined`. */
function fakeQ(answers: (string | undefined)[]): {
  q: BrainQuestions;
  picked: string[];
} {
  const picked: string[] = [];
  let i = 0;
  return {
    picked,
    q: {
      choose: async (input) => {
        picked.push(input.title);
        return answers[i++];
      },
      search: async () => answers[i++],
      value: async () => answers[i++],
      note: () => {},
    },
  };
}

function fakeDeps(overrides: Partial<BrainOnboardingDeps> = {}): {
  deps: BrainOnboardingDeps;
  chains: string[][];
} {
  const chains: string[][] = [];
  return {
    chains,
    deps: {
      persona: "batman",
      availability: async () => ({ pi: "/usr/bin/pi", claude: "/usr/bin/claude", codex: undefined }),
      installCommand: "sh -c 'curl pi.dev | sh'",
      installPi: async () => true,
      chain: [],
      routing: {},
      targetPath: "/tmp/personas/batman/config.toml",
      personaScope: true,
      listModels: async () => [],
      probeProviderKey: async () => ({ status: "verified", detail: "ok" }),
      setSecret: async () => ({ ok: true }),
      unsetSecret: async () => undefined,
      writeAuth: async () => ({ ok: true, path: "/tmp/auth.json" }),
      applyChain: async (chain) => void chains.push([...chain]),
      applyRouting: async () => undefined,
      clearRouting: async () => undefined,
      probe: async () => ({ ok: true, detail: "ready" }),
      ...overrides,
    } satisfies BrainOnboardingDeps,
  };
}

describe("wizard brain onboarding", () => {
  test("skip lands in configure and writes nothing", async () => {
    const { q } = fakeQ(["skip"]);
    const { deps, chains } = fakeDeps();
    const r = await runBrainOnboarding(q, deps);
    expect(r.landing).toBe("configure");
    expect(chains).toEqual([]);
  });

  test("esc on the primary question cancels to configure, untouched", async () => {
    const { q } = fakeQ([undefined]);
    const { deps, chains } = fakeDeps();
    const r = await runBrainOnboarding(q, deps);
    expect(r.landing).toBe("configure");
    expect(chains).toEqual([]);
  });

  test("a failed probe writes nothing and offers a restart; configure ends it", async () => {
    // pi (installed) → configure-here pass → provider none → key keep →
    // primary model free-text → coder none → test → fail → back to configure.
    const { q } = fakeQ([
      "pi", // primary
      "", // fallback: none
      "host", // use host configuration (skip the long provider pass)
      "test", // test now
      "configure", // restart prompt → back to configure
    ]);
    const { deps, chains } = fakeDeps({
      probe: async () => ({ ok: false, detail: "401 unauthorized" }),
    });
    const r = await runBrainOnboarding(q, deps);
    expect(r.landing).toBe("configure");
    expect(r.notice).toContain("401");
    expect(chains).toEqual([]);
  });

  test("a failed probe then start-over reruns the flow; a passing retest lands in chat", async () => {
    const attempt = ["pi", "", "host", "test"];
    const { q } = fakeQ([...attempt, "restart", ...attempt]);
    let calls = 0;
    const { deps, chains } = fakeDeps({
      probe: async () => (++calls === 1
        ? { ok: false, detail: "401 unauthorized" }
        : { ok: true, detail: "ready" }),
    });
    const r = await runBrainOnboarding(q, deps);
    expect(r.landing).toBe("chat");
    expect(chains).toEqual([["pi"]]);
  });

  test("a passing probe saves the chain and lands in chat", async () => {
    const { q } = fakeQ([
      "claude", // primary (chain-only: no configure step)
      "pi", // fallback
      "host", // fallback Pi uses its local configuration
      "test", // test now
    ]);
    const { deps, chains } = fakeDeps();
    const r = await runBrainOnboarding(q, deps);
    expect(r.landing).toBe("chat");
    expect(r.notice).toContain("claude → pi");
    expect(chains).toEqual([["claude", "pi"]]);
  });

  test("skipping the test saves the chain but lands in configure", async () => {
    const { q } = fakeQ([
      "pi",
      "", // fallback: none
      "host", // host configuration
      "skip", // skip the test
    ]);
    const { deps, chains } = fakeDeps();
    const r = await runBrainOnboarding(q, deps);
    expect(r.landing).toBe("configure");
    expect(chains).toEqual([["pi"]]);
    expect(r.notice).toContain("untested");
  });

  test("pi missing → install offer; going back re-asks the primary", async () => {
    const { q } = fakeQ([
      "pi", // primary (not installed)
      "back", // pick a different brain
      "claude", // primary, chain-only
      "", // fallback: none
      "test", // test → pass
    ]);
    const { deps, chains } = fakeDeps({
      availability: async () => ({ pi: undefined, claude: "/usr/bin/claude", codex: undefined }),
    });
    const r = await runBrainOnboarding(q, deps);
    expect(r.landing).toBe("chat");
    expect(chains).toEqual([["claude"]]);
  });

  test("pi missing → install runs, then the flow continues with pi", async () => {
    let installs = 0;
    const { q } = fakeQ([
      "pi", // primary (not installed yet)
      "install", // install now
      "", // fallback: none
      "host", // use host configuration
      "test", // test → pass
    ]);
    const { deps, chains } = fakeDeps({
      availability: async () => ({
        pi: installs > 0 ? "/usr/bin/pi" : undefined,
        claude: "/usr/bin/claude",
        codex: undefined,
      }),
      installPi: async () => {
        installs++;
        return true;
      },
    });
    const r = await runBrainOnboarding(q, deps);
    expect(installs).toBe(1);
    expect(r.landing).toBe("chat");
    expect(chains).toEqual([["pi"]]);
  });

  test("Pi primary (host) and Pi fallback (configure): fallback Pi cannot be host config and configures models directly", async () => {
    let routedChoices: unknown = undefined;
    const { q, picked } = fakeQ([
      "pi", "pi", // primary, fallback
      "host", // primary uses host config
      // fallback Pi does not get asked host vs configure — goes straight to provider & model search
      "openrouter", // provider
      "sk-fallback-key", // api key
      "gpt-5.2", // primary model
      "gpt-5.2-vision", // vision model
      "gpt-5.2-coder", // coding model
      "skip",
    ]);
    const { deps, chains } = fakeDeps({
      applyRouting: async (choices) => {
        routedChoices = choices;
      },
      listModels: async () => [
        { id: "gpt-5.2", name: "GPT 5.2", provider: "openrouter", reasoning: false, input: ["text"], model: "gpt-5.2", supportsImages: false },
        { id: "gpt-5.2-vision", name: "GPT 5 Vision", provider: "openrouter", reasoning: false, input: ["text", "image"], model: "gpt-5.2-vision", supportsImages: true },
        { id: "gpt-5.2-coder", name: "GPT 5 Coder", provider: "openrouter", reasoning: false, input: ["text"], model: "gpt-5.2-coder", supportsImages: false },
      ],
    });
    const r = await runBrainOnboarding(q, deps);
    expect(r.notice).toContain("pi-primary → pi-fallback");
    expect(chains).toEqual([["pi-primary", "pi-fallback"]]);
    expect(routedChoices).toEqual({
      provider: "openrouter",
      primaryModel: "gpt-5.2",
      imageModel: "gpt-5.2-vision",
      codingModel: "gpt-5.2-coder",
    });
    // Fallback Pi did not prompt for host config
    expect(picked.filter((p) => p.includes("fallback brain) — how should its models be configured"))).toHaveLength(0);
  });

  test("Pi primary (configure) and Pi fallback (host): fallback Pi can use host config", async () => {
    const { q } = fakeQ([
      "pi", "pi", // primary, fallback
      "configure", // primary configures models
      "openrouter", // provider
      "sk-primary-key", // api key
      "gpt-5.2", // primary model
      "gpt-5.2-vision", // vision model
      "gpt-5.2-coder", // coding model
      "host", // fallback Pi can pick host config because primary is custom
      "skip",
    ]);
    const { deps, chains } = fakeDeps({
      listModels: async () => [
        { id: "gpt-5.2", name: "GPT 5.2", provider: "openrouter", reasoning: false, input: ["text"], model: "gpt-5.2", supportsImages: false },
        { id: "gpt-5.2-vision", name: "GPT 5 Vision", provider: "openrouter", reasoning: false, input: ["text", "image"], model: "gpt-5.2-vision", supportsImages: true },
        { id: "gpt-5.2-coder", name: "GPT 5 Coder", provider: "openrouter", reasoning: false, input: ["text"], model: "gpt-5.2-coder", supportsImages: false },
      ],
    });
    const r = await runBrainOnboarding(q, deps);
    expect(r.notice).toContain("pi-primary → pi-fallback");
    expect(chains).toEqual([["pi-primary", "pi-fallback"]]);
  });

  test("maybePromptRestart is called on test pass", async () => {
    let restartPrompted = false;
    const { q } = fakeQ([
      "claude",
      "",
      "test",
    ]);
    const { deps, chains } = fakeDeps({
      maybePromptRestart: async () => {
        restartPrompted = true;
      },
    });
    const r = await runBrainOnboarding(q, deps);
    expect(r.landing).toBe("chat");
    expect(chains).toEqual([["claude"]]);
    expect(restartPrompted).toBe(true);
  });
});

/**
 * A stateful stand-in for the three stores the interview writes as it goes:
 * config.toml routing, the vault secret, and Pi's auth.json. `snapshotWrites`
 * / `restoreWrites` are wired the same way `createBrainOnboardingDeps` wires
 * the real ones, so a rollback here exercises the flow's contract with them.
 */
function worldDeps(prior: {
  routing?: Record<string, unknown>;
  secret?: string;
  auth?: string;
}) {
  const world = {
    routing: prior.routing,
    secret: prior.secret,
    auth: prior.auth,
  };
  const { deps, chains } = fakeDeps({
    routing: (prior.routing ?? {}) as BrainOnboardingDeps["routing"],
    storedKey: prior.secret,
    applyRouting: async (choices) => {
      world.routing = { ...(choices as unknown as Record<string, unknown>) };
    },
    clearRouting: async () => {
      world.routing = undefined;
    },
    setSecret: async (value) => {
      world.secret = value;
      return { ok: true };
    },
    unsetSecret: async () => {
      world.secret = undefined;
    },
    writeAuth: async (provider, value) => {
      world.auth = `${provider}:${value}`;
      return { ok: true, path: "/tmp/auth.json" };
    },
    listModels: async () => [
      { id: "gpt-5.2", name: "GPT 5.2", provider: "openrouter", reasoning: false, input: ["text"], model: "gpt-5.2", supportsImages: false },
      { id: "gpt-5.2-vision", name: "GPT 5 Vision", provider: "openrouter", reasoning: false, input: ["text", "image"], model: "gpt-5.2-vision", supportsImages: true },
      { id: "gpt-5.2-coder", name: "GPT 5 Coder", provider: "openrouter", reasoning: false, input: ["text"], model: "gpt-5.2-coder", supportsImages: false },
    ],
    // The PRODUCTION snapshot/restore, over in-memory stores — not a copy of
    // their logic, so a regression in either shows up here.
    snapshotWrites: () =>
      snapshotBrainWrites([{ instanceId: undefined, secretName: "PI_KEY" }], {
        snapshotRouting: async () =>
          world.routing ? { ...world.routing } : undefined,
        readVaultSecret: async () => world.secret,
        snapshotAuth: async () => world.auth,
      }),
    restoreWrites: (snap) =>
      restoreBrainWrites(snap, {
        restoreRouting: async (table) => {
          world.routing = table ? { ...table } : undefined;
        },
        setVaultSecret: async (_name, value) => {
          world.secret = value;
          return { ok: true };
        },
        unsetVaultSecret: async () => {
          world.secret = undefined;
          return { ok: true };
        },
        restoreAuth: async (auth) => {
          world.auth = auth;
          return { ok: true };
        },
      }),
  });
  return { deps, chains, world };
}

/** The full "configure this Pi here" interview, from primary brain to test. */
const CONFIGURE_ANSWERS = [
  "pi", // primary brain
  "", // fallback: none
  "configure", // configure provider + models here
  "openrouter", // provider
  "sk-new-key", // api key
  "gpt-5.2", // primary model
  "gpt-5.2-vision", // vision model
  "gpt-5.2-coder", // coding model
  "test", // test now
];

/** A BrainTest screen that returns a fixed verdict. */
const testScreen = (result: { ok: boolean; apply?: boolean; detail?: string }) =>
  async () => ({
    ok: result.ok,
    apply: result.apply,
    retry: false,
    detail: result.detail ?? "ready",
  }) as never;

const PRIOR = {
  routing: {
    provider: "groq",
    primaryModel: "llama-4",
    imageModel: undefined,
    codingModel: undefined,
  },
  secret: "sk-old-key",
  auth: "groq:sk-old-key",
};

describe("brain onboarding rollback (PR #539 review)", () => {
  /** The test screen's answer: passed, and what the operator chose next. */
  test("declining to apply after a passing test puts every store back", async () => {
    const { q } = fakeQ(CONFIGURE_ANSWERS);
    q.testBrain = testScreen({ ok: true, apply: false });
    const { deps, chains, world } = worldDeps(PRIOR);

    const r = await runBrainOnboarding(q, deps);

    // The interview DID write — provider, key, models and Pi's auth store are
    // persisted slot by slot, long before the apply question. Declining must
    // therefore roll them back, not merely skip applyChain.
    expect(world.routing).toEqual(PRIOR.routing);
    expect(world.secret).toBe("sk-old-key");
    expect(world.auth).toBe("groq:sk-old-key");
    expect(chains).toEqual([]);
    expect(r.landing).toBe("configure");
    expect(r.notice).toStartWith("brain unchanged");
  });

  test("a failed test rolls back too", async () => {
    const { q } = fakeQ(CONFIGURE_ANSWERS);
    q.testBrain = testScreen({ ok: false, detail: "401 unauthorized" });
    const { deps, chains, world } = worldDeps(PRIOR);

    const r = await runBrainOnboarding(q, deps);

    expect(world.routing).toEqual(PRIOR.routing);
    expect(world.secret).toBe("sk-old-key");
    expect(world.auth).toBe("groq:sk-old-key");
    expect(chains).toEqual([]);
    expect(r.notice).toContain("401");
  });

  test("applying keeps everything the interview wrote", async () => {
    const { q } = fakeQ(CONFIGURE_ANSWERS);
    q.testBrain = testScreen({ ok: true, apply: true });
    const { deps, chains, world } = worldDeps(PRIOR);

    const r = await runBrainOnboarding(q, deps);

    expect(world.routing).toEqual({
      provider: "openrouter",
      primaryModel: "gpt-5.2",
      imageModel: "gpt-5.2-vision",
      codingModel: "gpt-5.2-coder",
    });
    expect(world.secret).toBe("sk-new-key");
    expect(world.auth).toBe("openrouter:sk-new-key");
    expect(chains).toEqual([["pi"]]);
    expect(r.landing).toBe("chat");
  });

  test("cancelling mid-interview rolls back the slots already answered", async () => {
    // esc on the CODER slot, after provider + key + primary + vision landed.
    const { q } = fakeQ([
      "pi", "", "configure", "openrouter", "sk-new-key",
      "gpt-5.2", "gpt-5.2-vision", undefined,
    ]);
    const { deps, world } = worldDeps(PRIOR);

    const r = await runBrainOnboarding(q, deps);

    expect(world.secret).toBe("sk-old-key");
    expect(world.auth).toBe("groq:sk-old-key");
    expect(r.notice).toStartWith("brain unchanged");
  });

  test("a failed restore says so instead of claiming the brain is unchanged", async () => {
    const { q } = fakeQ(CONFIGURE_ANSWERS);
    q.testBrain = testScreen({ ok: true, apply: false });
    const { deps } = worldDeps(PRIOR);

    const r = await runBrainOnboarding(q, {
      ...deps,
      restoreWrites: async () => false,
    });

    // Honesty over comfort: the stores are in an unknown state, and the
    // notice must not tell the operator their old brain is intact.
    expect(r.notice).toStartWith("brain partly saved");
    expect(r.landing).toBe("configure");
  });
});

/**
 * The production snapshot/restore on their own (PR #539 re-review, Kai/Lena):
 * an absent vault row must come back ABSENT even with an ambient fallback in
 * the environment, and every store must be attempted and counted.
 */
describe("snapshotBrainWrites / restoreBrainWrites", () => {
  const NAME = "PB_TEST_ROLLBACK_KEY";
  const slots = [{ instanceId: undefined, secretName: NAME }];

  function stores(over: Partial<BrainRestoreStores> = {}) {
    const calls: string[] = [];
    const s: BrainRestoreStores = {
      restoreRouting: async (_t, id) => {
        calls.push(`routing:${id ?? ""}`);
      },
      setVaultSecret: async (name, value) => {
        calls.push(`set:${name}=${value}`);
        return { ok: true };
      },
      unsetVaultSecret: async (name) => {
        calls.push(`unset:${name}`);
        return { ok: true };
      },
      restoreAuth: async () => {
        calls.push("auth");
        return { ok: true };
      },
      ...over,
    };
    return { s, calls };
  }

  test("absent vault row + ambient fallback: restore UNSETS, never mints an override", async () => {
    const saved = process.env[NAME];
    process.env[NAME] = "sk-host-wide";
    try {
      const snap = await snapshotBrainWrites(slots, {
        snapshotRouting: async () => undefined,
        readVaultSecret: async () => undefined, // no persona row
        snapshotAuth: async () => undefined,
      });
      process.env[NAME] = "sk-wizard"; // setPersonaSecret mirrors into env
      const { s, calls } = stores();

      expect(await restoreBrainWrites(snap, s)).toBe(true);
      expect(calls).toContain(`unset:${NAME}`);
      expect(calls.some((c) => c.startsWith("set:"))).toBe(false);
      // …and the host-wide key is back in this process, not lost to the unset.
      expect(process.env[NAME]).toBe("sk-host-wide");
    } finally {
      if (saved === undefined) delete process.env[NAME];
      else process.env[NAME] = saved;
    }
  });

  test("an existing vault row is written back verbatim", async () => {
    const snap = await snapshotBrainWrites(slots, {
      snapshotRouting: async () => undefined,
      readVaultSecret: async () => "sk-old",
      snapshotAuth: async () => undefined,
    });
    const { s, calls } = stores();
    expect(await restoreBrainWrites(snap, s)).toBe(true);
    expect(calls).toContain(`set:${NAME}=sk-old`);
  });

  test("a failed unset ({ok:false}) makes the rollback report failure", async () => {
    const snap = {
      routing: {},
      secrets: { [NAME]: { vault: undefined, env: undefined } },
      auth: undefined,
    };
    const { s } = stores({ unsetVaultSecret: async () => ({ ok: false }) });
    expect(await restoreBrainWrites(snap, s)).toBe(false);
  });

  test("a throwing routing restore still attempts every other store, then reports failure", async () => {
    const snap = {
      routing: { "": { provider: "groq" }, "pi-primary": undefined },
      secrets: { [NAME]: { vault: "sk-old", env: undefined } },
      auth: "{}",
    };
    const { s, calls } = stores({
      restoreRouting: async (_t, id) => {
        calls.push(`routing:${id ?? ""}`);
        if (id === undefined) throw new Error("config.toml locked");
      },
    });
    expect(await restoreBrainWrites(snap, s)).toBe(false);
    expect(calls).toEqual([
      "routing:",
      "routing:pi-primary",
      `set:${NAME}=sk-old`,
      "auth",
    ]);
  });

  test("a throwing restoreWrites still reaches the honest 'partly saved' notice", async () => {
    const { q } = fakeQ(CONFIGURE_ANSWERS);
    q.testBrain = testScreen({ ok: true, apply: false });
    const { deps } = worldDeps(PRIOR);
    const r = await runBrainOnboarding(q, {
      ...deps,
      restoreWrites: async () => {
        throw new Error("boom");
      },
    });
    expect(r.notice).toStartWith("brain partly saved");
    expect(r.landing).toBe("configure");
  });
});
