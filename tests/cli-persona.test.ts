/**
 * Tests for the consolidated `phantombot persona` CLI.
 *
 * Three flows the CLI exposes:
 *   - bare `phantombot persona`           → TUI menu (not driven by tests)
 *   - `phantombot persona <name>`         → switch default
 *   - `phantombot persona --import <dir>` → non-interactive import
 *
 * The TUI menu itself isn't tested here (it'd require @clack/prompts
 * mocking that's not worth the friction for a menu-of-existing-flows);
 * the underlying flows are covered by cli-create-persona / cli-import-persona.
 *
 * What we DO cover here: the dispatcher arg parsing, the switch path
 * end-to-end, and the bug-fix mutual-exclusion between --import and a
 * positional <name>.
 */

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runPersona, runSwitchPersona } from "../src/cli/persona.ts";
import type { Config } from "../src/config.ts";
import type { ServiceControl } from "../src/lib/systemd.ts";

class CaptureStream {
  chunks: string[] = [];
  write(s: string | Uint8Array): boolean {
    this.chunks.push(typeof s === "string" ? s : new TextDecoder().decode(s));
    return true;
  }
  get text(): string {
    return this.chunks.join("");
  }
}

const svcInactive: ServiceControl = {
  isActive: async () => false,
  restart: async () => ({ ok: true }),
  start: async () => ({ ok: true }),
  stop: async () => ({ ok: true }),
  rerenderUnitIfStale: async () => ({ rerendered: false }),
};

let workdir: string;
let personasDir: string;
let configPath: string;
let stateDir: string;
let savedPersonaEnv: string | undefined;
let savedGlobalConfig: string | undefined;

beforeEach(async () => {
  workdir = await mkdtemp(join(tmpdir(), "phantombot-persona-cli-"));
  personasDir = join(workdir, "personas");
  await mkdir(personasDir, { recursive: true });
  configPath = join(workdir, "config.toml");
  // state.ts loads from ~/.local/share/phantombot/state.json by default.
  // Override via env so tests don't pollute the real home dir.
  stateDir = join(workdir, "data");
  await mkdir(stateDir, { recursive: true });
  process.env.PHANTOMBOT_STATE = join(stateDir, "state.json");
  // `default_persona` moved to the global config in #435; give each test its
  // own so switches neither leak between tests nor touch the real box.
  savedGlobalConfig = process.env.PHANTOMBOT_GLOBAL_CONFIG;
  process.env.PHANTOMBOT_GLOBAL_CONFIG = join(workdir, "global.toml");
  // Isolate PHANTOMBOT_PERSONA: the normal agent runtime sets it, which
  // would make every non-agent test hit the scope-refusal path (3/13
  // failures). Preserve the ambient value and restore it in afterEach so
  // the suite also passes when run from inside an agent.
  savedPersonaEnv = process.env.PHANTOMBOT_PERSONA;
  delete process.env.PHANTOMBOT_PERSONA;
});

afterEach(async () => {
  delete process.env.PHANTOMBOT_STATE;
  if (savedGlobalConfig === undefined) delete process.env.PHANTOMBOT_GLOBAL_CONFIG;
  else process.env.PHANTOMBOT_GLOBAL_CONFIG = savedGlobalConfig;
  if (savedPersonaEnv === undefined) {
    delete process.env.PHANTOMBOT_PERSONA;
  } else {
    process.env.PHANTOMBOT_PERSONA = savedPersonaEnv;
  }
  mock.restore();
  await rm(workdir, { recursive: true, force: true });
});

/**
 * The persisted default persona. Since #435 a switch writes it to the GLOBAL
 * config (`<personas-root>/config.toml`), not to the per-persona state file —
 * a default that lived inside one persona's state could only ever be seen by
 * that persona.
 */
async function persistedDefault(): Promise<string | undefined> {
  const text = await Bun.file(process.env.PHANTOMBOT_GLOBAL_CONFIG!).text();
  return /^\s*default_persona\s*=\s*"([^"]*)"/m.exec(text)?.[1];
}

