/**
 * Tests for the write path behind `phantombot jev` (issue #597).
 * The TUI prompts are covered in tui-decisionModelFlow.test.ts.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  applyDecisionModelConfig,
  findReusableDecisionModelKeys,
  decisionModelUpdateEquals,
  type DecisionModelConfigUpdate,
} from "../src/cli/jev.ts";
import { type Config, loadConfig } from "../src/config.ts";
import { openPersonaVault } from "../src/lib/vault.ts";
import { _resetVaultTrackingForTesting } from "../src/lib/vaultEnvTracking.ts";

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

const BASE_UPDATE: DecisionModelConfigUpdate = {
  provider: "openrouter",
  keyEnv: "PHANTOMBOT_JEV_API_KEY",
  judge: { enabled: true },
  router: { enabled: true },
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
  _resetVaultTrackingForTesting();
  config = await loadConfig();
});

afterEach(async () => {
  if (SAVED_CONFIG === undefined) delete process.env.PHANTOMBOT_CONFIG;
  else process.env.PHANTOMBOT_CONFIG = SAVED_CONFIG;
  for (const name of ENV_NAMES) {
    if (savedEnv[name] === undefined) delete process.env[name];
    else process.env[name] = savedEnv[name]!;
  }
  _resetVaultTrackingForTesting();
  await rm(workdir, { recursive: true, force: true });
});

/** Seed a real per-persona vault (mirrors config-embeddings-vault.test.ts). */
async function seedVault(target: string, name: string, value: string) {
  const dir = join(config.personasDir, target);
  await mkdir(dir, { recursive: true });
  const v = await openPersonaVault(dir);
  try {
    v.set(name, value);
  } finally {
    v.close();
  }
}

function personaTomlPath(): string {
  return join(config.personasDir, persona, "config.toml");
}

