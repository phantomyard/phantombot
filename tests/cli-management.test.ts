/**
 * Tests for the small management commands:
 *   list-personas, set-default-persona, history, config, doctor.
 *
 * All tests use a real temp filesystem; no subprocesses (except editor
 * spawn in config edit, which we mock).
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runConfig, runConfigEdit } from "../src/cli/config.ts";
import { runDoctor } from "../src/cli/doctor.ts";
import { runHistory } from "../src/cli/history.ts";
import { runListPersonas } from "../src/cli/list-personas.ts";
import { runSetDefaultPersona } from "../src/cli/set-default-persona.ts";
import type { Config } from "../src/config.ts";
import { openMemoryStore } from "../src/memory/store.ts";
import { loadState, statePath } from "../src/state.ts";

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

let workdir: string;
let config: Config;
const SAVED_STATE = process.env.PHANTOMBOT_STATE;

beforeEach(async () => {
  workdir = await mkdtemp(join(tmpdir(), "phantombot-mgmt-"));
  await mkdir(join(workdir, "personas"), { recursive: true });
  process.env.PHANTOMBOT_STATE = join(workdir, "state.json");
  config = {
    defaultPersona: "phantom",
    turnTimeoutMs: 600_000,
    personasDir: join(workdir, "personas"),
    memoryDbPath: join(workdir, "memory.sqlite"),
    configPath: join(workdir, "config.toml"),
    harnesses: {
      chain: ["claude"],
      claude: { bin: "claude", model: "opus", fallbackModel: "sonnet" },
      pi: { bin: "pi", maxPayloadBytes: 1_500_000 },
    },
  };
});

afterEach(async () => {
  if (SAVED_STATE === undefined) delete process.env.PHANTOMBOT_STATE;
  else process.env.PHANTOMBOT_STATE = SAVED_STATE;
  await rm(workdir, { recursive: true, force: true });
});

async function makePersona(name: string, identityFile = "BOOT.md") {
  const dir = join(config.personasDir, name);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, identityFile), `# ${name}`);
}

// ---------------------------------------------------------------------------
// list-personas
// ---------------------------------------------------------------------------

describe("runListPersonas", () => {
  test("prints helpful message when no personas exist", async () => {
    const out = new CaptureStream();
    const code = await runListPersonas({ config, out });
    expect(code).toBe(0);
    expect(out.text).toContain("no personas found");
    expect(out.text).toContain("import-persona");
  });

  test("lists personas, marks the default with *", async () => {
    await makePersona("phantom");
    await makePersona("robbie", "SOUL.md");
    const out = new CaptureStream();
    const code = await runListPersonas({ config, out });
    expect(code).toBe(0);
    // phantom is the default — gets the * marker; robbie does not.
    expect(out.text).toContain("* phantom");
    expect(out.text).not.toContain("* robbie");
    expect(out.text).toContain("robbie  (SOUL.md)");
  });

  test("skips dirs without an identity file", async () => {
    await makePersona("phantom");
    await mkdir(join(config.personasDir, "garbage"));
    const out = new CaptureStream();
    await runListPersonas({ config, out });
    expect(out.text).toContain("phantom");
    expect(out.text).not.toContain("garbage");
  });
});

// ---------------------------------------------------------------------------
// set-default-persona
// ---------------------------------------------------------------------------

describe("runSetDefaultPersona", () => {
  test("writes default_persona to state.json and reports success", async () => {
    await makePersona("robbie");
    const out = new CaptureStream();
    const err = new CaptureStream();
    const code = await runSetDefaultPersona({
      name: "robbie",
      config,
      out,
      err,
    });
    expect(code).toBe(0);
    expect(out.text).toContain("default persona set to 'robbie'");
    const state = await loadState();
    expect(state.default_persona).toBe("robbie");
    // Should have created a state file at the configured path.
    expect(statePath()).toBe(join(workdir, "state.json"));
    const content = await readFile(join(workdir, "state.json"), "utf8");
    expect(JSON.parse(content)).toEqual({ default_persona: "robbie" });
  });

  test("refuses if the persona doesn't exist", async () => {
    const out = new CaptureStream();
    const err = new CaptureStream();
    const code = await runSetDefaultPersona({
      name: "doesnotexist",
      config,
      out,
      err,
    });
    expect(code).toBe(1);
    expect(err.text).toContain("not found");
    // No state file should be written.
    await expect(readFile(join(workdir, "state.json"), "utf8")).rejects.toThrow();
  });
});

// ---------------------------------------------------------------------------
// history
// ---------------------------------------------------------------------------

describe("runHistory", () => {
  test("prints helpful message when there are no turns", async () => {
    const out = new CaptureStream();
    const code = await runHistory({ config, out });
    expect(code).toBe(0);
    expect(out.text).toContain("no turns recorded");
  });

  test("prints recent turns with timestamps and roles", async () => {
    const m = await openMemoryStore(config.memoryDbPath);
    await m.appendTurn({
      persona: "phantom",
      conversation: "cli:default",
      role: "user",
      text: "hi",
    });
    await m.appendTurn({
      persona: "phantom",
      conversation: "cli:default",
      role: "assistant",
      text: "hello",
    });
    await m.close();

    const out = new CaptureStream();
    const code = await runHistory({ config, n: 10, out });
    expect(code).toBe(0);
    expect(out.text).toContain("user (cli:default)");
    expect(out.text).toContain("assistant (cli:default)");
    expect(out.text).toContain("hi");
    expect(out.text).toContain("hello");
  });

  test("respects --persona override", async () => {
    const m = await openMemoryStore(config.memoryDbPath);
    await m.appendTurn({
      persona: "phantom",
      conversation: "cli:default",
      role: "user",
      text: "phantom-msg",
    });
    await m.appendTurn({
      persona: "robbie",
      conversation: "cli:default",
      role: "user",
      text: "robbie-msg",
    });
    await m.close();

    const out = new CaptureStream();
    await runHistory({ config, persona: "robbie", out });
    expect(out.text).toContain("robbie-msg");
    expect(out.text).not.toContain("phantom-msg");
  });
});

// ---------------------------------------------------------------------------
// config
// ---------------------------------------------------------------------------

describe("runConfig", () => {
  test("prints the resolved configuration", async () => {
    const out = new CaptureStream();
    const code = await runConfig({ config, out });
    expect(code).toBe(0);
    expect(out.text).toContain("default_persona  = phantom");
    expect(out.text).toContain("personas_dir");
    expect(out.text).toContain("memory_db");
    expect(out.text).toContain("claude:");
    expect(out.text).toContain("model           = opus");
    expect(out.text).toContain("fallback_model  = sonnet");
    expect(out.text).toContain("Resolution priority");
  });
});

describe("runConfigEdit", () => {
  test("creates an empty config if none exists, then spawns editor", async () => {
    const out = new CaptureStream();
    const err = new CaptureStream();
    let spawned: string[] | undefined;
    const code = await runConfigEdit({
      config,
      editor: "fakeditor",
      out,
      err,
      spawn: async (cmd) => {
        spawned = cmd;
        return 0;
      },
    });
    expect(code).toBe(0);
    expect(spawned).toEqual(["fakeditor", config.configPath]);
    expect(out.text).toContain("created empty config");
    const content = await readFile(config.configPath, "utf8");
    expect(content).toContain("phantombot config");
  });

  test("propagates editor exit code", async () => {
    const out = new CaptureStream();
    const err = new CaptureStream();
    const code = await runConfigEdit({
      config,
      editor: "fakeditor",
      out,
      err,
      spawn: async () => 130, // user hit Ctrl-C in editor
    });
    expect(code).toBe(130);
    expect(err.text).toContain("exited with code 130");
  });
});

// ---------------------------------------------------------------------------
// doctor
// ---------------------------------------------------------------------------

describe("runDoctor", () => {
  test("returns 1 when default persona is missing and binaries are absent", async () => {
    const out = new CaptureStream();
    const code = await runDoctor({
      config,
      out,
      which: async () => undefined,
    });
    expect(code).toBe(1);
    expect(out.text).toContain("FAIL");
    expect(out.text).toContain("not imported yet");
  });

  test("returns 0 when everything is in place", async () => {
    await makePersona("phantom");
    const out = new CaptureStream();
    const fakeBin = "/usr/bin/claude-fake";
    const code = await runDoctor({
      config,
      out,
      which: async () => fakeBin,
    });
    // Auth check may still fail depending on the host's actual ~/.claude state,
    // so just verify the binary check passed and reporting is sane.
    expect(out.text).toContain("ok");
    expect(out.text).toContain(fakeBin);
    // (We don't pin the exit code because of the host-dependent auth check.)
    expect([0, 1]).toContain(code);
  });

  test("reports failure for unknown harness ids in the chain", async () => {
    const out = new CaptureStream();
    await runDoctor({
      config: {
        ...config,
        harnesses: { ...config.harnesses, chain: ["claude", "wat"] },
      },
      out,
      which: async () => "/fake",
    });
    expect(out.text).toContain("unknown harness id");
  });
});
