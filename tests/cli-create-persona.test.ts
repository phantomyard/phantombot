/**
 * Tests for `phantombot create-persona`'s side-effect function.
 * The TUI is verified manually.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applyPersona } from "../src/cli/create-persona.ts";
import type { Config } from "../src/config.ts";
import { listArchives } from "../src/lib/personaArchive.ts";
import { loadState } from "../src/state.ts";

const SAVED_STATE = process.env.PHANTOMBOT_STATE;
let workdir: string;
let config: Config;

beforeEach(async () => {
  workdir = await mkdtemp(join(tmpdir(), "phantombot-cp-"));
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
    channels: {},
    embeddings: { provider: "none" },
    voice: { provider: "none" },
  };
});

afterEach(async () => {
  if (SAVED_STATE === undefined) delete process.env.PHANTOMBOT_STATE;
  else process.env.PHANTOMBOT_STATE = SAVED_STATE;
  await rm(workdir, { recursive: true, force: true });
});

describe("applyPersona", () => {
  test("writes BOOT.md and MEMORY.md to the personas dir", async () => {
    const r = await applyPersona(config, {
      name: "robbie",
      identity: "a curious assistant",
      tone: "blunt",
      expertise: ["Coding"],
      hardRules: "",
      greeting: "",
      setDefault: false,
    });
    expect(r.dir).toBe(join(config.personasDir, "robbie"));
    const boot = await readFile(join(r.dir, "BOOT.md"), "utf8");
    const mem = await readFile(join(r.dir, "MEMORY.md"), "utf8");
    expect(boot).toContain("# robbie");
    expect(boot).toContain("a curious assistant");
    expect(boot).toContain("Tone: **blunt**");
    expect(boot).toContain("- Coding");
    expect(mem).toContain("robbie — persistent memory");
  });

  test("setDefault=true updates state.json", async () => {
    await applyPersona(config, {
      name: "robbie",
      identity: "x",
      tone: "casual",
      expertise: [],
      hardRules: "",
      greeting: "",
      setDefault: true,
    });
    const state = await loadState();
    expect(state.default_persona).toBe("robbie");
  });

  test("archives an existing persona before overwriting", async () => {
    // First create
    await applyPersona(config, {
      name: "robbie",
      identity: "v1",
      tone: "blunt",
      expertise: [],
      hardRules: "",
      greeting: "",
      setDefault: false,
    });
    // Second create with same name — should archive the first
    const r = await applyPersona(config, {
      name: "robbie",
      identity: "v2",
      tone: "casual",
      expertise: [],
      hardRules: "",
      greeting: "",
      setDefault: false,
    });
    expect(r.archived).toBeDefined();
    expect(r.archived?.name).toBe("robbie");
    const archives = await listArchives(config.personasDir);
    expect(archives).toHaveLength(1);
    expect(archives[0]?.name).toBe("robbie");
  });

  test("setDefault=false leaves state.json untouched", async () => {
    await applyPersona(config, {
      name: "x",
      identity: "y",
      tone: "casual",
      expertise: [],
      hardRules: "",
      greeting: "",
      setDefault: false,
    });
    const state = await loadState();
    expect(state.default_persona).toBeUndefined();
  });
});
