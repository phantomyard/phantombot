/**
 * `phantombot mcp` — manage this persona's MCP (Model Context Protocol) servers.
 *
 * Surfaced exactly like `phantombot vault` / `memory` / `task`: a plain shell
 * command, so EVERY harness gets MCP for free (including pi, which has no native
 * MCP client). MCP-native harnesses (Claude/Codex) additionally get the same
 * servers projected natively via the loopback proxy (`phantombot mcp proxy`).
 *
 * Design rule honoured here: the USER never edits mcp.json. The agent runs these
 * commands; the only human input is a pasted "Learn More" link (--from-url) and,
 * where unavoidable, one pasted credential (stored via `phantombot vault set`).
 *
 * All the real logic lives in run* functions taking a WriteSink, so the surface
 * is unit-testable without spawning a process (mirrors cli/vault.ts).
 */

import { defineCommand } from "citty";
import { readFile } from "node:fs/promises";

import {
  loadConfig,
  personaDir,
  resolvePersona,
} from "../config.ts";
import type { WriteSink } from "../lib/io.ts";
import { openPersonaVault, type Vault } from "../lib/vault.ts";
import { staticClientVaultKey, writeStaticClient } from "../mcp/authProvider.ts";
import { discoverFromUrl } from "../mcp/discovery.ts";
import { parseOAuthClientFile, toClientInformation, type ParsedOAuthClient } from "../mcp/oauthClient.ts";
import { MCP_HELP } from "../mcp/help.ts";
import { McpHub } from "../mcp/hub.ts";
import { beginLogin, completeLogin } from "../mcp/login.ts";
import {
  loadRegistry,
  type McpAuth,
  type McpServerEntry,
  MCP_SERVER_ID,
  referencedVaultKeys,
  removeServer,
  saveRegistry,
  upsertServer,
} from "../mcp/registry.ts";

/** Resolve the persona dir the same way the rest of the CLI does. */
async function resolvePersonaDir(explicitPersona?: string): Promise<string> {
  const cfg = await loadConfig();
  const persona = resolvePersona(explicitPersona, cfg);
  return personaDir(cfg, persona);
}

/** Default vault key for an env secret: MCP_<ID>_<VAR>, upper-cased and shell-safe. */
export function defaultEnvVaultKey(serverId: string, envVar: string): string {
  const norm = (s: string) => s.toUpperCase().replace(/[^A-Z0-9]+/g, "_");
  return `MCP_${norm(serverId)}_${norm(envVar)}`;
}

/** Parse a repeated/comma-joined `--env-secret` value: "VAR" or "VAR=VAULT_KEY". */
export function parseEnvSecrets(serverId: string, raw: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!raw) return out;
  for (const item of raw.split(",").map((s) => s.trim()).filter(Boolean)) {
    const eq = item.indexOf("=");
    if (eq > 0) out[item.slice(0, eq)] = item.slice(eq + 1);
    else out[item] = defaultEnvVaultKey(serverId, item);
  }
  return out;
}

function csv(raw: string | undefined): string[] | undefined {
  if (raw === undefined) return undefined;
  const arr = raw.split(",").map((s) => s.trim()).filter(Boolean);
  return arr.length > 0 ? arr : undefined;
}

// ─── add ────────────────────────────────────────────────────────────────────

export interface McpAddInput {
  id: string;
  persona?: string;
  stdio?: boolean;
  http?: boolean;
  command?: string;
  args?: string;
  url?: string;
  envSecret?: string;
  valueRef?: string;
  header?: string;
  headerPrefix?: string;
  oauth?: boolean;
  tokenRef?: string;
  scopes?: string;
  /** oauth skip-DCR: path to a downloaded OAuth-client credentials.json. */
  clientFile?: string;
  /** oauth skip-DCR: client_id supplied directly (alternative to --client-file). */
  clientId?: string;
  /** oauth skip-DCR: client_secret supplied directly (paired with --client-id). */
  clientSecret?: string;
  fromUrl?: string;
  note?: string;
  dryRun?: boolean;
  out?: WriteSink;
  err?: WriteSink;
}

