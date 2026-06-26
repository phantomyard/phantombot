import { describe, expect, test } from "bun:test";
import {
  computeRoutingWrites,
  ENV_CODING_MODEL,
  ENV_IMAGE_MODEL,
  ENV_PI_PROVIDER,
  ENV_PRIMARY_MODEL,
  resolvePiApiKeyWrite,
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

describe("resolvePiApiKeyWrite — blank key only kept when provider unchanged", () => {
  test("a freshly entered key is always set (trimmed)", () => {
    expect(resolvePiApiKeyWrite("  sk-new  ", "openai", "openrouter")).toEqual({
      action: "set",
      value: "sk-new",
    });
  });

  test("an entered key wins even when the provider is unchanged", () => {
    expect(resolvePiApiKeyWrite("sk-new", "openrouter", "openrouter")).toEqual({
      action: "set",
      value: "sk-new",
    });
  });

  test("blank key + unchanged provider keeps the current key", () => {
    expect(resolvePiApiKeyWrite("", "openrouter", "openrouter")).toEqual({
      action: "keep",
    });
  });

  test("blank key + whitespace-only key + unchanged provider keeps", () => {
    expect(resolvePiApiKeyWrite("   ", "openrouter", "openrouter")).toEqual({
      action: "keep",
    });
  });

  test("THE REGRESSION: undefined key (TUI blank submit) keeps, never throws", () => {
    // @clack returns undefined (not "") when the user submits a blank line, so the
    // resolver must treat undefined/null as blank — an unguarded .trim() threw
    // "undefined is not an object" and forced the user to retype the key every run.
    expect(resolvePiApiKeyWrite(undefined, "openrouter", "openrouter")).toEqual({
      action: "keep",
    });
    expect(resolvePiApiKeyWrite(null, "openrouter", "openrouter")).toEqual({
      action: "keep",
    });
    // undefined key + switched provider still clears the stale key.
    expect(resolvePiApiKeyWrite(undefined, "openai", "openrouter")).toEqual({
      action: "clear",
    });
  });

  test("THE REGRESSION: blank key + switched provider clears the stale key", () => {
    // Operator had openrouter + an openrouter key, reruns the wizard, switches to
    // openai and leaves the key blank. The old key must NOT survive — threading it
    // onto `--provider openai` auth-fails.
    expect(resolvePiApiKeyWrite("", "openai", "openrouter")).toEqual({
      action: "clear",
    });
  });

  test("blank key + provider cleared to (none) clears the stale key", () => {
    // "(none)" arrives as "" from the picker; that's a provider change from
    // openrouter → no provider, so the openrouter key must go.
    expect(resolvePiApiKeyWrite("", "", "openrouter")).toEqual({
      action: "clear",
    });
  });

  test("blank key + no provider before or after is a no-op keep", () => {
    expect(resolvePiApiKeyWrite("", "", undefined)).toEqual({ action: "keep" });
    expect(resolvePiApiKeyWrite("", undefined, undefined)).toEqual({
      action: "keep",
    });
  });

  test("provider compare ignores surrounding whitespace", () => {
    // " openrouter " and "openrouter" are the same provider → keep.
    expect(resolvePiApiKeyWrite("", " openrouter ", "openrouter")).toEqual({
      action: "keep",
    });
  });
});
