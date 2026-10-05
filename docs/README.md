# Phantombot documentation

Phantombot gives an AI harness a persistent identity, memory, secure
credentials, scheduled work, and access through chat, terminal, and editor
surfaces.

New here? Start with [Install Phantombot](getting-started/install.md), then
[complete the first run](getting-started/first-run.md).

## Set up and use Phantombot

- [Personas](how-to/personas.md) — create, import, isolate, and run personas.
- [Harnesses and models](how-to/harnesses-and-models.md) — choose native, Pi,
  Claude Code, or Codex and configure fallback.
- [Channels](how-to/channels.md) — connect Telegram and PhantomChat.
- [Group chats](how-to/group-chats.md) — routing, privacy mode, names, and bot
  participation.
- [Editors](how-to/editors.md) — use the same persona from VS Code, Zed, or
  JetBrains through ACP.
- [Voice](how-to/voice.md) — speech-to-text, text-to-speech, and reply behavior.
- [Scheduled tasks](how-to/scheduled-tasks.md) — persistent one-off and recurring
  work.
- [Memory](how-to/memory.md) — search, capture, inspect, back up, and restore.
- [MCP integrations](how-to/mcp.md) — connect external tools and accounts.
- [Secrets](how-to/secrets.md) — store persona-scoped credentials safely.
- [Shell completion](how-to/shell-completion.md) — enable command completion.
- [Import from OpenClaw](how-to/import-openclaw.md) — migrate an existing persona.

## Operate a real installation

- [Service lifecycle](operations/service-lifecycle.md) — start, stop, restart,
  inspect logs, and understand background services.
- [Configuration](operations/configuration.md) — config locations, precedence,
  persona overrides, and environment variables.
- [Environment variables](reference/environment.md) — operator overrides,
  internal harness context, and test-only controls.
- [Windows](operations/windows.md) — native Windows setup, Task Scheduler, PATH,
  and recovery.
- [macOS permissions](operations/macos-permissions.md) — repair repeated TCC
  permission prompts and signing.
- [Updates and release rings](operations/updates.md) — stable versus preview,
  verified updates, and rollback considerations.
- [Troubleshooting](operations/troubleshooting.md) — use `doctor`, logs, and
  harness detection to diagnose failures.
- [Concurrent work](operations/concurrency.md) — turn registry, background
  digests, notifications, and workspace locks.

## Understand the system

- [Architecture](concepts/architecture.md) — how messages, trust, context,
  harnesses, memory, and replies fit together.
- [Security and trust](concepts/security-and-trust.md) — principal versus
  untrusted input, threat screening, and capability boundaries.
- [Memory lifecycle](concepts/memory-lifecycle.md) — conversations, journal,
  drawers, nightly distillation, knowledge base, and retrieval.
- [Prompt cache](concepts/prompt-cache.md) — bounded context epochs and their
  security boundaries.
- [Decision model](concepts/decision-model.md) — optional typed decisions for
  screening and model routing.
- [P2P transport](concepts/p2p-transport.md) — relay-free PhantomChat transport.

## Build with or contribute to Phantombot

- [Engine API](reference/engine.md) — embed Phantombot in a Bun/TypeScript app.
- [Memory drawer API](reference/memory-drawers.md) — row identity, lifecycle,
  ranking, exports, imports, and third-party filing.
- [Add a harness](contributing/adding-a-harness.md) — implement and register a
  new harness.
- [AGENTS.md](../AGENTS.md) — repository invariants, testing rules, and
  contributor workflow.

For exact command syntax, use the installed version:

```bash
phantombot --help
phantombot <command> --help
```
