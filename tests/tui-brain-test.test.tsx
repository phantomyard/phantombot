import { afterEach, describe, expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import React from "react";
import { render } from "ink";

import {
  BrainTestScreen,
  type BrainTestRequest,
  type BrainTestResult,
} from "../src/tui/screens/BrainTest.tsx";
import { runBrainOnboarding, type BrainOnboardingDeps } from "../src/tui/brainOnboarding.ts";
import type { BrainQuestions } from "../src/tui/brainFlow.ts";
import { stripAnsi } from "./helpers/ansi.ts";

let mounted: Array<() => void> = [];
afterEach(() => {
  for (const c of mounted) c();
  mounted = [];
});

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function mount(node: React.ReactElement) {
  const stdin = new PassThrough() as PassThrough & {
    isTTY: boolean;
    setRawMode: () => void;
    ref: () => void;
    unref: () => void;
  };
  stdin.isTTY = true;
  stdin.setRawMode = () => {};
  stdin.ref = () => {};
  stdin.unref = () => {};
  const frames: string[] = [];
  const stdout = new EventEmitter() as EventEmitter & {
    columns: number;
    rows: number;
    write: (c: string) => void;
  };
  stdout.columns = 100;
  stdout.rows = 40;
  stdout.write = (c: string) => void frames.push(c);
  const instance = render(node, {
    stdin: stdin as never,
    stdout: stdout as never,
    exitOnCtrlC: false,
    patchConsole: false,
    debug: true,
  });
  mounted.push(() => instance.unmount());
  return {
    frame: () => stripAnsi(frames.at(-1) ?? ""),
    press: async (bytes: string) => {
      stdin.write(bytes);
      await sleep(40);
    },
  };
}

describe("BrainTestScreen checklist", () => {
  test("shows in-progress state then success checklist and applies on y", async () => {
    let answer: BrainTestResult | undefined;
    let resolveProbe!: (val: { ok: boolean; detail: string }) => void;
    const probePromise = new Promise<{ ok: boolean; detail: string }>((r) => {
      resolveProbe = r;
    });

    const req: BrainTestRequest = {
      persona: "batman",
      harness: "pi",
      probe: () => probePromise,
    };

    const ui = mount(
      <BrainTestScreen request={req} onAnswer={(res) => { answer = res; }} />,
    );

    // Initial frame shows in progress
    expect(ui.frame()).toContain("Test in progress....");
    expect(ui.frame()).toContain("Testing model configuration for batman");

    // Resolve probe with success
    resolveProbe({ ok: true, detail: "I am ready to help." });
    await sleep(60);

    expect(ui.frame()).toContain("Test in progress....");
    expect(ui.frame()).toContain("Test successful, apply? (Y/n)");
    expect(ui.frame()).toContain("Yes, apply configuration");

    // Press y
    await ui.press("y");
    expect(answer).toEqual({
      ok: true,
      apply: true,
      detail: "I am ready to help.",
    });
  });

  test("declines apply on n when test succeeds", async () => {
    let answer: BrainTestResult | undefined;
    const req: BrainTestRequest = {
      persona: "batman",
      harness: "pi",
      probe: async () => ({ ok: true, detail: "All good" }),
    };

    const ui = mount(
      <BrainTestScreen request={req} onAnswer={(res) => { answer = res; }} />,
    );
    await sleep(60);

    expect(ui.frame()).toContain("Test successful, apply? (Y/n)");
    await ui.press("n");
    expect(answer).toEqual({
      ok: true,
      apply: false,
      detail: "All good",
    });
  });

  test("shows failure state, error details, and retries on y", async () => {
    let answer: BrainTestResult | undefined;
    const req: BrainTestRequest = {
      persona: "batman",
      harness: "claude",
      probe: async () => ({ ok: false, detail: "401 Unauthorized: Invalid API key" }),
    };

    const ui = mount(
      <BrainTestScreen request={req} onAnswer={(res) => { answer = res; }} />,
    );
    await sleep(60);

    expect(ui.frame()).toContain("Test in progress....");
    expect(ui.frame()).toContain("401 Unauthorized: Invalid API key");
    expect(ui.frame()).toContain("Test failed, retry? (Y/n)");
    expect(ui.frame()).toContain("Yes, retry setup & test");

    await ui.press("y");
    expect(answer).toEqual({
      ok: false,
      retry: true,
      detail: "401 Unauthorized: Invalid API key",
    });
  });

  test("cancels on esc when test fails", async () => {
    let answer: BrainTestResult | undefined;
    const req: BrainTestRequest = {
      persona: "batman",
      harness: "claude",
      probe: async () => ({ ok: false, detail: "rate limit exceeded" }),
    };

    const ui = mount(
      <BrainTestScreen request={req} onAnswer={(res) => { answer = res; }} />,
    );
    await sleep(60);

    await ui.press("\u001b"); // ESC
    expect(answer).toEqual({
      ok: false,
      retry: false,
      detail: "rate limit exceeded",
    });
  });

  test("runBrainOnboarding with testBrain lands in chat on apply", async () => {
    const q: BrainQuestions = {
      choose: async () => "pi", // pick primary
      search: async () => "",
      value: async () => "",
      note: () => {},
      testBrain: async () => ({
        ok: true,
        apply: true,
        detail: "test ok",
      }),
    };

    let appliedChain: string[] = [];
    const deps: BrainOnboardingDeps = {
      persona: "batman",
      availability: async () => ({ pi: "/usr/bin/pi", claude: undefined, codex: undefined }),
      installCommand: "",
      installPi: async () => true,
      chain: [],
      routing: {},
      targetPath: "/tmp/config.toml",
      personaScope: true,
      listModels: async () => [],
      setSecret: async () => ({ ok: true }),
      unsetSecret: async () => undefined,
      writeAuth: async () => ({ ok: true, path: "/tmp/auth.json" }),
      applyChain: async (chain) => { appliedChain = [...chain]; },
      applyRouting: async () => undefined,
      clearRouting: async () => undefined,
      probe: async () => ({ ok: true, detail: "test ok" }),
    };

    // primary = pi, fallback = "" (none), mode = host, test = test
    let chooseCount = 0;
    q.choose = async () => {
      chooseCount++;
      if (chooseCount === 1) return "pi"; // primary
      if (chooseCount === 2) return ""; // fallback none
      if (chooseCount === 3) return "host"; // mode
      if (chooseCount === 4) return "test"; // test the brain
      return undefined;
    };

    const result = await runBrainOnboarding(q, deps);
    expect(result.landing).toBe("chat");
    expect(appliedChain).toEqual(["pi"]);
    expect(result.notice).toContain("brain verified: pi");
  });

  test("runBrainOnboarding with testBrain lands in configure on discard", async () => {
    let appliedChain: string[] = [];
    let chooseCount = 0;
    const q: BrainQuestions = {
      choose: async () => {
        chooseCount++;
        if (chooseCount === 1) return "pi";
        if (chooseCount === 2) return "";
        if (chooseCount === 3) return "host";
        if (chooseCount === 4) return "test";
        return undefined;
      },
      search: async () => "",
      value: async () => "",
      note: () => {},
      testBrain: async () => ({
        ok: true,
        apply: false,
        detail: "test ok",
      }),
    };

    const deps: BrainOnboardingDeps = {
      persona: "batman",
      availability: async () => ({ pi: "/usr/bin/pi", claude: undefined, codex: undefined }),
      installCommand: "",
      installPi: async () => true,
      chain: [],
      routing: {},
      targetPath: "/tmp/config.toml",
      personaScope: true,
      listModels: async () => [],
      setSecret: async () => ({ ok: true }),
      unsetSecret: async () => undefined,
      writeAuth: async () => ({ ok: true, path: "/tmp/auth.json" }),
      applyChain: async (chain) => { appliedChain = [...chain]; },
      applyRouting: async () => undefined,
      clearRouting: async () => undefined,
      probe: async () => ({ ok: true, detail: "test ok" }),
    };

    const result = await runBrainOnboarding(q, deps);
    expect(result.landing).toBe("configure");
    expect(appliedChain).toEqual([]);
    expect(result.notice).toContain("not applied");
  });
});
