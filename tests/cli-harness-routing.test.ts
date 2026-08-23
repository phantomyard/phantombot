import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  applyRouting,
  clearPiRouting,
  resolveHarnessWriteTarget,
} from "../src/cli/harness.ts";
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

describe("applyRouting for a non-default persona (phantombot#441)", () => {
  test("TOML lands in the persona file and the env mirror is SUFFIXED", async () => {
    // The env file is shared by every persona on the host, so writing the
    // unsuffixed vars while configuring Lena would repoint Kai and Robbie too —
    // and, because env outranks the global TOML, would keep doing so. The
    // suffixed vars are what config.ts reads for a non-default persona.
    await applyRouting(
      configPath,
      { provider: "openrouter", primaryModel: "lena-primary", imageModel: "lena-vision" },
      envPath,
      "LENA",
    );

    const toml = await readConfigToml(configPath);
    expect((toml as any).harnesses.pi.routing.primary_model).toBe("lena-primary");

    const env = await loadEnvFile(envPath);
    expect(env.PHANTOMBOT_PRIMARY_MODEL_LENA).toBe("lena-primary");
    expect(env.PHANTOMBOT_IMAGE_MODEL_LENA).toBe("lena-vision");
    expect(env.PHANTOMBOT_PI_PROVIDER_LENA).toBe("openrouter");
    // The host's own vars are untouched — configuring one persona must never
    // move another persona's brain.
    expect(env.PHANTOMBOT_PRIMARY_MODEL).toBeUndefined();
    expect(env.PHANTOMBOT_IMAGE_MODEL).toBeUndefined();
  });

  test("clearPiRouting clears the SUFFIXED vars, not the host's", async () => {
    await applyRouting(configPath, { primaryModel: "host-primary" }, envPath);
    await applyRouting(configPath, { primaryModel: "lena-primary" }, envPath, "LENA");
    await clearPiRouting(configPath, envPath, "LENA");

    const env = await loadEnvFile(envPath);
    // An empty write REMOVES the var (updateEnvFile's "" = unset semantics).
    expect(env.PHANTOMBOT_PRIMARY_MODEL_LENA).toBeUndefined();
    expect(env.PHANTOMBOT_PRIMARY_MODEL).toBe("host-primary");
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

describe("resolveHarnessWriteTarget (phantombot#441, wizard scope)", () => {
  const cfg = (defaultPersona: string) =>
    ({
      configPath,
      personasDir: join(workdir, "personas"),
      defaultPersona,
    }) as any;

  test("a NON-DEFAULT persona is written in persona scope even with no file yet", async () => {
    // THE edge Lena caught: resolvePersonaWriteTarget falls back to the GLOBAL
    // file until the persona has one of its own. For the chain that fallback is
    // harmless (it writes the legacy per-persona table), but routing is written
    // as a plain [harnesses.pi.routing] — in the global file that is the HOST
    // default every other persona inherits under the per-key merge. Configuring
    // Lena would move Kai's models via TOML, which is the very leak the suffixed
    // env mirror closes on the env side.
    const target = await resolveHarnessWriteTarget(cfg("robbie"), "lena");
    expect(target.scope).toBe("persona");
    expect(target.path).toBe(join(workdir, "personas", "lena", "config.toml"));
    expect(target.envSuffix).toBe("LENA");

    // And the write actually materialises that file rather than the global one.
    await applyRouting(target.path, { primaryModel: "lena-primary" }, envPath, target.envSuffix);
    expect((await readConfigToml(target.path) as any).harnesses.pi.routing.primary_model)
      .toBe("lena-primary");
    expect(await readConfigToml(configPath)).toEqual({});
  });

  test("the DEFAULT persona keeps the global-file fallback until migration runs", async () => {
    // Unmigrated hosts must stay readable by an older binary — release rings
    // make rollback real — so the default persona only moves to its own file
    // once that file exists.
    const before = await resolveHarnessWriteTarget(cfg("robbie"), "robbie");
    expect(before.scope).toBe("global");
    expect(before.path).toBe(configPath);
    expect(before.envSuffix).toBeUndefined();

    const personaPath = join(workdir, "personas", "robbie", "config.toml");
    await applyRouting(personaPath, { primaryModel: "host-primary" }, envPath);
    const after = await resolveHarnessWriteTarget(cfg("robbie"), "robbie");
    expect(after.scope).toBe("persona");
    expect(after.path).toBe(personaPath);
    expect(after.envSuffix).toBeUndefined();
  });

  test("no --persona is the default persona, not a suffixed one", async () => {
    const target = await resolveHarnessWriteTarget(cfg("robbie"));
    expect(target.persona).toBe("robbie");
    expect(target.envSuffix).toBeUndefined();
    expect(target.scope).toBe("global");
  });
});

describe("persona clears are tombstoned, not deleted (phantombot#441)", () => {
  const cfg = (defaultPersona: string) =>
    ({
      configPath,
      personasDir: join(workdir, "personas"),
      defaultPersona,
    }) as any;

  test("PERSONA scope writes an explicit use_local_config opt-out", async () => {
    // THE bug Kai caught: deleting a persona's routing keys is not clearing
    // them. Under the per-key merge an absent key falls back to the HOST's
    // [harnesses.pi.routing] — so "use Pi's own config" silently resolved to
    // the host's provider and models. The cleared state needs its own spelling.
    const target = await resolveHarnessWriteTarget(cfg("robbie"), "lena");
    await applyRouting(
      target.path,
      { provider: "openrouter", primaryModel: "lena-primary", codingModel: "lena-coder" },
      envPath,
      target.envSuffix,
    );

    await clearPiRouting(target.path, envPath, target.envSuffix, { tombstone: true });

    const routing = (await readConfigToml(target.path) as any).harnesses.pi.routing;
    expect(routing.use_local_config).toBe(true);
    expect(routing.provider).toBeUndefined();
    expect(routing.primary_model).toBeUndefined();
    expect(routing.coding_model).toBeUndefined();
  });

  test("GLOBAL scope never writes the tombstone (it would be inherited host-wide)", async () => {
    // In the global file the flag is not this persona's opt-out, it is every
    // persona's: any persona that does not state its own routing inherits it.
    await applyRouting(configPath, { primaryModel: "host-primary" }, envPath);
    await clearPiRouting(configPath, envPath);
    const routing = (await readConfigToml(configPath) as any).harnesses.pi.routing;
    expect(routing.use_local_config).toBeUndefined();
    expect(routing.primary_model).toBeUndefined();
  });

  test("configuring models REVOKES a previous opt-out in the same write", async () => {
    const target = await resolveHarnessWriteTarget(cfg("robbie"), "lena");
    await clearPiRouting(target.path, envPath, target.envSuffix, { tombstone: true });
    await applyRouting(
      target.path,
      { primaryModel: "lena-primary-2" },
      envPath,
      target.envSuffix,
    );
    const routing = (await readConfigToml(target.path) as any).harnesses.pi.routing;
    expect(routing.use_local_config).toBeUndefined();
    expect(routing.primary_model).toBe("lena-primary-2");
  });
});
