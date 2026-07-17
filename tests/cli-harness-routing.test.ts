import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applyRouting, clearPiRouting } from "../src/cli/harness.ts";
import {
  computeRoutingClears,
  resolveRoutingProvider,
} from "../src/lib/piRouting.ts";
import { loadEnvFile, updateEnvFile } from "../src/lib/envFile.ts";
import { readConfigToml } from "../src/lib/configWriter.ts";

let workdir: string;
let configPath: string;
let envPath: string;

beforeEach(async () => {
  workdir = await mkdtemp(join(tmpdir(), "phantombot-route-"));
  configPath = join(workdir, "config.toml");
  envPath = join(workdir, ".env");
});

afterEach(async () => {
  await rm(workdir, { recursive: true, force: true });
});

describe("clearPiRouting (the 'Use Pi's own config' path)", () => {
  test("erases routing from BOTH toml and env after a configured run", async () => {
    // THE regression: the old "later" option returned early without clearing,
    // so once "now" had run, its routing persisted and pi.ts kept threading
    // --model/--provider forever. Configure first, then delegate to Pi.
    await applyRouting(
      configPath,
      {
        provider: "openrouter",
        primaryModel: "deepseek-v4-pro",
        imageModel: "gpt-4o",
        codingModel: "gpt-5.2-codex",
      },
      envPath,
    );
    await updateEnvFile(envPath, { PHANTOMBOT_PI_API_KEY: "sk-stale" });

    await clearPiRouting(configPath, envPath);

    const toml = await readConfigToml(configPath);
    const routing = (toml as any).harnesses.pi.routing;
    expect(routing.provider).toBeUndefined();
    expect(routing.primary_model).toBeUndefined();
    expect(routing.image_model).toBeUndefined();
    expect(routing.coding_model).toBeUndefined();

    const env = await loadEnvFile(envPath);
    expect(env.PHANTOMBOT_PI_PROVIDER).toBeUndefined();
    expect(env.PHANTOMBOT_PRIMARY_MODEL).toBeUndefined();
    expect(env.PHANTOMBOT_IMAGE_MODEL).toBeUndefined();
    expect(env.PHANTOMBOT_CODING_MODEL).toBeUndefined();
  });

  test("clears the stale API key too (it would be fired at google)", async () => {
    // pi --provider defaults to GOOGLE, so a surviving OpenRouter key with the
    // provider erased auth-fails every turn. Clearing it restores Pi's own
    // auth-store fallback, which is what 'use Pi's own config' means.
    await applyRouting(
      configPath,
      { provider: "openrouter", primaryModel: "deepseek-v4-pro" },
      envPath,
    );
    await updateEnvFile(envPath, { PHANTOMBOT_PI_API_KEY: "sk-stale" });

    await clearPiRouting(configPath, envPath);

    const env = await loadEnvFile(envPath);
    expect(env.PHANTOMBOT_PI_API_KEY).toBeUndefined();
  });

  test("leaves unrelated env vars and config alone", async () => {
    await applyRouting(configPath, { primaryModel: "gpt-5.2" }, envPath);
    await updateEnvFile(envPath, { TELEGRAM_BOT_TOKEN: "keep-me" });

    await clearPiRouting(configPath, envPath);

    const env = await loadEnvFile(envPath);
    expect(env.TELEGRAM_BOT_TOKEN).toBe("keep-me");
  });

  test("is a safe no-op on a virgin box (nothing configured yet)", async () => {
    await clearPiRouting(configPath, envPath);
    const env = await loadEnvFile(envPath);
    expect(env.PHANTOMBOT_PRIMARY_MODEL).toBeUndefined();
  });

  test("clears every key applyRouting can write", () => {
    // Guard against drift: if computeRoutingWrites learns a new key, this fails
    // until computeRoutingClears erases it too.
    const clears = computeRoutingClears();
    expect([...clears.tomlKeys].sort()).toEqual([
      "coding_model",
      "image_model",
      "primary_model",
      "provider",
    ]);
    expect(Object.values(clears.env).every((v) => v === "")).toBe(true);
  });
});