export async function runMcpAdd(input: McpAddInput): Promise<number> {
  const out = input.out ?? process.stdout;
  const err = input.err ?? process.stderr;
  if (!MCP_SERVER_ID.test(input.id)) {
    err.write(`invalid server id '${input.id}': lowercase letters, digits, '-' or '_'.\n`);
    return 2;
  }

  // --from-url: heuristic discovery. Fills in the flags the agent didn't give.
  let discovered: Awaited<ReturnType<typeof discoverFromUrl>> | undefined;
  if (input.fromUrl) {
    discovered = await discoverFromUrl(input.fromUrl);
    for (const n of discovered.notes) out.write(`• ${n}\n`);
    if (!discovered.actionable && !input.stdio && !input.http) {
      err.write("Discovery was inconclusive — not writing a registration. Ask the user for details or treat as unsupported.\n");
      return 1;
    }
  }

  const transport = pickTransport(input, discovered);
  if (!transport) {
    err.write("Specify a transport: --stdio (local) or --http (remote), or use --from-url.\n");
    return 2;
  }

  let entry: McpServerEntry;
  try {
    entry = transport === "stdio"
      ? buildStdioEntry(input, discovered)
      : buildHttpEntry(input, discovered);
  } catch (e) {
    err.write(`${(e as Error).message}\n`);
    return 2;
  }
  if (input.fromUrl) entry.note = input.note ?? input.fromUrl;
  else if (input.note) entry.note = input.note;

  // Pre-registered OAuth client (skip-DCR): parse it now so a bad file fails
  // before we write anything.
  let preClient: ParsedOAuthClient | undefined;
  if (input.clientFile || input.clientId) {
    if (entry.auth?.type !== "oauth") {
      err.write("--client-file/--client-id only apply to an oauth server (add --oauth too).\n");
      return 2;
    }
    try {
      preClient = input.clientFile
        ? parseOAuthClientFile(await readFile(input.clientFile, "utf8"))
        : { clientId: input.clientId!, clientSecret: input.clientSecret };
    } catch (e) {
      err.write(`${(e as Error).message}\n`);
      return 2;
    }
  }

  const tokenRef = entry.auth?.type === "oauth" ? entry.auth.tokenRef : undefined;

  if (input.dryRun) {
    out.write(JSON.stringify({ [input.id]: entry }, null, 2) + "\n");
    if (preClient && tokenRef) {
      out.write(
        `  would store pre-registered client ${preClient.clientId} ` +
          `(secret: ${preClient.clientSecret ? "yes" : "no"}) in vault key ${staticClientVaultKey(tokenRef)}\n`,
      );
    }
    printNextSteps(input.id, entry, out, { hasStaticClient: Boolean(preClient) });
    return 0;
  }

  const dir = await resolvePersonaDir(input.persona);

  // Write the vault client secret BEFORE the registry entry. The registry is
  // what agents read to reach a server; if we registered first and the vault
  // write then failed, we'd leave a server registered without its stored
  // client. Ordering the vault write first keeps that invariant intact.
  if (preClient && tokenRef) {
    const vault = await openPersonaVault(dir);
    try {
      writeStaticClient(vault, tokenRef, toClientInformation(preClient));
    } finally {
      vault.close();
    }
    out.write(
      `  stored pre-registered OAuth client ${preClient.clientId} in the vault ` +
        `(DCR will be skipped for this server)\n`,
    );
  }

  const registry = await loadRegistry(dir);
  await saveRegistry(dir, upsertServer(registry, input.id, entry));
  out.write(`registered MCP server '${input.id}' (${transport})\n`);

  printNextSteps(input.id, entry, out, { hasStaticClient: Boolean(preClient) });
  return 0;
}

function pickTransport(input: McpAddInput, d?: { transport?: "stdio" | "http" }): "stdio" | "http" | undefined {
  if (input.stdio) return "stdio";
  if (input.http) return "http";
  if (input.command) return "stdio";
  if (input.url) return "http";
  return d?.transport;
}

