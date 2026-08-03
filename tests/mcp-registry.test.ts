/**
 * MCP registry: parse/validate/mutate + secret resolution.
 *
 * The registry is the trust boundary between "a config file safe to read/diff/
 * copy" and "live credentials". These tests pin: strict validation of the three
 * auth shapes, that secrets are referenced by vault key (never inlined), and
 * that resolveServerSecrets reports EXACTLY which keys are missing so the agent
 * can tell the user what to provide.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { generateSecretKey } from "nostr-tools/pure";

import { openVaultWithSecret, type Vault } from "../src/lib/vault.ts";
import {
  loadRegistry,
  parseRegistry,
  referencedVaultKeys,
  removeServer,
  resolveServerSecrets,
  saveRegistry,
  upsertServer,
  validateEntry,
} from "../src/mcp/registry.ts";
import { rmrf } from "./fixtures/rmrf.ts";

let workdir: string;
beforeEach(async () => {
  workdir = await mkdtemp(join(tmpdir(), "phantombot-mcp-reg-"));
});
afterEach(async () => {
  await rmrf(workdir);
});

describe("parse + validate", () => {
  test("missing file loads as an empty registry", async () => {
    const reg = await loadRegistry(join(workdir, "nope"));
    expect(reg.mcpServers).toEqual({});
  });

  test("empty / no-mcpServers content is an empty registry", () => {
    expect(parseRegistry("").mcpServers).toEqual({});
    expect(parseRegistry("{}").mcpServers).toEqual({});
  });

  test("stdio + env auth round-trips", () => {
    const e = validateEntry("some_local", {
      transport: "stdio",
      command: "npx",
      args: ["-y", "some-mcp"],
      auth: { type: "env", env: { API_KEY: "SOME_KEY" } },
    });
    expect(e.transport).toBe("stdio");
    expect(e.command).toBe("npx");
    expect(e.auth).toEqual({ type: "env", env: { API_KEY: "SOME_KEY" } });
  });

  test("http + header + oauth auth round-trip", () => {
    const header = validateEntry("h", {
      transport: "http",
      url: "https://x.test/mcp",
      auth: { type: "header", header: "Authorization", valueRef: "TOK", prefix: "Bearer " },
    });
    expect(header.auth).toEqual({ type: "header", header: "Authorization", valueRef: "TOK", prefix: "Bearer " });
    const oauth = validateEntry("o", {
      transport: "http",
      url: "https://x.test/mcp",
      auth: { type: "oauth", tokenRef: "OTOK", scopes: ["a", "b"] },
    });
    expect(oauth.auth).toEqual({ type: "oauth", tokenRef: "OTOK", scopes: ["a", "b"] });
  });

  test("rejects malformed entries with actionable messages", () => {
    expect(() => validateEntry("Bad Id", { transport: "stdio", command: "x" })).toThrow(/invalid server id/);
    expect(() => validateEntry("x", { transport: "ftp" })).toThrow(/transport must be/);
    expect(() => validateEntry("x", { transport: "stdio" })).toThrow(/non-empty command/);
    expect(() => validateEntry("x", { transport: "http", url: "not-a-url" })).toThrow(/valid http/);
    // env auth on http, header/oauth on stdio are cross-transport errors.
    expect(() => validateEntry("x", { transport: "http", url: "https://y.test/mcp", auth: { type: "env", env: {} } })).toThrow(/only valid for stdio/);
    expect(() => validateEntry("x", { transport: "stdio", command: "c", auth: { type: "oauth", tokenRef: "T" } })).toThrow(/only valid for http/);
    expect(() => validateEntry("x", { transport: "http", url: "https://y.test/mcp", auth: { type: "bespoke" } })).toThrow(/unknown auth type/);
  });
});

describe("mutation + persistence", () => {
  test("upsert then save/load round-trips through disk", async () => {
    const reg = upsertServer({ mcpServers: {} }, "gh", {
      transport: "http",
      url: "https://api.githubcopilot.com/mcp",
      auth: { type: "oauth", tokenRef: "GH_OAUTH" },
    });
    await saveRegistry(workdir, reg);
    const back = await loadRegistry(workdir);
    expect(back.mcpServers.gh?.url).toBe("https://api.githubcopilot.com/mcp");
  });

  test("remove reports no-op distinctly", () => {
    const reg = upsertServer({ mcpServers: {} }, "a", { transport: "stdio", command: "x" });
    expect(removeServer(reg, "missing").removed).toBe(false);
    const after = removeServer(reg, "a");
    expect(after.removed).toBe(true);
    expect(after.registry.mcpServers.a).toBeUndefined();
  });

  test("saved mcp.json never contains a secret value, only vault keys", async () => {
    const reg = upsertServer({ mcpServers: {} }, "s", {
      transport: "stdio",
      command: "npx",
      auth: { type: "env", env: { API_KEY: "MY_VAULT_KEY" } },
    });
    await saveRegistry(workdir, reg);
    const raw = await Bun.file(join(workdir, "mcp.json")).text();
    expect(raw).toContain("MY_VAULT_KEY");
    expect(raw).not.toContain("secret-value");
  });
});

describe("secret resolution", () => {
  let vault: Vault;
  beforeEach(() => {
    vault = openVaultWithSecret(join(workdir, "p"), generateSecretKey());
  });
  afterEach(() => vault.close());

  test("env auth resolves present keys and reports missing ones", () => {
    vault.set("PRESENT", "secret-value");
    const entry = validateEntry("s", {
      transport: "stdio",
      command: "npx",
      auth: { type: "env", env: { HAVE: "PRESENT", NEED: "ABSENT" } },
    });
    const r = resolveServerSecrets(entry, vault);
    expect(r.env).toEqual({ HAVE: "secret-value" });
    expect(r.missing).toEqual(["ABSENT"]);
  });

  test("header auth applies the prefix and reports missing", () => {
    vault.set("TOK", "abc123");
    const entry = validateEntry("h", {
      transport: "http",
      url: "https://x.test/mcp",
      auth: { type: "header", header: "Authorization", valueRef: "TOK", prefix: "Bearer " },
    });
    expect(resolveServerSecrets(entry, vault).headerValue).toBe("Bearer abc123");
  });

  test("referencedVaultKeys enumerates every key an entry touches", () => {
    const oauth = validateEntry("o", { transport: "http", url: "https://x.test/mcp", auth: { type: "oauth", tokenRef: "T" } });
    expect(referencedVaultKeys(oauth)).toEqual(["T", "T__CLIENT", "T__VERIFIER", "T__DISCOVERY"]);
  });
});
