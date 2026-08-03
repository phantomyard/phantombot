/**
 * MCP client wrapper — the one place that actually talks to servers.
 *
 * Everything here goes through the official `@modelcontextprotocol/sdk` Client
 * and its transports. We never hand-roll a transport, a JSON-RPC frame, or the
 * OAuth dance — the SDK owns all of that. This module's job is to translate a
 * registry entry (registry.ts) + the persona vault into a connected SDK Client,
 * mapping each of the three auth methods onto the right transport wiring:
 *
 *   stdio + env   -> StdioClientTransport, secrets injected into child env
 *   http  + header-> StreamableHTTPClientTransport, static header via requestInit
 *   http  + oauth -> StreamableHTTPClientTransport, authProvider = vault provider
 *   (+ none for unauthenticated stdio/http)
 */

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport, getDefaultEnvironment } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

import type { Vault } from "../lib/vault.ts";
import { VERSION } from "../version.ts";
import { VaultOAuthClientProvider } from "./authProvider.ts";
import { type McpServerEntry, resolveServerSecrets } from "./registry.ts";

/** A tool as advertised by a server, trimmed to what the CLI/proxy surface needs. */
export interface McpToolInfo {
  name: string;
  description?: string;
  inputSchema?: unknown;
}

/** An open connection to one server. Always `close()` it when done. */
export interface McpConnection {
  client: Client;
  close(): Promise<void>;
}

/** Raised when an oauth server needs an interactive login before it can be used. */
export class McpAuthRequiredError extends Error {
  constructor(public readonly serverId: string) {
    super(`server '${serverId}' needs an OAuth login — run: phantombot mcp login ${serverId}`);
    this.name = "McpAuthRequiredError";
  }
}

/** Raised when a referenced vault secret is missing, with the exact keys to set. */
export class McpMissingSecretError extends Error {
  constructor(public readonly serverId: string, public readonly keys: string[]) {
    super(
      `server '${serverId}' is missing vault secret(s): ${keys.join(", ")} — set them with 'phantombot vault set <KEY> <value>'`,
    );
    this.name = "McpMissingSecretError";
  }
}

export interface ConnectOptions {
  /** Persona vault (open) for secret + OAuth-token resolution. */
  vault: Pick<Vault, "get" | "set" | "unset">;
  /** For oauth: called with the authorization URL if a login is triggered inline. Omit to fail with McpAuthRequiredError instead. */
  onAuthorizationUrl?: (url: URL) => void | Promise<void>;
  /** For oauth: the redirect_uri to register (loopback URL). Required if onAuthorizationUrl is set. */
  redirectUrl?: string;
}

/**
 * Connect to a registered server and return a live SDK Client. Throws
 * McpMissingSecretError / McpAuthRequiredError with actionable messages rather
 * than a raw transport error, so the agent knows exactly what the user must do.
 */
export async function connectServer(
  serverId: string,
  entry: McpServerEntry,
  opts: ConnectOptions,
): Promise<McpConnection> {
  const client = new Client({ name: "phantombot", version: VERSION });

  if (entry.transport === "stdio") {
    const { env, missing } = resolveServerSecrets(entry, opts.vault);
    if (missing.length > 0) throw new McpMissingSecretError(serverId, missing);
    const transport = new StdioClientTransport({
      command: entry.command!,
      args: entry.args ?? [],
      env: { ...getDefaultEnvironment(), ...env },
      stderr: "pipe",
    });
    await client.connect(transport);
    return { client, close: () => client.close() };
  }

  // http transport
  const auth = entry.auth ?? { type: "none" };
  const url = new URL(entry.url!);

  if (auth.type === "oauth") {
    const provider = new VaultOAuthClientProvider(opts.vault, {
      tokenRef: auth.tokenRef,
      // Without a real redirect (i.e. no interactive login in flight) we still
      // need a syntactically valid redirect_uri for the metadata; the loopback
      // URL is supplied only during `mcp login`.
      redirectUrl: opts.redirectUrl ?? "http://127.0.0.1:0/callback",
      scopes: auth.scopes,
      onAuthorizationUrl: opts.onAuthorizationUrl,
    });
    const transport = new StreamableHTTPClientTransport(url, { authProvider: provider });
    try {
      await client.connect(transport);
    } catch (err) {
      // The SDK throws UnauthorizedError when no valid token exists and no
      // interactive redirect handler was supplied. Surface it as an actionable
      // "run mcp login" instead of a raw stack.
      if (isUnauthorized(err)) throw new McpAuthRequiredError(serverId);
      throw err;
    }
    return { client, close: () => client.close() };
  }

  // none / header
  const headers: Record<string, string> = {};
  if (auth.type === "header") {
    const { headerValue, missing } = resolveServerSecrets(entry, opts.vault);
    if (missing.length > 0) throw new McpMissingSecretError(serverId, missing);
    if (headerValue !== undefined) headers[auth.header] = headerValue;
  }
  const transport = new StreamableHTTPClientTransport(url, {
    requestInit: Object.keys(headers).length > 0 ? { headers } : undefined,
  });
  await client.connect(transport);
  return { client, close: () => client.close() };
}

/** List a connected server's tools, trimmed to McpToolInfo. */
export async function listServerTools(client: Client): Promise<McpToolInfo[]> {
  const res = await client.listTools();
  return (res.tools ?? []).map((t) => ({
    name: t.name,
    description: t.description,
    inputSchema: t.inputSchema,
  }));
}

/** Call a tool. `args` is the tool's input object. Returns the raw SDK result. */
export async function callServerTool(
  client: Client,
  toolName: string,
  args: Record<string, unknown>,
): Promise<unknown> {
  return client.callTool({ name: toolName, arguments: args });
}

function isUnauthorized(err: unknown): boolean {
  if (err instanceof Error) {
    return err.name === "UnauthorizedError" || /unauthor/i.test(err.message);
  }
  return false;
}
