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
