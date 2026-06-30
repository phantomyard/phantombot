/**
 * Tests for the Pi harness. Mirrors tests/harnesses-claude.test.ts:
 *   - Pure-function tests for renderPayload / parsePiEvent
 *   - End-to-end via tests/fixtures/fake-pi.sh — verifies Bun.spawn
 *     wiring, stream-json translation, exit-code handling, timeout fix.
 *   - One ARG_MAX guard test (synthetic — confirms the precheck fires).
 */

import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { resolve } from "node:path";
import {
  PiHarness,
  parsePiEvent,
  piActivity,
  renderPayload,
} from "../src/harnesses/pi.ts";
import * as envBootstrap from "../src/lib/envBootstrap.ts";
import type { HarnessChunk, HarnessRequest } from "../src/harnesses/types.ts";

const FAKE_PI = resolve(__dirname, "fixtures/fake-pi.sh");

function newRequest(overrides: Partial<HarnessRequest> = {}): HarnessRequest {
  return {
    systemPrompt: "you are pi",
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
  test("extracts text_delta from message_update.assistantMessageEvent.delta", () => {
    const c = parsePiEvent({
      type: "message_update",
      assistantMessageEvent: {
        type: "text_delta",
        contentIndex: 1,
        delta: "hi",
        partial: {},
      },
      message: {},
    });
    expect(c).toEqual({ type: "text", text: "hi" });
  });

  test("emits heartbeat for thinking_delta (and does NOT leak the chain-of-thought content)", () => {
    const c = parsePiEvent({
      type: "message_update",
      assistantMessageEvent: {
        type: "thinking_delta",
        contentIndex: 0,
        delta: "internal reasoning",
        partial: {},
      },
      message: {},
    });
    expect(c).toEqual({ type: "heartbeat" });
    // The reasoning content MUST NOT appear in the chunk.
    expect(JSON.stringify(c)).not.toContain("internal reasoning");
  });

  test("emits progress for tool_execution_start (pi 0.79.x toolName field)", () => {
    const c = parsePiEvent({
      type: "tool_execution_start",
      toolName: "bash",
    });
    expect(c).toEqual({ type: "progress", note: "tool: bash" });
  });

  test("tool_execution_start surfaces args in the note when present (#218)", () => {
    const c = parsePiEvent({
      type: "tool_execution_start",
      toolName: "bash",
      args: { command: "npm test" },
    });
    expect(c).toEqual({ type: "progress", note: "bash: npm test" });
  });

  test("emits progress for tool_execution_start (legacy 0.67.x tool_name field)", () => {
    const c = parsePiEvent({
      type: "tool_execution_start",
      tool_name: "run_shell_command",
    });
    expect(c).toEqual({ type: "progress", note: "tool: run_shell_command" });
  });

  test("emits progress for tool_execution_start without a tool name", () => {
    const c = parsePiEvent({ type: "tool_execution_start" });
    expect(c).toEqual({ type: "progress", note: "tool" });
  });

  test("emits a payload-less heartbeat for tool_execution_update (coder liveness)", () => {
    // The coder delegate forwards its child's progress via pi's onUpdate, which
    // surfaces as tool_execution_update. We keep the primary alive without
    // leaking the partialResult into a bubble.
    const c = parsePiEvent({
      type: "tool_execution_update",
      toolName: "coder",
      toolCallId: "abc",
      args: {},
      partialResult: { content: [{ type: "text", text: "coder: working…" }] },
    });
    expect(c).toEqual({ type: "heartbeat" });
  });

  test("emits heartbeat for anonymous toolcall_* / tool_use_* assistantMessageEvent noise", () => {
    for (const ameType of [
      // pi 0.79.x names
      "toolcall_start",
      "toolcall_delta",
      "toolcall_end",
      // legacy 0.67.x names (still accepted)
      "tool_use_start",
      "tool_use_end",
      "tool_use",
    ]) {
      expect(
        parsePiEvent({
          type: "message_update",
          assistantMessageEvent: { type: ameType, contentIndex: 0 },
          message: {},
        }),
      ).toEqual({ type: "heartbeat" });
    }
  });

  test("emits progress for named assistantMessageEvent tool calls", () => {
    const c = parsePiEvent({
      type: "message_update",
      assistantMessageEvent: {
        type: "toolcall_start",
        contentIndex: 0,
        toolName: "bash",
        args: { command: "npm test" },
      },
      message: {},
    });
    expect(c).toEqual({ type: "progress", note: "bash: npm test" });
  });

  test("emits progress for assistantMessageEvent tool calls with useful args but no name", () => {
    const c = parsePiEvent({
      type: "message_update",
      assistantMessageEvent: {
        type: "toolcall_delta",
        contentIndex: 0,
        partial: { input: { file_path: "/tmp/example.txt" } },
      },
      message: {},
    });
    expect(c).toEqual({ type: "progress", note: "tool: /tmp/example.txt" });
  });

  test("emits heartbeat for text_start / text_end / thinking_start / thinking_end markers", () => {
    for (const ameType of [
      "text_start",
      "text_end",
      "thinking_start",
      "thinking_end",
    ]) {
      expect(
        parsePiEvent({
          type: "message_update",
          assistantMessageEvent: { type: ameType, contentIndex: 0 },
          message: {},
        }),
      ).toEqual({ type: "heartbeat" });
    }
  });

  test("ignores session / agent_start / turn_start / turn_end / agent_end / message_start / message_end", () => {
    for (const t of [
      "session",
      "agent_start",
      "turn_start",
      "turn_end",
      "agent_end",
      "message_start",
      "message_end",
    ]) {
      expect(parsePiEvent({ type: t })).toBeUndefined();
    }
  });

  test("ignores empty text_delta", () => {
    expect(
      parsePiEvent({
        type: "message_update",
        assistantMessageEvent: {
          type: "text_delta",
          contentIndex: 1,
          delta: "",
          partial: {},
        },
        message: {},
      }),
    ).toBeUndefined();
  });

  test("returns undefined for malformed input", () => {
    expect(parsePiEvent(null)).toBeUndefined();
    expect(parsePiEvent("string")).toBeUndefined();
    expect(parsePiEvent({})).toBeUndefined();
    expect(parsePiEvent({ type: 42 })).toBeUndefined();
    // message_update with no assistantMessageEvent
    expect(parsePiEvent({ type: "message_update" })).toBeUndefined();
  });
});

