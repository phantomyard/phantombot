# phantombot

A personality-first chat agent CLI. Phantombot wraps existing AI CLIs (Claude Code, Inflection Pi) with persona, memory, and a fallback chain — and otherwise stays out of their way. The harness runs its own tool loop. Phantombot does the four things the harnesses don't:

1. **Identity** — load the agent's persona (`BOOT.md` / `SOUL.md` / `IDENTITY.md`, plus `MEMORY.md`, `tools.md` / `AGENTS.md`) and inject it as the harness's system prompt.
2. **Memory** — persist conversation turns to local SQLite, retrieve recent history per turn.
3. **CLI** — `phantombot ask "..."`, `phantombot chat`, `phantombot import-persona /path/to/openclaw-agent`.
4. **Fallback** — if the primary harness fails or rate-limits, fail over to the next harness in the chain.

## Why this exists

The author's daily-driver assistant ("Robbie") used to run on [OpenClaw](https://github.com/openclaw/openclaw). OpenClaw provides personality + channels + memory **and** its own model abstraction **and** its own tool layer. The model abstraction is fine. The tool layer fights with how Claude Code, Pi, etc. already do tools — better than OpenClaw could. Phantombot keeps the personality + memory and lets the harness be the brain *and* the hands.

Concretely: when Phantom is asked to "SSH to the home lab and write a note to the Obsidian vault," the request goes to `claude --print` with Phantom's system prompt installed. Claude Code uses *its* Bash / Write / SSH tools to do the work and returns the final text. Phantombot prints it. No tool-call translation layer, no permission gates, no `tools[]` array conversion.

## Architecture

```
phantombot ask "..."  ──┐
phantombot chat         │     Citty CLI
phantombot import-persona ─┐  (src/cli/*.ts)
…                       │  │
                        ▼  ▼
              ┌──────────────────────┐
              │  one-turn coordinator│  (src/orchestrator/turn.ts)
              └────────┬─────────────┘
                       │
       ┌───────────────┼────────────────┐
       ▼               ▼                ▼
  load persona   load history     run harness chain
 (BOOT.md / …)  (bun:sqlite)      (claude → pi)
                                       │
                                       ▼
                            spawn `claude --print …`  (or pi --print --mode json)
                            stream stream-json from stdout
                            yield text/progress/done/error chunks
                                       │
                                       ▼
                            on recoverable error → next harness in chain
                                       │
                                       ▼
                            persist user + assistant turn (on success only)
                                       │
                                       ▼
                            print reply to terminal (streamed token-by-token)
```

Tool execution happens entirely inside the harness — phantombot doesn't see it and doesn't need to.

## Status

All twelve build phases landed. Working CLI:

```
phantombot ask "<message>"                         # one-shot turn
phantombot chat                                    # interactive REPL
phantombot import-persona <openclaw-agent-dir>     # copy persona files in
phantombot list-personas                           # which personas exist + which is default
phantombot set-default-persona <name>              # change the default
phantombot history [-n N] [--persona <name>]       # show recent turns from memory
phantombot config                                  # print resolved config + paths
phantombot config edit                             # open config.toml in $EDITOR
phantombot doctor                                  # check binaries + auth
```

