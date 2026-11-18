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

Native coding-model swaps retry empty replies alongside eligible provider
errors: up to three coder attempts, then the primary-model fallback. An attempt
that already streamed usable text or tool progress is never replayed.

## Bring your own endpoint

The native harness can point Pi at an endpoint that is not in Pi's own provider
catalogue — no extension, no hand-edited config file:

| Provider | What it is for |
|---|---|
| **openai-compatible** | Any server speaking the OpenAI Chat Completions API — vLLM, Ollama, llama.cpp, LM Studio, LocalAI, a proxy. You supply the base URL; an unauthenticated server is a valid setup. |
| **phantomops** | A [PhantomOps](https://phantomops.app) personal API token (`pok_…`). One credential and nothing else: `phantomops/auto` runs your full phantom server-side, and the wizard asks for the token then goes straight to the connection test — no model picker. The raw catalogue models stay reachable through the normal model pickers afterwards. |

Both are offered in `phantombot harness` (and Brain in the TUI) with or without
a key. Phantombot writes the provider's entry into the native agent dir, keeps
the key in the vault and relays it per turn like any other provider — the
credential is never written into that entry.

## Persona overrides and credentials

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