describe("applyDecisionModelConfig", () => {
  test("stores a new key in the vault and writes only non-secret settings", async () => {
    const writes: unknown[][] = [];
    await applyDecisionModelConfig({
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
    await applyDecisionModelConfig({
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
    await applyDecisionModelConfig({ config, persona, update: BASE_UPDATE });
    // Operator hand-tunes thresholds/timeouts after the wizard.
    const path = personaTomlPath();
    const tuned = (await readFile(path, "utf8")).replace(
      "[jev.judge]",
      "[jev.judge]\nthreshold = 65\ntimeout_ms = 900\nfail_closed = true",
    );
    await writeFile(path, tuned);
    // Re-run the wizard flipping only the consumers.
    await applyDecisionModelConfig({
      config,
      persona,
      update: {
        ...BASE_UPDATE,
        judge: { enabled: true },
        router: { enabled: false },
      },
    });
    const text = await readFile(path, "utf8");
    expect(text).toContain("threshold = 65");
    expect(text).toContain("timeout_ms = 900");
    expect(text).toContain("fail_closed = true");
    expect(text).toContain("enabled = false");
  });

  test("scrubs a legacy `mode` key — a draft setting nothing honours", async () => {
    // Pre-merge drafts wrote mode = "shadow"/"active". Leaving it behind
    // would read on-disk as a live switch between deciding and not; the
    // write path deletes it so the file says exactly what the code does.
    await mkdir(join(config.personasDir, persona), { recursive: true });
    await writeFile(
      personaTomlPath(),
      '[jev]\nprovider = "openrouter"\n\n[jev.judge]\nmode = "shadow"\n\n' +
        '[jev.router]\nmode = "shadow"\n',
    );
    await applyDecisionModelConfig({ config, persona, update: BASE_UPDATE });
    const text = await readFile(personaTomlPath(), "utf8");
    // A bare `mode` KEY, not the substring — `model =` legitimately contains it.
    expect(text).not.toMatch(/^\s*mode\s*=/m);
  });

  test("scrubs a plaintext api_key if one ever lands in the file", async () => {
    await mkdir(join(config.personasDir, persona), { recursive: true });
    await writeFile(
      personaTomlPath(),
      '[jev]\nprovider = "openrouter"\napi_key = "sk-leaked"\n',
    );
    await applyDecisionModelConfig({ config, persona, update: BASE_UPDATE });
    const text = await readFile(personaTomlPath(), "utf8");
    expect(text).not.toContain("sk-leaked");
    expect(text).not.toContain("api_key");
  });

  test("a failed vault write aborts with the secret name, never the value — and config.toml stays UNTOUCHED", async () => {
    await expect(
      applyDecisionModelConfig({
        config,
        persona,
        update: { ...BASE_UPDATE, apiKey: "sk-secret-value" },
        writeSecret: async () => ({ ok: false, persona, error: "vault locked" }),
      }),
    ).rejects.toThrow("PHANTOMBOT_JEV_API_KEY");
    // The atomicity rule (review, #600): a failed key replacement must not
    // leave an enabled [jev] block pointing at a missing credential. The
    // persona's config.toml is either absent or free of any [jev] block.
    let text = "";
    try {
      text = await readFile(personaTomlPath(), "utf8");
    } catch {
      // never written — the strongest form of untouched
    }
    expect(text).not.toContain("[jev]");
    expect(text).not.toContain("sk-secret-value");
  });
});

describe("decisionModelUpdateEquals — the idempotence check", () => {
  test("keeping every offered default after a save is a no-op", async () => {
    process.env.PHANTOMBOT_JEV_API_KEY = "sk-stored";
    await applyDecisionModelConfig({ config, persona, update: BASE_UPDATE });
    const reloaded = await loadConfig();
    expect(decisionModelUpdateEquals(reloaded.jev, BASE_UPDATE)).toBe(true);
  });

  test("a new typed key is always a change", async () => {
    await applyDecisionModelConfig({ config, persona, update: BASE_UPDATE });
    process.env.PHANTOMBOT_JEV_API_KEY = "sk-stored";
    const reloaded = await loadConfig();
    expect(
      decisionModelUpdateEquals(reloaded.jev, { ...BASE_UPDATE, apiKey: "sk-other" }),
    ).toBe(false);
  });

  test("flipping a consumer is a change", async () => {
    await applyDecisionModelConfig({ config, persona, update: BASE_UPDATE });
    process.env.PHANTOMBOT_JEV_API_KEY = "sk-stored";
    const reloaded = await loadConfig();
    expect(
      decisionModelUpdateEquals(reloaded.jev, {
        ...BASE_UPDATE,
        judge: { enabled: false },
      }),
    ).toBe(false);
    expect(
      decisionModelUpdateEquals(reloaded.jev, {
        ...BASE_UPDATE,
        router: { enabled: false },
      }),
    ).toBe(false);
  });
});

describe("findReusableDecisionModelKeys — frictionless discovery", () => {
  test("finds the embeddings OpenRouter key only when its endpoint IS OpenRouter", async () => {
    process.env.PHANTOMBOT_OPENAI_COMPATIBLE_API_KEY = "sk-or-embed";
    // No embeddings block → the key alone doesn't prove an OpenRouter endpoint.
    expect(
      (await findReusableDecisionModelKeys(config)).map((k) => k.env),
    ).not.toContain("PHANTOMBOT_OPENAI_COMPATIBLE_API_KEY");

    await mkdir(join(config.personasDir, persona), { recursive: true });
    await writeFile(
      personaTomlPath(),
      '[embeddings]\nprovider = "openai-compatible"\n\n[embeddings.openai_compatible]\nbase_url = "https://openrouter.ai/api/v1"\nmodel = "openai/text-embedding-3-small"\n',
    );
    const reloaded = await loadConfig();
    expect((await findReusableDecisionModelKeys(reloaded)).map((k) => k.env)).toContain(
      "PHANTOMBOT_OPENAI_COMPATIBLE_API_KEY",
    );
  });

  test("finds a stored Jev key and a generic OpenRouter export", async () => {
    process.env.PHANTOMBOT_JEV_API_KEY = "sk-jev";
    process.env.OPENROUTER_API_KEY = "sk-generic";
    const envs = (await findReusableDecisionModelKeys(config)).map((k) => k.env);
    expect(envs).toContain("PHANTOMBOT_JEV_API_KEY");
    expect(envs).toContain("OPENROUTER_API_KEY");
  });

  test("SECONDARY-PERSONA regression: the default persona's vault key is never offered to another persona", async () => {
    // The multi-persona daemon injects exactly ONE persona's vault at
    // startup. Discovery that read process.env raw would offer (and
    // validate) THAT persona's key for any other persona selected in the
    // TUI, then write key_env into a vault that does not contain it
    // (review, #600).
    const { loadVaultIntoEnv } = await import("../src/lib/vault.ts");
    await seedVault("phantom", "PHANTOMBOT_JEV_API_KEY", "sk-or-PHANTOM");
    await seedVault("kai", "OPENROUTER_API_KEY", "sk-or-KAI");
    await loadVaultIntoEnv(join(config.personasDir, "phantom"));
    expect(process.env.PHANTOMBOT_JEV_API_KEY).toBe("sk-or-PHANTOM");

    // kai is offered only what KAI can resolve — phantom's injected key is
    // not a candidate, kai's own vault row is.
    const kaiEnvs = (await findReusableDecisionModelKeys(config, "kai")).map(
      (k) => k.env,
    );
    expect(kaiEnvs).not.toContain("PHANTOMBOT_JEV_API_KEY");
    expect(kaiEnvs).toContain("OPENROUTER_API_KEY");

    // …and the loaded persona itself still sees its own key.
    const phantomEnvs = (await findReusableDecisionModelKeys(config, "phantom")).map(
      (k) => k.env,
    );
    expect(phantomEnvs).toContain("PHANTOMBOT_JEV_API_KEY");
  });
});
