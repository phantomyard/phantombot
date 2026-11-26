/**
 * #820 spawn wiring, at the harness boundary (PR #821 review): each harness
 * decides WHETHER a spawn carries the pbot_* tools, adapts the prompt to
 * match, and filters the agent env through `[vault] agent_env`. The pure
 * helpers have their own tests (pbot-harness, vault-agent-env); these drive
 * the real ClaudeHarness / CodexHarness / PiHarness against the fake CLIs so
 * removing the gate, the adaptation or the env filter at the call site fails.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { runVaultSet } from "../src/cli/vault.ts";
import { ClaudeHarness } from "../src/harnesses/claude.ts";
import { CodexHarness } from "../src/harnesses/codex.ts";
import { PiHarness } from "../src/harnesses/pi.ts";
import type { HarnessChunk, HarnessRequest } from "../src/harnesses/types.ts";
import { _resetConfigCacheForTesting } from "../src/lib/vault.ts";
import { rmrf } from "./fixtures/rmrf.ts";

const FAKE_CLAUDE = resolve(__dirname, "fixtures/fake-claude.sh");
const FAKE_CODEX = resolve(__dirname, "fixtures/fake-codex.sh");
const FAKE_PI = resolve(__dirname, "fixtures/fake-pi.sh");

// The inline memory reflex: rewritten to the tool on a tooled spawn only.
const CLI = "phantombot memory search";
const TOOL = "pbot_memory search";

let root: string;
const saved = { ...process.env };
const sink = { write: () => true };

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "phantombot-pbot-spawn-"));
  await mkdir(join(root, "personas", "p"), { recursive: true });
  await writeFile(join(root, "config.toml"), 'default_persona = "p"\n[vault]\nagent_env = ["KEEP_ME"]\n');
  process.env.PHANTOMBOT_CONFIG = join(root, "config.toml");
  process.env.PHANTOMBOT_PERSONAS_DIR = join(root, "personas");
  process.env.PHANTOMBOT_MEMORY_DB = join(root, "memory.sqlite");
  delete process.env.PHANTOMBOT_PERSONA;
  delete process.env.PHANTOMBOT_PBOT_TOOLS;
  _resetConfigCacheForTesting();
  for (const n of ["KEEP_ME", "DROP_ME"]) {
    await runVaultSet({ name: n, value: `${n}-value`, persona: "p", out: sink, err: sink });
  }
  for (const f of [FAKE_CLAUDE, FAKE_CODEX, FAKE_PI]) await chmod(f, 0o755);
});

afterEach(async () => {
  process.env = { ...saved };
  _resetConfigCacheForTesting();
  await rmrf(root);
});

function req(overrides: Partial<HarnessRequest> = {}): HarnessRequest {
  return {
    systemPrompt: `you are a test. Recall with \`${CLI} "<q>"\`.`,
    userMessage: "hi",
    history: [],
    workingDir: process.cwd(),
    persona: "p",
    idleTimeoutMs: 10_000,
    hardTimeoutMs: 10_000,
    ...overrides,
  };
}

async function text(iter: AsyncIterable<HarnessChunk>): Promise<string> {
  let out = "";
  for await (const c of iter) if (c.type === "text") out += c.text;
  return out;
}

const claude = () => new ClaudeHarness({ bin: FAKE_CLAUDE, model: "test", fallbackModel: "" });
const codex = () => new CodexHarness({ bin: FAKE_CODEX, model: "" });
const pi = () => new PiHarness({ bin: FAKE_PI, mode: "native", command: [FAKE_PI] } as never);

describe("claude spawn", () => {
  test("a foreground spawn gets the adapted system prompt", async () => {
    process.env.FAKE_CLAUDE_MODE = "argv";
    const argv = await text(claude().invoke(req()));
    expect(argv).toContain(TOOL);
    expect(argv).not.toContain(CLI);
  });

  test("a background spawn (mcpMode none) keeps the CLI prompt", async () => {
    process.env.FAKE_CLAUDE_MODE = "argv";
    const argv = await text(claude().invoke(req({ mcpMode: "none" })));
    expect(argv).toContain(CLI);
    expect(argv).not.toContain(TOOL);
  });

  test("a bounded (sandboxed) spawn keeps the CLI prompt", async () => {
    // A bounded spawn's env is a fixed allowlist, so FAKE_CLAUDE_MODE never
    // reaches the fake: pin the mode in a wrapper instead.
    const bin = join(root, "fake-claude-argv.sh");
    await writeFile(bin, `#!/bin/bash\nFAKE_CLAUDE_MODE=argv exec ${JSON.stringify(FAKE_CLAUDE)} "$@"\n`);
    await chmod(bin, 0o755);
    const h = new ClaudeHarness({ bin, model: "test", fallbackModel: "" });
    const argv = await text(h.invoke(req({ securitySession: {} as never })));
    // the bounded shape really ran (only the session tools are allowed)
    expect(argv).toContain("--strict-mcp-config");
    expect(argv).toContain(CLI);
    expect(argv).not.toContain(TOOL);
  });

  test("[vault] agent_env filters the spawn env", async () => {
    process.env.FAKE_CLAUDE_MODE = "envvars";
    process.env.FAKE_CLAUDE_ECHO_VARS = "KEEP_ME DROP_ME";
    const out = await text(claude().invoke(req()));
    expect(out).toContain("KEEP_ME=KEEP_ME-value");
    expect(out).toContain("DROP_ME=<unset>");
  });
});

describe("codex spawn", () => {
  test("a foreground spawn gets the proxy overrides and the adapted prompt", async () => {
    process.env.FAKE_CODEX_MODE = "pbot";
    expect(await text(codex().invoke(req()))).toBe("tool=yes cli=no mcp=yes");
  });

  test("a judge spawn (toolsMode none) gets neither", async () => {
    process.env.FAKE_CODEX_MODE = "pbot";
    expect(await text(codex().invoke(req({ toolsMode: "none" })))).toBe("tool=no cli=yes mcp=no");
  });

  test("a background spawn (mcpMode none) gets neither", async () => {
    process.env.FAKE_CODEX_MODE = "pbot";
    expect(await text(codex().invoke(req({ mcpMode: "none" })))).toBe("tool=no cli=yes mcp=no");
  });

  test("[vault] agent_env filters the spawn env", async () => {
    process.env.FAKE_CODEX_MODE = "env";
    process.env.FAKE_CODEX_ECHO_VARS = "KEEP_ME DROP_ME";
    const out = await text(codex().invoke(req()));
    expect(out).toContain("KEEP_ME=KEEP_ME-value");
    expect(out).toContain("DROP_ME= ");
  });
});

describe("native pi spawn", () => {
  test("a foreground spawn sets PHANTOMBOT_PBOT_TOOLS and gets the adapted prompt", async () => {
    process.env.FAKE_PI_MODE = "pbot";
    expect(await text(pi().invoke(req()))).toBe("flag=1 tool=yes cli=no");
  });

  test("a background spawn clears an inherited PHANTOMBOT_PBOT_TOOLS and keeps the CLI prompt", async () => {
    process.env.FAKE_PI_MODE = "pbot";
    process.env.PHANTOMBOT_PBOT_TOOLS = "1";
    expect(await text(pi().invoke(req({ mcpMode: "none" })))).toBe("flag=<unset> tool=no cli=yes");
  });

  test("a judge spawn (toolsMode none) gets neither", async () => {
    process.env.FAKE_PI_MODE = "pbot";
    expect(await text(pi().invoke(req({ toolsMode: "none" })))).toBe("flag=<unset> tool=no cli=yes");
  });

  test("[vault] agent_env filters the spawn env", async () => {
    process.env.FAKE_PI_MODE = "pbot";
    process.env.FAKE_PI_ECHO_VARS = "KEEP_ME DROP_ME";
    expect(await text(pi().invoke(req()))).toBe("flag=1 tool=yes cli=no KEEP_ME=KEEP_ME-value DROP_ME=<unset>");
  });
});