function buildStdioEntry(input: McpAddInput, d?: { command?: string; args?: string[]; auth?: string }): McpServerEntry {
  const command = input.command ?? d?.command;
  if (!command) throw new Error("stdio transport needs --command");
  const args = csv(input.args) ?? d?.args;
  const env = parseEnvSecrets(input.id, input.envSecret);
  const auth: McpAuth = Object.keys(env).length > 0 ? { type: "env", env } : { type: "none" };
  return { transport: "stdio", command, ...(args ? { args } : {}), auth };
}

function buildHttpEntry(input: McpAddInput, d?: { url?: string; auth?: string; scopes?: string[] }): McpServerEntry {
  const url = input.url ?? d?.url;
  if (!url) throw new Error("http transport needs --url");
  let auth: McpAuth;
  if (input.oauth || d?.auth === "oauth") {
    auth = { type: "oauth", tokenRef: input.tokenRef ?? defaultEnvVaultKey(input.id, "OAUTH") };
    const scopes = csv(input.scopes) ?? d?.scopes;
    if (scopes) (auth as { scopes?: string[] }).scopes = scopes;
  } else if (input.valueRef || input.header || d?.auth === "header") {
    auth = {
      type: "header",
      header: input.header ?? "Authorization",
      valueRef: input.valueRef ?? defaultEnvVaultKey(input.id, "TOKEN"),
      ...(input.headerPrefix ? { prefix: input.headerPrefix } : {}),
    };
  } else {
    auth = { type: "none" };
  }
  return { transport: "http", url, auth };
}

function printNextSteps(
  id: string,
  entry: McpServerEntry,
  out: WriteSink,
  opts: { hasStaticClient?: boolean } = {},
): void {
  const auth = entry.auth ?? { type: "none" };
  switch (auth.type) {
    case "env":
      for (const [v, key] of Object.entries(auth.env)) {
        out.write(`  next: ask the user for '${v}', then  phantombot vault set ${key} "<value>"\n`);
      }
      break;
    case "header":
      out.write(`  next: ask the user to generate a token, then  phantombot vault set ${auth.valueRef} "<token>"\n`);
      break;
    case "oauth":
      if (!opts.hasStaticClient) {
        out.write(
          `  note: if 'mcp login' reports the server "does not support dynamic client registration",\n` +
            `        the user must pre-register an OAuth client and re-run add with --client-file <credentials.json>\n`,
        );
      }
      out.write(`  next: run  phantombot mcp login ${id}  and have the user approve the login link\n`);
      break;
    default:
      out.write(`  next: verify with  phantombot mcp status ${id}\n`);
  }
}

// ─── list ─────────────────────────────────────────────────────────────────────

export async function runMcpList(input: { persona?: string; out?: WriteSink } = {}): Promise<number> {
  const out = input.out ?? process.stdout;
  const dir = await resolvePersonaDir(input.persona);
  const registry = await loadRegistry(dir);
  const ids = Object.keys(registry.mcpServers);
  if (ids.length === 0) {
    out.write("(no MCP servers registered)\n");
    return 0;
  }
  for (const id of ids.sort()) {
    const e = registry.mcpServers[id]!;
    const target = e.transport === "stdio" ? `${e.command} ${(e.args ?? []).join(" ")}`.trim() : e.url;
    out.write(`${id}  [${e.transport}, auth=${(e.auth ?? { type: "none" }).type}]  ${target}\n`);
  }
  return 0;
}

// ─── remove ───────────────────────────────────────────────────────────────────

export async function runMcpRemove(input: {
  id: string;
  persona?: string;
  purge?: boolean;
  out?: WriteSink;
  err?: WriteSink;
}): Promise<number> {
  const out = input.out ?? process.stdout;
  const err = input.err ?? process.stderr;
  const dir = await resolvePersonaDir(input.persona);
  const registry = await loadRegistry(dir);
  const entry = registry.mcpServers[input.id];
  const { registry: next, removed } = removeServer(registry, input.id);
  if (!removed) {
    err.write(`no such MCP server: '${input.id}'\n`);
    return 1;
  }
  await saveRegistry(dir, next);
  out.write(`removed MCP server '${input.id}'\n`);
  if (input.purge && entry) {
    const keys = referencedVaultKeys(entry);
    if (keys.length > 0) {
      const vault = await openPersonaVault(dir);
      try {
        for (const k of keys) vault.unset(k);
      } finally {
        vault.close();
      }
      out.write(`  purged vault secrets: ${keys.join(", ")}\n`);
    }
  }
  return 0;
}

