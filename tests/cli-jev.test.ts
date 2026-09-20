/**
 * Tests for the write path behind `phantombot jev` (issue #597).
 * The TUI prompts are covered in tui-jevFlow.test.ts.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  applyJevConfig,
  findReusableJevKeys,
  jevUpdateEquals,
  type JevConfigUpdate,
} from "../src/cli/jev.ts";
import { type Config, loadConfig } from "../src/config.ts";

let workdir: string;
let config: Config;
const persona = "phantom";
const SAVED_CONFIG = process.env.PHANTOMBOT_CONFIG;
const savedEnv: Record<string, string | undefined> = {};
const ENV_NAMES = [
  "PHANTOMBOT_JEV_API_KEY",
  "PHANTOMBOT_OPENAI_COMPATIBLE_API_KEY",
  "OPENROUTER_API_KEY",
];

const BASE_UPDATE: JevConfigUpdate = {
  provider: "openrouter",
  keyEnv: "PHANTOMBOT_JEV_API_KEY",
  judge: { enabled: true, mode: "shadow" },
  router: { enabled: true, mode: "shadow" },
};

beforeEach(async () => {
  workdir = await mkdtemp(join(tmpdir(), "phantombot-jev-"));
  process.env.PHANTOMBOT_CONFIG = join(workdir, "config.toml");
  process.env.XDG_CONFIG_HOME = join(workdir, "xdg-config");
  process.env.XDG_DATA_HOME = join(workdir, "xdg-data");
  for (const name of ENV_NAMES) {
    savedEnv[name] = process.env[name];
    delete process.env[name];
  }
  config = await loadConfig();
});

afterEach(async () => {
  if (SAVED_CONFIG === undefined) delete process.env.PHANTOMBOT_CONFIG;
  else process.env.PHANTOMBOT_CONFIG = SAVED_CONFIG;
  for (const name of ENV_NAMES) {
    if (savedEnv[name] === undefined) delete process.env[name];
    else process.env[name] = savedEnv[name]!;
  }
  await rm(workdir, { recursive: true, force: true });
});

function personaTomlPath(): string {
  return join(config.personasDir, persona, "config.toml");
}

describe("applyJevConfig", () => {
  test("stores a new key in the vault and writes only non-secret settings", async () => {
    const writes: unknown[][] = [];
    await applyJevConfig({
      config,
      persona,
      update: { ...BASE_UPDATE, apiKey: "sk-or-test" },
      writeSecret: async (...args) => {
        writes.push(args);
        return { ok: true, persona };
      },
    });
    expect(writes[0]?.slice(1)).toEqual([
      "PHANTOMBOT_JEV_API_KEY",
      "sk-or-test",
      persona,
    ]);
    const text = await readFile(personaTomlPath(), "utf8");
    expect(text).toContain("[jev]");
    expect(text).toContain('provider = "openrouter"');
    expect(text).toContain("openrouter.ai");
    expect(text).not.toContain("sk-or-test");
    expect(text).not.toContain("api_key");
  });

  test("a reused key stores nothing — the block just points key_env at it", async () => {
    const writes: unknown[][] = [];
    await applyJevConfig({
      config,
      persona,
      update: {
        ...BASE_UPDATE,
        keyEnv: "PHANTOMBOT_OPENAI_COMPATIBLE_API_KEY",
      },
      writeSecret: async (...args) => {
        writes.push(args);
        return { ok: true, persona };
      },
    });
    expect(writes).toHaveLength(0);
    const text = await readFile(personaTomlPath(), "utf8");
    expect(text).toContain('key_env = "PHANTOMBOT_OPENAI_COMPATIBLE_API_KEY"');
  });

  test("merge semantics: operator tuning the wizard doesn't mention survives a re-run", async () => {
    await applyJevConfig({ config, persona, update: BASE_UPDATE });
    // Operator hand-tunes thresholds/timeouts after the wizard.
    const path = personaTomlPath();
    const tuned = (await readFile(path, "utf8")).replace(
      "[jev.judge]",
      "[jev.judge]\nthreshold = 65\ntimeout_ms = 900\nfail_closed = true",
    );
    await writeFile(path, tuned);
    // Re-run the wizard flipping only consumers/mode.
    await applyJevConfig({
      config,
      persona,
      update: {
        ...BASE_UPDATE,
        judge: { enabled: true, mode: "active" },
        router: { enabled: false, mode: "shadow" },
      },
    });
    const text = await readFile(path, "utf8");
    expect(text).toContain("threshold = 65");
    expect(text).toContain("timeout_ms = 900");
    expect(text).toContain("fail_closed = true");
    expect(text).toContain('mode = "active"');
  });

  test("scrubs a plaintext api_key if one ever lands in the file", async () => {
    await mkdir(join(config.personasDir, persona), { recursive: true });
    await writeFile(
      personaTomlPath(),
      '[jev]\nprovider = "openrouter"\napi_key = "sk-leaked"\n',
    );
    await applyJevConfig({ config, persona, update: BASE_UPDATE });
    const text = await readFile(personaTomlPath(), "utf8");
    expect(text).not.toContain("sk-leaked");
    expect(text).not.toContain("api_key");
  });

  test("a failed vault write aborts with the secret name, never the value", async () => {
    await expect(
      applyJevConfig({
        config,
        persona,
        update: { ...BASE_UPDATE, apiKey: "sk-secret-value" },
        writeSecret: async () => ({ ok: false, persona, error: "vault locked" }),
      }),
    ).rejects.toThrow("PHANTOMBOT_JEV_API_KEY");
  });
});

describe("jevUpdateEquals — the idempotence check", () => {
  test("keeping every offered default after a save is a no-op", async () => {
    process.env.PHANTOMBOT_JEV_API_KEY = "sk-stored";
    await applyJevConfig({ config, persona, update: BASE_UPDATE });
    const reloaded = await loadConfig();
    expect(jevUpdateEquals(reloaded.jev, BASE_UPDATE)).toBe(true);
  });

  test("a new typed key is always a change", async () => {
    await applyJevConfig({ config, persona, update: BASE_UPDATE });
    process.env.PHANTOMBOT_JEV_API_KEY = "sk-stored";
    const reloaded = await loadConfig();
    expect(
      jevUpdateEquals(reloaded.jev, { ...BASE_UPDATE, apiKey: "sk-other" }),
    ).toBe(false);
  });

  test("flipping a consumer or a mode is a change", async () => {
    await applyJevConfig({ config, persona, update: BASE_UPDATE });
    process.env.PHANTOMBOT_JEV_API_KEY = "sk-stored";
    const reloaded = await loadConfig();
    expect(
      jevUpdateEquals(reloaded.jev, {
        ...BASE_UPDATE,
        judge: { enabled: true, mode: "active" },
      }),
    ).toBe(false);
    expect(
      jevUpdateEquals(reloaded.jev, {
        ...BASE_UPDATE,
        router: { enabled: false, mode: "shadow" },
      }),
    ).toBe(false);
  });
});

describe("findReusableJevKeys — frictionless discovery", () => {
  test("finds the embeddings OpenRouter key only when its endpoint IS OpenRouter", async () => {
    process.env.PHANTOMBOT_OPENAI_COMPATIBLE_API_KEY = "sk-or-embed";
    // No embeddings block → the key alone doesn't prove an OpenRouter endpoint.
    expect(
      findReusableJevKeys(config).map((k) => k.env),
    ).not.toContain("PHANTOMBOT_OPENAI_COMPATIBLE_API_KEY");

    await mkdir(join(config.personasDir, persona), { recursive: true });
    await writeFile(
      personaTomlPath(),
      '[embeddings]\nprovider = "openai-compatible"\n\n[embeddings.openai_compatible]\nbase_url = "https://openrouter.ai/api/v1"\nmodel = "openai/text-embedding-3-small"\n',
    );
    const reloaded = await loadConfig();
    expect(findReusableJevKeys(reloaded).map((k) => k.env)).toContain(
      "PHANTOMBOT_OPENAI_COMPATIBLE_API_KEY",
    );
  });

  test("finds a stored Jev key and a generic OpenRouter export", async () => {
    process.env.PHANTOMBOT_JEV_API_KEY = "sk-jev";
    process.env.OPENROUTER_API_KEY = "sk-generic";
    const envs = findReusableJevKeys(config).map((k) => k.env);
    expect(envs).toContain("PHANTOMBOT_JEV_API_KEY");
    expect(envs).toContain("OPENROUTER_API_KEY");
  });
});
