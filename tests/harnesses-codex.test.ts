import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmod } from "node:fs/promises";
import { resolve } from "node:path";
import {
  CodexHarness,
  parseCodexEvent,
  PHANTOMBOT_INJECTED_CODEX_FLAGS,
  renderStdinPayload,
} from "../src/harnesses/codex.ts";
import type { HarnessChunk, HarnessRequest } from "../src/harnesses/types.ts";

const FAKE_CODEX = resolve(__dirname, "fixtures/fake-codex.sh");

function newRequest(overrides: Partial<HarnessRequest> = {}): HarnessRequest {
  return {
    systemPrompt: "you are codex",
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

beforeEach(async () => {
  await chmod(FAKE_CODEX, 0o755);
});

afterEach(() => {
  delete process.env.FAKE_CODEX_MODE;
});

describe("renderStdinPayload (Codex)", () => {
  test("includes system prompt and wraps assistant history", () => {
    const out = renderStdinPayload(newRequest({
      history: [
        { role: "user", text: "q1" },
        { role: "assistant", text: "a1" },
      ],
      userMessage: "q2",
    }));
    expect(out).toContain("you are codex");
    expect(out).toContain("q1");
    expect(out).toContain("<previous_response>\na1\n</previous_response>");
    expect(out).toContain("q2");
  });
});

describe("parseCodexEvent", () => {
  test("agent_message -> text", () => {
    expect(parseCodexEvent({
      type: "item.completed",
      item: { type: "agent_message", text: "hello" },
    })).toEqual({ type: "text", text: "hello" });
  });

  test("turn.started -> heartbeat", () => {
    expect(parseCodexEvent({ type: "turn.started" })).toEqual({ type: "heartbeat" });
  });

  test("turn.completed -> done-shaped stats carrier", () => {
    const c = parseCodexEvent({ type: "turn.completed", usage: { output_tokens: 2 } });
    expect(c?.type).toBe("done");
  });
});

describe("CodexHarness.invoke", () => {
  const mkHarness = (model = "") => new CodexHarness({ bin: FAKE_CODEX, model });

  test("normal: emits text then done", async () => {
    process.env.FAKE_CODEX_MODE = "normal";
    const chunks = await collect(mkHarness("gpt-5.3-codex").invoke(newRequest()));
    const done = chunks.find((c) => c.type === "done");
    expect(chunks.some((c) => c.type === "text")).toBe(true);
    expect(done).toBeDefined();
    if (done?.type !== "done") return;
    expect(done.finalText).toContain("hello codex");
    expect(done.meta?.harnessId).toBe("codex");
  });

  test("non-zero exit -> recoverable error", async () => {
    process.env.FAKE_CODEX_MODE = "error";
    const chunks = await collect(mkHarness().invoke(newRequest()));
    const err = chunks.find((c) => c.type === "error");
    expect(err).toBeDefined();
    if (err?.type !== "error") return;
    expect(err.recoverable).toBe(true);
  });

  test("exit 127 -> terminal error", async () => {
    process.env.FAKE_CODEX_MODE = "notfound";
    const chunks = await collect(mkHarness().invoke(newRequest()));
    const err = chunks.find((c) => c.type === "error");
    if (err?.type !== "error") throw new Error("expected error chunk");
    expect(err.recoverable).toBe(false);
  });

  test("timeout path emits error and no done", async () => {
    process.env.FAKE_CODEX_MODE = "hang";
    const chunks = await collect(
      mkHarness().invoke(newRequest({ idleTimeoutMs: 100, hardTimeoutMs: 100 })),
    );
    expect(chunks.find((c) => c.type === "done")).toBeUndefined();
    const err = chunks.find((c) => c.type === "error");
    if (err?.type !== "error") throw new Error("expected error chunk");
    expect(err.error).toContain("timed out");
  });

  test("argv includes injected memory override flags", async () => {
    process.env.FAKE_CODEX_MODE = "argv";
    const chunks = await collect(mkHarness("gpt-5.3-codex").invoke(newRequest()));
    const text = chunks
      .filter((c): c is Extract<HarnessChunk, { type: "text" }> => c.type === "text")
      .map((c) => c.text)
      .join(" ");
    for (const flag of PHANTOMBOT_INJECTED_CODEX_FLAGS) {
      expect(text).toContain(flag);
    }
    expect(text).toContain("-m gpt-5.3-codex");
  });
});
