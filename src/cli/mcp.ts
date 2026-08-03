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

import { loadConfig, personaDir } from "../config.ts";
import type { WriteSink } from "../lib/io.ts";
import { openPersonaVault, type Vault } from "../lib/vault.ts";
import { discoverFromUrl } from "../mcp/discovery.ts";
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
  const persona = explicitPersona || process.env.PHANTOMBOT_PERSONA || cfg.defaultPersona;
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

  if (input.dryRun) {
    out.write(JSON.stringify({ [input.id]: entry }, null, 2) + "\n");
    printNextSteps(input.id, entry, out);
    return 0;
  }

  const dir = await resolvePersonaDir(input.persona);
  const registry = await loadRegistry(dir);
  await saveRegistry(dir, upsertServer(registry, input.id, entry));
  out.write(`registered MCP server '${input.id}' (${transport})\n`);
  printNextSteps(input.id, entry, out);
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

function printNextSteps(id: string, entry: McpServerEntry, out: WriteSink): void {
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
    const result = await beginLogin(input.id, entry, vault, {
      waitForRedirectMs: input.waitMs ?? 0,
      onUrl: (url) => out.write(`Open this URL and approve:\n  ${url}\n`),
    });
    if (result.status === "authorized") {
      out.write(`'${input.id}' authorized.\n`);
      return 0;
    }
    out.write(
      `Waiting for approval. If the browser can't reach this host, copy the '?code=' value from the redirect and run:\n` +
        `  phantombot mcp login ${input.id} --code <CODE> --redirect-url ${result.redirectUrl}\n`,
    );
    return 0;
  } catch (e) {
    err.write(`${(e as Error).message}\n`);
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
        wait: { type: "string", description: "Wait up to N ms for the browser redirect on the loopback listener." },
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
