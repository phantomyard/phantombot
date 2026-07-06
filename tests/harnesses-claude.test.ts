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
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import {
  ClaudeHarness,
  PHANTOMBOT_INJECTED_CLAUDE_SETTINGS,
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

  test("strips the whole ANTHROPIC_* / CLAUDE_CODE_* auth family", () => {
    const out = filterAuthEnv({
      ANTHROPIC_API_KEY: "sk-redacted",
      ANTHROPIC_AUTH_TOKEN: "tok-redacted",
      ANTHROPIC_BASE_URL: "https://proxy.example",
      ANTHROPIC_CUSTOM_HEADERS: "X-Foo: bar",
      CLAUDE_CODE_OAUTH_TOKEN: "oauth-redacted",
      CLAUDE_CODE_USE_BEDROCK: "1",
      PATH: "/usr/bin",
      HOME: "/home/test",
    });
    expect(out).not.toHaveProperty("ANTHROPIC_API_KEY");
    expect(out).not.toHaveProperty("ANTHROPIC_AUTH_TOKEN");
    expect(out).not.toHaveProperty("ANTHROPIC_BASE_URL");
    expect(out).not.toHaveProperty("ANTHROPIC_CUSTOM_HEADERS");
    expect(out).not.toHaveProperty("CLAUDE_CODE_OAUTH_TOKEN");
    expect(out).not.toHaveProperty("CLAUDE_CODE_USE_BEDROCK");
    // Non-auth env passes through untouched.
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

  test("returns undefined for non-assistant events without tool results", () => {
    expect(parseStreamJson({ type: "system" })).toBeUndefined();
    expect(
      parseStreamJson({
        type: "user",
        message: { content: [{ type: "text", text: "not surfaced" }] },
      }),
    ).toBeUndefined();
    expect(parseStreamJson({ type: "result" })).toBeUndefined();
  });

  test("progress for tool_use blocks with tool name in note", () => {
    const c = parseStreamJson({
      type: "assistant",
      message: { content: [{ type: "tool_use", name: "Bash", input: {} }] },
    });
    expect(c).toEqual({
      type: "progress",
      note: "tool: Bash",
      tool: { title: "tool: Bash", kind: "execute", locations: [] },
    });
  });

  test("progress note surfaces the tool input when present (#218)", () => {
    const c = parseStreamJson({
      type: "assistant",
      message: {
        content: [
          { type: "tool_use", name: "Bash", input: { command: "git status" } },
        ],
      },
    });
    expect(c).toEqual({
      type: "progress",
      note: "Bash: git status",
      tool: { title: "Bash: git status", kind: "execute", locations: [] },
    });
  });

  test("heartbeat for thinking blocks (no flush — mirrors pi.ts)", () => {
    const c = parseStreamJson({
      type: "assistant",
      message: {
        content: [{ type: "thinking", thinking: "internal chain-of-thought" }],
      },
    });
    expect(c).toEqual({ type: "heartbeat" });
  });

  test("heartbeat for tool_result blocks (no flush)", () => {
    const c = parseStreamJson({
      type: "assistant",
      message: {
        content: [{ type: "tool_result", tool_use_id: "abc", content: "done" }],
      },
    });
    expect(c).toEqual({ type: "heartbeat" });
  });

  test("heartbeat for user-side tool_result blocks so idle latch clears", () => {
    const c = parseStreamJson({
      type: "user",
      message: {
        content: [{ type: "tool_result", tool_use_id: "abc", content: "done" }],
      },
    });
    expect(c).toEqual({ type: "heartbeat" });
  });

  test("progress when tool_use present, even if thinking also present", () => {
    const c = parseStreamJson({
      type: "assistant",
      message: {
        content: [
          { type: "thinking", thinking: "hm..." },
          { type: "tool_use", name: "Read", input: {} },
        ],
      },
    });
    expect(c).toEqual({
      type: "progress",
      note: "tool: Read",
      tool: { title: "tool: Read", kind: "read", locations: [] },
    });
  });

  test("heartbeat for thinking + tool_result (no tool_use)", () => {
    const c = parseStreamJson({
      type: "assistant",
      message: {
        content: [
          { type: "thinking", thinking: "hm..." },
          { type: "tool_result", tool_use_id: "abc", content: "ok" },
        ],
      },
    });
    expect(c).toEqual({ type: "heartbeat" });
  });

  test("text takes precedence: when a message has both text and tool_use, text wins (no progress)", () => {
    const c = parseStreamJson({
      type: "assistant",
      message: {
        content: [
          { type: "text", text: "hello" },
          { type: "tool_use", name: "Bash", input: {} },
        ],
      },
    });
    expect(c).toEqual({ type: "text", text: "hello" });
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

  test("user-side tool_result clears tool latch so post-tool thinking can keep the turn alive", async () => {
    process.env.FAKE_CLAUDE_MODE = "posttool_thinking";
    const chunks = await collect(
      mkHarness().invoke(newRequest({ idleTimeoutMs: 700, hardTimeoutMs: 5_000 })),
    );

    expect(chunks.some((c) => c.type === "error")).toBe(false);
    expect(chunks).toContainEqual({ type: "text", text: "finished" });
    expect(chunks.at(-1)).toMatchObject({
      type: "done",
      finalText: "finished",
    });
  });
});

describe("PHANTOMBOT_INJECTED_CLAUDE_SETTINGS", () => {
  test("denies the three harness-native scheduler tools and only those", () => {
    const denied = PHANTOMBOT_INJECTED_CLAUDE_SETTINGS.permissions.deny;
    expect(denied).toContain("CronCreate");
    expect(denied).toContain("CronDelete");
    expect(denied).toContain("CronList");
    // We're not crippling the harness — this list is intentionally narrow.
    expect(denied).toHaveLength(3);
  });

  test("serializes to valid JSON for --settings flag", () => {
    const json = JSON.stringify(PHANTOMBOT_INJECTED_CLAUDE_SETTINGS);
    const round = JSON.parse(json);
    expect(round.permissions.deny).toEqual([
      "CronCreate",
      "CronDelete",
      "CronList",
    ]);
  });
});

describe("ClaudeHarness subprocess invocation passes injected settings", () => {
  test("--settings JSON appears in argv received by claude subprocess", async () => {
    // fake-claude.sh in 'argv' mode (added below) prints argv to stdout
    // as a stream-json text event so we can inspect what it received.
    process.env.FAKE_CLAUDE_MODE = "argv";
    const h = new ClaudeHarness({
      bin: FAKE_CLAUDE,
      model: "test",
      fallbackModel: "",
    });
    const chunks = await collect(h.invoke(newRequest()));
    const texts = chunks
      .filter((c): c is Extract<HarnessChunk, { type: "text" }> => c.type === "text")
      .map((c) => c.text)
      .join("");
    // --settings should be present and immediately followed by JSON
    // containing the deny list.
    expect(texts).toContain("--settings");
    expect(texts).toContain("CronCreate");
    expect(texts).toContain("CronDelete");
    expect(texts).toContain("CronList");
  });

  test("toolsMode 'none' (tool-less judge) passes claude's native --tools \"\" to disable all tools", async () => {
    process.env.FAKE_CLAUDE_MODE = "argv";
    const h = new ClaudeHarness({ bin: FAKE_CLAUDE, model: "test", fallbackModel: "" });
    const chunks = await collect(
      h.invoke(newRequest({ toolsMode: "none" })),
    );
    const texts = chunks
      .filter((c): c is Extract<HarnessChunk, { type: "text" }> => c.type === "text")
      .map((c) => c.text)
      .join("");
    // Native zero-tools flag present (empty value disables all tools per
    // `claude --help`) — a positive grant, not an enumerated deny-list.
    expect(texts).toContain("--tools");
    // Baseline cron denials still ride along on --settings.
    expect(texts).toContain("CronCreate");
  });

  test("a normal turn (no toolsMode) does NOT pass --tools", async () => {
    process.env.FAKE_CLAUDE_MODE = "argv";
    const h = new ClaudeHarness({ bin: FAKE_CLAUDE, model: "test", fallbackModel: "" });
    const chunks = await collect(h.invoke(newRequest()));
    const texts = chunks
      .filter((c): c is Extract<HarnessChunk, { type: "text" }> => c.type === "text")
      .map((c) => c.text)
      .join("");
    expect(texts).not.toContain("--tools");
  });

  test("pre-prompting trim flags ride along on every turn", async () => {
    process.env.FAKE_CLAUDE_MODE = "argv";
    const h = new ClaudeHarness({ bin: FAKE_CLAUDE, model: "test", fallbackModel: "" });
    const chunks = await collect(h.invoke(newRequest()));
    const texts = chunks
      .filter((c): c is Extract<HarnessChunk, { type: "text" }> => c.type === "text")
      .map((c) => c.text)
      .join("");
    // Workflow tool removed (kills the "you typed 'workflow'…" nudge at source).
    expect(texts).toContain("--disallowedTools");
    expect(texts).toContain("Workflow");
    // Skills block suppressed.
    expect(texts).toContain("--disable-slash-commands");
    // Per-machine dynamic sections dropped.
    expect(texts).toContain("--exclude-dynamic-system-prompt-sections");
  });
});

// ---------------------------------------------------------------------------
// Windows argv-length workaround. Claude's conversation payload already goes
// via stdin, but the persona system prompt still rides on argv via
// `--system-prompt <text>` - and a large BOOT.md can exceed Windows' ~8,191
// char command-line limit. On Windows the harness spills the system prompt to
// a temp file and passes `--system-prompt-file <file>` instead. Platform is
// injected so this runs on the Linux CI runner.
// ---------------------------------------------------------------------------

describe("ClaudeHarness Windows argv-length workaround", () => {
  const argvOf = (chunks: HarnessChunk[]): string =>
    chunks
      .filter((c): c is Extract<HarnessChunk, { type: "text" }> => c.type === "text")
      .map((c) => c.text)
      .join("");

  test("win32: system prompt goes to a file, not raw argv", async () => {
    process.env.FAKE_CLAUDE_MODE = "argv";
    const h = new ClaudeHarness(
      { bin: FAKE_CLAUDE, model: "test", fallbackModel: "" },
      "win32",
    );
    const chunks = await collect(
      h.invoke(newRequest({ systemPrompt: "SECRET-CLAUDE-PERSONA" })),
    );
    const argv = argvOf(chunks);
    // File flag present with a temp path; inline flag + raw text absent.
    expect(argv).toContain("--system-prompt-file");
    expect(argv).toContain("system-prompt.md");
    expect(argv).not.toContain("SECRET-CLAUDE-PERSONA");
  });

  test("win32: temp system-prompt file is cleaned up after the run", async () => {
    process.env.FAKE_CLAUDE_MODE = "argv";
    const h = new ClaudeHarness(
      { bin: FAKE_CLAUDE, model: "test", fallbackModel: "" },
      "win32",
    );
    const chunks = await collect(h.invoke(newRequest()));
    const argv = argvOf(chunks);
    const match = argv.match(/(\S*system-prompt\.md)/);
    const systemPromptFile = match?.[1];
    expect(systemPromptFile).toBeTruthy();
    expect(existsSync(systemPromptFile!)).toBe(false);
  });

  test("POSIX: system prompt stays inline via --system-prompt", async () => {
    process.env.FAKE_CLAUDE_MODE = "argv";
    // Force the POSIX branch so this holds on the Windows CI runner too.
    const h = new ClaudeHarness(
      { bin: FAKE_CLAUDE, model: "test", fallbackModel: "" },
      "linux",
    );
    const chunks = await collect(
      h.invoke(newRequest({ systemPrompt: "INLINE-CLAUDE-PERSONA" })),
    );
    const argv = argvOf(chunks);
    expect(argv).toContain("--system-prompt");
    expect(argv).toContain("INLINE-CLAUDE-PERSONA");
    expect(argv).not.toContain("--system-prompt-file");
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
