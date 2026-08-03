/**
 * `mcp help` is the agent-teaching contract (acceptance criterion): it must
 * document all three auth methods and the zero-config-file setup flow well
 * enough that an agent can register/configure a server or decline. If a future
 * edit drops a method, this test fails loudly.
 */

import { describe, expect, test } from "bun:test";

import { MCP_HELP } from "../src/mcp/help.ts";

describe("mcp help coverage", () => {
  test("documents all three auth methods by name", () => {
    expect(MCP_HELP).toMatch(/\benv\b/);
    expect(MCP_HELP).toMatch(/\bheader\b/);
    expect(MCP_HELP).toMatch(/\boauth\b/);
  });

  test("names the OAuth 2.1 building blocks the SDK drives", () => {
    expect(MCP_HELP).toMatch(/PKCE/);
    expect(MCP_HELP).toMatch(/RFC 9728/);
    expect(MCP_HELP).toMatch(/RFC 7591|dynamic client registration/i);
  });

  test("covers the zero-config-file / from-url flow and the unsupported answer", () => {
    expect(MCP_HELP).toMatch(/--from-url/);
    expect(MCP_HELP).toMatch(/never\s+edits?\s+(a )?config file/i);
    expect(MCP_HELP).toMatch(/not supported/i);
  });

  test("lists the core commands and the secrets-by-vault-key rule", () => {
    for (const cmd of ["add", "list", "describe", "status", "search", "call", "login", "remove"]) {
      expect(MCP_HELP).toContain(cmd);
    }
    expect(MCP_HELP).toMatch(/vault key/i);
  });
});
