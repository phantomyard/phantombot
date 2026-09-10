/**
 * The brain wizard's rollback, through the PRODUCTION deps and a REAL persona
 * vault (PR #539 re-review, Kai/Lena). The unit tests in brain-onboarding.test
 * pin restoreBrainWrites' logic; this pins the wiring — that the snapshot
 * reads the persona's vault row STRICTLY. With the effective read
 * (getPersonaSecret) an ambient host key stands in for a missing row, and
 * discard then mints it into the vault as a new persona override.
 */
import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { ENV_PI_API_KEY } from "../src/lib/piRouting.ts";
import { openPersonaVault } from "../src/lib/vault.ts";
import { _resetVaultTrackingForTesting } from "../src/lib/vaultEnvTracking.ts";
import { getPersonaSecretStrict } from "../src/lib/vaultSecrets.ts";
import { loadConfig } from "../src/config.ts";
import { createBrainOnboardingDeps } from "../src/tui/brainOnboarding.ts";

const KEYS = [
  "HOME",
  "PHANTOMBOT_CONFIG",
  "XDG_CONFIG_HOME",
  "XDG_DATA_HOME",
  "PHANTOMBOT_PERSONAS_DIR",
  "PHANTOMBOT_DEFAULT_PERSONA",
  ENV_PI_API_KEY,
];
const saved: Record<string, string | undefined> = {};
let workdir: string;

beforeEach(async () => {
  for (const k of KEYS) {
    saved[k] = process.env[k];
    delete process.env[k];
  }
  workdir = await mkdtemp(join(tmpdir(), "phantombot-brain-rollback-"));
  process.env.HOME = join(workdir, "home"); // Pi's auth.json lands here
  process.env.PHANTOMBOT_CONFIG = join(workdir, "config.toml");
  process.env.XDG_CONFIG_HOME = join(workdir, "xdg-config");
  process.env.XDG_DATA_HOME = join(workdir, "xdg-data");
  process.env.PHANTOMBOT_PERSONAS_DIR = join(workdir, "personas");
  process.env.PHANTOMBOT_DEFAULT_PERSONA = "phantom";
  _resetVaultTrackingForTesting();
  // A provisioned persona whose vault has rows — just not the Pi key.
  const dir = join(workdir, "personas", "phantom");
  await mkdir(dir, { recursive: true });
  const v = await openPersonaVault(dir);
  try {
    v.set("SOMETHING_ELSE", "x");
  } finally {
    v.close();
  }
});

afterEach(async () => {
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  _resetVaultTrackingForTesting();
  await rm(workdir, { recursive: true, force: true });
});

test("discard with no vault row but a host-wide key leaves NO row behind", async () => {
  process.env[ENV_PI_API_KEY] = "sk-host-wide"; // shell export, not vault-injected
  const deps = await createBrainOnboardingDeps("phantom");

  const snap = await deps.snapshotWrites!();
  expect((await deps.setSecret("sk-wizard")).ok).toBe(true); // the interview's write

  expect(await deps.restoreWrites!(snap)).toBe(true);
  const config = await loadConfig("phantom");
  expect(
    await getPersonaSecretStrict(config, ENV_PI_API_KEY, "phantom"),
  ).toBeUndefined();
  expect(process.env[ENV_PI_API_KEY]).toBe("sk-host-wide");
});

test("discard puts an existing vault row back verbatim", async () => {
  const deps0 = await createBrainOnboardingDeps("phantom");
  expect((await deps0.setSecret("sk-old")).ok).toBe(true);
  const deps = await createBrainOnboardingDeps("phantom");

  const snap = await deps.snapshotWrites!();
  await deps.setSecret("sk-wizard");

  expect(await deps.restoreWrites!(snap)).toBe(true);
  const config = await loadConfig("phantom");
  expect(await getPersonaSecretStrict(config, ENV_PI_API_KEY, "phantom")).toBe(
    "sk-old",
  );
});
