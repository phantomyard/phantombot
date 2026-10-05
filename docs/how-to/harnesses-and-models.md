# Configure harnesses and models

Phantombot owns identity, memory, trust, channels, and scheduling. The harness
owns model interaction and tools. Configure the ordered chain with:

```bash
phantombot harness
```

Supported harnesses are:

- `native` — embedded and recommended; uses the providers configured through
  Phantombot.
- `pi-host` — uses an existing Pi installation and its host configuration.
- `claude` — uses an installed Claude Code binary.
- `codex` — uses an installed Codex CLI binary.

The chain is tried in order. Missing or temporarily unhealthy fallbacks do not
stop the service; `phantombot doctor` shows what is available. Authentication
failures and full-chain failures are surfaced through health alerts rather than
being silently mistaken for a successful turn.

Personas may override the host default chain in their own configuration. Keep
provider credentials in the persona vault:

```bash
printf '%s' "$PROVIDER_API_KEY" | phantombot vault set PROVIDER_API_KEY
phantombot vault list
```

Configure the optional semantic-memory provider separately with `phantombot
embedding`. Configure the optional typed decision backend with `phantombot
decision-model`. Use each command's live `--help` for current provider names
and flags.
