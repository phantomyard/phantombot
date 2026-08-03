/**
 * MCP server registry — the per-persona list of declared MCP servers.
 *
 * Mirrors the existing per-persona config precedent (phantomchat.json,
 * identity.json, vault.sqlite): each persona owns a `<persona-dir>/mcp.json`
 * that travels with the persona folder. It is WRITTEN BY THE AGENT (via
 * `phantombot mcp add`), never hand-edited by the user — the whole design
 * intent is that a human never touches a config file.
 *
 * This module is deliberately pure I/O + validation: no network, no SDK, no
 * vault decryption. Secrets are referenced BY VAULT KEY here (`valueRef`,
 * `tokenRef`, env-value refs) and only resolved to real values at connection
 * time (see resolveServerSecrets + client.ts). That keeps `mcp.json` safe to
 * read, diff, and copy — it never contains a plaintext credential.
 *
 * Three auth shapes cover essentially the whole MCP ecosystem; they map 1:1 to
 * the three methods documented in `phantombot mcp help` (see help.ts):
 *   - `env`    — stdio server, secret(s) injected into the child process env.
 *   - `header` — remote server, a static bearer token on a fixed header.
 *   - `oauth`  — remote server, interactive OAuth 2.1 (PKCE + DCR), tokens in
 *                the vault under `tokenRef`.
 */

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import type { Vault } from "../lib/vault.ts";

/** Filename of the per-persona MCP registry inside a persona dir. */
export const MCP_REGISTRY_FILE = "mcp.json";

/** Transport by which phantombot reaches an MCP server. */
export type McpTransport = "stdio" | "http";

/**
 * `env` auth — stdio server that needs one or more secrets in its process
 * environment. Each map entry is `ENV_VAR -> VAULT_KEY`: at launch we resolve
 * VAULT_KEY from the persona vault and inject it as ENV_VAR into the child.
 * The most common shape in the wild (an npx/uvx server that reads an API key).
 */
export interface McpEnvAuth {
  type: "env";
  /** `CHILD_ENV_VAR` -> `VAULT_KEY`. Values are vault references, never literals. */
  env: Record<string, string>;
}

/**
 * `header` auth — remote HTTP server authenticated by a fixed token on a
 * static header (e.g. `Authorization: Bearer <token>`). The token is stored in
 * the vault under `valueRef`; `header` is the header name and `prefix` the
 * optional scheme prefix ("Bearer ").
 */
export interface McpHeaderAuth {
  type: "header";
  /** Header name to attach, e.g. "Authorization". */
  header: string;
  /** Vault key holding the token value. Never a literal. */
  valueRef: string;
  /** Optional scheme prefix prepended to the resolved value, e.g. "Bearer ". */
  prefix?: string;
}

/**
 * `oauth` auth — remote HTTP server behind interactive OAuth 2.1. The SDK's
 * OAuthClientProvider drives PKCE + RFC 9728 discovery + RFC 7591 dynamic
 * client registration; phantombot only stores the resulting tokens (and the
 * DCR client registration) in the vault, keyed off `tokenRef`. Google is an
 * adapter under this method, not a special case.
 */
export interface McpOAuthAuth {
  type: "oauth";
  /**
   * Vault-key STEM under which this server's OAuth material is stored. The
   * concrete rows are `<tokenRef>` (tokens), `<tokenRef>__CLIENT` (DCR client
   * registration) and `<tokenRef>__VERIFIER`/`<tokenRef>__DISCOVERY` (in-flight
   * PKCE + discovery state). See authProvider.ts.
   */
  tokenRef: string;
  /** OAuth scopes to request, if the server needs specific ones. */
  scopes?: string[];
}

/** `none` — an unauthenticated server (local stdio with no secret, or a public remote). */
export interface McpNoAuth {
  type: "none";
}

export type McpAuth = McpEnvAuth | McpHeaderAuth | McpOAuthAuth | McpNoAuth;

/** One declared MCP server. Discriminated on `transport`. */
export interface McpServerEntry {
  transport: McpTransport;
  /** stdio only: executable to spawn (e.g. "npx", "uvx", an absolute path). */
  command?: string;
  /** stdio only: argv for the command. */
  args?: string[];
  /** http only: the server's MCP endpoint URL. */
  url?: string;
  /** Auth method. Absent is treated as `{ type: "none" }`. */
  auth?: McpAuth;
  /** Optional human note the agent recorded (e.g. the "Learn More" URL it discovered from). */
  note?: string;
}

/** The whole registry file. */
export interface McpRegistry {
  mcpServers: Record<string, McpServerEntry>;
}

const EMPTY_REGISTRY: McpRegistry = { mcpServers: {} };