describe("piActivity — idle-watchdog classification", () => {
  test("tool_execution_update counts as in-tool activity (resets the idle timer)", () => {
    // Crux of 'keep the primary fed': the heartbeat chunk would otherwise be
    // classified 'model', which does NOT reset the timer once a tool is running.
    // Forcing 'tool' is what lets a long-but-working coder stay alive.
    const parsed = { type: "tool_execution_update", toolName: "coder" };
    const chunk = parsePiEvent(parsed)!;
    expect(chunk).toEqual({ type: "heartbeat" });
    expect(piActivity(parsed, chunk)).toBe("tool");
  });

  test("tool_execution_start is in-tool activity", () => {
    const parsed = { type: "tool_execution_start", toolName: "coder" };
    expect(piActivity(parsed, parsePiEvent(parsed)!)).toBe("tool");
  });

  test("a plain thinking heartbeat stays 'model' (must NOT reset a running tool)", () => {
    const parsed = {
      type: "message_update",
      assistantMessageEvent: { type: "thinking_delta", contentIndex: 0 },
      message: {},
    };
    expect(piActivity(parsed, { type: "heartbeat" })).toBe("model");
  });

  test("text output is productive", () => {
    expect(piActivity({ type: "message_update" }, { type: "text", text: "hi" })).toBe(
      "productive",
    );
  });
});

// ---------------------------------------------------------------------------
// End-to-end via fake-pi.sh
// ---------------------------------------------------------------------------

