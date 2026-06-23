/**
 * Tests for the capability-routing Pi extension's pure registration logic.
 * We test `planRouting` (which decides which tools register) directly, without
 * the @earendil-works Pi SDK on the import path — the extension's index.ts
 * (the SDK glue + routing.json read) is verified manually against a live pi via
 * /reload. `planRouting` now takes the parsed routing.json config object.
 */
import { describe, expect, test } from "bun:test";
import {
  coderDelegationPrompt,
  imageDelegationPrompt,
  planRouting,
} from "../pi-extension/capability-routing/tools.ts";

describe("planRouting — tool registration decisions", () => {
  test("registers both tools when image and coding models are set", () => {
    const plan = planRouting({
      primaryModel: "deepseek-v4-pro",
      imageModel: "gpt-4o",
      codingModel: "gpt-5.2-codex",
    });
    expect(plan.registerLookAtImage).toBe(true);
    expect(plan.registerCoder).toBe(true);
    expect(plan.imageModel).toBe("gpt-4o");
    expect(plan.codingModel).toBe("gpt-5.2-codex");
  });

  test("does NOT register look_at_image when image model is unset (multimodal primary)", () => {
    const plan = planRouting({
      primaryModel: "gpt-5.2",
      codingModel: "gpt-5.2-codex",
      // no imageModel — primary is multimodal
    });
    expect(plan.registerLookAtImage).toBe(false);
    expect(plan.registerCoder).toBe(true);
  });

  test("treats empty string as unset", () => {
    const plan = planRouting({
      imageModel: "",
      codingModel: "   ",
    });
    expect(plan.registerLookAtImage).toBe(false);
    expect(plan.registerCoder).toBe(false);
  });

  test("registers nothing when no models are set", () => {
    const plan = planRouting({});
    expect(plan.registerLookAtImage).toBe(false);
    expect(plan.registerCoder).toBe(false);
    expect(plan.primaryModel).toBeUndefined();
  });
});

describe("delegation prompts", () => {
  test("image prompt is question-driven and embeds path + question", () => {
    const prompt = imageDelegationPrompt("/tmp/x.png", "How many people are in this photo?");
    expect(prompt).toContain("/tmp/x.png");
    expect(prompt).toContain("How many people are in this photo?");
    expect(prompt).toContain("answer the question");
  });

  test("coder prompt signals coarse-grained / fresh-process semantics", () => {
    const prompt = coderDelegationPrompt("Add input validation to the API.");
    expect(prompt).toContain("Add input validation to the API.");
    expect(prompt.toLowerCase()).toContain("coarse-grained");
    expect(prompt).toContain("edit, bash, and write");
  });
});
