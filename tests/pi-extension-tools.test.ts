/**
 * Tests for the capability-routing Pi extension's pure registration logic.
 * We test `planRouting` (which decides which tools register) directly, without
 * the @earendil-works Pi SDK on the import path — the extension's index.ts
 * (the SDK glue + routing.json read) is verified manually against a live pi via
 * /reload. `planRouting` now takes the parsed routing.json config object.
 */
import { describe, expect, test } from "bun:test";
import {
  imageDelegationPrompt,
  planRouting,
} from "../pi-extension/capability-routing/tools.ts";
import {
  buildDelegateBaseArgs,
  delegateFailureText,
  isDelegateFailure,
  lastProgressText,
  type DelegateResult,
  type Message,
} from "../pi-extension/capability-routing/spawnPi.ts";

/** Minimal DelegateResult builder for the failure-surfacing tests. */
function result(over: Partial<DelegateResult> = {}): DelegateResult {
  return {
    exitCode: 0,
    messages: [],
    stderr: "",
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 },
    ...over,
  };
}

/** Assistant message carrying a single text part. */
function assistantText(text: string): Message {
  return { role: "assistant", content: [{ type: "text", text }] };
}

describe("buildDelegateBaseArgs — provider/api-key threading for delegates", () => {
  const argsOf = (over: Parameters<typeof buildDelegateBaseArgs>[0]) =>
    buildDelegateBaseArgs(over).join(" ");

  test("model is always pinned via --model", () => {
    expect(argsOf({ model: "z-ai/glm-5.2" })).toContain("--model z-ai/glm-5.2");
  });

  test("provider + api-key are threaded as a pair (OpenRouter routes to openrouter, NOT google)", () => {
    const a = argsOf({ model: "z-ai/glm-5.2", provider: "openrouter", apiKey: "sk-or-1" });
    expect(a).toContain("--provider openrouter");
    expect(a).not.toContain("--provider google");
    expect(a).toContain("--api-key sk-or-1");
  });

  test("a different harness can carry a different provider (openai), no collision", () => {
    const a = argsOf({ model: "gpt-5.2", provider: "openai", apiKey: "sk-oa-2" });
    expect(a).toContain("--provider openai");
    expect(a).toContain("--api-key sk-oa-2");
    expect(a).not.toContain("openrouter");
  });

  test("no provider/key → neither flag (Pi falls back to its own default/store)", () => {
    const a = argsOf({ model: "gpt-5.2" });
    expect(a).not.toContain("--provider");
    expect(a).not.toContain("--api-key");
  });

  test("blank provider/key are treated as absent (trimmed away)", () => {
    const a = argsOf({ model: "gpt-5.2", provider: "  ", apiKey: "  " });
    expect(a).not.toContain("--provider");
    expect(a).not.toContain("--api-key");
  });

  test("tools are appended after the auth pair", () => {
    const a = argsOf({ model: "m", provider: "openai", apiKey: "k", tools: ["read"] });
    expect(a).toContain("--tools read");
  });
});

describe("isDelegateFailure — tool-boundary failure detection", () => {
  test("clean exit with no/benign stopReason is success", () => {
    expect(isDelegateFailure(result({ exitCode: 0 }))).toBe(false);
    expect(isDelegateFailure(result({ exitCode: 0, stopReason: "stop" }))).toBe(false);
    expect(isDelegateFailure(result({ exitCode: 0, stopReason: "toolUse" }))).toBe(false);
  });

  test("non-zero exit, error, aborted, and timeout are failures", () => {
    expect(isDelegateFailure(result({ exitCode: 1 }))).toBe(true);
    expect(isDelegateFailure(result({ stopReason: "error" }))).toBe(true);
    expect(isDelegateFailure(result({ stopReason: "aborted" }))).toBe(true);
    expect(isDelegateFailure(result({ stopReason: "timeout" }))).toBe(true);
  });
});

describe("lastProgressText — partial work for a timeout report", () => {
  test("returns the most recent non-empty assistant text", () => {
    const msgs: Message[] = [
      assistantText("first"),
      assistantText("   "), // blank — skipped
      assistantText("running the migration"),
    ];
    expect(lastProgressText(msgs)).toBe("running the migration");
  });

  test("empty string when there is nothing usable", () => {
    expect(lastProgressText([])).toBe("");
    expect(lastProgressText([assistantText("  ")])).toBe("");
  });
});

describe("delegateFailureText — tested-failure result the primary can iterate on", () => {
  test("non-timeout failure surfaces reason + detail, no retry nudge", () => {
    const text = delegateFailureText("look_at_image", result({ exitCode: 2, stderr: "boom" }));
    expect(text).toContain("look_at_image failed (exit 2): boom");
    expect(text).not.toContain("recover from");
  });

  test("timeout failure includes the last progress and an explicit retry nudge", () => {
    const r = result({
      stopReason: "timeout",
      errorMessage: "no output for 240s (likely wedged on a tool call)",
      messages: [assistantText("patched the auth guard, now running tests")],
    });
    const text = delegateFailureText("look_at_image", r);
    expect(text).toContain("look_at_image failed (timeout): no output for 240s");
    expect(text).toContain("patched the auth guard, now running tests");
    expect(text).toContain("call look_at_image again");
  });

  test("timeout with no partial output says so plainly", () => {
    const text = delegateFailureText("look_at_image", result({ stopReason: "timeout" }));
    expect(text).toContain("no usable output before it was stopped");
  });
});

describe("planRouting — tool registration decisions", () => {
  test("registers look_at_image when an image model is set", () => {
    const plan = planRouting({
      primaryModel: "deepseek-v4-pro",
      imageModel: "gpt-4o",
    });
    expect(plan.registerLookAtImage).toBe(true);
    expect(plan.imageModel).toBe("gpt-4o");
  });

  test("does NOT register look_at_image when image model is unset (operator opted out)", () => {
    // The extension keys purely off imageModel presence. phantombot now keeps an
    // image model set whenever routing is configured (defaulting to the primary
    // for a vision primary), so this unset case means the operator explicitly
    // picked "(none)" — and then look_at_image must not register.
    const plan = planRouting({
      primaryModel: "gpt-5.2",
      // no imageModel — operator chose "(none)"
    });
    expect(plan.registerLookAtImage).toBe(false);
  });

  test("treats empty string as unset", () => {
    const plan = planRouting({
      imageModel: "",
    });
    expect(plan.registerLookAtImage).toBe(false);
  });

  test("registers nothing when no models are set", () => {
    const plan = planRouting({});
    expect(plan.registerLookAtImage).toBe(false);
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
});
