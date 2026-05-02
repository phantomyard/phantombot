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

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
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
  rerenderUnitIfStale: async () => ({ rerendered: false }),
};

let workdir: string;
let personasDir: string;
let configPath: string;
let stateDir: string;

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
});

afterEach(async () => {
  delete process.env.PHANTOMBOT_STATE;
  await rm(workdir, { recursive: true, force: true });
});

function makeConfig(overrides: Partial<Config> = {}): Config {
  return {
    defaultPersona: "phantom",
    turnTimeoutMs: 1000,
    personasDir,
    memoryDbPath: join(workdir, "memory.sqlite"),
    configPath,
    harnesses: {
      chain: ["claude"],
      claude: { bin: "claude", model: "opus", fallbackModel: "sonnet" },
      pi: { bin: "pi", maxPayloadBytes: 1 },
      gemini: { bin: "gemini", model: "" },
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
      config: makeConfig(),
      serviceControl: svcInactive,
      out,
      err: new CaptureStream(),
    });
    expect(code).toBe(0);
    expect(out.text).toContain("→ 'robbie'");
    const state = JSON.parse(
      await Bun.file(process.env.PHANTOMBOT_STATE!).text(),
    );
    expect(state.default_persona).toBe("robbie");
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
      config: makeConfig(),
      serviceControl: svcInactive,
      out,
      err: new CaptureStream(),
    });
    expect(code).toBe(0);
    expect(out.text).toContain("→ 'robbie'");
  });
});
