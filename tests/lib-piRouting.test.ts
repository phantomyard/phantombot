import { describe, expect, test } from "bun:test";
import {
  computeRoutingWrites,
  ENV_CODING_MODEL,
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
  });
});
