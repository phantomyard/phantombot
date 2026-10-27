/**
 * The brain wizard's deps carry the STORED endpoint — through the PRODUCTION
 * `createBrainOnboardingDeps`, not an injected `routing` object (PR #695
 * re-review, Lena). The tui-brain-flow tests inject `routing.baseUrl` straight
 * into `configureNative`, which is exactly why a gap in the mapping was
 * invisible to them: `BrainOnboardingDeps.routing` has no required `baseUrl`,
 * so `tsc` is silent when the adapter drops it. This pins the adapter itself —
 * the re-run flow must see the stored endpoint, or an openai-compatible
 * operator cannot keep a working URL with one Enter and a phantomops re-run
 * silently rewrites a dev-ring base_url to the gateway default.
 */
import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  ENV_CODING_MODEL,
  ENV_IMAGE_MODEL,
  ENV_PI_API_KEY,
  ENV_PI_PROVIDER,
  ENV_PRIMARY_MODEL,
} from "../src/lib/piRouting.ts";
import { openPersonaVault } from "../src/lib/vault.ts";
import { _resetVaultTrackingForTesting } from "../src/lib/vaultEnvTracking.ts";
import { createBrainOnboardingDeps } from "../src/tui/brainOnboarding.ts";

const KEYS = [
  "HOME",
  "PHANTOMBOT_CONFIG",
  "XDG_CONFIG_HOME",
  "XDG_DATA_HOME",
  "PHANTOMBOT_PERSONAS_DIR",
  "PHANTOMBOT_DEFAULT_PERSONA",
  ENV_PI_API_KEY,
  // Routing env overrides outrank the TOML (resolveRouting reads env first) —
  // an ambient one would drown the values under test.
  ENV_PI_PROVIDER,
  ENV_PRIMARY_MODEL,
  ENV_IMAGE_MODEL,
  ENV_CODING_MODEL,
];
const saved: Record<string, string | undefined> = {};
let workdir: string;

beforeEach(async () => {
  for (const k of KEYS) {
    saved[k] = process.env[k];
    delete process.env[k];
  }
  workdir = await mkdtemp(join(tmpdir(), "phantombot-brain-deps-"));
  process.env.HOME = join(workdir, "home");
  process.env.PHANTOMBOT_CONFIG = join(workdir, "config.toml");
  process.env.XDG_CONFIG_HOME = join(workdir, "xdg-config");
  process.env.XDG_DATA_HOME = join(workdir, "xdg-data");
  process.env.PHANTOMBOT_PERSONAS_DIR = join(workdir, "personas");
  process.env.PHANTOMBOT_DEFAULT_PERSONA = "phantom";
  _resetVaultTrackingForTesting();
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

test("createBrainOnboardingDeps carries the stored endpoint into deps.routing", async () => {
  await writeFile(
    process.env.PHANTOMBOT_CONFIG!,
    [
      "[harnesses.pi.routing]",
      'provider = "openai-compatible"',
      'base_url = "http://10.0.0.5:8000/v1"',
      'primary_model = "llama3.1"',
      'image_model = "llava"',
      'coding_model = "qwen-coder"',
      "",
    ].join("\n"),
  );

  const deps = await createBrainOnboardingDeps("phantom");

  // The exact mapping at brainOnboarding.ts — the third argument the flow's
  // storedBaseUrlForProvider() reads. Every field here is one the wizard needs.
  expect(deps.routing).toEqual({
    provider: "openai-compatible",
    baseUrl: "http://10.0.0.5:8000/v1",
    primaryModel: "llama3.1",
    imageModel: "llava",
    codingModel: "qwen-coder",
  });
});

test("a config with no routing still yields an empty routing object", async () => {
  const deps = await createBrainOnboardingDeps("phantom");
  expect(deps.routing.baseUrl).toBeUndefined();
  expect(deps.routing.provider).toBeUndefined();
});
