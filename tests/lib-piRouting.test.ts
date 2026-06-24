import { describe, expect, test } from "bun:test";
import {
  computeRoutingWrites,
  ENV_CODING_MODEL,
  ENV_IMAGE_MODEL,
  ENV_PI_PROVIDER,
  ENV_PRIMARY_MODEL,
  resolveRouting,
  resolveRoutingProvider,
} from "../src/lib/piRouting.ts";

describe("resolveRouting", () => {
  test("env wins over toml", () => {
    const r = resolveRouting(
      { primary_model: "toml-primary", image_model: "toml-image" },
      {
        [ENV_PRIMARY_MODEL]: "env-primary",
        [ENV_IMAGE_MODEL]: "",
        [ENV_CODING_MODEL]: undefined,
      },
    );
    expect(r.primaryModel).toBe("env-primary");
    // empty env string falls through to toml (treated as unset)
    expect(r.imageModel).toBe("toml-image");
    expect(r.codingModel).toBeUndefined();
  });

  test("reads from toml when env is empty", () => {
    const r = resolveRouting(
      {
        primary_model: "gpt-5.2",
        image_model: "gpt-4o",
        coding_model: "gpt-5.2-codex",
      },
      {},
    );
    expect(r).toEqual({
      primaryModel: "gpt-5.2",
      imageModel: "gpt-4o",
      codingModel: "gpt-5.2-codex",
    });
  });

  test("all undefined when nothing is set", () => {
    expect(resolveRouting(undefined, {})).toEqual({
      primaryModel: undefined,
      imageModel: undefined,
      codingModel: undefined,
    });
  });

  test("trims whitespace and treats blank as unset", () => {
    const r = resolveRouting(
      {},
      { [ENV_PRIMARY_MODEL]: "  gpt-5.2  ", [ENV_IMAGE_MODEL]: "   " },
    );
    expect(r.primaryModel).toBe("gpt-5.2");
    expect(r.imageModel).toBeUndefined();
  });

  describe("provider", () => {
    test("reads provider from env over toml", () => {
      const r = resolveRouting(
        { provider: "openai" },
        { [ENV_PI_PROVIDER]: "openrouter" },
      );
      expect(r.provider).toBe("openrouter");
    });

    test("falls back to toml when env blank; trims", () => {
      expect(resolveRouting({ provider: "xai" }, {}).provider).toBe("xai");
      expect(
        resolveRouting({ provider: "xai" }, { [ENV_PI_PROVIDER]: "  " }).provider,
      ).toBe("xai");
      expect(
        resolveRouting({}, { [ENV_PI_PROVIDER]: "  deepseek  " }).provider,
      ).toBe("deepseek");
    });

    test("undefined when unset", () => {
      expect(resolveRouting({}, {}).provider).toBeUndefined();
    });
  });

});

describe("computeRoutingWrites — image model honored as-is (no auto-skip)", () => {
  test("image model is KEPT even when the primary is vision-capable", () => {
    // The old multimodal auto-drop is gone: whatever the wizard collected is
    // persisted. (The wizard defaults the image pick TO the primary for a vision
    // primary, so this is the common shape — an image model that equals primary.)
    const w = computeRoutingWrites({
      primaryModel: "gpt-5.2",
      imageModel: "gpt-5.2", // wizard defaulted image → the vision primary
      codingModel: "gpt-5.2-codex",
    });
    expect(w.toml).toEqual({
      primary_model: "gpt-5.2",
      image_model: "gpt-5.2",
      coding_model: "gpt-5.2-codex",
    });
    expect(w.env[ENV_IMAGE_MODEL]).toBe("gpt-5.2");
    expect(w.env[ENV_PRIMARY_MODEL]).toBe("gpt-5.2");
    expect(w.env[ENV_CODING_MODEL]).toBe("gpt-5.2-codex");
  });

  test("a distinct image model is kept verbatim", () => {
    const w = computeRoutingWrites({
      primaryModel: "deepseek-v4-pro",
      imageModel: "gpt-4o",
      codingModel: "gpt-5.2-codex",
    });
    expect(w.toml.image_model).toBe("gpt-4o");
    expect(w.env[ENV_IMAGE_MODEL]).toBe("gpt-4o");
  });

  test("explicit (none) image — undefined — is honored: unset in env and toml", () => {
    // A vision primary that opts out of look_at_image: the wizard passes
    // undefined, and we DON'T re-default it back to the primary.
    const w = computeRoutingWrites({
      primaryModel: "gpt-5.2",
      imageModel: undefined,
      codingModel: "gpt-5.2-codex",
    });
    expect(w.toml.image_model).toBeUndefined();
    expect(w.env[ENV_IMAGE_MODEL]).toBe("");
  });

  test("omitted coding/image models produce unset env and absent toml keys", () => {
    const w = computeRoutingWrites({
      primaryModel: "deepseek-v4-pro",
    });
    expect(w.toml).toEqual({ primary_model: "deepseek-v4-pro" });
    expect(w.env[ENV_IMAGE_MODEL]).toBe("");
    expect(w.env[ENV_CODING_MODEL]).toBe("");
  });
});

describe("computeRoutingWrites — provider", () => {
  test("provider is written to toml AND env when set", () => {
    const w = computeRoutingWrites({
      provider: "openrouter",
      primaryModel: "z-ai/glm-5.2",
    });
    expect(w.toml.provider).toBe("openrouter");
    expect(w.env[ENV_PI_PROVIDER]).toBe("openrouter");
  });

  test("absent provider ⇒ toml key omitted, env cleared (\"\")", () => {
    const w = computeRoutingWrites({ primaryModel: "gpt-5.2" });
    expect(w.toml.provider).toBeUndefined();
    expect(w.env[ENV_PI_PROVIDER]).toBe("");
  });

  test("blank provider is treated as unset", () => {
    const w = computeRoutingWrites({ provider: "   ", primaryModel: "gpt-5.2" });
    expect(w.toml.provider).toBeUndefined();
    expect(w.env[ENV_PI_PROVIDER]).toBe("");
  });
});

describe("resolveRoutingProvider — explicit (none) clears, skipped keeps", () => {
  test("explicit '' ((none)) overrides an existing provider (clears it)", () => {
    // The regression: choosing "(none)" with openrouter already set must NOT
    // fall back to openrouter.
    expect(resolveRoutingProvider("", "openrouter")).toBe("");
  });

  test("a chosen provider name wins over the current one", () => {
    expect(resolveRoutingProvider("openai", "openrouter")).toBe("openai");
  });

  test("undefined (step skipped) keeps the current provider", () => {
    expect(resolveRoutingProvider(undefined, "openrouter")).toBe("openrouter");
  });

  test("undefined with no current provider stays unset", () => {
    expect(resolveRoutingProvider(undefined, undefined)).toBeUndefined();
  });

  test("explicit '' with no current provider stays cleared", () => {
    expect(resolveRoutingProvider("", undefined)).toBe("");
  });
});
