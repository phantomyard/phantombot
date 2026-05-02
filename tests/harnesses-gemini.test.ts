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
// End-to-end via the fake-gemini fixture
// ---------------------------------------------------------------------------

describe("GeminiHarness.invoke (end-to-end via fake-gemini.sh)", () => {
  function harness(env: Record<string, string> = {}): GeminiHarness {
    // Inject env via a per-test process.env mutation; the harness
    // passes process.env to Bun.spawn, so this lands.
    Object.assign(process.env, env);
    return new GeminiHarness({ bin: FAKE_GEMINI, model: "" });
  }

  test("normal: stdin received, -p value used as prompt, exit 0 → text + done", async () => {
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
    // text chunk includes both stdin (last line) and the -p value
    const textChunk = chunks.find((c) => c.type === "text");
    expect(textChunk).toBeDefined();
    if (textChunk?.type !== "text") return;
    expect(textChunk.text).toContain("prompt=the new question");
    expect(textChunk.text).toContain("Assistant: ok"); // last stdin line
    // done chunk follows
    const done = chunks.find((c) => c.type === "done");
    expect(done).toBeDefined();
    if (done?.type !== "done") return;
    expect(done.finalText).toBe(textChunk.text);
    expect(done.meta?.harnessId).toBe("gemini");
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

  test("argv shape: -p <user> -o text -y; -m only when model is non-empty", async () => {
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
    expect(text1.text).toContain("text");
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
