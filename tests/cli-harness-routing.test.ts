import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applyRouting } from "../src/cli/harness.ts";
import { loadEnvFile } from "../src/lib/envFile.ts";
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

describe("applyRouting", () => {
  test("text-only primary writes all three models to toml + env", async () => {
    await applyRouting(
      configPath,
      {
        primaryModel: "deepseek-v4-pro",
        imageModel: "gpt-4o",
        codingModel: "gpt-5.2-codex",
        primaryMultimodal: false,
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

  test("multimodal primary omits image model from toml and env", async () => {
    await applyRouting(
      configPath,
      {
        primaryModel: "gpt-5.2",
        imageModel: "gpt-4o",
        codingModel: "gpt-5.2-codex",
        primaryMultimodal: true,
      },
      envPath,
    );

    const routing = (
      (await readConfigToml(configPath)).harnesses as Record<string, any>
    ).pi.routing;
    expect(routing.primary_model).toBe("gpt-5.2");
    expect(routing.coding_model).toBe("gpt-5.2-codex");
    expect("image_model" in routing).toBe(false);

    const env = await loadEnvFile(envPath);
    expect(env.PHANTOMBOT_PRIMARY_MODEL).toBe("gpt-5.2");
    // "" deletes the key in updateEnvFile, so it must be absent.
    expect("PHANTOMBOT_IMAGE_MODEL" in env).toBe(false);
  });

  test("switching to a multimodal primary clears a previously-set image model", async () => {
    // First: text-only primary with an image model.
    await applyRouting(
      configPath,
      {
        primaryModel: "deepseek-v4-pro",
        imageModel: "gpt-4o",
        primaryMultimodal: false,
      },
      envPath,
    );
    expect((await loadEnvFile(envPath)).PHANTOMBOT_IMAGE_MODEL).toBe("gpt-4o");

    // Then: switch to a multimodal primary — the stale image model must go.
    await applyRouting(
      configPath,
      { primaryModel: "gpt-5.2", imageModel: "gpt-4o", primaryMultimodal: true },
      envPath,
    );

    const routing = (
      (await readConfigToml(configPath)).harnesses as Record<string, any>
    ).pi.routing;
    expect("image_model" in routing).toBe(false);
    expect("PHANTOMBOT_IMAGE_MODEL" in (await loadEnvFile(envPath))).toBe(false);
  });

  test("coding_progress on: persists to toml + env alongside the coding model", async () => {
    await applyRouting(
      configPath,
      {
        primaryModel: "gpt-5.2",
        codingModel: "gpt-5.2-codex",
        codingProgress: true,
        primaryMultimodal: true,
      },
      envPath,
    );
    const routing = (
      (await readConfigToml(configPath)).harnesses as Record<string, any>
    ).pi.routing;
    expect(routing.coding_progress).toBe(true);
    expect((await loadEnvFile(envPath)).PHANTOMBOT_CODING_PROGRESS).toBe("true");
  });

  test("disabling coding_progress clears a previously-set flag (toml + env)", async () => {
    await applyRouting(
      configPath,
      {
        primaryModel: "gpt-5.2",
        codingModel: "gpt-5.2-codex",
        codingProgress: true,
        primaryMultimodal: true,
      },
      envPath,
    );
    expect((await loadEnvFile(envPath)).PHANTOMBOT_CODING_PROGRESS).toBe("true");

    // Turn it off — both the toml key and the env var must be removed.
    await applyRouting(
      configPath,
      {
        primaryModel: "gpt-5.2",
        codingModel: "gpt-5.2-codex",
        codingProgress: false,
        primaryMultimodal: true,
      },
      envPath,
    );
    const routing = (
      (await readConfigToml(configPath)).harnesses as Record<string, any>
    ).pi.routing;
    expect("coding_progress" in routing).toBe(false);
    expect("PHANTOMBOT_CODING_PROGRESS" in (await loadEnvFile(envPath))).toBe(
      false,
    );
  });

  test("preserves unrelated config keys (does not clobber the chain)", async () => {
    const { applyHarnessChain } = await import("../src/cli/harness.ts");
    await applyHarnessChain(configPath, ["pi", "claude"]);
    await applyRouting(
      configPath,
      { primaryModel: "gpt-5.2", primaryMultimodal: true },
      envPath,
    );
    const toml = await readConfigToml(configPath);
    expect((toml.harnesses as Record<string, any>).chain).toEqual(["pi", "claude"]);
    expect((toml.harnesses as Record<string, any>).pi.routing.primary_model).toBe(
      "gpt-5.2",
    );
  });
});
