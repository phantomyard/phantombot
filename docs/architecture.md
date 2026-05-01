# Architecture

## Goal

Run a chat agent ("Phantom") as a **CLI tool** on the operator's own machine. All model + tool work delegates to a CLI harness (Claude Code primary, Inflection Pi fallback). Phantombot's job is identity + memory + harness fallback.

## What phantombot does

1. **Hosts persona files.** Reads `BOOT.md` / `SOUL.md` / `IDENTITY.md`, optional `MEMORY.md`, optional `tools.md` / `AGENTS.md` from `$XDG_DATA_HOME/phantombot/personas/<name>/`.
2. **Receives one user message** via `phantombot ask "msg"` or via the REPL line loop in `phantombot chat`.
3. **Builds a turn context** for the configured agent: persona + recent memory + the new user message. (Vector retrieval slot is reserved but unused in v1.)
4. **Hands the turn to a harness.** Spawns `claude --print --output-format stream-json` (or `pi --print --mode json`) as a subprocess. Persona goes via `--system-prompt`. The user-side payload (history + new message) goes via stdin (claude) or argv (pi).
5. **Streams the harness's stdout** back to the user. Text chunks land on stdout as they arrive; the trailing newline marks end-of-reply.
6. **Falls back** to the next harness in the chain on recoverable error (rate limit, transient network, oversize payload pre-skip).
7. **Persists the turn** (user message + assistant reply) to SQLite for future memory retrieval. **On success only** — failed turns leave no trace, so the user can retry without orphan half-turns in history.

## What phantombot does NOT do

- Translate `tools[]` arrays into anything. Each harness brings its own tools.
- Enforce permission gates on tool calls. The harness handles that — Claude is run with `--permission-mode bypassPermissions`.
- Implement vector retrieval, embeddings, RAG. The slot in the system prompt is empty in v1; if needed later, prefer SQLite FTS5 before reaching for sqlite-vec or embeddings.
- Run a web UI, dashboard, status page, or admin panel.
- Listen on chat channels (Telegram / Signal / Google Chat). The original skeleton was built for that; the current shape is CLI only. Channels can be added later without rearchitecting.
- Hold API keys. OAuth-on-host: claude / pi are configured separately on the operator's machine and read their own credentials at spawn time.

## Module map

| Module | Responsibility | Talks to |
|---|---|---|
| `src/index.ts` | Entry point. Calls `runMain(mainCommand)`. | `cli/` |
| `src/cli/index.ts` | Citty dispatcher. Wires every subcommand. | `cli/*.ts` |
| `src/cli/{ask,chat,import-persona,list-personas,set-default-persona,history,config,doctor}.ts` | One subcommand each. Each exports a `run*` function for testing. | `orchestrator`, `importer`, `state`, `repl` |
| `src/config.ts` | TOML + XDG + env-var loader. Single source of truth for paths and harness chain. | filesystem, env, `state.ts` |
| `src/state.ts` | Phantombot-managed runtime state (currently just `default_persona`). Lives at `$XDG_DATA_HOME/phantombot/state.json`. | filesystem |
| `src/persona/loader.ts` | Reads BOOT.md / SOUL.md / IDENTITY.md (required) + MEMORY.md / tools.md / AGENTS.md (optional). | filesystem |
| `src/persona/builder.ts` | Concatenates persona pieces + (deferred) retrieved memory + invocation context into a system prompt string. | `loader.ts` |
| `src/memory/store.ts` | bun:sqlite wrapper. `appendTurn`, `recentTurns`, `recentTurnsForDisplay`, `close`. | `bun:sqlite` |
| `src/importer/openclaw.ts` | Walks an OpenClaw agent dir; copies recognized markdown into the personas dir. | filesystem |
| `src/orchestrator/turn.ts` | `runTurn`: persona → memory → harness chain → persist. The one function every entry point calls. | `loader`, `builder`, `memory`, `fallback` |
| `src/orchestrator/fallback.ts` | `runWithFallback`: tries each harness in order, advances on recoverable error, terminates on success or terminal error. Pre-spawn skip when `maxPayloadBytes` is too small. | `harnesses/*` |
| `src/repl/index.ts` | `runChat` (node:readline loop) + `handleSlash` (command dispatch). | `orchestrator/turn`, `memory` |
| `src/harnesses/types.ts` | `Harness`, `HarnessRequest`, `HarnessChunk` (discriminated union). | — |
| `src/harnesses/claude.ts` | `Bun.spawn claude --print --output-format stream-json …`. Stdin payload, ANTHROPIC_API_KEY filtered out. | `claude` CLI |
| `src/harnesses/pi.ts` | `Bun.spawn pi --print --mode json …`. Argv payload (Pi ignores stdin). Declares `maxPayloadBytes`. | `pi` CLI |
| `src/lib/logger.ts` | Structured logs to stdout. | stdout |
| `src/lib/io.ts` | Shared `WriteSink` interface. | — |

