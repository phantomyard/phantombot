# MCP client support

Phantombot is a first-class **MCP (Model Context Protocol) consumer**. A persona
can declare MCP servers and reach their tools from any harness, through one
config + auth path — instead of a bespoke CLI wrapper per integration.

This document covers: the design, the `phantombot mcp` command surface, the
three auth methods, the zero-config-file setup flow, the lazy-discovery model,
and the account-connector isolation fix.

## Design principle — MCP is a phantombot-core primitive

MCP lives in **phantombot core**, surfaced exactly like `phantombot vault`,
`memory`, and `task`. Core owns three things and reuses the official
[`@modelcontextprotocol/sdk`](https://github.com/modelcontextprotocol/typescript-sdk)
for all of them — **we do not hand-roll the client, transports, or the OAuth
dance**:

- **connections** — stdio + Streamable HTTP, via the SDK's `Client`;
- **the registry** — which servers exist, per persona, in `<persona-dir>/mcp.json`;
- **the tokens/secrets** — in the existing encrypted per-persona vault.

Those upstreams are surfaced through **two faces over one shared set of
connections and one token store** (the [`McpHub`](../src/mcp/hub.ts)):

1. **A uniform CLI facade — `phantombot mcp`** (`add`, `list`, `describe`,
   `call`, `login`, `status`, `search`, `remove`, `help`). Because it's just a
   shell command, **every harness gets MCP for free** — including pi, which has
   no native MCP client.
2. **An optional loopback MCP proxy** — `phantombot mcp proxy` re-exposes the
   registered upstreams as a single aggregated MCP server on stdio, and
   MCP-native harnesses (Claude via `--mcp-config`, Codex via `mcp_servers`)
   point at that one proxy. Same connections, same vault tokens, one registry
   behind both.

## The three auth methods

The MCP ecosystem in practice uses three auth shapes. All three are vault-backed
and documented in `phantombot mcp help` so an agent can configure a server from
a pasted link — or say plainly that it isn't supported.

| Method   | Transport | What it is | Human step the agent relays |
|----------|-----------|------------|-----------------------------|
| `env`    | stdio     | Local server (npx/uvx/binary) that reads an API key from its env. Core injects the vault-resolved secret into the child. | "paste me your `<SERVICE>` API key" |
| `header` | http      | Remote server behind a static bearer token on a fixed header. Core attaches the vault-resolved header per request. | "generate a token at `<url>`, paste it" |
| `oauth`  | http      | Remote server behind interactive OAuth 2.1: PKCE + RFC 9728 protected-resource-metadata discovery + RFC 7591 dynamic client registration, all driven by the SDK's `OAuthClientProvider`. We implement only vault token storage + loopback redirect capture. | "I'll open a login link — approve it" |

**Google is an adapter under `oauth`**, not the core model — its
`client_secret.json` is a non-DCR variant. If a discovered server needs a shape
outside these three, the agent reports it as **unsupported** rather than
half-configuring it.

Secrets are always referenced **by vault key** in `mcp.json`, resolved only at
connection time. `mcp list`/`status`/`describe` never echo a secret value.

## Zero-config-file setup — the user never edits a file

Registering a server follows phantombot's standing rule that a human never
hand-writes config. The user's only input is human-level (a "Learn More" link,
and where unavoidable one pasted credential); the agent does the rest:

```
phantombot mcp add <id> --from-url <url>   # infer transport+auth, write mcp.json
phantombot mcp login <id>                  # (oauth) run the login flow
phantombot mcp status <id>                 # verify before reporting success
```

`mcp add --from-url` fetches the page/doc, infers the transport + which of the
three auth methods applies + any scopes, writes the registration on the agent's
behalf, and surfaces the one human step. `mcp.json` is an implementation detail
the user never sees.

## Lazy discovery — not eager injection

MCP tools are **never** dumped into every prompt (that bloats context and
degrades tool selection as the list grows). The default across all harnesses is
discovery-on-demand, modelled on `phantombot memory` and on phantombot's own
deferred-tool / `ToolSearch` primitive:

- **Always present (cheap):** a one-line persona-prompt hint that the
  `phantombot mcp` toolbox exists (see `MCP_TOOLS_SECTION` in
  `src/persona/builder.ts`). No upstream schemas loaded up front.
- **On demand:** `phantombot mcp search "<query>"` → `mcp describe <server>`
  (loads schemas for just that server) → `mcp call <server> <tool> --args '{…}'`.