let originalMode: string | undefined;

// Hermetic env-file isolation. PiHarness.invoke() calls reloadEnvFiles(), which
// re-sources ~/.env and $XDG_CONFIG_HOME/phantombot/.env into process.env. On
// any machine that ACTUALLY has Pi configured (a dev box, or Lena), those files
// carry a real PHANTOMBOT_PI_API_KEY / PHANTOMBOT_PI_PROVIDER — which the reload
// would silently re-inject, undoing the `delete process.env...` these tests rely
// on and breaking the "no key → no --api-key flag" / "clears stale provider"
// assertions off the test author's machine. Redirecting env vars can't fix the
// `~/.env` arm because Bun caches os.homedir() at startup. So stub the reload to
// a no-op: these tests assert argv / child-env construction against process.env,
// NOT the reconcile behavior (lib-envBootstrap.test.ts covers that with injected
// paths). The spy makes every invoke read exactly the process.env the test set.
let reloadSpy: ReturnType<typeof spyOn> | undefined;

beforeEach(() => {
  originalMode = process.env.FAKE_PI_MODE;
  reloadSpy = spyOn(envBootstrap, "reloadEnvFiles").mockResolvedValue({
    updated: [],
    removed: [],
  });
});

afterEach(() => {
  if (originalMode === undefined) delete process.env.FAKE_PI_MODE;
  else process.env.FAKE_PI_MODE = originalMode;
  reloadSpy?.mockRestore();
});

const mkHarness = (overrides: Partial<{ maxPayloadBytes: number }> = {}) =>
  new PiHarness({
    bin: FAKE_PI,
    maxPayloadBytes: overrides.maxPayloadBytes ?? 1_500_000,
  });

