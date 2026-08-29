/**
 * Regression test for the harness wizard's blank-Enter cancellation.
 *
 * `phantombot harness` aborted with "cancelled" when the operator pressed
 * Enter on an empty API-key field — exactly the "blank to keep current" path
 * the prompt advertises. Root cause: @clack/prompts' password prompt resolves
 * `undefined` (not the cancel symbol, `isCancel === false`) on an empty
 * submit, and the `clackPrompts` adapter passed that straight through, so the
 * flow's `undefined === cancelled` contract misread it.
 *
 * These tests drive the REAL adapter against a mocked @clack/prompts and pin
 * the contract: empty submit → "", genuine cancel → undefined.
 */
import { describe, expect, mock, test } from "bun:test";

type PasswordResult = string | symbol | undefined;

let passwordResult: PasswordResult;
let passwordIsCancel = false;

mock.module("@clack/prompts", () => ({
  password: async () => passwordResult,
  isCancel: (_r: unknown) => passwordIsCancel,
}));

const { clackPrompts } = await import("../src/cli/harnessPrompts.ts");

describe("clackPrompts.password — empty submit is '', not a cancellation", () => {
  test("clack resolving undefined on empty Enter maps to '' (keep current)", async () => {
    // What @clack/prompts 1.3 actually does on Enter with an empty field:
    // resolves undefined, isCancel false.
    passwordResult = undefined;
    passwordIsCancel = false;
    expect(await clackPrompts.password({ message: "openrouter API key" })).toBe("");
  });

  test("a real cancel (symbol + isCancel) stays undefined", async () => {
    passwordResult = Symbol.for("clack:cancel");
    passwordIsCancel = true;
    expect(await clackPrompts.password({ message: "openrouter API key" })).toBeUndefined();
  });

  test("a pasted key passes through untouched", async () => {
    passwordResult = "sk-or-v1-test";
    passwordIsCancel = false;
    expect(await clackPrompts.password({ message: "openrouter API key" })).toBe("sk-or-v1-test");
  });
});