// ─── describe / status / search / call (need a live hub) ──────────────────────

async function withHub<T>(
  persona: string | undefined,
  fn: (hub: McpHub, vault: Vault) => Promise<T>,
): Promise<T> {
  const dir = await resolvePersonaDir(persona);
  const registry = await loadRegistry(dir);
  const vault = await openPersonaVault(dir);
  const hub = new McpHub(registry, vault);
  try {
    return await fn(hub, vault);
  } finally {
    await hub.close();
    vault.close();
  }
}

export async function runMcpDescribe(input: { id: string; persona?: string; out?: WriteSink; err?: WriteSink }): Promise<number> {
  const out = input.out ?? process.stdout;
  const err = input.err ?? process.stderr;
  return withHub(input.persona, async (hub) => {
    if (!hub.entry(input.id)) {
      err.write(`no such MCP server: '${input.id}'\n`);
      return 1;
    }
    try {
      const tools = await hub.tools(input.id);
      out.write(`${input.id}: ${tools.length} tool(s)\n`);
      for (const t of tools) out.write(`  ${t.name}  —  ${t.description ?? "(no description)"}\n`);
      return 0;
    } catch (e) {
      err.write(`${(e as Error).message}\n`);
      return 1;
    }
  });
}

export async function runMcpStatus(input: { id?: string; persona?: string; out?: WriteSink }): Promise<number> {
  const out = input.out ?? process.stdout;
  return withHub(input.persona, async (hub) => {
    const ids = input.id ? [input.id] : hub.serverIds();
    if (ids.length === 0) {
      out.write("(no MCP servers registered)\n");
      return 0;
    }
    let anyBad = false;
    for (const id of ids) {
      if (!hub.entry(id)) {
        out.write(`${id}: not registered\n`);
        anyBad = true;
        continue;
      }
      try {
        const tools = await hub.tools(id);
        out.write(`${id}: OK — reachable, ${tools.length} tool(s)\n`);
      } catch (e) {
        anyBad = true;
        out.write(`${id}: NOT READY — ${(e as Error).message}\n`);
      }
    }
    return anyBad ? 1 : 0;
  });
}

export async function runMcpSearch(input: { query: string; persona?: string; out?: WriteSink }): Promise<number> {
  const out = input.out ?? process.stdout;
  return withHub(input.persona, async (hub) => {
    const { hits, errors } = await hub.search(input.query);
    if (hits.length === 0) out.write("(no matching tools)\n");
    for (const h of hits) out.write(`${h.qualifiedName}  —  ${h.tool.description ?? ""}\n`);
    for (const [id, msg] of Object.entries(errors)) out.write(`! ${id} unreachable: ${msg}\n`);
    return 0;
  });
}

export async function runMcpCall(input: {
  id: string;
  tool: string;
  args?: string;
  persona?: string;
  out?: WriteSink;
  err?: WriteSink;
}): Promise<number> {
  const out = input.out ?? process.stdout;
  const err = input.err ?? process.stderr;
  let parsedArgs: Record<string, unknown> = {};
  if (input.args) {
    try {
      parsedArgs = JSON.parse(input.args) as Record<string, unknown>;
    } catch (e) {
      err.write(`--args must be a JSON object: ${(e as Error).message}\n`);
      return 2;
    }
  }
  return withHub(input.persona, async (hub) => {
    if (!hub.entry(input.id)) {
      err.write(`no such MCP server: '${input.id}'\n`);
      return 1;
    }
    try {
      const result = await hub.call(input.id, input.tool, parsedArgs);
      out.write(JSON.stringify(result, null, 2) + "\n");
      return 0;
    } catch (e) {
      err.write(`${(e as Error).message}\n`);
      return 1;
    }
  });
}