describe("PiHarness.invoke (subprocess)", () => {
  test("normal exit: text chunks (thinking ignored) + done with finalText", async () => {
    process.env.FAKE_PI_MODE = "normal";
    const chunks = await collect(mkHarness().invoke(newRequest()));
    const texts = chunks.filter((c) => c.type === "text");
    const dones = chunks.filter((c) => c.type === "done");
    expect(texts.map((c) => (c as { text: string }).text)).toEqual([
      "hello ",
      "world",
    ]);
    expect(dones).toHaveLength(1);
    expect(dones[0]).toMatchObject({
      type: "done",
      finalText: "hello world",
      meta: { harnessId: "pi" },
    });
  });

  test("toolsMode 'none' passes pi's native --no-tools (true zero-tools)", async () => {
    process.env.FAKE_PI_MODE = "argv";
    const chunks = await collect(mkHarness().invoke(newRequest({ toolsMode: "none" })));
    const argv = chunks
      .filter((c) => c.type === "text")
      .map((c) => (c as { text: string }).text)
      .join("");
    expect(argv).toContain("--no-tools");
  });

  test("a normal turn (no toolsMode) does NOT pass --no-tools", async () => {
    process.env.FAKE_PI_MODE = "argv";
    const chunks = await collect(mkHarness().invoke(newRequest()));
    const argv = chunks
      .filter((c) => c.type === "text")
      .map((c) => (c as { text: string }).text)
      .join("");
    expect(argv).not.toContain("--no-tools");
  });

  test("pre-prompting trim flags ride along on every turn", async () => {
    process.env.FAKE_PI_MODE = "argv";
    const chunks = await collect(mkHarness().invoke(newRequest()));
    const argv = chunks
      .filter((c) => c.type === "text")
      .map((c) => (c as { text: string }).text)
      .join("");
    // Startup network ops off (telemetry/update checks) — model call unaffected.
    expect(argv).toContain("--offline");
    // Ephemeral: phantombot owns conversation state.
    expect(argv).toContain("--no-session");
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
      mkHarness().invoke(newRequest({ idleTimeoutMs: 200, hardTimeoutMs: 200 })),
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

// ---------------------------------------------------------------------------
// Capability routing — argv pinning only. Delegate models no longer travel via
// the child env; they reach the extension through the managed routing.json
// (lib/piExtensionProvision.ts), so the spawned Pi env must NOT carry them.
// ---------------------------------------------------------------------------

describe("PiHarness routing (subprocess)", () => {
  const routed = (routing: {
    provider?: string;
    primaryModel?: string;
    imageModel?: string;
    codingModel?: string;
  }) => new PiHarness({ bin: FAKE_PI, maxPayloadBytes: 1_500_000, routing });

  test("routing.primaryModel pins the orchestrator via --model", async () => {
    process.env.FAKE_PI_MODE = "argv";
    const chunks = await collect(routed({ primaryModel: "gpt-5.2" }).invoke(newRequest()));
    const argv = chunks
      .filter((c) => c.type === "text")
      .map((c) => (c as { text: string }).text)
      .join("");
    expect(argv).toContain("--model gpt-5.2");
  });

  test("routing.provider is threaded onto --provider (OpenRouter routes to openrouter, NOT google)", async () => {
    process.env.FAKE_PI_MODE = "argv";
    const chunks = await collect(
      routed({ provider: "openrouter", primaryModel: "z-ai/glm-5.2" }).invoke(
        newRequest(),
      ),
    );
    const argv = chunks
      .filter((c) => c.type === "text")
      .map((c) => (c as { text: string }).text)
      .join("");
    // The whole point: without --provider, Pi defaults to google and an
    // OpenRouter key fails. The provider must be pinned explicitly.
    expect(argv).toContain("--provider openrouter");
    expect(argv).not.toContain("--provider google");
    expect(argv).toContain("--model z-ai/glm-5.2");
  });

  test("no provider → no --provider flag (Pi uses its own default)", async () => {
    process.env.FAKE_PI_MODE = "argv";
    const chunks = await collect(routed({ primaryModel: "gpt-5.2" }).invoke(newRequest()));
    const argv = chunks
      .filter((c) => c.type === "text")
      .map((c) => (c as { text: string }).text)
      .join("");
    expect(argv).not.toContain("--provider");
  });

  test("provider is threaded even after a coding-brain swap (one provider covers all models)", async () => {
    process.env.FAKE_PI_MODE = "argv";
    // A coding-triggering message should swap primary → coding model, but the
    // single --provider must still apply (both models share the provider).
    const chunks = await collect(
      routed({
        provider: "openrouter",
        primaryModel: "mimo-v2.5",
        codingModel: "z-ai/glm-5.2",
      }).invoke(
        newRequest({
          userMessage: "review this pull request https://github.com/x/y/pull/1",
        }),
      ),
    );
    const argv = chunks
      .filter((c) => c.type === "text")
      .map((c) => (c as { text: string }).text)
      .join("");
    expect(argv).toContain("--provider openrouter");
    expect(argv).toContain("--model z-ai/glm-5.2");
  });

  test("no routing → no --model flag", async () => {
    process.env.FAKE_PI_MODE = "argv";
    const chunks = await collect(mkHarness().invoke(newRequest()));
    const argv = chunks
      .filter((c) => c.type === "text")
      .map((c) => (c as { text: string }).text)
      .join("");
    expect(argv).not.toContain("--model");
  });

  test("delegate models are NOT projected into the spawned Pi env", async () => {
    process.env.FAKE_PI_MODE = "env";
    // Make sure nothing in the ambient env spoofs the assertion.
    delete process.env.PHANTOMBOT_IMAGE_MODEL;
    delete process.env.PHANTOMBOT_CODING_MODEL;
    const chunks = await collect(
      routed({
        primaryModel: "gpt-5.2",
        imageModel: "vision-x",
        codingModel: "qwen-coder",
      }).invoke(newRequest()),
    );
    const out = chunks
      .filter((c) => c.type === "text")
      .map((c) => (c as { text: string }).text)
      .join("");
    // Routing models reach the extension via the managed routing.json, not the
    // child env, so the spawned process must not see them as env vars.
    expect(out).not.toContain("image=vision-x");
    expect(out).not.toContain("coding=qwen-coder");
    expect(out).not.toContain("PHANTOMBOT_IMAGE_MODEL=vision-x");
    expect(out).not.toContain("PHANTOMBOT_CODING_MODEL=qwen-coder");
  });

  test("the active harness's provider + api-key ARE projected into the child env (for the extension's delegates)", async () => {
    // The capability-routing extension runs INSIDE this spawned pi and threads
    // the pair onto its OWN delegate children. It reads them from this env, so
    // the harness must project ITS provider/key here — scoped to this harness,
    // not a shared ambient var — so a primary-Pi→OpenRouter / fallback-Pi→OpenAI
    // box never collides two providers in one namespace.
    process.env.FAKE_PI_MODE = "env";
    process.env.PHANTOMBOT_PI_API_KEY = "sk-openrouter-key";
    try {
      const out = (
        await collect(
          routed({ provider: "openrouter", primaryModel: "z-ai/glm-5.2" }).invoke(
            newRequest(),
          ),
        )
      )
        .filter((c) => c.type === "text")
        .map((c) => (c as { text: string }).text)
        .join("");
      expect(out).toContain("provider=openrouter");
      expect(out).toContain("apikey=sk-openrouter-key");
    } finally {
      delete process.env.PHANTOMBOT_PI_API_KEY;
    }
  });

  test("no provider/key → the child env actively CLEARS the pair (no stale ambient leak)", async () => {
    process.env.FAKE_PI_MODE = "env";
    // Spoof a stale ambient value: the harness must overwrite it to empty, not
    // leak it into a subtree that didn't configure a provider.
    process.env.PHANTOMBOT_PI_PROVIDER = "stale-google";
    delete process.env.PHANTOMBOT_PI_API_KEY;
    try {
      const out = (await collect(routed({ primaryModel: "gpt-5.2" }).invoke(newRequest())))
        .filter((c) => c.type === "text")
        .map((c) => (c as { text: string }).text)
        .join("");
      expect(out).toContain("provider= ");
      expect(out).not.toContain("provider=stale-google");
    } finally {
      delete process.env.PHANTOMBOT_PI_PROVIDER;
    }
  });

  test("PHANTOMBOT_PI_API_KEY is threaded onto --api-key per turn", async () => {
    process.env.FAKE_PI_MODE = "argv";
    process.env.PHANTOMBOT_PI_API_KEY = "sk-test-key";
    try {
      const chunks = await collect(mkHarness().invoke(newRequest()));
      const argv = chunks
        .filter((c) => c.type === "text")
        .map((c) => (c as { text: string }).text)
        .join("");
      expect(argv).toContain("--api-key sk-test-key");
    } finally {
      delete process.env.PHANTOMBOT_PI_API_KEY;
    }
  });

  test("no PHANTOMBOT_PI_API_KEY → no --api-key flag (Pi falls back to its own store)", async () => {
    process.env.FAKE_PI_MODE = "argv";
    delete process.env.PHANTOMBOT_PI_API_KEY;
    const chunks = await collect(mkHarness().invoke(newRequest()));
    const argv = chunks
      .filter((c) => c.type === "text")
      .map((c) => (c as { text: string }).text)
      .join("");
    expect(argv).not.toContain("--api-key");
  });

  test("invoke re-sources env files each turn (reloadEnvFiles is called)", async () => {
    // The reload is stubbed for hermeticity (see top-of-file note), so lock in
    // the guarantee it stands for: phantombot re-sources ~/.env per turn so a
    // secret saved last turn (`phantombot env set`) is visible without a daemon
    // restart. If a refactor ever drops the call, this fails instead of silently
    // regressing behind the stub.
    process.env.FAKE_PI_MODE = "argv";
    await collect(mkHarness().invoke(newRequest()));
    expect(reloadSpy).toHaveBeenCalled();
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
