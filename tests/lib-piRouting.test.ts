import { describe, expect, test } from "bun:test";
import {
  computeRoutingWrites,
  ENV_CODING_MODEL,
  ENV_CODING_PROGRESS,
  ENV_IMAGE_MODEL,
  ENV_PRIMARY_MODEL,
  resolveRouting,
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

  describe("codingProgress", () => {
    test("reads a real TOML boolean", () => {
      expect(resolveRouting({ coding_progress: true }, {}).codingProgress).toBe(
        true,
      );
      expect(resolveRouting({ coding_progress: false }, {}).codingProgress).toBe(
        false,
      );
    });

    test("coerces env truthy/falsy strings", () => {
      const on = ["true", "1", "yes", "on", "TRUE", " On "];
      for (const v of on) {
        expect(
          resolveRouting({}, { [ENV_CODING_PROGRESS]: v }).codingProgress,
        ).toBe(true);
      }
      const off = ["false", "0", "no", "off"];
      for (const v of off) {
        expect(
          resolveRouting({}, { [ENV_CODING_PROGRESS]: v }).codingProgress,
        ).toBe(false);
      }
    });

    test("env wins over toml; blank env falls through to toml", () => {
      expect(
        resolveRouting(
          { coding_progress: true },
          { [ENV_CODING_PROGRESS]: "false" },
        ).codingProgress,
      ).toBe(false);
      expect(
        resolveRouting(
          { coding_progress: true },
          { [ENV_CODING_PROGRESS]: "   " },
        ).codingProgress,
      ).toBe(true);
    });

    test("undefined when unset / unrecognized", () => {
      expect(resolveRouting({}, {}).codingProgress).toBeUndefined();
      expect(
        resolveRouting({}, { [ENV_CODING_PROGRESS]: "maybe" }).codingProgress,
      ).toBeUndefined();
    });
  });
});

describe("computeRoutingWrites — multimodal auto-skip", () => {
  test("multimodal primary DROPS the image model in both toml and env", () => {
    const w = computeRoutingWrites({
      primaryModel: "gpt-5.2",
      imageModel: "gpt-4o", // user picked one, but...
      codingModel: "gpt-5.2-codex",
      primaryMultimodal: true, // ...primary is multimodal → skip
    });
    expect(w.toml).toEqual({
      primary_model: "gpt-5.2",
      coding_model: "gpt-5.2-codex",
    });
    expect(w.toml.image_model).toBeUndefined();
    // env writes "" for image → unset (clears any stale value)
    expect(w.env[ENV_IMAGE_MODEL]).toBe("");
    expect(w.env[ENV_PRIMARY_MODEL]).toBe("gpt-5.2");
    expect(w.env[ENV_CODING_MODEL]).toBe("gpt-5.2-codex");
  });

  test("text-only primary KEEPS the image model", () => {
    const w = computeRoutingWrites({
      primaryModel: "deepseek-v4-pro",
      imageModel: "gpt-4o",
      codingModel: "gpt-5.2-codex",
      primaryMultimodal: false,
    });
    expect(w.toml.image_model).toBe("gpt-4o");
    expect(w.env[ENV_IMAGE_MODEL]).toBe("gpt-4o");
  });

  test("omitted coding/image models produce unset env and absent toml keys", () => {
    const w = computeRoutingWrites({
      primaryModel: "deepseek-v4-pro",
      primaryMultimodal: false,
    });
    expect(w.toml).toEqual({ primary_model: "deepseek-v4-pro" });
    expect(w.env[ENV_IMAGE_MODEL]).toBe("");
    expect(w.env[ENV_CODING_MODEL]).toBe("");
    // no coding model ⇒ progress forced off and cleared
    expect(w.toml.coding_progress).toBeUndefined();
    expect(w.env[ENV_CODING_PROGRESS]).toBe("");
  });
});

describe("computeRoutingWrites — coder progress", () => {
  test("persists coding_progress only when on AND a coding model is set", () => {
    const w = computeRoutingWrites({
      primaryModel: "gpt-5.2",
      codingModel: "gpt-5.2-codex",
      codingProgress: true,
      primaryMultimodal: true,
    });
    expect(w.toml.coding_progress).toBe(true);
    expect(w.env[ENV_CODING_PROGRESS]).toBe("true");
  });

  test("progress off ⇒ toml key omitted, env cleared to ''", () => {
    const w = computeRoutingWrites({
      primaryModel: "gpt-5.2",
      codingModel: "gpt-5.2-codex",
      codingProgress: false,
      primaryMultimodal: true,
    });
    expect(w.toml.coding_progress).toBeUndefined();
    expect(w.env[ENV_CODING_PROGRESS]).toBe("");
  });

  test("progress true but no coding model ⇒ forced off (coupled to coder)", () => {
    const w = computeRoutingWrites({
      primaryModel: "gpt-5.2",
      codingProgress: true,
      primaryMultimodal: true,
    });
    expect(w.toml.coding_model).toBeUndefined();
    expect(w.toml.coding_progress).toBeUndefined();
    expect(w.env[ENV_CODING_PROGRESS]).toBe("");
  });
});
