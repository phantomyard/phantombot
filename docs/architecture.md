# Architecture

## Goal

Run a chat agent (named "Phantom") on Telegram / Signal / Google Chat that delegates all model + tool work to a CLI harness (Claude Code being the default).

## What phantombot does

1. **Hosts persona files.** `agents/phantom/BOOT.md`, `MEMORY.md`, etc. live on disk. Phantombot reads them at boot and on a watch.
2. **Receives messages** from one or more channel adapters.
3. **Builds a turn context** for the configured agent: persona + retrieved memory + recent conversation + the new user message.
4. **Hands the turn to a harness.** The harness's CLI is invoked as a subprocess. Persona goes via `--system-prompt`. The user-side payload (history + new message) goes via stdin.
5. **Streams the harness's stdout** back to the user via the channel adapter. Partial messages from the harness become live channel updates if the adapter supports it; otherwise they're buffered and sent as one reply.
6. **Falls back** to the next harness in the configured chain on timeout, rate-limit, or non-recoverable error.
7. **Persists the turn** (user message + harness reply, plus minimal metadata) into SQLite for future memory retrieval.

## What phantombot does NOT do

- Translate `tools[]` arrays into anything. Each harness brings its own tools.
- Enforce permission gates on tool calls. The harness handles that (or doesn't — Claude Code can be run with `--permission-mode bypassPermissions`).
- Implement memory plugins, RAG-on-RAG, or vector DBs beyond a simple SQLite + sqlite-vec local store. If you need more, the harness can read/write external sources directly.
- Run a web UI, dashboard, status page, or admin panel. Logs go to stdout / journald. Health is checked with HTTP `GET /health` and `curl` (when the optional health server is on).

## Module map

| Module | Responsibility | Talks to |
|--------|----------------|----------|
| `src/index.ts` | Entry point. Loads config, instantiates adapters, registers harnesses, starts channels, optional health server. | `config`, `channels/*`, `harnesses/*`, `orchestrator/*` |
| `src/config.ts` | Reads env, validates required vars, resolves agent directory. | filesystem, env |
| `src/persona/loader.ts` | Reads `BOOT.md` / `MEMORY.md` / `tools.md` from the agent dir. | filesystem |
| `src/persona/builder.ts` | Concatenates persona pieces + retrieved memory + channel context into a system prompt string. | `persona/loader`, `memory/retriever` |
| `src/memory/store.ts` | SQLite + sqlite-vec wrapper. Stores turns. | `better-sqlite3` (TBD) |
| `src/memory/retriever.ts` | Given a query, returns the top-N relevant turns / notes. | `memory/store` |
| `src/channels/types.ts` | `ChannelAdapter` interface. | — |
| `src/channels/telegram.ts` | Telegram adapter. Long-poll or webhook. | `node:https` or `telegraf`/`grammy` (TBD) |
| `src/channels/signal.ts` | Signal adapter via signal-cli HTTP/JSON-RPC. | `signal-cli` HTTP wrapper |
| `src/channels/googlechat.ts` | Google Chat adapter via service account + Pub/Sub or webhook. | Google Chat API |
| `src/harnesses/types.ts` | `Harness` interface. | — |
| `src/harnesses/claude.ts` | `claude --print` wrapper. Reference implementation. | `claude` CLI |
| `src/harnesses/codex.ts` | `codex` (OpenAI Codex CLI) wrapper. Stub. | `codex` CLI |
| `src/harnesses/gemini.ts` | `gemini` CLI wrapper. Stub. | `gemini` CLI |
| `src/harnesses/pi.ts` | Pi Coding Agent wrapper. Stub. | `pi` CLI |
| `src/orchestrator/router.ts` | Decides which agent + which harness chain handles an incoming message. | persona, harness chain |
| `src/orchestrator/fallback.ts` | Runs a request through a harness chain until one succeeds. | harnesses |
| `src/heartbeat/scheduler.ts` | Optional. Schedules periodic "heartbeat" turns (self-checks, summaries). | orchestrator |
| `src/lib/logger.ts` | Structured logging. | stdout |

## End-to-end flow

```
Telegram message arrives
  → TelegramAdapter parses it into IncomingMessage
  → Orchestrator.handleIncoming(msg)
       → Router.resolve(msg) → { agent: 'phantom', harnesses: [claude, codex, gemini, pi] }
       → Persona.build({ agent, history, retrievedMemory, channelContext }) → systemPrompt
       → Fallback.run(harnesses, { systemPrompt, userMessage, history })
            → claude.invoke(req)
                 → spawn `claude --print --system-prompt <sys> --model opus --fallback-model sonnet --permission-mode bypassPermissions`
                 → write payload to stdin
                 → stream stdout chunks
                 → emit { type: 'text', text } / { type: 'progress' } / { type: 'done', finalText }
                 → on error/timeout: emit { type: 'error', recoverable: true|false }
            → if recoverable error: try codex.invoke(req), etc.
       → Memory.store(msg, finalReply)
       → TelegramAdapter.send({ conversationId, text: finalReply })
```

## Open design questions

These are deliberately not resolved in the skeleton; the first implementer should pick:

1. **Streaming vs buffered replies on Telegram.** Telegram supports message editing (Bot API `editMessageText`). Should phantombot edit a "🤔 thinking..." message live as the harness streams, or just send one final reply? Pro for live edits: feels more responsive on long turns. Con: Telegram has rate limits on edits (~1/sec).

2. **Harness session continuity.** The Claude harness can use `--session-id` + `--resume` for context persistence, but only if phantombot doesn't also re-send the full history. Decide whether OpenClaw-style "send everything every turn" or Claude-Code-native "resume sessions" wins. The skeleton goes with the former because it's simpler and the Anthropic prompt cache (5min TTL) limits the win from session-id when turns are spaced out.

3. **Memory store backend.** SQLite + `sqlite-vec` is the plan in this README. If `sqlite-vec` is too rough or licensing is awkward, fall back to a flat JSONL with grep-style retrieval — phantom's memory volume is low enough that a literal full-table scan over a year of conversations is fine. Don't over-engineer.

4. **Tool exposure to the harness.** Should phantombot constrain Claude Code via `--allowedTools` or let it have everything? Default in the skeleton: everything (`bypassPermissions`). Single-user system, trusted operator, the simplicity wins. Re-evaluate if multi-user.

5. **Heartbeat.** OpenClaw has scheduled "heartbeat" turns (every 30m for the assistant, every 1h for some agents). Worth porting? Maybe — but a systemd timer that calls `phantombot heartbeat` on a cron is simpler than building a scheduler inside the process. Defer until the basics work.

## Non-goals

- Multi-tenant. Phantombot is single-operator.
- Web UI. Use the chat itself.
- High availability. One process per host. If it dies, systemd restarts it. If the host dies, you have bigger problems.
- Plugins. The codebase is small enough that "fork it and edit" is the supported customization story.