/** Server-id grammar: lowercase, digits, dash/underscore. Namespaced tool ids derive from this. */
export const MCP_SERVER_ID = /^[a-z0-9][a-z0-9_-]*$/;

/** Path to a persona's registry file given its dir. */
export function registryPath(personaDir: string): string {
  return join(personaDir, MCP_REGISTRY_FILE);
}

/**
 * Read + parse a persona's registry. A missing file is a valid empty registry
 * (a persona that has registered no servers). A malformed file throws — silent
 * data loss on write-back would be worse than a loud parse error.
 */
export async function loadRegistry(personaDir: string): Promise<McpRegistry> {
  let raw: string;
  try {
    raw = await readFile(registryPath(personaDir), "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return { mcpServers: {} };
    }
    throw err;
  }
  return parseRegistry(raw);
}

/** Parse + validate registry JSON. Exported for testing. */
export function parseRegistry(raw: string): McpRegistry {
  const trimmed = raw.trim();
  if (trimmed.length === 0) return { mcpServers: {} };
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch (err) {
    throw new Error(`mcp.json is not valid JSON: ${(err as Error).message}`);
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error("mcp.json must be a JSON object with an mcpServers map");
  }
  const servers = (parsed as Record<string, unknown>).mcpServers;
  if (servers === undefined) return { mcpServers: {} };
  if (typeof servers !== "object" || servers === null || Array.isArray(servers)) {
    throw new Error("mcp.json: mcpServers must be an object keyed by server id");
  }
  const out: Record<string, McpServerEntry> = {};
  for (const [id, entry] of Object.entries(servers as Record<string, unknown>)) {
    out[id] = validateEntry(id, entry);
  }
  return { mcpServers: out };
}

/**
 * Validate one entry. Throws with a precise message on anything malformed so
 * the agent gets a fixable error rather than a server that silently never
 * connects.
 */
export function validateEntry(id: string, entry: unknown): McpServerEntry {
  if (!MCP_SERVER_ID.test(id)) {
    throw new Error(
      `invalid server id '${id}': use lowercase letters, digits, '-' or '_' (starts alphanumeric)`,
    );
  }
  if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
    throw new Error(`server '${id}': entry must be an object`);
  }
  const e = entry as Record<string, unknown>;
  const transport = e.transport;
  if (transport !== "stdio" && transport !== "http") {
    throw new Error(`server '${id}': transport must be "stdio" or "http"`);
  }
  const out: McpServerEntry = { transport };
  if (transport === "stdio") {
    if (typeof e.command !== "string" || e.command.trim().length === 0) {
      throw new Error(`server '${id}': stdio transport needs a non-empty command`);
    }
    out.command = e.command;
    if (e.args !== undefined) {
      if (!Array.isArray(e.args) || !e.args.every((a) => typeof a === "string")) {
        throw new Error(`server '${id}': args must be an array of strings`);
      }
      out.args = e.args as string[];
    }
  } else {
    if (typeof e.url !== "string" || !isHttpUrl(e.url)) {
      throw new Error(`server '${id}': http transport needs a valid http(s) url`);
    }
    out.url = e.url;
  }
  out.auth = validateAuth(id, transport, e.auth);
  if (e.note !== undefined) {
    if (typeof e.note !== "string") throw new Error(`server '${id}': note must be a string`);
    out.note = e.note;
  }
  return out;
}

