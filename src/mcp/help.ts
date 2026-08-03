/**
 * `phantombot mcp help` — the self-documenting contract that lets ANY harness's
 * agent stand up an MCP server from a human-pasted "Learn More" link, tell the
 * user exactly what to provide, or state plainly that the server isn't
 * supported.
 *
 * This text is load-bearing, not decoration: it is the only thing a fresh agent
 * turn reads to learn (a) that the three auth methods exist, (b) how to map a
 * discovered server onto one of them, (c) the exact human step each method
 * needs, and (d) where the supported boundary is. Keep it complete and current
 * — an agent that can't tell `env` from `oauth` from this text will half-
 * configure a server, which is worse than declining.
 */

/** The full `phantombot mcp help` body. Exported so a test can assert coverage. */
export const MCP_HELP = `phantombot mcp — connect this persona to MCP (Model Context Protocol) servers.

WHAT THIS IS
  MCP servers expose external tools/data (Google Drive, GitHub, Linear, a
  filesystem, Home Assistant, ...) over a standard protocol. Register one here
  and it becomes available to every persona turn — through the CLI on any
  harness, and natively projected into MCP-capable harnesses (Claude, Codex)
  via a single loopback proxy. You (the agent) manage this; the USER never
  edits a config file. Their only input is human-level: a "Learn More"/setup
  link, and — where unavoidable — one pasted credential.

THE THREE AUTH METHODS (this is the whole ecosystem in practice)
  Every standards-compliant MCP server falls into one of these. Pick the one
  the server's docs describe, then tell the user exactly what you need.

  1. env — LOCAL stdio server, secret in an environment variable.
     The common case: a package (npx/uvx/binary) run as a child process that
     reads an API key from its env. phantombot launches it with the secret
     injected from the vault.
       Register:  phantombot mcp add <id> --stdio --command npx \\
                    --args "-y,some-mcp-server" --env-secret API_KEY
       You then:  ask the user "paste me your <SERVICE> API key", and store it
                  with  phantombot vault set <VAULT_KEY> "<value>"
     The value lives ONLY in the vault; mcp.json holds the vault key, never the
     secret.

  2. header — REMOTE http server, static bearer token.
     A remote MCP endpoint authenticated by a fixed token on a header
     (typically Authorization: Bearer <token>).
       Register:  phantombot mcp add <id> --http --url https://.../mcp \\
                    --header Authorization --header-prefix "Bearer " \\
                    --value-ref <VAULT_KEY>
       You then:  tell the user "generate a token at <url> and paste it", then
                  phantombot vault set <VAULT_KEY> "<token>"

  3. oauth — REMOTE http server, interactive OAuth 2.1.
     The gold-standard interactive path: OAuth 2.1 + PKCE, auth-server
     discovery (RFC 9728 protected-resource-metadata) and dynamic client
     registration (RFC 7591), all driven by the official SDK. phantombot only
     stores the resulting tokens in the vault. Google's remote MCP servers are
     an adapter under THIS method — not a special case.
       Register:  phantombot mcp add <id> --http --url https://.../mcp --oauth \\
                    [--scopes "scope1,scope2"]
       You then:  run  phantombot mcp login <id>  — this prints an authorization
                  URL. Tell the user "open this link and approve"; the callback
                  is captured on a loopback listener and tokens are saved.

     PRE-REGISTERED CLIENT (skip-DCR) — for providers that REJECT dynamic client
     registration. Google's remote MCP servers are the main case: 'mcp login'
     fails with "does not support dynamic client registration". The fix: the
     user pre-registers an OAuth client in the provider console (Google Cloud
     Console → APIs & Services → Credentials → OAuth client ID → prefer type
     "Desktop app", which allows the loopback redirect on any port → Download
     JSON) and hands you the file. Attach it once and the SDK skips DCR:
       Register:  phantombot mcp add <id> --http --url https://.../mcp --oauth \\
                    --client-file ./credentials.json  [--scopes "..."]
                  (or pass --client-id/--client-secret directly). phantombot
                  reads the file, stores the client_id/secret in the vault, and
                  the file can be deleted.
       You then:  run  phantombot mcp login <id>  as usual.

  If a discovered server needs an auth shape OUTSIDE these three (a bespoke
  handshake, mutual TLS, a transport phantombot doesn't speak), say so plainly:
  it is not supported yet. Do NOT half-configure it.

REGISTERING FROM A "LEARN MORE" LINK (zero-config-file flow)
    phantombot mcp add <id> --from-url <url>
  Fetches the page/doc, infers the transport + which of the three auth methods
  applies + any required scopes, and writes mcp.json on your behalf. Then it
  tells you the one human step (paste a key / generate a token / approve a
  login) needed to finish. Always verify with  phantombot mcp status <id>
  before reporting success.

LAZY DISCOVERY (don't dump every tool into the prompt)
    phantombot mcp search "<query>"     find tools across registered servers
    phantombot mcp describe <id>        load the schemas for just one server
    phantombot mcp call <id> <tool> --args '{"...":"..."}'   invoke a tool
  Search first; only describe/load schemas when a task actually needs them —
  the same reflex as memory_search and the deferred-tool ToolSearch primitive.

COMMANDS
    add       register a server (--stdio/--http, an auth method, or --from-url)
    list      list registered servers (never prints secret values)
    describe  show one server's transport, auth, and (if reachable) its tools
    status    check whether a server is reachable + authenticated
    search    lazy tool discovery across registered servers
    call      invoke a tool on a server
    login     run the OAuth login flow for an oauth-auth server
    remove    unregister a server (optionally purge its vault secrets)
    help      this text

SECRETS
  Secrets are ALWAYS referenced by vault key in mcp.json and resolved only at
  connection time. list/status/describe never echo a secret value. Store
  credentials with  phantombot vault set NAME "value".
`;

/** Short per-method blurb, reused by `mcp add` when the agent omits an auth flag. */
export const MCP_AUTH_METHOD_SUMMARY = `Pick one auth method:
  --env-secret VAR         (env)    stdio server reads a vault secret as env VAR
  --value-ref KEY          (header) remote server, static bearer token from vault
  --oauth                  (oauth)  remote server, interactive OAuth 2.1 login
  (omit all three)         (none)   unauthenticated server`;
