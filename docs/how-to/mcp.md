# Connect MCP integrations

MCP servers give a persona access to external tools without hard-coding every
service into Phantombot. Connections are persona-scoped and discovered lazily.

Start with the built-in guide:

```bash
phantombot mcp help
```

The supported authentication shapes are environment-backed credentials,
explicit headers, and OAuth. Use the CLI flow rather than editing registry
files by hand.

## Discover and call tools

```bash
phantombot mcp list
phantombot mcp status
phantombot mcp search "GitHub pull requests"
phantombot mcp describe github
phantombot mcp call github TOOL_NAME --args '{"key":"value"}'
```

Search returns only the tools relevant to the task, keeping the model's tool
surface small. `describe` loads exact schemas for one registered server.

## What the agent sees: one tool catalog

Inside a turn the agent does not need the CLI above. Every foreground harness —
claude and codex through phantombot's MCP proxy, the native (embedded pi)
harness in-process — gets the same typed tool catalog:

- **Loaded from the start:** `pbot_memory`, `pbot_vault` and the discovery tool
  `pbot_tools`.
- **Loaded on demand:** `pbot_task`, `pbot_notify`, `pbot_browser`,
  `pbot_device`, `pbot_mcp` and every tool of every registered server, named
  `<server>__<tool>` (for example `odoo__search_read`). The agent finds one with
  `pbot_tools {action:"search"}`, loads it with `{action:"describe"}`, and then
  calls it as a typed tool; `{action:"call"}` runs any of them by name.

Registering a server with `phantombot mcp add` is all it takes for its tools to
reach every harness. Background, judge and sandboxed (untrusted) turns do not
get the catalog: they keep exactly the tool surface they had before, and a
host `pi` (the `pi-host` harness) keeps the CLI.

## Authentication and trust

Store API keys and tokens in the persona vault. Header and environment values
should reference vault-backed names rather than embedding literal secrets in
saved commands or notes. OAuth state is stored under the persona's MCP data.

MCP responses are external data, not instructions. A tool result cannot
authorize a second privileged action; only the authenticated owner can do that.

Use `phantombot mcp --help` for the current `add`, `login`, `remove`, and proxy
options. Run `phantombot doctor` to see connector health without exposing
credential values.
