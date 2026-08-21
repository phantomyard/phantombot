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
import { existsSync, readdirSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  ClaudeHarness,
  PHANTOMBOT_INJECTED_CLAUDE_SETTINGS,
  filterAuthEnv,
  apiErrorStatus,
  isSubagentActivity,
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

describe("apiErrorStatus", () => {
  test("reads the status the CLI stamps on the envelope", () => {
    expect(apiErrorStatus({ type: "assistant", error: "rate_limit" })).toBe("rate_limit");
    expect(apiErrorStatus({ type: "assistant", error: "overloaded" })).toBe("overloaded");
  });

  test("max_output_tokens is NOT an error — it is a real, truncated reply", () => {
    expect(apiErrorStatus({ error: "max_output_tokens" })).toBeUndefined();
  });

  test("an unknown future status still counts as an error (fails safe)", () => {
    expect(apiErrorStatus({ error: "some_new_status" })).toBe("some_new_status");
  });

  test("absent / empty / non-string error means no error", () => {
    expect(apiErrorStatus({})).toBeUndefined();
    expect(apiErrorStatus({ error: "" })).toBeUndefined();
    expect(apiErrorStatus({ error: "   " })).toBeUndefined();
    expect(apiErrorStatus({ error: 42 })).toBeUndefined();
    expect(apiErrorStatus({ error: null })).toBeUndefined();
  });
});

describe("parseStreamJson api-error gate", () => {
  // Fixture shape captured from claude CLI v2.1.206 on the wire (forced
  // model_not_found). The session-cap message has the same shape with
  // error:"rate_limit".
  const errorEnvelope = (status: string, text: string) => ({
    type: "assistant",
    message: {
      model: "<synthetic>",
      content: [{ type: "text", text }],
    },
    error: status,
    request_id: "req_test",
  });

  test("a rate-limited session yields a recoverable error, never text", () => {
    const c = parseStreamJson(
      errorEnvelope(
        "rate_limit",
        "You've hit your session limit · resets 1:40pm (Europe/Amsterdam)",
      ),
    );
    expect(c).toMatchObject({ type: "error", recoverable: true });
    expect((c as { error: string }).error).toContain("rate_limit");
    // The CLI's prose must never be surfaced.
    expect((c as { error: string }).error).not.toContain("session limit");
  });

  test.each([
    "authentication_failed",
    "oauth_org_not_allowed",
    "billing_error",
    "overloaded",
    "invalid_request",
    "model_not_found",
    "server_error",
    "unknown",
  ])("%s also falls through recoverably", (status) => {
    const c = parseStreamJson(errorEnvelope(status, "There's an issue with..."));
    expect(c).toMatchObject({ type: "error", recoverable: true });
  });

  test("max_output_tokens is surfaced as real (truncated) assistant text", () => {
    const c = parseStreamJson(errorEnvelope("max_output_tokens", "a long partial answer"));
    expect(c).toEqual({ type: "text", text: "a long partial answer" });
  });

  // ── Regression: the old regex-based sentinel ate these as "rate limits".
  // A reply is only an error when the ENVELOPE says so, never because of its
  // prose. Each of these matched RATE_LIMIT_RE and was silently discarded.
  test.each([
    "You have reached the limit for this proof.",
    "The limit reached as n approaches infinity is zero.",
    "Your query hit the row limit of 1000.",
    "You have hit the limit of my patience.",
    "Sure — the API has a rate limit of 50 requests per minute.",
    "You've hit your session limit · resets 1:40pm (Europe/Amsterdam)",
  ])("a normal reply is surfaced verbatim, whatever it says: %s", (text) => {
    const c = parseStreamJson({
      type: "assistant",
      message: { content: [{ type: "text", text }] },
    });
    expect(c).toEqual({ type: "text", text });
  });

  test("the gate ignores non-assistant envelopes", () => {
    // control_response carries a free-text `error`, not an API status enum.
    expect(
      parseStreamJson({ type: "control_response", error: "boom", message: {} }),
    ).toBeUndefined();
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

  // #387: nightly stages get a POSITIVE tool grant so claude's native
  // Glob/Grep — whose parallel workers recursively walk the tree from cwd,
  // tripping the macOS TCC AppData prompt once per spawn — are simply not on
  // the menu. Search still exists for the stage, via `phantombot memory
  // search` (an index query) rather than a filesystem walk.
  test("toolsMode allowlist passes --tools with exactly the named tools", async () => {
    process.env.FAKE_CLAUDE_MODE = "argv";
    const h = new ClaudeHarness({ bin: FAKE_CLAUDE, model: "test", fallbackModel: "" });
    const chunks = await collect(
      h.invoke(newRequest({ toolsMode: { allow: ["Bash", "Read", "Write", "Edit"] } })),
    );
    const texts = chunks
      .filter((c): c is Extract<HarnessChunk, { type: "text" }> => c.type === "text")
      .map((c) => c.text)
      .join("");
    expect(texts).toContain("--tools");
    expect(texts).toContain("Bash,Read,Write,Edit");
    // The whole point: the tree-walking search tools are absent from the grant.
    expect(texts).not.toContain("Glob");
    expect(texts).not.toContain("Grep");
  });

  test("an EMPTY toolsMode allowlist is ignored rather than silently disabling every tool", async () => {
    process.env.FAKE_CLAUDE_MODE = "argv";
    const h = new ClaudeHarness({ bin: FAKE_CLAUDE, model: "test", fallbackModel: "" });
    const chunks = await collect(h.invoke(newRequest({ toolsMode: { allow: [] } })));
    const texts = chunks
      .filter((c): c is Extract<HarnessChunk, { type: "text" }> => c.type === "text")
      .map((c) => c.text)
      .join("");
    // `--tools ""` means ZERO tools. An empty allowlist almost certainly means
    // a caller built the list wrong, and silently running a tool-less nightly
    // would look like a hang, so fall through to the normal surface instead.
    expect(texts).not.toContain("--tools");
  });

  test("mcpMode 'none' (background/nightly) runs MCP-free via --strict-mcp-config + empty --mcp-config", async () => {
    process.env.FAKE_CLAUDE_MODE = "argv";
    const h = new ClaudeHarness({ bin: FAKE_CLAUDE, model: "test", fallbackModel: "" });
    const chunks = await collect(h.invoke(newRequest({ mcpMode: "none" })));
    const texts = chunks
      .filter((c): c is Extract<HarnessChunk, { type: "text" }> => c.type === "text")
      .map((c) => c.text)
      .join("");
    // --strict-mcp-config ignores every ambient MCP source (~/.claude.json +
    // remote connectors); the empty server map means zero servers to init, so
    // an unauthenticated connector can't wedge the --print startup handshake.
    expect(texts).toContain("--strict-mcp-config");
    expect(texts).toContain("--mcp-config");
    expect(texts).toContain('{"mcpServers":{}}');
  });

  test("a normal foreground turn also runs --strict-mcp-config (account-connector isolation, #338)", async () => {
    process.env.FAKE_CLAUDE_MODE = "argv";
    const h = new ClaudeHarness({ bin: FAKE_CLAUDE, model: "test", fallbackModel: "" });
    const chunks = await collect(h.invoke(newRequest()));
    const texts = chunks
      .filter((c): c is Extract<HarnessChunk, { type: "text" }> => c.type === "text")
      .map((c) => c.text)
      .join("");
    // Foreground turns are now ALSO strict: claude uses only phantombot's own
    // registry, ignoring ~/.claude.json + account-level claude.ai connectors
    // (IBKR/Gmail/Calendar/Drive). With no servers registered for the test
    // persona the projection is the empty map, so account connectors are
    // isolated without spawning any child MCP server.
    expect(texts).toContain("--strict-mcp-config");
    expect(texts).toContain("--mcp-config");
    expect(texts).toContain('{"mcpServers":{}}');
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
// Argv-length workaround. Claude's conversation payload already goes via
// stdin, but the persona system prompt still rides on argv via
// `--system-prompt <text>`, and that one string can outgrow what execve takes:
// a large BOOT.md exceeds Windows' ~8,191-char command-line limit, and a large
// journal exceeds Linux's 131,071-byte per-argv-string MAX_ARG_STRLEN (#426).
// Either way the harness spills the system prompt to a temp file and passes
// `--system-prompt-file <file>` instead. Platform is injected so both branches
// run on the Linux CI runner.
// ---------------------------------------------------------------------------

describe("ClaudeHarness argv-length workaround", () => {
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

  test("POSIX: an oversized system prompt spills to a file too (#426)", async () => {
    // The wedge this fixes: every turn died at `posix_spawn` with `E2BIG`
    // because the assembled prompt (~140KB, mostly journal) exceeded the
    // kernel's per-argv-string cap. Spilling is what makes the size moot.
    process.env.FAKE_CLAUDE_MODE = "argv";
    const h = new ClaudeHarness(
      { bin: FAKE_CLAUDE, model: "test", fallbackModel: "" },
      "linux",
    );
    const huge = "OVERSIZED-CLAUDE-PERSONA\n" + "x".repeat(140_000);
    const chunks = await collect(h.invoke(newRequest({ systemPrompt: huge })));
    const argv = argvOf(chunks);
    expect(argv).toContain("--system-prompt-file");
    expect(argv).not.toContain("OVERSIZED-CLAUDE-PERSONA");
  });

  test("POSIX: the spill threshold is measured in BYTES, not characters", async () => {
    // A journal full of em dashes / CJK is up to 3x its `.length` in UTF-8.
    // Sizing on `.length` would leave such a prompt inline at ~270KB of argv
    // and reproduce the exact spawn failure this guards against.
    process.env.FAKE_CLAUDE_MODE = "argv";
    const h = new ClaudeHarness(
      { bin: FAKE_CLAUDE, model: "test", fallbackModel: "" },
      "linux",
    );
    // 40k chars, but 120k+ bytes — under any char-based threshold, over ours.
    const multibyte = "MULTIBYTE-CLAUDE-PERSONA" + "漢".repeat(40_000);
    expect(multibyte.length).toBeLessThan(96 * 1024);
    expect(Buffer.byteLength(multibyte, "utf8")).toBeGreaterThan(96 * 1024);
    const chunks = await collect(
      h.invoke(newRequest({ systemPrompt: multibyte })),
    );
    expect(argvOf(chunks)).toContain("--system-prompt-file");
  });

  test("POSIX: an oversized prompt's temp file is cleaned up after the run", async () => {
    process.env.FAKE_CLAUDE_MODE = "argv";
    const h = new ClaudeHarness(
      { bin: FAKE_CLAUDE, model: "test", fallbackModel: "" },
      "linux",
    );
    const chunks = await collect(
      h.invoke(newRequest({ systemPrompt: "x".repeat(140_000) })),
    );
    const file = argvOf(chunks).match(/(\S*system-prompt\.md)/)?.[1];
    expect(file).toBeTruthy();
    expect(existsSync(file!)).toBe(false);
  });

  // ── the spill must never be able to KILL a turn ────────────────────────
  // Writing the temp file touches a real filesystem, and a filesystem can say
  // no (disk full, read-only mount, drifted perms on the persona dir). On a
  // headless box nobody is there to notice, so an unwritable tmp has to degrade
  // to the inline argument rather than throw out of invoke(). ENOTDIR - a
  // tmpBaseDir whose parent is a regular file - reproduces that without root.

  test("an unwritable tmp base degrades to the inline arg instead of throwing", async () => {
    // win32 spills unconditionally, so it reaches the guard with a small
    // prompt - which keeps the echoed argv readable and lets us assert the
    // degraded shape exactly: inline flag, real text, a completed turn.
    process.env.FAKE_CLAUDE_MODE = "argv";
    const blocker = join(await mkdtemp(join(tmpdir(), "pb-blocked-")), "not-a-dir");
    writeFileSync(blocker, "i am a file, not a directory");
    const h = new ClaudeHarness(
      { bin: FAKE_CLAUDE, model: "test", fallbackModel: "" },
      "win32",
    );
    const chunks = await collect(
      h.invoke(newRequest({
        systemPrompt: "DEGRADED-CLAUDE-PERSONA",
        tmpBaseDir: join(blocker, "tmp"),
      })),
    );
    const argv = argvOf(chunks);
    // No throw, a real turn, and the prompt travelled inline after all.
    expect(argv).toContain("--system-prompt");
    expect(argv).not.toContain("--system-prompt-file");
    expect(argv).toContain("DEGRADED-CLAUDE-PERSONA");
    expect(chunks.some((c) => c.type === "done")).toBe(true);
  });

  test("an oversized prompt with an unwritable tmp base still completes a turn", async () => {
    // The POSIX size-gated branch, where the guard matters most: the prompt is
    // over the spill threshold but under MAX_ARG_STRLEN, so the inline
    // fallback genuinely spawns and the persona keeps working on a box whose
    // tmp is broken. (Not asserting on argv here - the fixture echoes its own
    // argv back as one JSON line, which a 100KB prompt makes unusable.)
    process.env.FAKE_CLAUDE_MODE = "argv";
    const blocker = join(await mkdtemp(join(tmpdir(), "pb-blocked-")), "not-a-dir");
    writeFileSync(blocker, "blocker");
    const h = new ClaudeHarness(
      { bin: FAKE_CLAUDE, model: "test", fallbackModel: "" },
      "linux",
    );
    const chunks = await collect(
      h.invoke(newRequest({
        systemPrompt: "x".repeat(100 * 1024),
        tmpBaseDir: join(blocker, "tmp"),
      })),
    );
    expect(chunks.some((c) => c.type === "done")).toBe(true);
    expect(chunks.some((c) => c.type === "error")).toBe(false);
  });

  test("a failed spill leaks no temp dir under the persona tmp base", async () => {
    // mkdtemp can succeed and only the WRITE fail; the guard must still drop
    // the dir. Simulate by making the base a dir we then strip write perms on
    // after mkdtemp is impossible - instead assert the simpler invariant: a
    // usable base is left with no residue once the run completes.
    process.env.FAKE_CLAUDE_MODE = "argv";
    const personaDir = await mkdtemp(join(tmpdir(), "pb-persona-"));
    try {
      const base = join(personaDir, "tmp");
      const h = new ClaudeHarness(
        { bin: FAKE_CLAUDE, model: "test", fallbackModel: "" },
        "linux",
      );
      await collect(
        h.invoke(newRequest({ systemPrompt: "x".repeat(140_000), tmpBaseDir: base })),
      );
      expect(readdirSync(base)).toEqual([]);
    } finally {
      await rm(personaDir, { recursive: true, force: true });
    }
  });

  test("the spill lands under the persona tmp base, never the shared /tmp", async () => {
    // A spilled system prompt is persona data - memory, drawers, conversation.
    // It must not sit in a world-readable shared /tmp next to other personas'.
    process.env.FAKE_CLAUDE_MODE = "argv";
    const personaDir = await mkdtemp(join(tmpdir(), "pb-persona-"));
    try {
      const base = join(personaDir, "tmp");
      const h = new ClaudeHarness(
        { bin: FAKE_CLAUDE, model: "test", fallbackModel: "" },
        "linux",
      );
      const chunks = await collect(
        h.invoke(newRequest({ systemPrompt: "y".repeat(140_000), tmpBaseDir: base })),
      );
      const file = argvOf(chunks).match(/(\S*system-prompt\.md)/)?.[1];
      expect(file).toBeTruthy();
      expect(file!.startsWith(base)).toBe(true);
    } finally {
      await rm(personaDir, { recursive: true, force: true });
    }
  });

  test("POSIX: a normal-sized system prompt stays inline via --system-prompt", async () => {
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

// ---------------------------------------------------------------------------
// Background-agent lockdown. Product policy: no subagents, ever. Three layers
// are tested here: the env flag that strips run_in_background from the tool
// schemas, Task in --disallowedTools, and the parser tripwire that turns any
// subagent-stamped envelope into a recoverable error.
// ---------------------------------------------------------------------------

describe("isSubagentActivity", () => {
  test("flags an envelope stamped with subagent_type", () => {
    expect(
      isSubagentActivity({
        type: "assistant",
        subagent_type: "Explore",
        message: { content: [{ type: "text", text: "hi" }] },
      }),
    ).toBe(true);
  });

  test("flags a sidechain envelope", () => {
    expect(
      isSubagentActivity({
        type: "assistant",
        isSidechain: true,
        message: { content: [{ type: "text", text: "hi" }] },
      }),
    ).toBe(true);
  });

  test("flags a Task tool_use block", () => {
    expect(
      isSubagentActivity({
        type: "assistant",
        message: {
          content: [{ type: "tool_use", name: "Task", input: {} }],
        },
      }),
    ).toBe(true);
  });

  test("ignores ordinary main-chain messages", () => {
    expect(
      isSubagentActivity({
        type: "assistant",
        message: { content: [{ type: "text", text: "hello" }] },
      }),
    ).toBe(false);
    expect(
      isSubagentActivity({
        type: "assistant",
        isSidechain: false,
        message: {
          content: [{ type: "tool_use", name: "Bash", input: {} }],
        },
      }),
    ).toBe(false);
    expect(isSubagentActivity({ type: "result" })).toBe(false);
  });
});

describe("parseStreamJson subagent tripwire", () => {
  test("subagent-stamped text becomes a recoverable error, never user text", () => {
    const chunk = parseStreamJson({
      type: "assistant",
      subagent_type: "Explore",
      message: { content: [{ type: "text", text: "secret sidechain reply" }] },
    });
    expect(chunk).toEqual({
      type: "error",
      error: "claude emitted subagent activity (disabled by phantombot policy)",
      recoverable: true,
      terminal: true,
    });
  });

  test("a Task tool_use becomes a recoverable error, not progress", () => {
    const chunk = parseStreamJson({
      type: "assistant",
      message: {
        content: [{ type: "tool_use", name: "Task", input: { prompt: "x" } }],
      },
    });
    expect(chunk?.type).toBe("error");
    if (chunk?.type === "error") {
      expect(chunk.recoverable).toBe(true);
      expect(chunk.terminal).toBe(true);
    }
  });
});

describe("ClaudeHarness background-agent lockdown", () => {
  test("--disallowedTools removes Task as well as Workflow", async () => {
    process.env.FAKE_CLAUDE_MODE = "argv";
    const h = new ClaudeHarness({ bin: FAKE_CLAUDE, model: "test", fallbackModel: "" });
    const chunks = await collect(h.invoke(newRequest()));
    const texts = chunks
      .filter((c): c is Extract<HarnessChunk, { type: "text" }> => c.type === "text")
      .map((c) => c.text)
      .join("");
    expect(texts).toContain("--disallowedTools");
    expect(texts).toContain("Workflow,Task");
  });

  test("CLAUDE_CODE_DISABLE_BACKGROUND_TASKS=1 reaches the subprocess env", async () => {
    process.env.FAKE_CLAUDE_MODE = "env";
    const h = new ClaudeHarness({ bin: FAKE_CLAUDE, model: "test", fallbackModel: "" });
    const chunks = await collect(h.invoke(newRequest()));
    const texts = chunks
      .filter((c): c is Extract<HarnessChunk, { type: "text" }> => c.type === "text")
      .map((c) => c.text)
      .join("");
    expect(texts).toContain("BGTASKS=1");
  });

  test("an inherited CLAUDE_CODE_DISABLE_BACKGROUND_TASKS=0 cannot re-enable backgrounding", async () => {
    // The whole CLAUDE_CODE_* namespace is stripped from the inherited env
    // (auth filter) and the flag is re-injected as 1 afterwards — so a stray
    // =0 in ~/.env or the daemon's shell must not survive to the subprocess.
    const prev = process.env.CLAUDE_CODE_DISABLE_BACKGROUND_TASKS;
    process.env.CLAUDE_CODE_DISABLE_BACKGROUND_TASKS = "0";
    try {
      process.env.FAKE_CLAUDE_MODE = "env";
      const h = new ClaudeHarness({ bin: FAKE_CLAUDE, model: "test", fallbackModel: "" });
      const chunks = await collect(h.invoke(newRequest()));
      const texts = chunks
        .filter((c): c is Extract<HarnessChunk, { type: "text" }> => c.type === "text")
        .map((c) => c.text)
        .join("");
      expect(texts).toContain("BGTASKS=1");
      expect(texts).not.toContain("BGTASKS=0");
    } finally {
      if (prev === undefined) delete process.env.CLAUDE_CODE_DISABLE_BACKGROUND_TASKS;
      else process.env.CLAUDE_CODE_DISABLE_BACKGROUND_TASKS = prev;
    }
  });
});
