import { describe, expect, test } from "bun:test";
import {
  boundedClaudeEnv,
  claudeBoundedSettings,
  securityMcpConfig,
} from "../src/harnesses/claude.ts";
import { handleSecurityMcp, SECURITY_MCP_SUBCOMMAND } from "../src/security/mcpServer.ts";

const session = { url: "http://127.0.0.1:1/operation", token: "a".repeat(64), workspace: "/w" };

describe("bounded claude turn (GHSA-w7w8)", () => {
  test("env is an allowlist: no vault secret reaches claude", () => {
    const env = boundedClaudeEnv({
      PATH: "/bin", HOME: "/h", LC_ALL: "C", GITHUB_TOKEN: "x", OPENROUTER_API_KEY: "y",
      PHANTOMBOT_VAULT_KEY: "z", ANTHROPIC_API_KEY: "k", SOME_RANDOM_SECRET: "s",
    });
    expect(env).toEqual({ PATH: "/bin", HOME: "/h", LC_ALL: "C" });
  });
  test("mcp config names only __security_mcp and carries no session token", () => {
    const cfg = securityMcpConfig(["/bin/phantombot"]);
    const parsed = JSON.parse(cfg);
    expect(Object.keys(parsed.mcpServers)).toEqual(["phantombot"]);
    expect(parsed.mcpServers.phantombot.args).toEqual([SECURITY_MCP_SUBCOMMAND]);
    expect(cfg).not.toContain("token");
  });
  test("settings deny every built-in and allow only the two session tools", () => {
    const s = claudeBoundedSettings() as { permissions: { deny: string[]; allow: string[] } };
    for (const t of ["Bash", "Read", "Edit", "Write", "WebFetch"]) expect(s.permissions.deny).toContain(t);
    expect(s.permissions.allow).toEqual(["mcp__phantombot__sandbox", "mcp__phantombot__broker"]);
  });
});

describe("__security_mcp server", () => {
  test("no session: lists no tools and refuses calls", async () => {
    const list = (await handleSecurityMcp({ id: 1, method: "tools/list" }, undefined)) as any;
    expect(list.result.tools).toEqual([]);
    const call = (await handleSecurityMcp(
      { id: 2, method: "tools/call", params: { name: "sandbox", arguments: { command: "id" } } },
      undefined,
    )) as any;
    expect(call.result.isError).toBe(true);
  });
  test("only sandbox and broker forward; bodies match the native extension", async () => {
    const sent: unknown[] = [];
    const invoke = async (_s: unknown, body: unknown) => { sent.push(body); return { text: "ok", ok: true }; };
    await handleSecurityMcp({ id: 1, method: "tools/call", params: { name: "sandbox", arguments: { command: "ls" } } }, session, invoke as never);
    await handleSecurityMcp({ id: 2, method: "tools/call", params: { name: "broker", arguments: { manifest: true } } }, session, invoke as never);
    const other = (await handleSecurityMcp({ id: 3, method: "tools/call", params: { name: "Bash", arguments: {} } }, session, invoke as never)) as any;
    expect(sent).toEqual([{ kind: "sandbox", command: "ls" }, { kind: "manifest" }]);
    expect(other.result.isError).toBe(true);
  });
  test("notifications get no reply; unknown methods get -32601", async () => {
    expect(await handleSecurityMcp({ method: "notifications/initialized" }, session)).toBeUndefined();
    expect(((await handleSecurityMcp({ id: 9, method: "resources/list" }, session)) as any).error.code).toBe(-32601);
  });
});

describe("ClaudeHarness.invoke with a security session (real spawn)", () => {
  test("built-ins off, only the phantombot MCP server, no vault secret in env, runtime-owned cwd", async () => {
    const { mkdtempSync, readFileSync, rmSync, writeFileSync, chmodSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const { ClaudeHarness } = await import("../src/harnesses/claude.ts");
    if (process.platform === "win32") return; // the fake bin is a shell script
    const dir = mkdtempSync(join(tmpdir(), "pb-claude-bounded-"));
    const out = join(dir, "seen.json");
    const bin = join(dir, "claude");
    writeFileSync(
      bin,
      `#!/bin/sh
cat >/dev/null
printf '%s\\n' "$*" > ${JSON.stringify(out + ".argv")}
printf 'cwd=%s\\ngh=%s\\nanth=%s\\nsession=%s\\n' "$(pwd)" "\${GITHUB_TOKEN:-}" "\${ANTHROPIC_API_KEY:-}" "\${PHANTOMBOT_SECURITY_SESSION:+set}" > ${JSON.stringify(out)}
printf '%s\\n' '{"type":"assistant","message":{"content":[{"type":"text","text":"ok"}]}}'
printf '%s\\n' '{"type":"result"}'
`,
    );
    chmodSync(bin, 0o755);
    const prev = { gh: process.env.GITHUB_TOKEN, an: process.env.ANTHROPIC_API_KEY };
    process.env.GITHUB_TOKEN = "gh-must-not-leak";
    process.env.ANTHROPIC_API_KEY = "anth-must-not-leak";
    try {
      const h = new ClaudeHarness({ bin, model: "test", fallbackModel: "" });
      for await (const _ of h.invoke({
        systemPrompt: "s",
        userMessage: "hi",
        history: [],
        workingDir: dir,
        idleTimeoutMs: 5_000,
        hardTimeoutMs: 5_000,
        securitySession: { ...session, workspace: dir },
      })) {
        /* drain */
      }
      const seen: Record<string, string> = Object.fromEntries(
        readFileSync(out, "utf8").trim().split("\n").map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1)]),
      );
      seen.argv = readFileSync(out + ".argv", "utf8");
      expect(seen.argv).toContain('--tools');
      expect(seen.argv).toContain("__security_mcp");
      expect(seen.argv).toContain("mcp__phantombot__sandbox");
      expect(seen.gh).toBe("");
      expect(seen.anth).toBe("");
      expect(seen.session).toBe("set");
      // Never the workspace: a planted bunfig.toml/.mcp.json there must not load on the host.
      expect(seen.cwd).toBe("/");
    } finally {
      if (prev.gh === undefined) delete process.env.GITHUB_TOKEN;
      else process.env.GITHUB_TOKEN = prev.gh;
      if (prev.an === undefined) delete process.env.ANTHROPIC_API_KEY;
      else process.env.ANTHROPIC_API_KEY = prev.an;
      rmSync(dir, { recursive: true, force: true });
    }
  }, 20000);
});
