/**
 * Tests for the Pi harness. Mirrors tests/harnesses-claude.test.ts:
 *   - Pure-function tests for renderPayload / parsePiEvent
 *   - End-to-end via tests/fixtures/fake-pi.sh — verifies Bun.spawn
 *     wiring, stream-json translation, exit-code handling, timeout fix.
 *   - One ARG_MAX guard test (synthetic — confirms the precheck fires).
 */

import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve, join } from "node:path";
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
    expect(c).toEqual({
      type: "progress",
      note: "tool: bash",
      tool: { title: "tool: bash", kind: "execute", locations: [] },
    });
  });

  test("tool_execution_start surfaces args in the note when present (#218)", () => {
    const c = parsePiEvent({
      type: "tool_execution_start",
      toolName: "bash",
      args: { command: "npm test" },
    });
    expect(c).toEqual({
      type: "progress",
      note: "bash: npm test",
      tool: { title: "bash: npm test", kind: "execute", locations: [] },
    });
  });

  test("emits progress for tool_execution_start (legacy 0.67.x tool_name field)", () => {
    const c = parsePiEvent({
      type: "tool_execution_start",
      tool_name: "run_shell_command",
    });
    expect(c).toEqual({
      type: "progress",
      note: "tool: run_shell_command",
      tool: { title: "tool: run_shell_command", kind: "execute", locations: [] },
    });
  });

  test("emits progress for tool_execution_start without a tool name", () => {
    const c = parsePiEvent({ type: "tool_execution_start" });
    expect(c).toEqual({
      type: "progress",
      note: "tool",
      tool: { title: "tool", kind: "other", locations: [] },
    });
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
    expect(c).toEqual({
      type: "progress",
      note: "bash: npm test",
      tool: { title: "bash: npm test", kind: "execute", locations: [] },
    });
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
    expect(c).toEqual({
      type: "progress",
      note: "tool: /tmp/example.txt",
      tool: { title: "tool: /tmp/example.txt", kind: "other", locations: [] },
    });
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

  test("ignores session / agent_start / turn_start / agent_end / agent_settled / message_start / message_end", () => {
    for (const t of [
      "session",
      "agent_start",
      "turn_start",
      "agent_end",
      "agent_settled",
      "message_start",
      "message_end",
    ]) {
      expect(parsePiEvent({ type: t })).toBeUndefined();
    }
  });

  test("turn_end → done completion marker (payload-less, drives requireCompletion)", () => {
    // turn_end is pi's only completion signal. parsePiEvent surfaces it as a
    // `done` chunk so runHarnessProcess can tell a finished turn from an exit-0
    // that stopped mid-task. No finalText — the reply text already streamed as
    // text_delta chunks. See issue #352. NB agent_end is deliberately NOT a
    // completion marker (a run that errors can still emit it).
    expect(parsePiEvent({ type: "turn_end", message: {}, toolResults: [] })).toEqual({
      type: "done",
      finalText: "",
      meta: undefined,
    });
    expect(parsePiEvent({ type: "agent_end", messages: [] })).toBeUndefined();
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

const mkHarness = () => new PiHarness({ bin: FAKE_PI });

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

  test("exit 0 without turn_end → recoverable error, NOT done (issue #352)", async () => {
    // A narration-only run that exits 0 with no completion signal must fall
    // through to the next harness, not be stored as a finished answer.
    process.env.FAKE_PI_MODE = "nofinish";
    const chunks = await collect(mkHarness().invoke(newRequest()));
    expect(chunks.some((c) => c.type === "done")).toBe(false);
    const err = chunks.find((c) => c.type === "error") as
      | { type: "error"; error: string; recoverable: boolean }
      | undefined;
    expect(err).toBeDefined();
    expect(err!.recoverable).toBe(true);
    expect(err!.error).toContain("without a completion signal");
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
// Payload always via temp files (every platform). Pi carries both the system
// prompt (a flag) and the full payload (the positional) on argv, so a real
// persona turn would fail to spawn on Windows (~8,191-char command line) and
// could hit Linux ARG_MAX on a huge turn. As the LAST harness in the chain, pi
// must swallow whatever context the primary was chewing when it failed — so it
// spills both to temp files and passes `--system-prompt <file>` plus an
// `@<file>` positional, on every platform, with no size ceiling. FAKE_PI
// 'argv' mode echoes argv so we can inspect it.
// ---------------------------------------------------------------------------

describe("PiHarness.invoke payload-via-temp-files", () => {
  const argvOf = (chunks: HarnessChunk[]): string =>
    chunks
      .filter((c) => c.type === "text")
      .map((c) => (c as { text: string }).text)
      .join("");

  test("system prompt + payload go to temp files, not raw argv", async () => {
    process.env.FAKE_PI_MODE = "argv";
    const harness = new PiHarness({ bin: FAKE_PI });
    const chunks = await collect(
      harness.invoke(
        newRequest({ systemPrompt: "SECRET-PERSONA-PROMPT", userMessage: "SECRET-USER-MSG" }),
      ),
    );
    const argv = argvOf(chunks);

    // The raw system prompt and payload text must NOT appear on the command
    // line - they live in the temp files instead.
    expect(argv).not.toContain("SECRET-PERSONA-PROMPT");
    expect(argv).not.toContain("SECRET-USER-MSG");
    // The system prompt is passed as a file path, the payload as an @file.
    expect(argv).toContain("system-prompt.md");
    expect(argv).toMatch(/@\S*payload\.md/);
  });

  test("temp dir is cleaned up after the run", async () => {
    process.env.FAKE_PI_MODE = "argv";
    const harness = new PiHarness({ bin: FAKE_PI });
    const chunks = await collect(harness.invoke(newRequest()));
    const argv = argvOf(chunks);
    const match = argv.match(/@(\S*payload\.md)/);
    const payloadFile = match?.[1];
    expect(payloadFile).toBeTruthy();
    // The temp payload file referenced on argv is gone once invoke() completed.
    expect(existsSync(payloadFile!)).toBe(false);
  });

  test("a large payload still spills to files and is answered (no size ceiling)", async () => {
    process.env.FAKE_PI_MODE = "argv";
    const harness = new PiHarness({ bin: FAKE_PI });
    // ~200 KB — far past any old maxPayloadBytes cap and past a raw Windows
    // command line. Must still spill to a file and produce a reply, never a
    // recoverable "exceeds" error.
    const huge = "x".repeat(200_000);
    const chunks = await collect(
      harness.invoke(newRequest({ userMessage: huge })),
    );
    expect(chunks.some((c) => c.type === "error")).toBe(false);
    const argv = argvOf(chunks);
    expect(argv).toMatch(/@\S*payload\.md/);
    expect(argv).not.toContain(huge);
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
  }) => new PiHarness({ bin: FAKE_PI, routing });

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
    // file-backed runtime setting changed last turn is visible without a daemon
    // restart. If a refactor ever drops the call, this fails instead of silently
    // regressing behind the stub.
    process.env.FAKE_PI_MODE = "argv";
    await collect(mkHarness().invoke(newRequest()));
    expect(reloadSpy).toHaveBeenCalled();
  });
});

describe("PiHarness has no payload ceiling", () => {
  test("does not declare maxPayloadBytes (fallback never refuses a turn for size)", () => {
    // The orchestrator's generic precheck skips a harness only when it declares
    // maxPayloadBytes. Pi must NOT declare it — as the last-resort fallback it
    // spills any payload to temp files and always answers.
    expect((mkHarness() as { maxPayloadBytes?: number }).maxPayloadBytes).toBeUndefined();
  });
});

describe("PiHarness.available", () => {
  test("returns true for the absolute path of an executable file", async () => {
    expect(await mkHarness().available()).toBe(true);
  });

  test("returns false for a non-existent absolute path", async () => {
    expect(await new PiHarness({ bin: "/no/such/pi" }).available()).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Coder-swap retry ladder. A swapped turn rides a different provider model
// than the primary; when that model hangs or errors the turn used to be lost
// (pi is usually the last harness in the chain — no fallback). Now: up to
// CODER_SWAP_MAX_ATTEMPTS attempts on the coding model, then one attempt on
// the primary. Uses fake-pi.sh's `modelgate` mode, which fails on
// `--model $FAKE_PI_FAIL_MODEL` and behaves normally otherwise, logging every
// invocation's argv to $FAKE_PI_ARGV_LOG so tests can count attempts.
// ---------------------------------------------------------------------------

describe("PiHarness coder-swap retry ladder", () => {
  const PR_MSG = "review this pull request https://github.com/x/y/pull/1";
  let logDir: string;
  let argvLog: string;

  beforeEach(async () => {
    logDir = await mkdtemp(join(tmpdir(), "fake-pi-argv-"));
    argvLog = join(logDir, "argv.log");
    process.env.FAKE_PI_ARGV_LOG = argvLog;
  });

  afterEach(async () => {
    delete process.env.FAKE_PI_ARGV_LOG;
    delete process.env.FAKE_PI_FAIL_MODEL;
    await rm(logDir, { recursive: true, force: true });
  });

  const loggedArgv = async (): Promise<string[]> => {
    try {
      return (await readFile(argvLog, "utf8")).trim().split("\n").filter(Boolean);
    } catch {
      return [];
    }
  };

  test("swapped model fails 3x → falls back to the primary and answers", async () => {
    process.env.FAKE_PI_MODE = "modelgate";
    process.env.FAKE_PI_FAIL_MODEL = "z-ai/glm-5.2";
    const chunks = await collect(
      new PiHarness({
        bin: FAKE_PI,
        routing: { primaryModel: "mimo-v2.5", codingModel: "z-ai/glm-5.2" },
      }).invoke(newRequest({ userMessage: PR_MSG })),
    );
    // The turn is ANSWERED — by the primary, after 3 coder attempts.
    const done = chunks.find((c) => c.type === "done") as
      | { type: "done"; finalText: string }
      | undefined;
    expect(done?.finalText).toBe("hello world");
    expect(chunks.some((c) => c.type === "error")).toBe(false);
    const argvs = await loggedArgv();
    expect(argvs).toHaveLength(4);
    expect(argvs.slice(0, 3).every((a) => a.includes("--model z-ai/glm-5.2"))).toBe(true);
    expect(argvs[3]).toContain("--model mimo-v2.5");
  });

  test("primary fallback failing too → error surfaces (orchestrator chain applies)", async () => {
    process.env.FAKE_PI_MODE = "modelgate";
    process.env.FAKE_PI_FAIL_MODEL = "*"; // every model fails
    const chunks = await collect(
      new PiHarness({
        bin: FAKE_PI,
        routing: { primaryModel: "mimo-v2.5", codingModel: "z-ai/glm-5.2" },
      }).invoke(newRequest({ userMessage: PR_MSG })),
    );
    const error = chunks.find((c) => c.type === "error") as
      | { type: "error"; error: string; recoverable?: boolean }
      | undefined;
    expect(error?.recoverable).toBe(true);
    // 3 coder attempts + 1 primary attempt, then the error is yielded.
    expect(await loggedArgv()).toHaveLength(4);
  });

  test("coding model EQUAL to primary → swap subsystem skipped: single attempt, no ladder", async () => {
    process.env.FAKE_PI_MODE = "modelgate";
    process.env.FAKE_PI_FAIL_MODEL = "z-ai/glm-5.2"; // == primary → the only attempt fails
    const chunks = await collect(
      new PiHarness({
        bin: FAKE_PI,
        routing: { primaryModel: "z-ai/glm-5.2", codingModel: "z-ai/glm-5.2" },
      }).invoke(newRequest({ userMessage: PR_MSG })),
    );
    // No retries, no primary re-run: exactly one invocation, error yielded.
    expect(await loggedArgv()).toHaveLength(1);
    expect(chunks.some((c) => c.type === "error")).toBe(true);
  });

  test("no retry after user-visible text streamed (no doubled reply)", async () => {
    // `nofinish` streams narration text, then exits 0 WITHOUT turn_end — a
    // recoverable error AFTER text. Retrying would duplicate the bubbles.
    process.env.FAKE_PI_MODE = "nofinish";
    const chunks = await collect(
      new PiHarness({
        bin: FAKE_PI,
        routing: { primaryModel: "mimo-v2.5", codingModel: "z-ai/glm-5.2" },
      }).invoke(newRequest({ userMessage: PR_MSG })),
    );
    expect(chunks.some((c) => c.type === "text")).toBe(true);
    expect(chunks.some((c) => c.type === "error")).toBe(true);
    // The swapped model was attempted exactly once — no retry, no fallback.
    expect(await loggedArgv()).toHaveLength(1);
    const error = chunks.find((c) => c.type === "error") as
      | { type: "error"; recoverable?: boolean }
      | undefined;
    expect(error?.recoverable).toBe(true);
  });

  test("no retry after a TOOL ran, even with zero text (tools aren't idempotent)", async () => {
    // `toolthenfail` runs one tool (progress chunk, NOT text) and then dies
    // exit-1 (recoverable). The old gate keyed on streamed TEXT only, so this
    // read as "nothing happened yet" and re-ran the attempt — replaying
    // side-effecting tools (bash, notify, vault) up to four times.
    process.env.FAKE_PI_MODE = "toolthenfail";
    const chunks = await collect(
      new PiHarness({
        bin: FAKE_PI,
        routing: { primaryModel: "mimo-v2.5", codingModel: "z-ai/glm-5.2" },
      }).invoke(newRequest({ userMessage: PR_MSG })),
    );
    // The tool run surfaced as a progress chunk before the error.
    expect(chunks.some((c) => c.type === "progress")).toBe(true);
    const error = chunks.find((c) => c.type === "error") as
      | { type: "error"; error: string; recoverable?: boolean }
      | undefined;
    expect(error?.recoverable).toBe(true);
    // Exactly ONE invocation — no retry on the coder model, no primary
    // fallback. The tool's side effects must never be replayed.
    expect(await loggedArgv()).toHaveLength(1);
  });

  test("terminal error (exit 127) → exactly one attempt, no ladder (locks the non-retryable rule)", async () => {
    // notfound exits 127 → recoverable: false. A /stop, a missing binary, or
    // a policy tripwire must never be re-run on a second brain — this test
    // locks in the discipline the whole ladder rests on.
    process.env.FAKE_PI_MODE = "notfound";
    const chunks = await collect(
      new PiHarness({
        bin: FAKE_PI,
        routing: { primaryModel: "mimo-v2.5", codingModel: "z-ai/glm-5.2" },
      }).invoke(newRequest({ userMessage: PR_MSG })),
    );
    const error = chunks.find((c) => c.type === "error") as
      | { type: "error"; error: string; recoverable?: boolean }
      | undefined;
    expect(error?.recoverable).toBe(false);
    expect(await loggedArgv()).toHaveLength(1);
  });

  test("hard wall-clock cap kill is FINAL — no ladder, no primary fallback", async () => {
    // `hang` with a hard cap far SHORTER than the idle window kills via the
    // hard timer: "timed out after Nms (hard wall-clock cap)". The cap is the
    // one timer that is supposed to be final — retrying it 3x would turn one
    // 60-min cap into four hours. The error is still recoverable (the
    // orchestrator's harness chain applies) but the ladder must not touch it.
    process.env.FAKE_PI_MODE = "hang";
    const chunks = await collect(
      new PiHarness({
        bin: FAKE_PI,
        routing: { primaryModel: "mimo-v2.5", codingModel: "z-ai/glm-5.2" },
      }).invoke(
        newRequest({ userMessage: PR_MSG, idleTimeoutMs: 10_000, hardTimeoutMs: 300 }),
      ),
    );
    const error = chunks.find((c) => c.type === "error") as
      | { type: "error"; error: string; recoverable?: boolean }
      | undefined;
    expect(error?.error).toContain("hard wall-clock cap");
    expect(error?.recoverable).toBe(true);
    // Exactly ONE invocation — no retries, no primary fallback.
    expect(await loggedArgv()).toHaveLength(1);
  });

  test("successful swapped turn → single attempt, no ladder", async () => {
    process.env.FAKE_PI_MODE = "modelgate";
    const chunks = await collect(
      new PiHarness({
        bin: FAKE_PI,
        routing: { primaryModel: "mimo-v2.5", codingModel: "z-ai/glm-5.2" },
      }).invoke(newRequest({ userMessage: PR_MSG })),
    );
    const done = chunks.find((c) => c.type === "done") as
      | { type: "done"; finalText: string }
      | undefined;
    expect(done?.finalText).toBe("hello world");
    const argvs = await loggedArgv();
    expect(argvs).toHaveLength(1);
    expect(argvs[0]).toContain("--model z-ai/glm-5.2");
  });
});