## End-to-end flow

```
phantombot ask "what's on my calendar?"
  → ask.ts: load config, resolve persona, open memory, build harness chain
  → orchestrator.turn.runTurn(...)
       → loadPersona(agentDir) → { boot, memory, tools, identitySource, ... }
       → memory.recentTurns(persona, "cli:default", 20) → [{role,text}, ...]
       → buildSystemPrompt(persona, channelCtx) → systemPrompt
       → orchestrator.fallback.runWithFallback([claude, pi], req)
            → estimatePayloadBytes(req) → bytes
            → if bytes > pi.maxPayloadBytes && pi is in chain → log "skipping pi"
            → claude.invoke(req)
                 → Bun.spawn(["claude", "--print", "--output-format", "stream-json", ...,
                              "--system-prompt", systemPrompt],
                              { stdin: "pipe", env: filtered (no ANTHROPIC_API_KEY) })
                 → write history + new message to proc.stdin, close it
                 → for await chunk of proc.stdout: parse stream-json,
                       yield {type:"text"|"progress"|"done"|"error"}
                 → on timeout: state="timed_out", kill SIGTERM, yield error/recoverable
                 → on exit 0: yield {type:"done", finalText, meta:{harnessId,model}}
                 → on exit !=0: yield error/recoverable: code !== 127
            → if recoverable error and chain has more: try pi.invoke(req)
       → on done chunk: memory.appendTurn(user) + memory.appendTurn(assistant)
  → ask.ts: write text chunks to stdout as they arrive, "\n" on done
  → exit 0 / 1 / 2
```

## Open design questions

1. **Streaming display in the REPL.** Text chunks are written to stdout as they arrive. Looks responsive, but if the harness reformats the final reply (claude sometimes does), the user sees draft text replaced by the canonical version when `done` arrives — currently we just persist the canonical version, which may differ from what was on screen. Acceptable trade-off for v1.

2. **History scope.** Both `ask` and `chat` use conversation key `cli:default` so they share memory per persona. If a future channels phase lands, channel adapters would use distinct keys (`telegram:42`, `signal:abc`).

3. **Multi-line REPL input.** Currently line-by-line via node:readline. Long pasted content works (terminal sends it as one line); explicit multi-line mode (Esc-Enter) is not implemented. Add if it bites.

4. **Conversation history import from OpenClaw.** Skipped in v1 because OpenClaw's transcript format isn't formally documented. Add `phantombot import-history <path>` once we have the schema.

5. **Per-persona harness chains.** Today the chain is global. If different personas should use different defaults (Robbie via claude, alt-persona via pi-only), add `[personas.<name>]` overrides in config.toml.

## Non-goals

- Multi-tenant. Phantombot is single-operator.
- Web UI / dashboard. Use the chat itself.
- High availability. One process per host. If it dies, you re-run it.
- Plugins. The codebase is small enough that "fork it and edit" is the supported customization story.
- Tool-call passthrough. The architectural premise is that the harness owns its tools. See the warning at the bottom of `src/harnesses/claude.ts`.