For **pi (CLI facade):** identical to how it already reaches `vault`/`memory`/
`task`. For **Claude/Codex (proxy):** the loopback proxy exposes a discovery
meta-toolset (`mcp_search` / `mcp_describe` / `mcp_call`) rather than a flat dump
of every upstream tool.

## Account-connector isolation (Claude)

Phantombot's Claude harness authenticates with the operator's Claude Max OAuth
login, so **account-level claude.ai connectors** (IBKR, Gmail, Calendar, Drive —
bound to the account, not to any local config) would otherwise attach to every
foreground `claude --print` turn and inject their tool schemas + server
instructions into every phantombot prompt. They're wanted on Claude Desktop but
are noise (and an untrusted-input surface) inside phantombot.

The fix: **every** phantombot claude turn runs `--strict-mcp-config`, pointed at
phantombot's own registry (see `buildForegroundMcpConfig` in
`src/mcp/harnessConfig.ts`):

- persona has **no** registered servers → `{"mcpServers":{}}` (byte-identical to
  the long-standing nightly path; no child process). Account connectors are
  ignored, isolation holds.
- persona has **≥1** registered server → a single `phantombot mcp proxy` stdio
  server projecting the registry.

Background/nightly/threat-judge turns remain MCP-free (the pre-existing
`--strict-mcp-config` + empty-map hang fix). Claude Desktop is unaffected — the
account-wide connector settings are never touched.

> **Release note — behavior change.** After this upgrade, interactive
> (foreground) phantombot turns no longer see the account-level claude.ai
> connectors (Gmail, Google Calendar, Google Drive, IBKR). This is
> intentional — it stops those connectors injecting tool schemas and server
> instructions into every prompt — but if a workflow silently relied on one of
> them being present in a phantombot chat, register that server explicitly via
> `phantombot mcp add`. Claude Desktop keeps all connectors unchanged.

## Registry shape (`<persona-dir>/mcp.json`)

Written by the agent, never by the user. Secrets referenced by vault key. Tools
are namespaced by server id (`gmail__search`) to avoid collisions and make
provenance obvious.

```jsonc
{
  "mcpServers": {
    "some-remote": { "transport": "http",  "url": "https://…/mcp", "auth": { "type": "oauth",  "tokenRef": "MCP_SOME_OAUTH", "scopes": ["…"] } },
    "some-local":  { "transport": "stdio", "command": "npx", "args": ["-y","some-mcp"], "auth": { "type": "env", "env": { "API_KEY": "SOME_API_KEY_VAULTREF" } } },
    "some-header": { "transport": "http",  "url": "https://…/mcp", "auth": { "type": "header", "header": "Authorization", "valueRef": "SOME_BEARER_VAULTREF", "prefix": "Bearer " } }
  }
}
```

## Source map

| File | Responsibility |
|------|----------------|
| `src/mcp/registry.ts` | `mcp.json` schema, validation, CRUD, secret-ref resolution |
| `src/mcp/client.ts` | SDK client wrapper — build transport per auth method, connect/list/call |
| `src/mcp/authProvider.ts` | vault-backed `OAuthClientProvider` (persistence only) |
| `src/mcp/loopback.ts` | loopback HTTP listener for OAuth redirect capture |
| `src/mcp/login.ts` | OAuth login orchestration (begin / complete) |
| `src/mcp/hub.ts` | shared connection manager + lazy search behind both faces |
| `src/mcp/proxy.ts` | aggregated loopback MCP proxy (discovery meta-tools) |
| `src/mcp/discovery.ts` | `--from-url` best-effort inference |
| `src/mcp/harnessConfig.ts` | foreground `--mcp-config` projection (connector isolation) |
| `src/cli/mcp.ts` | the `phantombot mcp` command surface |
| `src/mcp/help.ts` | the agent-teaching `mcp help` contract |

## Verification status

Unit + integration tested here: the registry, secret resolution, the CLI
surface, the foreground isolation projection, the loopback capture, and — end to
end against a real stdio MCP server (`tests/fixtures/mcp-echo-server.ts`) — the
client connect/list/call path, env-secret injection, the hub, and the proxy
meta-tools over an in-memory transport.

Needs live verification against real endpoints (documented, not automatable in
CI): the `oauth` flow against a real provider (Google / GitHub remote MCP), a
`header` remote server, and the projected proxy running under a live
`claude --print` / `codex exec` turn.

**Binary weight.** The `@modelcontextprotocol/sdk` dependency adds **~640 KB**
to the compiled binary (arm64: 104.34 MB on `main` → 104.99 MB on this branch,
a +0.6% increase). Modest and expected for a first-class MCP client; noted so
the cost is visible.
