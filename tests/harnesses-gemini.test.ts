/**
 * Tests for the Gemini harness. Same shape as harnesses-pi.test.ts:
 *   - Pure-function test for renderStdinPayload
 *   - End-to-end via tests/fixtures/fake-gemini.sh — verifies Bun.spawn
 *     wiring, stdin/argv split, exit-code handling, timeout fix.
 */

import { describe, expect, test } from "bun:test";
import { resolve } from "node:path";
import {
  GeminiHarness,
  parseGeminiEvent,
  renderStdinPayload,
} from "../src/harnesses/gemini.ts";
import type { HarnessChunk, HarnessRequest } from "../src/harnesses/types.ts";

const FAKE_GEMINI = resolve(__dirname, "fixtures/fake-gemini.sh");

function newRequest(overrides: Partial<HarnessRequest> = {}): HarnessRequest {
  return {
    systemPrompt: "you are gemini",
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
// renderStdinPayload — pure function
// ---------------------------------------------------------------------------

describe("renderStdinPayload (Gemini)", () => {
  test("system + history → transcript with trailing newlines", () => {
    const out = renderStdinPayload(
      newRequest({
        systemPrompt: "you are gemini",
        history: [
          { role: "user", text: "earlier" },
          { role: "assistant", text: "previous reply" },
        ],
      }),
    );
    expect(out).toContain("you are gemini");
    expect(out).toContain("User: earlier");
    expect(out).toContain("Assistant: previous reply");
    // Trailing blank line before gemini appends the -p value.
    expect(out.endsWith("\n\n")).toBe(true);
  });

  test("empty history → just system prompt + trailing separator", () => {
    const out = renderStdinPayload(
      newRequest({ systemPrompt: "system text", history: [] }),
    );
    expect(out).toBe("system text\n\n");
  });

  test("empty system + empty history → empty stdin (no leading newlines)", () => {
    expect(
      renderStdinPayload(
        newRequest({ systemPrompt: "", history: [] }),
      ),
    ).toBe("");
  });

  test("user message is NOT in stdin payload (delivered via -p)", () => {
    const out = renderStdinPayload(
      newRequest({ systemPrompt: "sys", userMessage: "should not appear" }),
    );
    expect(out).not.toContain("should not appear");
  });
});

// ---------------------------------------------------------------------------
// parseGeminiEvent — pure mapper from stream-json to HarnessChunk
// ---------------------------------------------------------------------------

describe("parseGeminiEvent", () => {
  test("assistant message → text chunk", () => {
    expect(
      parseGeminiEvent({
        type: "message",
        role: "assistant",
        content: "hello",
        delta: true,
      }),
    ).toEqual({ type: "text", text: "hello" });
  });

  test("user-echo message → undefined (no signal)", () => {
    expect(
      parseGeminiEvent({
        type: "message",
        role: "user",
        content: "the prompt",
      }),
    ).toBeUndefined();
  });

  test("tool_use → progress chunk with tool name in note", () => {
    expect(
      parseGeminiEvent({
        type: "tool_use",
        tool_name: "run_shell_command",
        tool_id: "x",
        parameters: {},
      }),
    ).toEqual({ type: "progress", note: "tool: run_shell_command" });
  });

  test("tool_use without tool_name → progress with placeholder", () => {
    const c = parseGeminiEvent({ type: "tool_use" });
    expect(c?.type).toBe("progress");
  });

  test("tool_result → heartbeat", () => {
    expect(
      parseGeminiEvent({
        type: "tool_result",
        tool_id: "x",
        status: "success",
      }),
    ).toEqual({ type: "heartbeat" });
  });

  test("result → done with stats meta", () => {
    const c = parseGeminiEvent({
      type: "result",
      status: "success",
      stats: { total_tokens: 100, duration_ms: 500 },
    });
    expect(c?.type).toBe("done");
    if (c?.type !== "done") return;
    expect(c.finalText).toBe("");
    expect(c.meta?.stats).toEqual({ total_tokens: 100, duration_ms: 500 });
  });

  test("init → undefined (session-start chatter)", () => {
    expect(
      parseGeminiEvent({ type: "init", session_id: "x", model: "y" }),
    ).toBeUndefined();
  });

  test("malformed input → undefined", () => {
    expect(parseGeminiEvent(null)).toBeUndefined();
    expect(parseGeminiEvent("string")).toBeUndefined();
    expect(parseGeminiEvent({})).toBeUndefined();
    expect(parseGeminiEvent({ type: 42 })).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// End-to-end via the fake-gemini fixture
// ---------------------------------------------------------------------------

describe("GeminiHarness.invoke (end-to-end via fake-gemini.sh)", () => {
  function harness(env: Record<string, string> = {}): GeminiHarness {
    // Inject env via a per-test process.env mutation; the harness
    // passes process.env to Bun.spawn, so this lands.
    Object.assign(process.env, env);
    return new GeminiHarness({ bin: FAKE_GEMINI, model: "" });
  }

  test("normal: stream-json events parsed; stdin + -p both reach the model; exit 0 → text + heartbeat + progress + done", async () => {
    process.env.FAKE_GEMINI_MODE = "normal";
    const chunks = await collect(
      harness().invoke(
        newRequest({
          systemPrompt: "system",
          history: [
            { role: "user", text: "prev" },
            { role: "assistant", text: "ok" },
          ],
          userMessage: "the new question",
        }),
      ),
    );
    delete process.env.FAKE_GEMINI_MODE;

    // The fake's tool_use → progress chunk; tool_result → heartbeat;
    // assistant deltas → text chunks (concatenated by the harness loop).
    const progressChunks = chunks.filter((c) => c.type === "progress");
    expect(progressChunks.length).toBe(1);
    if (progressChunks[0]?.type === "progress") {
      expect(progressChunks[0].note).toBe("tool: echo");
    }

    const heartbeats = chunks.filter((c) => c.type === "heartbeat");
    expect(heartbeats.length).toBeGreaterThanOrEqual(1);

    const textChunks = chunks.filter(
      (c): c is { type: "text"; text: string } => c.type === "text",
    );
    const fullText = textChunks.map((c) => c.text).join("");
    expect(fullText).toContain("prompt=the new question");
    expect(fullText).toContain("Assistant: ok"); // last stdin line

    // Final done carries the concatenated text and the result-event stats.
    const done = chunks.find((c) => c.type === "done");
    expect(done).toBeDefined();
    if (done?.type !== "done") return;
    expect(done.finalText).toBe(fullText);
    expect(done.meta?.harnessId).toBe("gemini");
    expect(done.meta?.stats).toMatchObject({ total_tokens: 42 });
  });

  test("error: non-zero exit → recoverable error chunk; no done", async () => {
    process.env.FAKE_GEMINI_MODE = "error";
    const chunks = await collect(harness().invoke(newRequest()));
    delete process.env.FAKE_GEMINI_MODE;
    expect(chunks.find((c) => c.type === "done")).toBeUndefined();
    const err = chunks.find((c) => c.type === "error");
    expect(err).toBeDefined();
    if (err?.type !== "error") return;
    expect(err.error).toContain("exited with code 1");
    expect(err.recoverable).toBe(true);
  });

  test("notfound (exit 127) → error chunk with recoverable=false", async () => {
    process.env.FAKE_GEMINI_MODE = "notfound";
    const chunks = await collect(harness().invoke(newRequest()));
    delete process.env.FAKE_GEMINI_MODE;
    const err = chunks.find((c) => c.type === "error");
    expect(err).toBeDefined();
    if (err?.type !== "error") return;
    expect(err.recoverable).toBe(false);
  });

  test("hang + low timeout → SIGTERM kill, recoverable timeout error", async () => {
    process.env.FAKE_GEMINI_MODE = "hang";
    const chunks = await collect(
      harness().invoke(newRequest({ idleTimeoutMs: 100, hardTimeoutMs: 100 })),
    );
    delete process.env.FAKE_GEMINI_MODE;
    expect(chunks.find((c) => c.type === "done")).toBeUndefined();
    const err = chunks.find((c) => c.type === "error");
    expect(err).toBeDefined();
    if (err?.type !== "error") return;
    expect(err.error).toContain("timed out");
    expect(err.recoverable).toBe(true);
  });

  test("ARG_MAX guard: oversized userMessage → recoverable error, no spawn", async () => {
    // Set the fixture to "hang" so if we DID spawn, the test would
    // hit the timeout instead of returning quickly. The precheck
    // should fire BEFORE spawn, so we expect the recoverable error
    // immediately — well under the 5s default timeout.
    process.env.FAKE_GEMINI_MODE = "hang";
    const big = "x".repeat(1_000_001); // 1 byte over the 1 MiB-ish ceiling
    const start = Date.now();
    const chunks = await collect(
      new GeminiHarness({ bin: FAKE_GEMINI, model: "" }).invoke(
        newRequest({ userMessage: big, idleTimeoutMs: 30_000, hardTimeoutMs: 30_000 }),
      ),
    );
    const elapsed = Date.now() - start;
    delete process.env.FAKE_GEMINI_MODE;
    // Fired before spawn — should be near-instant, not anywhere near 30s.
    expect(elapsed).toBeLessThan(500);
    expect(chunks.find((c) => c.type === "done")).toBeUndefined();
    const err = chunks.find((c) => c.type === "error");
    expect(err).toBeDefined();
    if (err?.type !== "error") return;
    expect(err.error).toContain("ARG_MAX");
    expect(err.error).toContain("1000001");
    expect(err.recoverable).toBe(true);
  });

  test("argv shape: -p <user> -o stream-json -y; -m only when model is non-empty", async () => {
    process.env.FAKE_GEMINI_MODE = "echo-args";
    // No model.
    const noModel = await collect(
      new GeminiHarness({ bin: FAKE_GEMINI, model: "" }).invoke(
        newRequest({ userMessage: "the message" }),
      ),
    );
    const text1 = noModel.find((c) => c.type === "text");
    expect(text1?.type).toBe("text");
    if (text1?.type !== "text") return;
    expect(text1.text).toContain("-p");
    expect(text1.text).toContain("the message");
    expect(text1.text).toContain("-o");
    expect(text1.text).toContain("stream-json");
    expect(text1.text).toContain("-y");
    expect(text1.text).not.toContain("-m");

    // With model.
    const withModel = await collect(
      new GeminiHarness({
        bin: FAKE_GEMINI,
        model: "gemini-2.5-pro",
      }).invoke(newRequest({ userMessage: "x" })),
    );
    const text2 = withModel.find((c) => c.type === "text");
    if (text2?.type !== "text") {
      throw new Error("expected text chunk");
    }
    expect(text2.text).toContain("-m");
    expect(text2.text).toContain("gemini-2.5-pro");
    delete process.env.FAKE_GEMINI_MODE;
  });
});

// ---------------------------------------------------------------------------
// available()
// ---------------------------------------------------------------------------

describe("GeminiHarness.available", () => {
  test("absolute path that doesn't exist → false", async () => {
    const h = new GeminiHarness({ bin: "/no/such/gemini", model: "" });
    expect(await h.available()).toBe(false);
  });

  test("absolute path that does exist + is executable → true", async () => {
    const h = new GeminiHarness({ bin: FAKE_GEMINI, model: "" });
    expect(await h.available()).toBe(true);
  });

  test("bare bin name (PATH lookup) → reported as available (cheap; spawn handles real failure)", async () => {
    const h = new GeminiHarness({ bin: "definitely-not-on-path-9999", model: "" });
    // Same lenient behavior as PiHarness — we don't $PATH-walk; the spawn
    // surfaces the real ENOENT and the orchestrator falls through.
    expect(await h.available()).toBe(true);
  });
});
