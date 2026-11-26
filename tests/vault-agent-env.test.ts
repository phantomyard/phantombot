/**
 * `[vault] agent_env` (#820): what vault secrets a harness hands its agent.
 * Unset = everything (unchanged); a list = only those names; [] = none.
 * Non-vault env (PATH, sticky boot vars) is never touched.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { runVaultSet } from "../src/cli/vault.ts";
import { vaultAgentEnvFromToml } from "../src/config.ts";
import { _resetConfigCacheForTesting, agentSpawnEnv } from "../src/lib/vault.ts";
import { rmrf } from "./fixtures/rmrf.ts";

let root: string;
const saved = { ...process.env };
const sink = { write: () => true };

async function setup(vaultSection: string) {
  root = await mkdtemp(join(tmpdir(), "phantombot-agentenv-"));
  await mkdir(join(root, "personas", "p"), { recursive: true });
  await writeFile(join(root, "config.toml"), `default_persona = "p"\n${vaultSection}`);
  process.env.PHANTOMBOT_CONFIG = join(root, "config.toml");
  process.env.PHANTOMBOT_PERSONAS_DIR = join(root, "personas");
  process.env.PHANTOMBOT_MEMORY_DB = join(root, "memory.sqlite");
  _resetConfigCacheForTesting();
  for (const n of ["KEEP_ME", "DROP_ME"]) {
    await runVaultSet({ name: n, value: `${n}-value`, persona: "p", out: sink, err: sink });
  }
}

beforeEach(() => {
  delete process.env.PHANTOMBOT_PERSONA;
});

afterEach(async () => {
  process.env = { ...saved };
  _resetConfigCacheForTesting();
  await rmrf(root);
});

const env = (): NodeJS.ProcessEnv => ({ PATH: "/usr/bin", STICKY: "boot", KEEP_ME: "KEEP_ME-value", DROP_ME: "DROP_ME-value" });

describe("agentSpawnEnv", () => {
  test("no [vault] agent_env: unchanged (every secret, the old behaviour)", async () => {
    await setup("");
    const e = env();
    expect(await agentSpawnEnv(e, "p")).toBe(e);
  });

  test("an allow-list keeps only those vault names; non-vault env untouched", async () => {
    await setup('[vault]\nagent_env = ["KEEP_ME"]\n');
    const out = await agentSpawnEnv(env(), "p");
    expect(out).toEqual({ PATH: "/usr/bin", STICKY: "boot", KEEP_ME: "KEEP_ME-value" });
  });

  test("an empty list removes every vault secret", async () => {
    await setup("[vault]\nagent_env = []\n");
    const out = await agentSpawnEnv(env(), "p");
    expect(out).toEqual({ PATH: "/usr/bin", STICKY: "boot" });
  });

  test("the input env is never mutated", async () => {
    await setup("[vault]\nagent_env = []\n");
    const e = env();
    await agentSpawnEnv(e, "p");
    expect(e.DROP_ME).toBe("DROP_ME-value");
  });
});

describe("vaultAgentEnvFromToml", () => {
  test("absent / malformed = unset (fail toward the old behaviour)", () => {
    expect(vaultAgentEnvFromToml(undefined)).toEqual({});
    expect(vaultAgentEnvFromToml({})).toEqual({});
    expect(vaultAgentEnvFromToml({ agent_env: "GITHUB" })).toEqual({});
    expect(vaultAgentEnvFromToml({ agent_env: [1, 2] })).toEqual({});
  });
  test("a list of names", () => {
    expect(vaultAgentEnvFromToml({ agent_env: [" A ", "B", ""] })).toEqual({ vaultAgentEnv: ["A", "B"] });
  });
});
