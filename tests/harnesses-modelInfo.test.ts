/**
 * modelInfo() on the four harness classes (issue #313) — the /status and
 * /model display surface. Each class projects its own config shape into the
 * shared HarnessModelInfo; these pin that projection, especially the
 * "unpinned → (default)" sentinels.
 */

import { describe, expect, test } from "bun:test";
import { PiHarness } from "../src/harnesses/pi.ts";
import { ClaudeHarness } from "../src/harnesses/claude.ts";
import { GeminiHarness } from "../src/harnesses/gemini.ts";
import { CodexHarness } from "../src/harnesses/codex.ts";

describe("PiHarness.modelInfo", () => {
  test("with full routing configured", () => {
    const h = new PiHarness({
      bin: "pi",
      routing: {
        provider: "openrouter",
        primaryModel: "deepseek-v3",
        codingModel: "qwen-coder",
        imageModel: "qwen-vl",
      },
    });
    expect(h.modelInfo()).toEqual({
      model: "deepseek-v3",
      provider: "openrouter",
      codingModel: "qwen-coder",
      imageModel: "qwen-vl",
    });
  });

  test("without routing → pi default sentinel", () => {
    const h = new PiHarness({ bin: "pi" });
    const info = h.modelInfo();
    expect(info.model).toBe("(pi default)");
    expect(info.provider).toBeUndefined();
    expect(info.codingModel).toBeUndefined();
  });
});

describe("ClaudeHarness.modelInfo", () => {
  test("reports model and fallback", () => {
    const h = new ClaudeHarness({
      bin: "claude",
      model: "opus",
      fallbackModel: "sonnet",
    });
    expect(h.modelInfo()).toEqual({ model: "opus", fallbackModel: "sonnet" });
  });

  test("empty fallback is omitted", () => {
    const h = new ClaudeHarness({ bin: "claude", model: "opus", fallbackModel: "" });
    expect(h.modelInfo().fallbackModel).toBeUndefined();
  });
});

describe("GeminiHarness.modelInfo", () => {
  test("pinned model", () => {
    expect(
      new GeminiHarness({ bin: "gemini", model: "gemini-2.5-pro" }).modelInfo(),
    ).toEqual({ model: "gemini-2.5-pro" });
  });

  test("empty model → (default)", () => {
    expect(new GeminiHarness({ bin: "gemini", model: "" }).modelInfo()).toEqual({
      model: "(default)",
    });
  });
});

describe("CodexHarness.modelInfo", () => {
  test("pinned model", () => {
    expect(
      new CodexHarness({ bin: "codex", model: "gpt-5.2-codex" }).modelInfo(),
    ).toEqual({ model: "gpt-5.2-codex" });
  });

  test("empty model → (default)", () => {
    expect(new CodexHarness({ bin: "codex", model: "" }).modelInfo()).toEqual({
      model: "(default)",
    });
  });
});
