/**
 * Tests for the Pi harness. Mirrors tests/harnesses-claude.test.ts:
 *   - Pure-function tests for renderPayload / parsePiEvent
 *   - End-to-end via tests/fixtures/fake-pi.sh — verifies Bun.spawn
 *     wiring, stream-json translation, exit-code handling, timeout fix.
 *   - One ARG_MAX guard test (synthetic — confirms the precheck fires).
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { resolve } from "node:path";
import {
  PiHarness,
  parsePiEvent,
  renderPayload,
} from "../src/harnesses/pi.ts";
import type { HarnessChunk, HarnessRequest } from "../src/harnesses/types.ts";

const FAKE_PI = resolve(__dirname, "fixtures/fake-pi.sh");

function newRequest(overrides: Partial<HarnessRequest> = {}): HarnessRequest {
  return {
    systemPrompt: "you are pi",
    userMessage: "hi",
    history: [],
    workingDir: process.cwd(),
    timeoutMs: 5_000,
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

describe("renderPayload (Pi)", () => {
  test("just the new message when history is empty", () => {
    expect(renderPayload(newRequest({ userMessage: "hello" }))).toBe("hello");
  });

  test("wraps assistant turns in <previous_response> blocks", () => {
    const out = renderPayload(
      newRequest({
        history: [
          { role: "user", text: "earlier" },
          { role: "assistant", text: "previous" },
        ],
        userMessage: "now",
      }),
    );
    expect(out).toBe(
      "earlier\n\n<previous_response>\nprevious\n</previous_response>\n\nnow",
    );
  });
});

describe("parsePiEvent", () => {
  test("extracts text_delta from message_update via data.text_delta", () => {
    const c = parsePiEvent({
      type: "message_update",
      data: { text_delta: "hi" },
    });
    expect(c).toEqual({ type: "text", text: "hi" });
  });

  test("also handles message_update with text_delta at the top level", () => {
    const c = parsePiEvent({
      type: "message_update",
      text_delta: "hi",
    });
    expect(c).toEqual({ type: "text", text: "hi" });
  });

  test("turns tool_execution_start into a progress chunk naming the tool", () => {
    const c = parsePiEvent({
      type: "tool_execution_start",
      data: { tool_name: "bash" },
    });
    expect(c).toEqual({ type: "progress", note: "running bash" });
  });

  test("falls back to data.name for tool_execution_start when tool_name is missing", () => {
    const c = parsePiEvent({
      type: "tool_execution_start",
      data: { name: "edit" },
    });
    expect(c).toEqual({ type: "progress", note: "running edit" });
  });

  test("ignores agent_start, tool_execution_end, turn_end, and unknown types", () => {
    expect(parsePiEvent({ type: "agent_start" })).toBeUndefined();
    expect(parsePiEvent({ type: "tool_execution_end" })).toBeUndefined();
    expect(parsePiEvent({ type: "turn_end" })).toBeUndefined();
    expect(parsePiEvent({ type: "unknown" })).toBeUndefined();
  });

  test("ignores empty text_delta", () => {
    expect(
      parsePiEvent({
        type: "message_update",
        data: { text_delta: "" },
      }),
    ).toBeUndefined();
  });

  test("returns undefined for malformed input", () => {
    expect(parsePiEvent(null)).toBeUndefined();
    expect(parsePiEvent("string")).toBeUndefined();
    expect(parsePiEvent({})).toBeUndefined();
    expect(parsePiEvent({ type: 42 })).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// End-to-end via fake-pi.sh
// ---------------------------------------------------------------------------

let originalMode: string | undefined;

beforeEach(() => {
  originalMode = process.env.FAKE_PI_MODE;
});

afterEach(() => {
  if (originalMode === undefined) delete process.env.FAKE_PI_MODE;
  else process.env.FAKE_PI_MODE = originalMode;
});

const mkHarness = (overrides: Partial<{ maxPayloadBytes: number }> = {}) =>
  new PiHarness({
    bin: FAKE_PI,
    maxPayloadBytes: overrides.maxPayloadBytes ?? 1_500_000,
  });

describe("PiHarness.invoke (subprocess)", () => {
  test("normal exit: text chunks + progress chunk + done with finalText", async () => {
    process.env.FAKE_PI_MODE = "normal";
    const chunks = await collect(mkHarness().invoke(newRequest()));
    const texts = chunks.filter((c) => c.type === "text");
    const progress = chunks.filter((c) => c.type === "progress");
    const dones = chunks.filter((c) => c.type === "done");
    expect(texts.map((c) => (c as { text: string }).text)).toEqual([
      "hello ",
      "world",
    ]);
    expect(progress).toHaveLength(1);
    expect(progress[0]).toMatchObject({
      type: "progress",
      note: "running bash",
    });
    expect(dones).toHaveLength(1);
    expect(dones[0]).toMatchObject({
      type: "done",
      finalText: "hello world",
      meta: { harnessId: "pi" },
    });
  });

  test("non-zero exit emits recoverable error", async () => {
    process.env.FAKE_PI_MODE = "error";
    const chunks = await collect(mkHarness().invoke(newRequest()));
    const errors = chunks.filter((c) => c.type === "error");
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatchObject({ type: "error", recoverable: true });
  });

  test("exit 127 emits TERMINAL error", async () => {
    process.env.FAKE_PI_MODE = "notfound";
    const chunks = await collect(mkHarness().invoke(newRequest()));
    const errors = chunks.filter((c) => c.type === "error");
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatchObject({ type: "error", recoverable: false });
  });

  test("timeout emits recoverable error and NO done", async () => {
    process.env.FAKE_PI_MODE = "hang";
    const chunks = await collect(
      mkHarness().invoke(newRequest({ timeoutMs: 200 })),
    );
    const dones = chunks.filter((c) => c.type === "done");
    const errors = chunks.filter((c) => c.type === "error");
    expect(dones).toHaveLength(0);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatchObject({
      type: "error",
      recoverable: true,
      error: expect.stringContaining("timed out"),
    });
  });
});

describe("PiHarness ARG_MAX precheck", () => {
  test("emits a recoverable error and does NOT spawn when payload exceeds budget", async () => {
    // Make the budget tiny so the test request blows it.
    const chunks = await collect(
      mkHarness({ maxPayloadBytes: 5 }).invoke(
        newRequest({
          systemPrompt: "long system prompt that is more than 5 bytes",
          userMessage: "hello",
        }),
      ),
    );
    expect(chunks).toHaveLength(1);
    expect(chunks[0]).toMatchObject({
      type: "error",
      recoverable: true,
      error: expect.stringContaining("exceeds maxPayloadBytes"),
    });
  });

  test("declares maxPayloadBytes on the Harness instance", () => {
    const h = mkHarness({ maxPayloadBytes: 1_000 });
    expect(h.maxPayloadBytes).toBe(1_000);
  });
});

describe("PiHarness.available", () => {
  test("returns true for the absolute path of an executable file", async () => {
    expect(await mkHarness().available()).toBe(true);
  });

  test("returns false for a non-existent absolute path", async () => {
    expect(
      await new PiHarness({
        bin: "/no/such/pi",
        maxPayloadBytes: 1_000,
      }).available(),
    ).toBe(false);
  });
});
