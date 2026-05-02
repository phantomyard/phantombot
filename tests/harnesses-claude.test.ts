/**
 * Tests for the Claude harness.
 *
 * Two layers:
 *   1. Pure-function tests for the exported helpers (renderStdinPayload,
 *      filterAuthEnv, parseStreamJson) — fast, deterministic, no subprocess.
 *   2. End-to-end tests via tests/fixtures/fake-claude.sh — verifies
 *      Bun.spawn wiring, stream-json parsing, exit-code handling, and
 *      the timeout-vs-close state-machine fix.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { resolve } from "node:path";
import {
  ClaudeHarness,
  filterAuthEnv,
  parseStreamJson,
  renderStdinPayload,
} from "../src/harnesses/claude.ts";
import type { HarnessChunk, HarnessRequest } from "../src/harnesses/types.ts";

const FAKE_CLAUDE = resolve(__dirname, "fixtures/fake-claude.sh");

function newRequest(overrides: Partial<HarnessRequest> = {}): HarnessRequest {
  return {
    systemPrompt: "you are a test",
    userMessage: "hi",
    history: [],
    workingDir: process.cwd(),
    idleTimeoutMs: 5_000, hardTimeoutMs: 5_000,
    ...overrides,
  };
}

async function collect(
  iter: AsyncIterable<HarnessChunk>,
): Promise<HarnessChunk[]> {
  const chunks: HarnessChunk[] = [];
  for await (const c of iter) chunks.push(c);
  return chunks;
}

// ---------------------------------------------------------------------------
// Pure-function tests
// ---------------------------------------------------------------------------

describe("renderStdinPayload", () => {
  test("just the new message when history is empty", () => {
    const out = renderStdinPayload(newRequest({ userMessage: "hello" }));
    expect(out).toBe("hello");
  });

  test("wraps assistant turns in <previous_response> blocks", () => {
    const out = renderStdinPayload(
      newRequest({
        history: [
          { role: "user", text: "what's 2+2?" },
          { role: "assistant", text: "4" },
        ],
        userMessage: "and 3+3?",
      }),
    );
    expect(out).toBe(
      "what's 2+2?\n\n<previous_response>\n4\n</previous_response>\n\nand 3+3?",
    );
  });
});

describe("filterAuthEnv", () => {
  test("strips ANTHROPIC_API_KEY", () => {
    const out = filterAuthEnv({
      ANTHROPIC_API_KEY: "sk-redacted",
      PATH: "/usr/bin",
      HOME: "/home/test",
    });
    expect(out).not.toHaveProperty("ANTHROPIC_API_KEY");
    expect(out.PATH).toBe("/usr/bin");
    expect(out.HOME).toBe("/home/test");
  });

  test("drops undefined values (NodeJS.ProcessEnv allows them)", () => {
    const out = filterAuthEnv({
      DEFINED: "yes",
      MAYBE: undefined,
    });
    expect(out).toEqual({ DEFINED: "yes" });
  });
});

describe("parseStreamJson", () => {
  test("extracts assistant text content", () => {
    const c = parseStreamJson({
      type: "assistant",
      message: { content: [{ type: "text", text: "hello" }] },
    });
    expect(c).toEqual({ type: "text", text: "hello" });
  });

  test("concatenates multiple text parts in one assistant message", () => {
    const c = parseStreamJson({
      type: "assistant",
      message: {
        content: [
          { type: "text", text: "hello " },
          { type: "text", text: "world" },
        ],
      },
    });
    expect(c).toEqual({ type: "text", text: "hello world" });
  });

  test("returns undefined for non-assistant events", () => {
    expect(parseStreamJson({ type: "system" })).toBeUndefined();
    expect(parseStreamJson({ type: "user" })).toBeUndefined();
    expect(parseStreamJson({ type: "result" })).toBeUndefined();
  });

  test("returns undefined for assistant messages with no text parts (e.g. pure tool_use)", () => {
    const c = parseStreamJson({
      type: "assistant",
      message: { content: [{ type: "tool_use", name: "Bash", input: {} }] },
    });
    expect(c).toBeUndefined();
  });

  test("returns undefined for malformed input", () => {
    expect(parseStreamJson(null)).toBeUndefined();
    expect(parseStreamJson(undefined)).toBeUndefined();
    expect(parseStreamJson("string")).toBeUndefined();
    expect(parseStreamJson({})).toBeUndefined();
    expect(parseStreamJson({ type: "assistant" })).toBeUndefined();
    expect(
      parseStreamJson({ type: "assistant", message: {} }),
    ).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// End-to-end tests via fake-claude.sh
// ---------------------------------------------------------------------------

let originalMode: string | undefined;

beforeEach(() => {
  originalMode = process.env.FAKE_CLAUDE_MODE;
});

afterEach(() => {
  if (originalMode === undefined) delete process.env.FAKE_CLAUDE_MODE;
  else process.env.FAKE_CLAUDE_MODE = originalMode;
});

describe("ClaudeHarness.invoke (subprocess)", () => {
  const mkHarness = () =>
    new ClaudeHarness({
      bin: FAKE_CLAUDE,
      model: "test",
      fallbackModel: "",
    });

  test("normal exit: text chunks then done with finalText", async () => {
    process.env.FAKE_CLAUDE_MODE = "normal";
    const chunks = await collect(mkHarness().invoke(newRequest()));
    const texts = chunks.filter((c) => c.type === "text");
    const dones = chunks.filter((c) => c.type === "done");
    expect(texts).toHaveLength(2);
    expect(texts[0]).toEqual({ type: "text", text: "hello " });
    expect(texts[1]).toEqual({ type: "text", text: "world" });
    expect(dones).toHaveLength(1);
    expect(dones[0]).toMatchObject({
      type: "done",
      finalText: "hello world",
      meta: { harnessId: "claude", model: "test" },
    });
  });

  test("non-zero exit emits recoverable error", async () => {
    process.env.FAKE_CLAUDE_MODE = "error";
    const chunks = await collect(mkHarness().invoke(newRequest()));
    const errors = chunks.filter((c) => c.type === "error");
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatchObject({ type: "error", recoverable: true });
    expect(errors[0]).toMatchObject({
      error: expect.stringContaining("exited with code 1"),
    });
  });

  test("exit 127 (command not found) emits TERMINAL error (recoverable: false)", async () => {
    process.env.FAKE_CLAUDE_MODE = "notfound";
    const chunks = await collect(mkHarness().invoke(newRequest()));
    const errors = chunks.filter((c) => c.type === "error");
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatchObject({ type: "error", recoverable: false });
  });

  test("timeout: emits recoverable error, does NOT emit done with partial text (state-machine fix)", async () => {
    process.env.FAKE_CLAUDE_MODE = "hang";
    const chunks = await collect(
      mkHarness().invoke(newRequest({ idleTimeoutMs: 200, hardTimeoutMs: 200 })),
    );
    const dones = chunks.filter((c) => c.type === "done");
    const errors = chunks.filter((c) => c.type === "error");
    expect(dones).toHaveLength(0); // pre-fix this would have been 1 with empty finalText
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatchObject({
      type: "error",
      recoverable: true,
      error: expect.stringContaining("timed out"),
    });
  });
});

describe("ClaudeHarness.available", () => {
  test("returns true for an executable absolute path", async () => {
    const h = new ClaudeHarness({
      bin: FAKE_CLAUDE,
      model: "test",
      fallbackModel: "",
    });
    expect(await h.available()).toBe(true);
  });

  test("returns false for a non-existent absolute path", async () => {
    const h = new ClaudeHarness({
      bin: "/this/does/not/exist/claude",
      model: "test",
      fallbackModel: "",
    });
    expect(await h.available()).toBe(false);
  });

  test("returns true for a bare command name (assumes PATH lookup)", async () => {
    const h = new ClaudeHarness({
      bin: "claude",
      model: "test",
      fallbackModel: "",
    });
    expect(await h.available()).toBe(true);
  });
});
