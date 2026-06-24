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

  test("coding_progress on: persists to toml + env alongside the coding model", async () => {
    await applyRouting(
      configPath,
      {
        primaryModel: "gpt-5.2",
        codingModel: "gpt-5.2-codex",
        codingProgress: true,
      },
      envPath,
    );
    const routing = (
      (await readConfigToml(configPath)).harnesses as Record<string, any>
    ).pi.routing;
    expect(routing.coding_progress).toBe(true);
    expect((await loadEnvFile(envPath)).PHANTOMBOT_CODING_PROGRESS).toBe("true");
  });

  test("disabling coding_progress persists an explicit false (toml + env)", async () => {
    await applyRouting(
      configPath,
      {
        primaryModel: "gpt-5.2",
        codingModel: "gpt-5.2-codex",
        codingProgress: true,
      },
      envPath,
    );
    expect((await loadEnvFile(envPath)).PHANTOMBOT_CODING_PROGRESS).toBe("true");

    // Turn it off — with on-by-default, "off" must persist as an explicit
    // false (in both toml and env) so it wins over the default, rather than
    // being cleared and silently re-defaulting to on.
    await applyRouting(
      configPath,
      {
        primaryModel: "gpt-5.2",
        codingModel: "gpt-5.2-codex",
        codingProgress: false,
      },
      envPath,
    );
    const routing = (
      (await readConfigToml(configPath)).harnesses as Record<string, any>
    ).pi.routing;
    expect(routing.coding_progress).toBe(false);
    expect((await loadEnvFile(envPath)).PHANTOMBOT_CODING_PROGRESS).toBe("false");
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
