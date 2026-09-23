import { describe, expect, test } from "bun:test";

import {
  parseJsonReply,
  structuredOutputInstruction,
  validateOutput,
} from "../src/engine/structured.ts";

describe("parseJsonReply", () => {
  test("bare values", () => {
    expect(parseJsonReply('{"a":1}')).toEqual({ ok: true, value: { a: 1 } });
    expect(parseJsonReply("[1,2]")).toEqual({ ok: true, value: [1, 2] });
    expect(parseJsonReply("  42 ")).toEqual({ ok: true, value: 42 });
  });

  test("fenced values", () => {
    expect(parseJsonReply('```json\n{"a":1}\n```')).toEqual({ ok: true, value: { a: 1 } });
    expect(parseJsonReply('here:\n```\n[true]\n```\nbye')).toEqual({ ok: true, value: [true] });
  });

  test("the first balanced value inside prose, string-aware", () => {
    expect(parseJsonReply('The answer is {"s": "a } b", "n": {"x": 1}} ok')).toEqual({
      ok: true,
      value: { s: "a } b", n: { x: 1 } },
    });
  });

  test("failures carry a reason", () => {
    expect(parseJsonReply("")).toEqual({ ok: false, problem: "the reply was empty" });
    const r = parseJsonReply("no json here");
    expect(r.ok).toBe(false);
  });
});

describe("validateOutput", () => {
  test("function validators", async () => {
    expect(await validateOutput((v) => v as number, 1)).toEqual({ ok: true, value: 1 });
    expect(
      await validateOutput(() => {
        throw new Error("bad");
      }, 1),
    ).toEqual({ ok: false, problem: "bad" });
  });

  test("standard schema issues become a readable list with paths", async () => {
    const schema = {
      "~standard": {
        version: 1 as const,
        vendor: "t",
        validate: async () => ({
          issues: [
            { message: "required", path: ["user", { key: "name" }] },
            { message: "too big" },
          ],
        }),
      },
    };
    expect(await validateOutput(schema, {})).toEqual({
      ok: false,
      problem: "- user.name: required\n- too big",
    });
  });
});

test("the instruction embeds the JSON Schema when given", () => {
  expect(structuredOutputInstruction({ type: "object" })).toContain('{"type":"object"}');
  expect(structuredOutputInstruction(undefined)).not.toContain("JSON Schema");
});