// ─── login ────────────────────────────────────────────────────────────────────

/**
 * How long `mcp login` keeps the loopback listener open awaiting the browser
 * redirect when the user doesn't pass `--wait`. Chosen to comfortably cover a
 * human clicking through a provider's consent screen. `--wait 0` opts out.
 */
export const DEFAULT_LOGIN_WAIT_MS = 180_000;

export async function runMcpLogin(input: {
  id: string;
  persona?: string;
  code?: string;
  redirectUrl?: string;
  waitMs?: number;
  out?: WriteSink;
  err?: WriteSink;
}): Promise<number> {
  const out = input.out ?? process.stdout;
  const err = input.err ?? process.stderr;
  const dir = await resolvePersonaDir(input.persona);
  const registry = await loadRegistry(dir);
  const entry = registry.mcpServers[input.id];
  if (!entry) {
    err.write(`no such MCP server: '${input.id}'\n`);
    return 1;
  }
  const vault = await openPersonaVault(dir);
  try {
    if (input.code) {
      if (!input.redirectUrl) {
        err.write("completing a login with --code also needs --redirect-url (the one printed when the flow began).\n");
        return 2;
      }
      await completeLogin(input.id, entry, vault, input.code, input.redirectUrl);
      out.write(`'${input.id}' authorized.\n`);
      return 0;
    }
    // Default: hold the loopback listener open long enough for the user to
    // approve in the browser and get redirected back. Without this the listener
    // was torn down the instant the URL was printed, so the callback always hit
    // a dead port (ERR_CONNECTION_REFUSED) — even on the same host. Pass
    // `--wait 0` to opt out and drive the manual `--code` path from the start.
    const waitMs = input.waitMs ?? DEFAULT_LOGIN_WAIT_MS;
    const result = await beginLogin(input.id, entry, vault, {
      waitForRedirectMs: waitMs,
      onUrl: (url) => out.write(`Open this URL and approve:\n  ${url}\n`),
      onWaiting: ({ redirectUrl }) =>
        out.write(
          `Waiting up to ${Math.round(waitMs / 1000)}s for you to approve in the browser…\n` +
            `If the browser is on another machine and can't reach this host, copy the '?code='\n` +
            `value from the redirect URL and run:\n` +
            `  phantombot mcp login ${input.id} --code <CODE> --redirect-url ${redirectUrl}\n`,
        ),
    });
    if (result.status === "authorized") {
      out.write(`'${input.id}' authorized.\n`);
      return 0;
    }
    out.write(
      `\nNo redirect received yet. Copy the '?code=' value from the redirect and run:\n` +
        `  phantombot mcp login ${input.id} --code <CODE> --redirect-url ${result.redirectUrl}\n`,
    );
    return 0;
  } catch (e) {
    const msg = (e as Error).message;
    err.write(`${msg}\n`);
    // Google (and some others) reject RFC 7591 DCR. If that's the failure and
    // no pre-registered client is stored yet, point the agent at the skip-DCR
    // path rather than leaving a dead end.
    if (/dynamic client registration/i.test(msg) && entry.auth?.type === "oauth") {
      const hasStatic = vault.get(staticClientVaultKey(entry.auth.tokenRef)) !== undefined;
      if (!hasStatic) {
        err.write(
          `\nThis server needs a pre-registered OAuth client. Have the user create one in the\n` +
            `provider's console (e.g. Google Cloud Console → Credentials → OAuth client ID →\n` +
            `Download JSON), then attach it and retry:\n` +
            `  phantombot mcp add ${input.id} --http --url <url> --oauth --client-file <credentials.json>\n` +
            `  phantombot mcp login ${input.id}\n`,
        );
      }
    }
    return 1;
  } finally {
    vault.close();
  }
}

// ─── proxy ────────────────────────────────────────────────────────────────────