130 unit tests. Auth model is OAuth-on-host: phantombot holds **no** API keys, just spawns `claude` and `pi` (which read their own credentials from `~/.claude/.credentials.json` and Pi's own state).

## Layout

```
phantombot/
├── README.md
├── docs/
│   ├── architecture.md         # detailed flow + design decisions
│   └── adding-a-harness.md     # recipe for new harnesses
├── src/
│   ├── index.ts                # entry point: runs the Citty dispatcher
│   ├── config.ts               # TOML + XDG + env-var loader
│   ├── state.ts                # phantombot-managed runtime state (default persona)
│   ├── persona/                # load BOOT.md/SOUL.md/IDENTITY.md + build system prompt
│   ├── memory/                 # bun:sqlite turn store
│   ├── importer/               # OpenClaw → phantombot persona import
│   ├── orchestrator/           # one-turn coordinator + harness fallback chain
│   ├── repl/                   # node:readline interactive loop for `phantombot chat`
│   ├── cli/                    # one file per Citty subcommand
│   ├── harnesses/              # claude + pi wrappers (against Bun.spawn)
│   └── lib/                    # logger, shared IO interface
├── agents/
│   └── phantom/                # placeholder persona files
├── tests/                      # bun test (130 tests, in-memory + tmp-dir)
├── package.json
├── bunfig.toml
├── tsconfig.json
├── Dockerfile
└── docker-compose.yml          # for build/test in containers if needed
```

## Install + run

### Prerequisites

- **Bun** ≥ 1.1: `curl -fsSL https://bun.sh/install | bash`
- **Claude Code** installed and authenticated: `claude /login`
- **(Optional)** Inflection Pi installed and configured if you want it in the fallback chain

### From source (dev)

```bash
git clone https://github.com/andrewagrahamhodges/phantombot.git
cd phantombot
bun install
bun src/index.ts --help
```

### As a single binary

```bash
bun run build           # produces ./dist/phantombot (~98 MB, includes Bun)
./dist/phantombot --help

# Optionally: deploy to a server
scp dist/phantombot user@host:/usr/local/bin/phantombot
```

### First-time setup

```bash
phantombot doctor                                 # see what's missing
phantombot import-persona ./agents/phantom        # or any OpenClaw agent dir
phantombot list-personas
phantombot ask "introduce yourself"
phantombot chat                                   # interactive
```

## Configuration

Optional TOML at `$XDG_CONFIG_HOME/phantombot/config.toml` (`~/.config/phantombot/config.toml`):

```toml
default_persona = "robbie"
turn_timeout_s = 600

[harnesses]
chain = ["claude", "pi"]   # primary → fallback

[harnesses.claude]
bin = "claude"
model = "opus"
fallback_model = "sonnet"

[harnesses.pi]
bin = "pi"
max_payload_bytes = 1_500_000
```

All settings are optional — phantombot runs with built-in defaults. Env-var overrides for one-off testing: `PHANTOMBOT_CLAUDE_MODEL=sonnet phantombot ask "..."`.

Run `phantombot config` to see resolved values. Resolution priority (highest wins): env vars > `state.json` > `config.toml` > defaults.

## Memory

Local SQLite at `$XDG_DATA_HOME/phantombot/memory.sqlite` (`~/.local/share/phantombot/memory.sqlite`). One table:

```sql
turns(id, persona, conversation, role, text, created_at)
```

Each persona gets its own conversation namespace. `phantombot ask` and `phantombot chat` share `cli:default` so a chat session sees prior `ask` history and vice versa.

Vector / semantic retrieval is deferred. If you need it, prefer SQLite FTS5 (built into bun:sqlite) before reaching for sqlite-vec or embeddings.

## OpenClaw persona import

```bash
phantombot import-persona /path/to/openclaw-agent --as robbie
```

Recognized files (any layout works):

| Slot | Filenames (first match wins) |
|---|---|
| identity (required) | `BOOT.md` → `SOUL.md` → `IDENTITY.md` |
| persistent memory | `MEMORY.md` |
| tools / hints | `tools.md` → `AGENTS.md` |

Bonus `.md` files come along too (free agent context the harness can `Read`). SQLite, JSONL, dotfiles, and subdirectories are skipped with reasons in the import summary. **Conversation history is not imported in v1** — use phantombot's empty memory and rebuild over time, or wait for a future `phantombot import-history` command.

## Design principles

- **Small.** The whole CLI fits in ~2,500 lines including tests. If you're tempted to build a model-provider abstraction, a tool-call translator, or a multi-tenant model, stop — you're rebuilding what we're explicitly *not* using.
- **Harness-agnostic interface, harness-specific implementations.** Every harness wrapper translates the same `HarnessRequest` into its CLI's specific flags. No shared "model spec." See `src/harnesses/claude.ts` for the reference shape.
- **Personality lives in markdown files, not config.** Persona changes are commits to `agents/<name>/BOOT.md`, not config-knob flips.
- **Memory is local.** SQLite on disk. No cloud sync. If you need durable shared docs across machines, use a separate vault (e.g. an Obsidian vault on a NAS) and let the harness's tools read/write it.
- **OAuth on host. Phantombot holds no secrets.** Claude / Pi are pre-configured by you; phantombot just spawns them with their own credentials available.
- **Single-operator.** Phantombot has no multi-tenant story, no auth, no users. One person, one machine, one persona at a time.

## Testing in Docker

If you don't want to install Bun on the host (~150 MB), there's a docker-compose for build + test:

```bash
docker compose run --rm test         # bun test
docker compose run --rm typecheck    # bun tsc --noEmit
docker compose run --rm build        # produces ./dist/phantombot on the host
```

The container runs as your UID so `dist/` ends up writable.

## Acknowledgements

The motivating insight ("the harness can do its own tools — let it") and the initial Claude harness implementation came from work on a Claude-Code proxy (`~/clawd/claude-proxy/` on the OpenClaw VPS). The five-patch reasoning at the top of `src/harnesses/claude.ts` (stdin prompt, `--system-prompt` separation, `bypassPermissions`, `--fallback-model`, no `--bare`) is the basis for the harness here.
