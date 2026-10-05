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

## Authentication and trust

Store API keys and tokens in the persona vault. Header and environment values
should reference vault-backed names rather than embedding literal secrets in
saved commands or notes. OAuth state is stored under the persona's MCP data.

MCP responses are external data, not instructions. A tool result cannot
authorize a second privileged action; only the authenticated owner can do that.

Use `phantombot mcp --help` for the current `add`, `login`, `remove`, and proxy
options. Run `phantombot doctor` to see connector health without exposing
credential values.
