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

  test("item.started tool -> progress (now captures the tool name; #218)", () => {
    expect(parseCodexEvent({
      type: "item.started",
      item: { type: "tool_call", name: "shell" },
    })).toEqual({
      type: "progress",
      note: "tool: shell",
      tool: { title: "tool: shell", kind: "execute", locations: [] },
    });
  });

  test("item.started tool with a command surfaces it in the title (#218)", () => {
    expect(parseCodexEvent({
      type: "item.started",
      item: { type: "tool_call", name: "shell", command: ["git", "status"] },
    })).toEqual({
      type: "progress",
      note: "shell: git status",
      tool: { title: "shell: git status", kind: "execute", locations: [] },
    });
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

  test("toolsMode 'none' uses --sandbox read-only, NOT the YOLO bypass", async () => {
    process.env.FAKE_CODEX_MODE = "argv";
    const chunks = await collect(mkHarness().invoke(newRequest({ toolsMode: "none" })));
    const argv = chunks
      .filter((c) => c.type === "text")
      .map((c) => (c as { text: string }).text)
      .join("");
    expect(argv).toContain("--sandbox");
    expect(argv).toContain("read-only");
    expect(argv).not.toContain("--dangerously-bypass-approvals-and-sandbox");
  });

  test("a normal turn uses the YOLO bypass, NOT read-only", async () => {
    process.env.FAKE_CODEX_MODE = "argv";
    const chunks = await collect(mkHarness().invoke(newRequest()));
    const argv = chunks
      .filter((c) => c.type === "text")
      .map((c) => (c as { text: string }).text)
      .join("");
    expect(argv).toContain("--dangerously-bypass-approvals-and-sandbox");
    expect(argv).not.toContain("read-only");
  });

  test("a normal turn LOADS user config (no --ignore-user-config) so MCP connectors work, but keeps --ignore-rules", async () => {
    process.env.FAKE_CODEX_MODE = "argv";
    const chunks = await collect(mkHarness().invoke(newRequest()));
    const argv = chunks
      .filter((c) => c.type === "text")
      .map((c) => (c as { text: string }).text)
      .join("");
    // Workspace connectors live in ~/.codex/config.toml — must NOT be skipped.
    expect(argv).not.toContain("--ignore-user-config");
    // Persona stays authoritative: local rules/memory still ignored.
    expect(argv).toContain("--ignore-rules");
  });

  test("the tool-less judge stays fully isolated (--ignore-user-config)", async () => {
    process.env.FAKE_CODEX_MODE = "argv";
    const chunks = await collect(mkHarness().invoke(newRequest({ toolsMode: "none" })));
    const argv = chunks
      .filter((c) => c.type === "text")
      .map((c) => (c as { text: string }).text)
      .join("");
    expect(argv).toContain("--ignore-user-config");
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

  test("model heartbeats reset idle -> completes", async () => {
    process.env.FAKE_CODEX_MODE = "heartbeats";
    const chunks = await collect(
      mkHarness().invoke(
        newRequest({ idleTimeoutMs: 800, hardTimeoutMs: 10_000 }),
      ),
    );
    expect(chunks.some((c) => c.type === "heartbeat")).toBe(true);
    expect(chunks.some((c) => c.type === "error")).toBe(false);
    const done = chunks.find((c) => c.type === "done");
    if (done?.type !== "done") throw new Error("expected done chunk");
    expect(done.finalText).toContain("late finish");
  });

  // Regression for #123: after a tool has started, generic heartbeat noise
  // must NOT keep a stuck turn alive forever. The fixture emits heartbeats
  // spaced under the idle window after the tool-start signal; the harness must
  // idle-kill before the late agent_message lands.
  test("tool-phase heartbeats do not reset idle -> idle-killed before finish", async () => {
    process.env.FAKE_CODEX_MODE = "tool-heartbeats";
    const chunks = await collect(
      mkHarness().invoke(
        newRequest({ idleTimeoutMs: 800, hardTimeoutMs: 10_000 }),
      ),
    );
    expect(chunks.some((c) => c.type === "heartbeat")).toBe(true);
    expect(chunks.some((c) => c.type === "progress")).toBe(true);
    expect(chunks.some((c) => c.type === "done")).toBe(false);
    expect(
      chunks.some((c) => c.type === "text" && c.text.includes("late finish")),
    ).toBe(false);
    const err = chunks.find((c) => c.type === "error");
    if (err?.type !== "error") throw new Error("expected idle error chunk");
    expect(err.error).toContain("no output");
    expect(err.recoverable).toBe(true);
  });

  // Counterpart to the heartbeat test: productive text spaced under the idle
  // window must keep resetting the timer, so a turn that streams steadily for
  // longer than idleTimeoutMs still completes cleanly rather than idle-dying.
  test("steady productive output keeps resetting idle -> completes", async () => {
    process.env.FAKE_CODEX_MODE = "productive";
    const chunks = await collect(
      mkHarness().invoke(
        newRequest({ idleTimeoutMs: 800, hardTimeoutMs: 10_000 }),
      ),
    );
    expect(chunks.some((c) => c.type === "error")).toBe(false);
    const done = chunks.find((c) => c.type === "done");
    if (done?.type !== "done") throw new Error("expected done chunk");
    expect(done.finalText).toContain("chunk1");
    expect(done.finalText).toContain("chunk6");
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
