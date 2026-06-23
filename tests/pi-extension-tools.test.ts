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
import { buildProgress, isTerminalStop } from "../pi-extension/capability-routing/spawnPi.ts";

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
    expect(plan.streamCoderProgress).toBe(false);
  });
});

describe("planRouting — coder progress streaming", () => {
  test("streams when codingProgress is true AND a coding model is set", () => {
    const plan = planRouting({
      codingModel: "gpt-5.2-codex",
      codingProgress: true,
    });
    expect(plan.registerCoder).toBe(true);
    expect(plan.streamCoderProgress).toBe(true);
  });

  test("does NOT stream when codingProgress is true but no coding model", () => {
    // progress without a coder tool is meaningless — force-decoupled
    const plan = planRouting({ codingProgress: true });
    expect(plan.registerCoder).toBe(false);
    expect(plan.streamCoderProgress).toBe(false);
  });

  test("does NOT stream when codingProgress is unset or false", () => {
    expect(planRouting({ codingModel: "x" }).streamCoderProgress).toBe(false);
    expect(
      planRouting({ codingModel: "x", codingProgress: false }).streamCoderProgress,
    ).toBe(false);
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

describe("coder progress — terminal vs tool-use continuation", () => {
  // Pi sets a stopReason on EVERY assistant turn. Tool-use continuation turns
  // (edit/bash/write) carry "toolUse"; the run only truly ends with "stop",
  // "length", or an error/abort. The progress sink drops terminal turns, so
  // mis-flagging a toolUse turn as terminal silently swallows the progress.
  // Minimal assistant-message shape cast to buildProgress's param type — keeps
  // this test free of the host Pi SDK (not on the import path; see file header).
  const assistant = (stopReason: string | undefined, parts: unknown[]) =>
    ({ role: "assistant", content: parts, stopReason }) as unknown as Parameters<
      typeof buildProgress
    >[0];

  test("a toolUse turn is NOT terminal — it gets reported", () => {
    const ev = buildProgress(
      assistant("toolUse", [
        { type: "text", text: "Patching the validation path" },
        { type: "tool_use", name: "edit" },
        { type: "tool_use", name: "bash" },
      ]),
      3,
    );
    expect(ev.terminal).toBe(false); // sink forwards it ⇒ notifies
    expect(ev.turn).toBe(3);
    expect(ev.text).toBe("Patching the validation path");
    expect(ev.tools).toEqual(["edit", "bash"]);
  });

  test("the final answer (stop) IS terminal — sink skips it", () => {
    const ev = buildProgress(assistant("stop", [{ type: "text", text: "Done." }]), 5);
    expect(ev.terminal).toBe(true);
  });

  test("length / error / aborted are terminal; bare classifier agrees", () => {
    expect(buildProgress(assistant("length", []), 1).terminal).toBe(true);
    expect(buildProgress(assistant("error", []), 1).terminal).toBe(true);
    expect(buildProgress(assistant("aborted", []), 1).terminal).toBe(true);

    expect(isTerminalStop("toolUse")).toBe(false);
    expect(isTerminalStop("stop")).toBe(true);
    expect(isTerminalStop(undefined)).toBe(false); // in-flight turn, no reason yet
  });
});