function makeConfig(overrides: Partial<Config> = {}): Config {
  return {
    defaultPersona: "phantom",
    harnessIdleTimeoutMs: 1000, harnessHardTimeoutMs: 1000, harnessStartupTimeoutMs: 1000,
    personasDir,
    memoryDbPath: join(workdir, "memory.sqlite"),
    configPath,
    harnesses: {
      chain: ["claude"],
      claude: { bin: "claude", model: "opus", fallbackModel: "sonnet" },
      pi: { bin: "pi", maxPayloadBytes: 1 },
    },
    channels: {},
    embeddings: { provider: "none" },
    voice: { provider: "none" },
    ...overrides,
  };
}

describe("runPersona arg validation", () => {
  test("--import combined with positional name → exit 2", async () => {
    const err = new CaptureStream();
    const code = await runPersona({
      name: "robbie",
      import: "/tmp/somewhere",
      config: makeConfig(),
      out: new CaptureStream(),
      err,
    });
    expect(code).toBe(2);
    expect(err.text).toContain("don't combine --import");
  });
});

describe("runSwitchPersona", () => {
  test("missing persona dir → exit 1 with available list", async () => {
    await mkdir(join(personasDir, "phantom"), { recursive: true });
    await mkdir(join(personasDir, "robbie"), { recursive: true });
    const err = new CaptureStream();
    const code = await runSwitchPersona({
      name: "missing",
      config: makeConfig(),
      serviceControl: svcInactive,
      out: new CaptureStream(),
      err,
    });
    expect(code).toBe(1);
    expect(err.text).toContain("'missing' not found");
    expect(err.text).toMatch(/available:.*phantom/);
    expect(err.text).toMatch(/available:.*robbie/);
  });

  test("missing persona dir with no personas at all → distinct hint", async () => {
    const err = new CaptureStream();
    const code = await runSwitchPersona({
      name: "anything",
      config: makeConfig(),
      serviceControl: svcInactive,
      out: new CaptureStream(),
      err,
    });
    expect(code).toBe(1);
    expect(err.text).toContain("no personas exist yet");
  });

  test("happy path: writes default_persona to state.json", async () => {
    await mkdir(join(personasDir, "robbie"), { recursive: true });
    const out = new CaptureStream();
    const code = await runSwitchPersona({
      name: "robbie",
      yes: true,
      config: makeConfig(),
      serviceControl: svcInactive,
      out,
      err: new CaptureStream(),
    });
    expect(code).toBe(0);
    expect(out.text).toContain("→ 'robbie'");
    expect(await persistedDefault()).toBe("robbie");
  });

  test("non-TTY without --yes → refuses, no state write (regression #371)", async () => {
    await mkdir(join(personasDir, "robbie"), { recursive: true });
    await writeFile(
      process.env.PHANTOMBOT_STATE!,
      JSON.stringify({ default_persona: "phantom" }),
      "utf8",
    );
    const err = new CaptureStream();
    const code = await runSwitchPersona({
      name: "robbie",
      // Force the non-TTY path deterministically: the real TTY detection
      // (process.stdin.isTTY && process.stdout.isTTY) is environment-
      // dependent and would hang in an interactive test runner.
      isInteractive: false,
      config: makeConfig(),
      serviceControl: svcInactive,
      out: new CaptureStream(),
      err,
    });
    expect(code).toBe(2);
    expect(err.text).toContain("--yes");
    // The persisted default must be untouched.
    const state = JSON.parse(
      await Bun.file(process.env.PHANTOMBOT_STATE!).text(),
    );
    expect(state.default_persona).toBe("phantom");
  });

  test("confirm=false → cancelled, no state write", async () => {
    await mkdir(join(personasDir, "robbie"), { recursive: true });
    await writeFile(
      process.env.PHANTOMBOT_STATE!,
      JSON.stringify({ default_persona: "phantom" }),
      "utf8",
    );
    const out = new CaptureStream();
    const code = await runSwitchPersona({
      name: "robbie",
      confirm: async () => false,
      config: makeConfig(),
      serviceControl: svcInactive,
      out,
      err: new CaptureStream(),
    });
    expect(code).toBe(0);
    expect(out.text).toContain("cancelled");
    const state = JSON.parse(
      await Bun.file(process.env.PHANTOMBOT_STATE!).text(),
    );
    expect(state.default_persona).toBe("phantom");
  });

  test("agent context (PHANTOMBOT_PERSONA set) → refuse, no state write", async () => {
    await mkdir(join(personasDir, "alma"), { recursive: true });
    await writeFile(
      process.env.PHANTOMBOT_STATE!,
      JSON.stringify({ default_persona: "paco" }),
      "utf8",
    );
    process.env.PHANTOMBOT_PERSONA = "alma";
    try {
      const err = new CaptureStream();
      // The real #371 incident: agent `alma` runs `phantombot persona alma`,
      // unaware it re-points the daemon-wide default (paco → alma).
      const code = await runSwitchPersona({
        name: "alma",
        yes: true,
        config: makeConfig(),
        serviceControl: svcInactive,
        out: new CaptureStream(),
        err,
      });
      expect(code).toBe(2);
      expect(err.text).toContain("PHANTOMBOT_PERSONA");
      const state = JSON.parse(
        await Bun.file(process.env.PHANTOMBOT_STATE!).text(),
      );
      expect(state.default_persona).toBe("paco");
    } finally {
      delete process.env.PHANTOMBOT_PERSONA;
    }
  });

  test("agent context + --yes + different target → still refused, no state write", async () => {
    await mkdir(join(personasDir, "alma"), { recursive: true });
    await mkdir(join(personasDir, "paco"), { recursive: true });
    await writeFile(
      process.env.PHANTOMBOT_STATE!,
      JSON.stringify({ default_persona: "phantom" }),
      "utf8",
    );
    process.env.PHANTOMBOT_PERSONA = "alma";
    try {
      const err = new CaptureStream();
      // Adversarial case: agent `alma` tries to re-point default to a
      // DIFFERENT persona (`paco`), even with --yes — the scope check must
      // win over --yes (default is `phantom`, so this is a real switch).
      const code = await runSwitchPersona({
        name: "paco",
        yes: true,
        config: makeConfig(),
        serviceControl: svcInactive,
        out: new CaptureStream(),
        err,
      });
      expect(code).toBe(2);
      expect(err.text).toContain("PHANTOMBOT_PERSONA");
      const state = JSON.parse(
        await Bun.file(process.env.PHANTOMBOT_STATE!).text(),
      );
      expect(state.default_persona).toBe("phantom");
    } finally {
      delete process.env.PHANTOMBOT_PERSONA;
    }
  });

  test("interactive TTY confirm=true → prompts via defaultConfirm and persists", async () => {
    await mkdir(join(personasDir, "robbie"), { recursive: true });
    await writeFile(
      process.env.PHANTOMBOT_STATE!,
      JSON.stringify({ default_persona: "phantom" }),
      "utf8",
    );
    const out = new CaptureStream();
    // Drive the REAL defaultConfirm through an @clack mock: proves the
    // interactive branch calls it and persists on true.
    let promptedMessage = "";
    mock.module("@clack/prompts", () => ({
      confirm: async ({ message }: { message: string }) => {
        promptedMessage = message;
        return true;
      },
      isCancel: () => false,
      intro: () => {},
      note: () => {},
      outro: () => {},
      select: async () => undefined,
      cancel: () => {},
    }));
    const code = await runSwitchPersona({
      name: "robbie",
      isInteractive: true,
      config: makeConfig(),
      serviceControl: svcInactive,
      out,
      err: new CaptureStream(),
    });
    expect(code).toBe(0);
    expect(promptedMessage).toContain("robbie");
    expect(await persistedDefault()).toBe("robbie");
  });

  test("interactive TTY confirm=false → cancelled, no state write", async () => {
    await mkdir(join(personasDir, "robbie"), { recursive: true });
    await writeFile(
      process.env.PHANTOMBOT_STATE!,
      JSON.stringify({ default_persona: "phantom" }),
      "utf8",
    );
    const out = new CaptureStream();
    mock.module("@clack/prompts", () => ({
      confirm: async () => false,
      isCancel: () => false,
      intro: () => {},
      note: () => {},
      outro: () => {},
      select: async () => undefined,
      cancel: () => {},
    }));
    const code = await runSwitchPersona({
      name: "robbie",
      isInteractive: true,
      config: makeConfig(),
      serviceControl: svcInactive,
      out,
      err: new CaptureStream(),
    });
    expect(code).toBe(0);
    expect(out.text).toContain("cancelled");
    const state = JSON.parse(
      await Bun.file(process.env.PHANTOMBOT_STATE!).text(),
    );
    expect(state.default_persona).toBe("phantom");
  });

  test("concurrent writer during confirmation → other fields preserved (lost-update regression)", async () => {
    await mkdir(join(personasDir, "robbie"), { recursive: true });
    await writeFile(
      process.env.PHANTOMBOT_STATE!,
      JSON.stringify({
        default_persona: "phantom",
        harness_bins: { claude: "/usr/bin/claude" },
      }),
      "utf8",
    );
    const out = new CaptureStream();
    // Simulate another process writing state (harness_bins discovery AND a
    // concurrent default_persona switch) while this switch waits on the
    // injected confirm.
    const code = await runSwitchPersona({
      name: "robbie",
      confirm: async () => {
        await writeFile(
          process.env.PHANTOMBOT_STATE!,
          JSON.stringify({
            default_persona: "alma",
            harness_bins: { claude: "/opt/new/claude" },
          }),
          "utf8",
        );
        return true;
      },
      config: makeConfig(),
      serviceControl: svcInactive,
      out,
      err: new CaptureStream(),
    });
    expect(code).toBe(0);
    const state = JSON.parse(
      await Bun.file(process.env.PHANTOMBOT_STATE!).text(),
    );
    expect(await persistedDefault()).toBe("robbie");
    // The concurrent write must survive: re-loading fresh state before the
    // commit preserves fields we didn't touch.
    expect(state.harness_bins).toEqual({ claude: "/opt/new/claude" });
    // The success message must reflect the freshest `previous`, not the
    // stale snapshot captured before confirmation ('alma' was committed by
    // the concurrent writer while we were confirming).
    expect(out.text).toContain("'alma' → 'robbie'");
  });

  test("already-current → no-op exit 0, no state write", async () => {
    await mkdir(join(personasDir, "phantom"), { recursive: true });
    // Pre-write state with phantom as default.
    await writeFile(
      process.env.PHANTOMBOT_STATE!,
      JSON.stringify({ default_persona: "phantom" }),
      "utf8",
    );
    const out = new CaptureStream();
    const code = await runSwitchPersona({
      name: "phantom",
      config: makeConfig(),
      serviceControl: svcInactive,
      out,
      err: new CaptureStream(),
    });
    expect(code).toBe(0);
    expect(out.text).toContain("already the default");
  });
});

describe("runPersona dispatch", () => {
  test("positional <name> routes to runSwitchPersona", async () => {
    await mkdir(join(personasDir, "robbie"), { recursive: true });
    const out = new CaptureStream();
    const code = await runPersona({
      name: "robbie",
      yes: true,
      config: makeConfig(),
      serviceControl: svcInactive,
      out,
      err: new CaptureStream(),
    });
    expect(code).toBe(0);
    expect(out.text).toContain("→ 'robbie'");
  });
});
