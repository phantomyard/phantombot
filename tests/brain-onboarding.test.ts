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
  runBrainOnboarding,
  type BrainOnboardingDeps,
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
      "host", // use host configuration (skip the long provider pass)
      "", // fallback: none
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
    const attempt = ["pi", "host", "", "test"];
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
      "host", // host configuration
      "", // fallback: none
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
      "host", // use host configuration
      "", // fallback: none
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
});
