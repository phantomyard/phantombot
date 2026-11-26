/**
 * #820: phantombot's own config resolution reads the persona vault directly.
 * The startup env mirror is for child processes; no runtime feature may need it.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { loadConfig } from "../src/config.ts";
import { PHANTOOPS_DEFAULT_BASE_URL } from "../src/lib/piCustomProvider.ts";
import { loadVaultIntoEnv, openPersonaVault } from "../src/lib/vault.ts";
import { _resetVaultTrackingForTesting } from "../src/lib/vaultEnvTracking.ts";

const SECRET_NAMES = [
  "TELEGRAM_BOT_TOKEN",
  "TELEGRAM_BOT_TOKEN_KAI",
  "PHANTOMBOT_GEMINI_API_KEY",
  "PHANTOMBOT_OPENAI_COMPATIBLE_API_KEY",
  "PHANTOMBOT_JEV_API_KEY",
  "PHANTOMBOT_PI_API_KEY",
] as const;

let workdir: string;
let personasDir: string;
const saved: Record<string, string | undefined> = {};

beforeEach(async () => {
  for (const name of [
    "PHANTOMBOT_CONFIG",
    "PHANTOMBOT_PERSONAS_DIR",
    "PHANTOMBOT_DEFAULT_PERSONA",
    "XDG_CONFIG_HOME",
    "XDG_DATA_HOME",
    "PHANTOMBOT_PI_PROVIDER",
    "PHANTOMBOT_PRIMARY_MODEL",
    "PHANTOMBOT_IMAGE_MODEL",
    "PHANTOMBOT_CODING_MODEL",
    ...SECRET_NAMES,
  ]) {
    saved[name] = process.env[name];
    delete process.env[name];
  }
  workdir = await mkdtemp(join(tmpdir(), "phantombot-config-secrets-"));
  personasDir = join(workdir, "personas");
  process.env.PHANTOMBOT_CONFIG = join(workdir, "config.toml");
  process.env.PHANTOMBOT_PERSONAS_DIR = personasDir;
  process.env.PHANTOMBOT_DEFAULT_PERSONA = "phantom";
  process.env.XDG_CONFIG_HOME = join(workdir, "xdg-config");
  process.env.XDG_DATA_HOME = join(workdir, "xdg-data");
  _resetVaultTrackingForTesting();
});

afterEach(async () => {
  for (const [name, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  _resetVaultTrackingForTesting();
  await rm(workdir, { recursive: true, force: true });
});

async function seedVault(values: Record<string, string>): Promise<string> {
  const dir = join(personasDir, "phantom");
  await mkdir(dir, { recursive: true });
  const vault = await openPersonaVault(dir);
  try {
    for (const [name, value] of Object.entries(values)) vault.set(name, value);
  } finally {
    vault.close();
  }
  return dir;
}

/** Reproduce startup, then remove every secret the agent child would receive. */
async function injectThenScrub(dir: string): Promise<void> {
  await loadVaultIntoEnv(dir);
  for (const name of SECRET_NAMES) delete process.env[name];
  for (const name of SECRET_NAMES) expect(process.env[name]).toBeUndefined();
}

describe("config secrets with no startup env mirror", () => {
  test("a rotated Telegram token wins over its stale injected copy", async () => {
    const dir = await seedVault({
      TELEGRAM_BOT_TOKEN: "telegram-before-rotation",
    });
    await loadVaultIntoEnv(dir);
    expect(process.env.TELEGRAM_BOT_TOKEN).toBe("telegram-before-rotation");

    const vault = await openPersonaVault(dir);
    try {
      vault.set("TELEGRAM_BOT_TOKEN", "telegram-after-rotation");
    } finally {
      vault.close();
    }

    const config = await loadConfig();
    expect(process.env.TELEGRAM_BOT_TOKEN).toBe("telegram-before-rotation");
    expect(config.channels.telegram?.token).toBe("telegram-after-rotation");
  });

  test("Telegram, embeddings and the decision model still resolve", async () => {
    const dir = await seedVault({
      TELEGRAM_BOT_TOKEN: "telegram-default-from-vault",
      TELEGRAM_BOT_TOKEN_KAI: "telegram-kai-from-vault",
      PHANTOMBOT_OPENAI_COMPATIBLE_API_KEY: "embeddings-from-vault",
      PHANTOMBOT_JEV_API_KEY: "decisions-from-vault",
    });
    await injectThenScrub(dir);
    await writeFile(
      process.env.PHANTOMBOT_CONFIG!,
      `[channels.telegram]
allowed_user_ids = [1]
[channels.telegram.personas.kai]
allowed_user_ids = [2]
[embeddings]
provider = "openai-compatible"
[embeddings.openai_compatible]
base_url = "https://openrouter.ai/api/v1"
model = "text-embedding-3-small"
[jev]
provider = "openrouter"
base_url = "https://openrouter.ai/api/v1"
[jev.judge]
enabled = true
`,
    );

    const config = await loadConfig();
    expect(config.channels.telegram?.token).toBe("telegram-default-from-vault");
    expect(config.channels.telegramPersonas?.kai?.token).toBe("telegram-kai-from-vault");
    expect(config.embeddings.openaiCompatible?.apiKey).toBe("embeddings-from-vault");
    expect(config.jev?.apiKey).toBe("decisions-from-vault");
  });

  test("the startup persona's Gemini key does not rely on its injected copy", async () => {
    const dir = await seedVault({ PHANTOMBOT_GEMINI_API_KEY: "gemini-from-vault" });
    // This test has only one seeded row; inject it explicitly rather than using
    // injectThenScrub's multi-feature fixture assertion.
    await loadVaultIntoEnv(dir);
    expect(process.env.PHANTOMBOT_GEMINI_API_KEY).toBe("gemini-from-vault");
    delete process.env.PHANTOMBOT_GEMINI_API_KEY;

    const config = await loadConfig();
    expect(config.embeddings.provider).toBe("gemini");
    expect(config.embeddings.gemini?.apiKey).toBe("gemini-from-vault");
  });

  test("PhantomOps platform slots borrow the brain key without the env copy", async () => {
    const dir = await seedVault({ PHANTOMBOT_PI_API_KEY: "pok_from_vault" });
    await loadVaultIntoEnv(dir);
    expect(process.env.PHANTOMBOT_PI_API_KEY).toBe("pok_from_vault");
    delete process.env.PHANTOMBOT_PI_API_KEY;
    await writeFile(
      process.env.PHANTOMBOT_CONFIG!,
      `[harnesses.pi.routing]
provider = "phantomops"
base_url = "${PHANTOOPS_DEFAULT_BASE_URL}"
primary_model = "phantomops/auto"
[embeddings]
provider = "openai-compatible"
[embeddings.openai_compatible]
base_url = "${PHANTOOPS_DEFAULT_BASE_URL}"
model = "phantomops/embeddings"
`,
    );

    const config = await loadConfig();
    expect(config.harnesses.pi.routing?.provider).toBe("phantomops");
    expect(config.embeddings.openaiCompatible?.apiKey).toBe("pok_from_vault");
  });
});