async function runMcpProxy(persona?: string): Promise<number> {
  const dir = await resolvePersonaDir(persona);
  const registry = await loadRegistry(dir);
  const vault = await openPersonaVault(dir);
  const hub = new McpHub(registry, vault);
  const { runProxyStdio } = await import("../mcp/proxy.ts");
  try {
    await runProxyStdio(hub);
    return 0;
  } finally {
    vault.close();
  }
}

// ─── citty surface ────────────────────────────────────────────────────────────

const personaArg = { persona: { type: "string" as const, description: "Persona whose registry to use. Defaults to PHANTOMBOT_PERSONA / default persona." } };

export default defineCommand({
  meta: {
    name: "mcp",
    description:
      "Connect this persona to MCP servers (three auth methods: env/header/oauth). The agent manages these; the user never edits a config file. Run `phantombot mcp help` for the full guide.",
  },
  subCommands: {
    help: defineCommand({
      meta: { name: "help", description: "Full guide: the three auth methods and the zero-config-file setup flow (for agents)." },
      run() {
        process.stdout.write(MCP_HELP);
      },
    }),
    add: defineCommand({
      meta: { name: "add", description: "Register a server. Use --stdio/--http with an auth method, or --from-url <link> for guided discovery." },
      args: {
        id: { type: "positional", required: true, description: "Server id (lowercase, e.g. 'github')." },
        ...personaArg,
        stdio: { type: "boolean", description: "Local stdio server." },
        http: { type: "boolean", description: "Remote http server." },
        command: { type: "string", description: "stdio: command to spawn (e.g. npx)." },
        args: { type: "string", description: "stdio: comma-separated argv (e.g. '-y,some-mcp')." },
        url: { type: "string", description: "http: the MCP endpoint URL." },
        "env-secret": { type: "string", description: "env auth: 'VAR' or 'VAR=VAULT_KEY' (repeat via comma). Injects the vault secret into the stdio child." },
        "value-ref": { type: "string", description: "header auth: vault key holding the bearer token." },
        header: { type: "string", description: "header auth: header name (default Authorization)." },
        "header-prefix": { type: "string", description: "header auth: scheme prefix, e.g. 'Bearer '." },
        oauth: { type: "boolean", description: "oauth auth: interactive OAuth 2.1 (finish with `mcp login`)." },
        "token-ref": { type: "string", description: "oauth auth: vault key stem for tokens (default derived)." },
        scopes: { type: "string", description: "oauth auth: comma-separated scopes." },
        "client-file": { type: "string", description: "oauth auth: path to a downloaded OAuth-client credentials.json (skip-DCR; e.g. Google). Stored in the vault." },
        "client-id": { type: "string", description: "oauth auth: OAuth client_id supplied directly (alternative to --client-file)." },
        "client-secret": { type: "string", description: "oauth auth: OAuth client_secret (paired with --client-id)." },
        "from-url": { type: "string", description: "Infer transport+auth from a pasted 'Learn More' link and write the registration." },
        note: { type: "string", description: "Freeform note (e.g. the setup link)." },
        "dry-run": { type: "boolean", description: "Print the entry that would be written, don't save." },
      },
      async run({ args }) {
        process.exitCode = await runMcpAdd({
          id: String(args.id),
          persona: args.persona ? String(args.persona) : undefined,
          stdio: Boolean(args.stdio),
          http: Boolean(args.http),
          command: args.command ? String(args.command) : undefined,
          args: args.args ? String(args.args) : undefined,
          url: args.url ? String(args.url) : undefined,
          envSecret: args["env-secret"] ? String(args["env-secret"]) : undefined,
          valueRef: args["value-ref"] ? String(args["value-ref"]) : undefined,
          header: args.header ? String(args.header) : undefined,
          headerPrefix: args["header-prefix"] ? String(args["header-prefix"]) : undefined,
          oauth: Boolean(args.oauth),
          tokenRef: args["token-ref"] ? String(args["token-ref"]) : undefined,
          scopes: args.scopes ? String(args.scopes) : undefined,
          clientFile: args["client-file"] ? String(args["client-file"]) : undefined,
          clientId: args["client-id"] ? String(args["client-id"]) : undefined,
          clientSecret: args["client-secret"] ? String(args["client-secret"]) : undefined,
          fromUrl: args["from-url"] ? String(args["from-url"]) : undefined,
          note: args.note ? String(args.note) : undefined,
          dryRun: Boolean(args["dry-run"]),
        });
      },
    }),
    list: defineCommand({
      meta: { name: "list", description: "List registered servers (never prints secret values)." },
      args: { ...personaArg },
      async run({ args }) {
        process.exitCode = await runMcpList({ persona: args.persona ? String(args.persona) : undefined });
      },
    }),
    describe: defineCommand({
      meta: { name: "describe", description: "Show one server's tools + schemas (connects to it)." },
      args: { id: { type: "positional", required: true, description: "Server id." }, ...personaArg },
      async run({ args }) {
        process.exitCode = await runMcpDescribe({ id: String(args.id), persona: args.persona ? String(args.persona) : undefined });
      },
    }),
    status: defineCommand({
      meta: { name: "status", description: "Check whether server(s) are reachable + authenticated." },
      args: { id: { type: "positional", required: false, description: "Server id (omit for all)." }, ...personaArg },
      async run({ args }) {
        process.exitCode = await runMcpStatus({ id: args.id ? String(args.id) : undefined, persona: args.persona ? String(args.persona) : undefined });
      },
    }),
    search: defineCommand({
      meta: { name: "search", description: "Lazy tool discovery across registered servers." },
      args: { query: { type: "positional", required: false, description: "Keywords (omit to list all)." }, ...personaArg },
      async run({ args }) {
        process.exitCode = await runMcpSearch({ query: args.query ? String(args.query) : "", persona: args.persona ? String(args.persona) : undefined });
      },
    }),
    call: defineCommand({
      meta: { name: "call", description: "Invoke a tool on a server." },
      args: {
        id: { type: "positional", required: true, description: "Server id." },
        tool: { type: "positional", required: true, description: "Tool name (unqualified)." },
        args: { type: "string", description: "Tool arguments as a JSON object." },
        ...personaArg,
      },
      async run({ args }) {
        process.exitCode = await runMcpCall({
          id: String(args.id),
          tool: String(args.tool),
          args: args.args ? String(args.args) : undefined,
          persona: args.persona ? String(args.persona) : undefined,
        });
      },
    }),
    login: defineCommand({
      meta: { name: "login", description: "Run the OAuth login flow for an oauth-auth server." },
      args: {
        id: { type: "positional", required: true, description: "Server id." },
        code: { type: "string", description: "Complete a login with a pasted authorization code." },
        "redirect-url": { type: "string", description: "The redirect URL printed when the flow began (needed with --code)." },
        wait: { type: "string", description: "Milliseconds to hold the loopback listener open for the browser redirect (default 180000; '0' = manual --code path only)." },
        ...personaArg,
      },
      async run({ args }) {
        process.exitCode = await runMcpLogin({
          id: String(args.id),
          persona: args.persona ? String(args.persona) : undefined,
          code: args.code ? String(args.code) : undefined,
          redirectUrl: args["redirect-url"] ? String(args["redirect-url"]) : undefined,
          waitMs: args.wait ? Number(args.wait) : undefined,
        });
      },
    }),
    remove: defineCommand({
      meta: { name: "remove", description: "Unregister a server (optionally purge its vault secrets)." },
      args: {
        id: { type: "positional", required: true, description: "Server id." },
        purge: { type: "boolean", description: "Also delete the server's secrets from the vault." },
        ...personaArg,
      },
      async run({ args }) {
        process.exitCode = await runMcpRemove({
          id: String(args.id),
          persona: args.persona ? String(args.persona) : undefined,
          purge: Boolean(args.purge),
        });
      },
    }),
    proxy: defineCommand({
      meta: { name: "proxy", description: "Run the aggregated loopback MCP proxy on stdio (used by MCP-native harnesses)." },
      args: { ...personaArg },
      async run({ args }) {
        process.exitCode = await runMcpProxy(args.persona ? String(args.persona) : undefined);
      },
    }),
  },
});
