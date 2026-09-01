/**
 * Vault-first resolution of the embedding API keys (#514).
 *
 * The bug these pin: `buildEmbeddingsConfig` used to read
 * `process.env.PHANTOMBOT_GEMINI_API_KEY` unconditionally and let it win. On a
 * multi-persona host `loadVaultIntoEnv` injects exactly ONE persona's vault at
 * startup, so every other persona embedded with that persona's key — and a
 * stale row in it silently outranked a working key in everybody's config.toml.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { loadConfig } from "../src/config.ts";
import { openPersonaVault } from "../src/lib/vault.ts";
import {
  _resetVaultTrackingForTesting,
  isVaultInjectedEnvKey,
} from "../src/lib/vaultEnvTracking.ts";

const GEMINI_ENV = "PHANTOMBOT_GEMINI_API_KEY";

let workdir: string;
let configPath: string;
let personasDir: string;
const saved: Record<string, string | undefined> = {};

async function seedVault(persona: string, value: string): Promise<string> {
  const dir = join(personasDir, persona);
  await mkdir(dir, { recursive: true });
  const v = await openPersonaVault(dir);
  try {
    v.set(GEMINI_ENV, value);
  } finally {
    v.close();
  }
  return dir;
}

beforeEach(async () => {
  for (const k of [
    "PHANTOMBOT_CONFIG",
    "XDG_CONFIG_HOME",
    "XDG_DATA_HOME",
    "PHANTOMBOT_PERSONAS_DIR",
    "PHANTOMBOT_DEFAULT_PERSONA",
    GEMINI_ENV,
  ]) {
    saved[k] = process.env[k];
    delete process.env[k];
  }
  workdir = await mkdtemp(join(tmpdir(), "phantombot-emb-vault-"));
  configPath = join(workdir, "config.toml");
  personasDir = join(workdir, "personas");
  process.env.PHANTOMBOT_CONFIG = configPath;
  process.env.XDG_CONFIG_HOME = join(workdir, "xdg-config");
  process.env.XDG_DATA_HOME = join(workdir, "xdg-data");
  process.env.PHANTOMBOT_PERSONAS_DIR = personasDir;
  process.env.PHANTOMBOT_DEFAULT_PERSONA = "phantom";
  _resetVaultTrackingForTesting();
});

afterEach(async () => {
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  _resetVaultTrackingForTesting();
  await rm(workdir, { recursive: true, force: true });
});

describe("embedding api key — vault first", () => {
  test("a persona reads the key from its OWN vault, not the injected one", async () => {
    const { loadVaultIntoEnv } = await import("../src/lib/vault.ts");
    await seedVault("phantom", "AIza-DEFAULT-PERSONA");
    await seedVault("kai", "AIza-KAI");
    // Startup injects the default persona's vault, exactly as the daemon does.
    await loadVaultIntoEnv(join(personasDir, "phantom"));
    expect(process.env[GEMINI_ENV]).toBe("AIza-DEFAULT-PERSONA");
    expect(isVaultInjectedEnvKey(GEMINI_ENV)).toBe(true);

    const kai = await loadConfig("kai");
    expect(kai.embeddings.provider).toBe("gemini");
    expect(kai.embeddings.gemini?.apiKey).toBe("AIza-KAI");

    // ...and the loaded persona still gets its own, out of the environment.
    const phantom = await loadConfig("phantom");
    expect(phantom.embeddings.gemini?.apiKey).toBe("AIza-DEFAULT-PERSONA");
  });

  test("another persona's vault key never stands in; config.toml wins instead", async () => {
    const { loadVaultIntoEnv } = await import("../src/lib/vault.ts");
    await seedVault("phantom", "AIza-DEFAULT-PERSONA");
    await mkdir(join(personasDir, "kai"), { recursive: true });
    await loadVaultIntoEnv(join(personasDir, "phantom"));

    await writeFile(
      configPath,
      '[embeddings]\nprovider = "gemini"\n\n[embeddings.gemini]\napi_key = "AIza-FILE"\n',
      "utf8",
    );

    // kai has no vault row of its own — before #514 it silently embedded with
    // AIza-DEFAULT-PERSONA. The file is the next legitimate source.
    const kai = await loadConfig("kai");
    expect(kai.embeddings.gemini?.apiKey).toBe("AIza-FILE");
  });

  test("an ambient (non-vault) env export still wins over config.toml", async () => {
    // Pre-vault hosts set this in the shell or a systemd Environment=; nothing
    // ever claimed it for a persona, so the long-standing env-beats-TOML rule
    // is unchanged.
    process.env[GEMINI_ENV] = "AIza-AMBIENT";
    await writeFile(
      configPath,
      '[embeddings]\nprovider = "gemini"\n\n[embeddings.gemini]\napi_key = "AIza-FILE"\n',
      "utf8",
    );
    const c = await loadConfig("phantom");
    expect(isVaultInjectedEnvKey(GEMINI_ENV)).toBe(false);
    expect(c.embeddings.gemini?.apiKey).toBe("AIza-AMBIENT");
  });

  test("a vault-only key still infers provider=gemini with no [embeddings] block", async () => {
    await seedVault("kai", "AIza-KAI");
    const kai = await loadConfig("kai");
    expect(kai.embeddings.provider).toBe("gemini");
    expect(kai.embeddings.gemini?.apiKey).toBe("AIza-KAI");
  });

  test("no vault, no env, no file: provider stays none", async () => {
    const c = await loadConfig("kai");
    expect(c.embeddings.provider).toBe("none");
  });

  test("an unprovisioned persona is not given an identity by a config load", async () => {
    const { existsSync } = await import("node:fs");
    await loadConfig("never-seen");
    expect(existsSync(join(personasDir, "never-seen", "identity.json"))).toBe(
      false,
    );
    expect(existsSync(join(personasDir, "never-seen", "vault.sqlite"))).toBe(
      false,
    );
  });

  test("a persona's own config.toml key beats the host file", async () => {
    await writeFile(
      configPath,
      '[embeddings]\nprovider = "gemini"\n\n[embeddings.gemini]\napi_key = "AIza-HOST"\n',
      "utf8",
    );
    await mkdir(join(personasDir, "kai"), { recursive: true });
    await writeFile(
      join(personasDir, "kai", "config.toml"),
      '[embeddings.gemini]\napi_key = "AIza-KAI-FILE"\n',
      "utf8",
    );
    const kai = await loadConfig("kai");
    expect(kai.embeddings.gemini?.apiKey).toBe("AIza-KAI-FILE");
  });
});