describe("applyRouting", () => {
  test("text-only primary writes all three models to toml + env", async () => {
    await applyRouting(
      configPath,
      {
        primaryModel: "deepseek-v4-pro",
        imageModel: "gpt-4o",
        codingModel: "gpt-5.2-codex",
      },
      envPath,
    );

    const toml = await readConfigToml(configPath);
    expect(toml).toMatchObject({
      harnesses: {
        pi: {
          routing: {
            primary_model: "deepseek-v4-pro",
            image_model: "gpt-4o",
            coding_model: "gpt-5.2-codex",
          },
        },
      },
    });

    const env = await loadEnvFile(envPath);
    expect(env.PHANTOMBOT_PRIMARY_MODEL).toBe("deepseek-v4-pro");
    expect(env.PHANTOMBOT_IMAGE_MODEL).toBe("gpt-4o");
    expect(env.PHANTOMBOT_CODING_MODEL).toBe("gpt-5.2-codex");
  });

  test("vision primary KEEPS the image model (no auto-skip)", async () => {
    // The wizard defaults the image pick to the vision primary, so the image
    // model commonly equals the primary — and it must be persisted, not dropped.
    await applyRouting(
      configPath,
      {
        primaryModel: "gpt-5.2",
        imageModel: "gpt-5.2",
        codingModel: "gpt-5.2-codex",
      },
      envPath,
    );

    const routing = (
      (await readConfigToml(configPath)).harnesses as Record<string, any>
    ).pi.routing;
    expect(routing.primary_model).toBe("gpt-5.2");
    expect(routing.coding_model).toBe("gpt-5.2-codex");
    expect(routing.image_model).toBe("gpt-5.2");

    const env = await loadEnvFile(envPath);
    expect(env.PHANTOMBOT_PRIMARY_MODEL).toBe("gpt-5.2");
    expect(env.PHANTOMBOT_IMAGE_MODEL).toBe("gpt-5.2");
  });

  test("provider persists to toml + env, and (none) clears a previously-set one", async () => {
    await applyRouting(
      configPath,
      { provider: "openrouter", primaryModel: "z-ai/glm-5.2" },
      envPath,
    );
    let routing = (
      (await readConfigToml(configPath)).harnesses as Record<string, any>
    ).pi.routing;
    expect(routing.provider).toBe("openrouter");
    expect((await loadEnvFile(envPath)).PHANTOMBOT_PI_PROVIDER).toBe("openrouter");

    // Switch back to Pi's default provider (undefined) — must clear both stores.
    await applyRouting(configPath, { primaryModel: "gpt-5.2" }, envPath);
    routing = (
      (await readConfigToml(configPath)).harnesses as Record<string, any>
    ).pi.routing;
    expect("provider" in routing).toBe(false);
    expect("PHANTOMBOT_PI_PROVIDER" in (await loadEnvFile(envPath))).toBe(false);
  });

  test("explicit (none) image model clears a previously-set one", async () => {
    // First: an image model is set.
    await applyRouting(
      configPath,
      { primaryModel: "deepseek-v4-pro", imageModel: "gpt-4o" },
      envPath,
    );
    expect((await loadEnvFile(envPath)).PHANTOMBOT_IMAGE_MODEL).toBe("gpt-4o");

    // Then: operator picks "(none)" for the image model — undefined — which must
    // clear the stale value in both toml and env.
    await applyRouting(
      configPath,
      { primaryModel: "gpt-5.2", imageModel: undefined },
      envPath,
    );

    const routing = (
      (await readConfigToml(configPath)).harnesses as Record<string, any>
    ).pi.routing;
    expect("image_model" in routing).toBe(false);
    expect("PHANTOMBOT_IMAGE_MODEL" in (await loadEnvFile(envPath))).toBe(false);
  });

  test("existing provider → configure now → choose (none) → provider removed from toml + env", async () => {
    // Reproduces the review regression end-to-end through the wizard's two seams:
    // the provider-resolution decision (resolveRoutingProvider) and the
    // persistence (applyRouting). With openrouter already configured, the picker
    // returning "" for "(none)" must clear the provider, NOT fall back to it.
    await applyRouting(
      configPath,
      { provider: "openrouter", primaryModel: "z-ai/glm-5.2" },
      envPath,
    );
    const current = "openrouter";

    // Operator re-runs "configure now" and selects "(none)" → pickProvider yields
    // "". The wizard resolves the provider it will persist:
    const resolved = resolveRoutingProvider("", current);
    expect(resolved).toBe(""); // explicit clear, NOT "openrouter"

    await applyRouting(
      configPath,
      { provider: resolved, primaryModel: "gpt-5.2" },
      envPath,
    );

    const routing = (
      (await readConfigToml(configPath)).harnesses as Record<string, any>
    ).pi.routing;
    expect("provider" in routing).toBe(false);
    expect("PHANTOMBOT_PI_PROVIDER" in (await loadEnvFile(envPath))).toBe(false);
  });

  test("coding_model: persists to toml + env", async () => {
    await applyRouting(
      configPath,
      {
        primaryModel: "gpt-5.2",
        codingModel: "gpt-5.2-codex",
      },
      envPath,
    );
    const routing = (
      (await readConfigToml(configPath)).harnesses as Record<string, any>
    ).pi.routing;
    expect(routing.coding_model).toBe("gpt-5.2-codex");
    expect((await loadEnvFile(envPath)).PHANTOMBOT_CODING_MODEL).toBe(
      "gpt-5.2-codex",
    );
  });

  test("preserves unrelated config keys (does not clobber the chain)", async () => {
    const { applyHarnessChain } = await import("../src/cli/harness.ts");
    await applyHarnessChain(configPath, ["pi", "claude"]);
    await applyRouting(
      configPath,
      { primaryModel: "gpt-5.2" },
      envPath,
    );
    const toml = await readConfigToml(configPath);
    expect((toml.harnesses as Record<string, any>).chain).toEqual(["pi", "claude"]);
    expect((toml.harnesses as Record<string, any>).pi.routing.primary_model).toBe(
      "gpt-5.2",
    );
  });
});
