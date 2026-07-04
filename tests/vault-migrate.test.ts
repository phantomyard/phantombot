/**
 * Plaintext → encrypted-vault migration (PR #253). This is the SAFETY-CRITICAL
 * path: it deletes the only plaintext copy of each secret, so it must prove the
 * ciphertext read back first.
 *
 * Covers:
 *   - ~/.env → the DEFAULT persona's vault, decryptable, plaintext deleted,
 *   - central .env → FANNED OUT into every persona's vault,
 *   - COLLISION: a persona-local ~/.env value WINS over the central one,
 *   - IDEMPOTENCY: a re-run with the files already gone is a clean no-op,
 *   - hidden/non-persona dirs are NOT sprayed with an identity + secrets.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { Config } from "../src/config.ts";
import { personaDir } from "../src/config.ts";
import { saveEnvFile } from "../src/lib/envFile.ts";
import { openPersonaVault, vaultPath } from "../src/lib/vault.ts";
import { migratePlaintextToVault } from "../src/lib/vaultMigrate.ts";

let workdir: string;
let userEnv: string;
let centralEnv: string;
let personasDir: string;
let savedUserEnvVar: string | undefined;
let savedCentralEnvVar: string | undefined;

/** Minimal Config — the migrate path only reads defaultPersona + personasDir. */
function cfg(): Config {
  return { defaultPersona: "robbie", personasDir } as unknown as Config;
}

/** Decrypt one key out of a persona's vault. */
async function readVault(persona: string, name: string): Promise<string | undefined> {
  const v = await openPersonaVault(personaDir(cfg(), persona));
  try {
    return v.get(name);
  } finally {
    v.close();
  }
}

beforeEach(async () => {
  workdir = await mkdtemp(join(tmpdir(), "phantombot-migrate-"));
  userEnv = join(workdir, "user.env");
  centralEnv = join(workdir, "central.env");
  personasDir = join(workdir, "personas");
  await mkdir(personasDir, { recursive: true });

  savedUserEnvVar = process.env.PHANTOMBOT_USER_ENV_FILE;
  savedCentralEnvVar = process.env.PHANTOMBOT_ENV_FILE;
  process.env.PHANTOMBOT_USER_ENV_FILE = userEnv;
  process.env.PHANTOMBOT_ENV_FILE = centralEnv;
});

afterEach(async () => {
  if (savedUserEnvVar === undefined) delete process.env.PHANTOMBOT_USER_ENV_FILE;
  else process.env.PHANTOMBOT_USER_ENV_FILE = savedUserEnvVar;
  if (savedCentralEnvVar === undefined) delete process.env.PHANTOMBOT_ENV_FILE;
  else process.env.PHANTOMBOT_ENV_FILE = savedCentralEnvVar;
  await rm(workdir, { recursive: true, force: true });
});

describe("migratePlaintextToVault", () => {
  test("~/.env migrates into the default persona's vault, then deletes the plaintext", async () => {
    await saveEnvFile(userEnv, { GITHUB_TOKEN: "ghp_local", API_KEY: "abc123" });

    await migratePlaintextToVault(cfg());

    expect(await readVault("robbie", "GITHUB_TOKEN")).toBe("ghp_local");
    expect(await readVault("robbie", "API_KEY")).toBe("abc123");
    expect(existsSync(userEnv)).toBe(false); // plaintext removed after read-back
  });

  test("central .env fans out into EVERY persona's vault", async () => {
    // Pre-create two persona dirs so the fan-out reaches both.
    await mkdir(join(personasDir, "lena"), { recursive: true });
    await mkdir(join(personasDir, "kai"), { recursive: true });
    await saveEnvFile(centralEnv, { TTS_KEY: "shared-tts" });

    await migratePlaintextToVault(cfg());

    expect(await readVault("robbie", "TTS_KEY")).toBe("shared-tts");
    expect(await readVault("lena", "TTS_KEY")).toBe("shared-tts");
    expect(await readVault("kai", "TTS_KEY")).toBe("shared-tts");
    expect(existsSync(centralEnv)).toBe(false);
  });

  test("collision: a persona-local ~/.env value wins over the central one", async () => {
    await saveEnvFile(userEnv, { SHARED: "local-wins" });
    await saveEnvFile(centralEnv, { SHARED: "central-value", ONLY_CENTRAL: "x" });

    await migratePlaintextToVault(cfg());

    expect(await readVault("robbie", "SHARED")).toBe("local-wins");
    expect(await readVault("robbie", "ONLY_CENTRAL")).toBe("x");
  });

  test("idempotent: a re-run with files already gone is a clean no-op", async () => {
    await saveEnvFile(userEnv, { K: "v" });
    await migratePlaintextToVault(cfg());
    expect(existsSync(userEnv)).toBe(false);

    // Second run must not throw and must leave the vault value intact.
    await migratePlaintextToVault(cfg());
    expect(await readVault("robbie", "K")).toBe("v");
  });

  test("hidden/non-persona dirs are not sprayed with an identity or vault", async () => {
    await mkdir(join(personasDir, ".git"), { recursive: true });
    await saveEnvFile(centralEnv, { TTS_KEY: "shared" });

    await migratePlaintextToVault(cfg());

    // The default persona got it; the hidden dir did NOT get a vault.
    expect(await readVault("robbie", "TTS_KEY")).toBe("shared");
    expect(existsSync(vaultPath(join(personasDir, ".git")))).toBe(false);
    expect(existsSync(join(personasDir, ".git", "identity.json"))).toBe(false);
  });

  test("no plaintext files present → nothing happens, no throw", async () => {
    await migratePlaintextToVault(cfg());
    // default persona vault may exist but is empty of these keys.
    expect(await readVault("robbie", "ANYTHING")).toBeUndefined();
  });
});
