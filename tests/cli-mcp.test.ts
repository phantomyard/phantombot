/**
 * `phantombot mcp` CLI surface. Exercises the registry-mutating commands
 * end-to-end through a temp persona dir (add -> list -> remove), plus the
 * pure helpers (env-secret parsing, default vault-key derivation) and the
 * dry-run / next-steps guidance the agent relies on.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  defaultEnvVaultKey,
  parseEnvSecrets,
  runMcpAdd,
  runMcpList,
  runMcpRemove,
} from "../src/cli/mcp.ts";
import { rmrf } from "./fixtures/rmrf.ts";

class Cap {
  chunks: string[] = [];
  write(s: string | Uint8Array): boolean {
    this.chunks.push(typeof s === "string" ? s : new TextDecoder().decode(s));
    return true;
  }
  get text(): string {
    return this.chunks.join("");
  }
}

let workdir: string;
const savedEnv = { ...process.env };
beforeEach(async () => {
  workdir = await mkdtemp(join(tmpdir(), "phantombot-cli-mcp-"));
  process.env.PHANTOMBOT_PERSONAS_DIR = workdir;
  process.env.PHANTOMBOT_DEFAULT_PERSONA = "tester";
  // Pin the active persona: an ambient PHANTOMBOT_PERSONA (set when the suite
  // runs inside a live persona shell) would otherwise win over the default.
  process.env.PHANTOMBOT_PERSONA = "tester";
});
afterEach(async () => {
  process.env = { ...savedEnv };
  await rmrf(workdir);
});

describe("helpers", () => {
  test("defaultEnvVaultKey is shell-safe and namespaced", () => {
    expect(defaultEnvVaultKey("my-server", "api.key")).toBe("MCP_MY_SERVER_API_KEY");
  });
  test("parseEnvSecrets supports VAR and VAR=KEY, comma-joined", () => {
    expect(parseEnvSecrets("srv", "API_KEY,TOKEN=CUSTOM")).toEqual({
      API_KEY: "MCP_SRV_API_KEY",
      TOKEN: "CUSTOM",
    });
  });
});

describe("add / list / remove", () => {
  test("stdio + env: writes vault-key ref, prints the paste-a-key next step", async () => {
    const out = new Cap();
    const code = await runMcpAdd({
      id: "weather",
      stdio: true,
      command: "npx",
      args: "-y,weather-mcp",
      envSecret: "WEATHER_API_KEY",
      out,
      err: out,
    });
    expect(code).toBe(0);
    const raw = await readFile(join(workdir, "tester", "mcp.json"), "utf8");
    expect(raw).toContain("MCP_WEATHER_WEATHER_API_KEY");
    expect(out.text).toMatch(/vault set MCP_WEATHER_WEATHER_API_KEY/);
  });

  test("http + oauth: next step tells the agent to run mcp login", async () => {
    const out = new Cap();
    const code = await runMcpAdd({ id: "gh", http: true, url: "https://api.test/mcp", oauth: true, out, err: out });
    expect(code).toBe(0);
    expect(out.text).toMatch(/mcp login gh/);
  });

  test("http + header: derives a token vault key and next step", async () => {
    const out = new Cap();
    await runMcpAdd({ id: "linear", http: true, url: "https://api.test/mcp", valueRef: "LINEAR_TOKEN", out, err: out });
    const raw = await readFile(join(workdir, "tester", "mcp.json"), "utf8");
    expect(raw).toContain("LINEAR_TOKEN");
    expect(out.text).toMatch(/vault set LINEAR_TOKEN/);
  });

  test("dry-run prints the entry and does NOT write the file", async () => {
    const out = new Cap();
    const code = await runMcpAdd({ id: "dryone", stdio: true, command: "npx", dryRun: true, out, err: out });
    expect(code).toBe(0);
    expect(out.text).toContain("dryone");
    expect(await readFile(join(workdir, "tester", "mcp.json"), "utf8").catch(() => "MISSING")).toBe("MISSING");
  });

  test("rejects a bad server id", async () => {
    const err = new Cap();
    expect(await runMcpAdd({ id: "Bad Id", stdio: true, command: "x", out: new Cap(), err })).toBe(2);
    expect(err.text).toMatch(/invalid server id/);
  });

  test("list shows registered servers without secret values; remove is a no-op-aware", async () => {
    await runMcpAdd({ id: "a", stdio: true, command: "npx", envSecret: "K", out: new Cap(), err: new Cap() });
    const list = new Cap();
    await runMcpList({ out: list });
    expect(list.text).toMatch(/^a\s+\[stdio, auth=env\]/m);

    const rmErr = new Cap();
    expect(await runMcpRemove({ id: "ghost", out: new Cap(), err: rmErr })).toBe(1);
    expect(rmErr.text).toMatch(/no such MCP server/);

    const rmOut = new Cap();
    expect(await runMcpRemove({ id: "a", out: rmOut, err: new Cap() })).toBe(0);
    const list2 = new Cap();
    await runMcpList({ out: list2 });
    expect(list2.text).toContain("(no MCP servers registered)");
  });
});