function validateAuth(id: string, transport: McpTransport, auth: unknown): McpAuth {
  if (auth === undefined || auth === null) return { type: "none" };
  if (typeof auth !== "object" || Array.isArray(auth)) {
    throw new Error(`server '${id}': auth must be an object`);
  }
  const a = auth as Record<string, unknown>;
  switch (a.type) {
    case undefined:
    case "none":
      return { type: "none" };
    case "env": {
      if (transport !== "stdio") {
        throw new Error(`server '${id}': env auth is only valid for stdio transport`);
      }
      const env = a.env;
      if (typeof env !== "object" || env === null || Array.isArray(env)) {
        throw new Error(`server '${id}': env auth needs an { ENV_VAR: VAULT_KEY } map`);
      }
      const map: Record<string, string> = {};
      for (const [k, v] of Object.entries(env as Record<string, unknown>)) {
        if (typeof v !== "string") {
          throw new Error(`server '${id}': env.${k} must be a vault key string`);
        }
        map[k] = v;
      }
      return { type: "env", env: map };
    }
    case "header": {
      if (transport !== "http") {
        throw new Error(`server '${id}': header auth is only valid for http transport`);
      }
      if (typeof a.header !== "string" || a.header.trim().length === 0) {
        throw new Error(`server '${id}': header auth needs a header name`);
      }
      if (typeof a.valueRef !== "string" || a.valueRef.trim().length === 0) {
        throw new Error(`server '${id}': header auth needs a valueRef (vault key)`);
      }
      const out: McpHeaderAuth = { type: "header", header: a.header, valueRef: a.valueRef };
      if (a.prefix !== undefined) {
        if (typeof a.prefix !== "string") throw new Error(`server '${id}': header prefix must be a string`);
        out.prefix = a.prefix;
      }
      return out;
    }
    case "oauth": {
      if (transport !== "http") {
        throw new Error(`server '${id}': oauth auth is only valid for http transport`);
      }
      if (typeof a.tokenRef !== "string" || a.tokenRef.trim().length === 0) {
        throw new Error(`server '${id}': oauth auth needs a tokenRef (vault key stem)`);
      }
      const out: McpOAuthAuth = { type: "oauth", tokenRef: a.tokenRef };
      if (a.scopes !== undefined) {
        if (!Array.isArray(a.scopes) || !a.scopes.every((s) => typeof s === "string")) {
          throw new Error(`server '${id}': oauth scopes must be an array of strings`);
        }
        out.scopes = a.scopes as string[];
      }
      return out;
    }
    default:
      throw new Error(
        `server '${id}': unknown auth type '${String(a.type)}' — supported: env, header, oauth, none`,
      );
  }
}

/**
 * Write the registry back. Pretty-printed, trailing newline, dir created on
 * demand. Callers should mutate a loaded registry and pass it here rather than
 * editing the file by hand.
 */
export async function saveRegistry(personaDir: string, registry: McpRegistry): Promise<void> {
  const path = registryPath(personaDir);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(registry, null, 2) + "\n", "utf8");
}

/** Add or replace a server. Validates the entry before mutating. Returns the new registry. */
export function upsertServer(
  registry: McpRegistry,
  id: string,
  entry: McpServerEntry,
): McpRegistry {
  const validated = validateEntry(id, entry);
  return { mcpServers: { ...registry.mcpServers, [id]: validated } };
}

/** Remove a server. Returns { registry, removed } so callers can report a no-op distinctly. */
export function removeServer(
  registry: McpRegistry,
  id: string,
): { registry: McpRegistry; removed: boolean } {
  if (!(id in registry.mcpServers)) return { registry, removed: false };
  const next = { ...registry.mcpServers };
  delete next[id];
  return { registry: { mcpServers: next }, removed: true };
}

/** All vault keys an entry references, so `remove` can offer to clean up secrets. */
export function referencedVaultKeys(entry: McpServerEntry): string[] {
  const auth = entry.auth ?? { type: "none" };
  switch (auth.type) {
    case "env":
      return Object.values(auth.env);
    case "header":
      return [auth.valueRef];
    case "oauth":
      // Mirror the row layout in authProvider.ts (OAUTH_ROW_SUFFIX).
      return [
        auth.tokenRef,
        `${auth.tokenRef}__CLIENT`,
        `${auth.tokenRef}__CLIENT_STATIC`,
        `${auth.tokenRef}__VERIFIER`,
        `${auth.tokenRef}__DISCOVERY`,
      ];
    default:
      return [];
  }
}

/**
 * Resolve an entry's secret references against a persona vault into concrete
 * values, WITHOUT ever putting the values into the registry. Returns the
 * resolved env map (for stdio) and header value (for http header auth), plus a
 * list of vault keys that were referenced but missing — so the caller can tell
 * the agent exactly which secret still needs to be provided.
 */
export function resolveServerSecrets(
  entry: McpServerEntry,
  vault: Pick<Vault, "get">,
): { env: Record<string, string>; headerValue?: string; missing: string[] } {
  const auth = entry.auth ?? { type: "none" };
  const missing: string[] = [];
  const env: Record<string, string> = {};
  let headerValue: string | undefined;
  if (auth.type === "env") {
    for (const [childVar, vaultKey] of Object.entries(auth.env)) {
      const v = vault.get(vaultKey);
      if (v === undefined) missing.push(vaultKey);
      else env[childVar] = v;
    }
  } else if (auth.type === "header") {
    const v = vault.get(auth.valueRef);
    if (v === undefined) missing.push(auth.valueRef);
    else headerValue = (auth.prefix ?? "") + v;
  }
  return { env, headerValue, missing };
}

export { EMPTY_REGISTRY };

function isHttpUrl(s: string): boolean {
  try {
    const u = new URL(s);
    return u.protocol === "http:" || u.protocol === "https:";
  } catch {
    return false;
  }
}
