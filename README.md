# phantombot

A personality-first chat agent. Phantombot wraps Claude Code and Inflection Pi with persona, memory, and a Telegram bot — and otherwise stays out of their way. The harness runs its own tool loop. Phantombot does:

1. **Identity** — load the agent's persona files (`BOOT.md` / `SOUL.md` / `IDENTITY.md`, plus `MEMORY.md`, `tools.md` / `AGENTS.md`) and inject them as the harness's system prompt.
2. **Memory** — persist conversation turns to local SQLite, retrieve recent history per turn.
3. **Channel** — Telegram bot via long-polling `getUpdates`.
4. **Fallback** — primary harness fails → next in chain.

## Commands

The whole CLI surface, deliberately small:

```
phantombot import-persona <openclaw-dir>     # copy persona files in; also pulls Telegram config from ~/.openclaw/openclaw.json
phantombot create-persona                    # interactive TUI: build a fresh persona
phantombot telegram                          # interactive TUI: configure the Telegram channel
phantombot harness                           # interactive TUI: pick primary + fallback harnesses
phantombot install                           # install systemd --user unit (auto-restart, survives logout if linger is on)
phantombot uninstall                         # remove the systemd unit
phantombot run                               # run in the foreground (Ctrl-C to stop)
```

That's it. Seven commands. Configuration lives in `~/.config/phantombot/config.toml` (TUIs write here) and `~/.local/share/phantombot/state.json` (default persona).

## Why this exists

The author's daily-driver assistant ("Robbie") used to run on [OpenClaw](https://github.com/openclaw/openclaw). OpenClaw provides personality + channels + memory **and** its own model abstraction **and** its own tool layer. The model abstraction is fine. The tool layer fights with how Claude Code and Pi already do tools — better than OpenClaw could. Phantombot keeps the personality + memory + Telegram channel and lets the harness be the brain *and* the hands.

When Phantom is asked to "SSH to the home lab and write a note to the Obsidian vault," the request goes to `claude --print` with Phantom's system prompt installed. Claude Code uses *its* Bash / Write / SSH tools to do the work and returns the final text. Phantombot relays it to Telegram. No tool-call translation layer, no permission gates, no `tools[]` array conversion.

## Install + run

### Prerequisites

- **Bun** ≥ 1.1: `curl -fsSL https://bun.sh/install | bash` (only if you build from source — the compiled binary has no runtime dep)
- **Claude Code** installed and authenticated as the user that will run phantombot: `claude /login`
- **(Optional)** Inflection Pi installed and configured if you want it in the fallback chain
- A Telegram bot token from [@BotFather](https://t.me/BotFather)

### From a compiled binary

```bash
# On a build machine (matches target glibc):
git clone https://github.com/andrewagrahamhodges/phantombot.git
cd phantombot
bun install
bun run build                                  # → ./dist/phantombot (~98 MB)

# Older CPUs without AVX2 (e.g. QEMU virtual CPUs):
bun build --compile --target=bun-linux-x64-baseline ./src/index.ts --outfile dist/phantombot

# Deploy:
scp dist/phantombot user@host:~/.local/bin/phantombot
```

### First-time setup

```bash
# Pick ONE of:
phantombot create-persona                    # TUI — fresh persona from scratch
phantombot import-persona ~/clawd            # copy an existing OpenClaw agent (also imports Telegram config)

phantombot harness                           # TUI — choose primary + fallback (claude / pi / none)
phantombot telegram                          # TUI — bot token + allowed user IDs (validated via getMe)

# Run it foreground first to confirm it works:
phantombot run

# Then install as a systemd --user service:
phantombot install
journalctl --user -u phantombot -f           # watch logs
```

If you're a headless service account (no login session), enable linger first so the unit survives logout:

```bash
sudo loginctl enable-linger $USER
phantombot install
```

## Architecture

```
phantombot run                    # the only long-running command
       │
       ▼
┌─────────────────────────┐
│  one-turn coordinator   │  src/orchestrator/turn.ts
└──────────┬──────────────┘
           │
   ┌───────┼─────────────────┐
   ▼       ▼                 ▼
load     load history    run harness chain
persona  (bun:sqlite)    (claude → pi)
                              │
                              ▼
                  spawn `claude --print …`
                  stream stream-json from stdout
                  yield text/progress/done/error chunks
                              │
                              ▼
                  on recoverable error → next harness
                              │
                              ▼
                  persist user + assistant turn (on success only)
                              │
                              ▼
                  send reply via Telegram sendMessage
```

Tool execution happens entirely inside the harness — phantombot doesn't see it.

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
│   ├── channels/               # Telegram adapter (HttpTelegramTransport + long-poll loop)
│   ├── cli/                    # one file per Citty subcommand (7 of them)
│   ├── harnesses/              # claude + pi wrappers (against Bun.spawn)
│   └── lib/                    # logger, IO, configWriter, systemd, telegramApi, personaTemplate
├── agents/
│   └── phantom/                # placeholder persona files (used by tests / example)
├── tests/                      # bun test (147 tests across 20 files)
├── package.json
├── bunfig.toml
├── tsconfig.json
├── Dockerfile
└── docker-compose.yml          # for build/test in containers if you don't want Bun on host
```

## Configuration

`~/.config/phantombot/config.toml` — written by the TUIs; you can hand-edit but a subsequent TUI write will reformat it (smol-toml round-trip, no comment preservation).

```toml
default_persona = "robbie"      # also tracked in state.json by `set` from create-persona
turn_timeout_s = 600

[harnesses]
chain = ["claude", "pi"]        # primary → fallback. Set via `phantombot harness`.

[harnesses.claude]
bin = "claude"
model = "opus"
fallback_model = "sonnet"

[harnesses.pi]
bin = "pi"
max_payload_bytes = 1500000

[channels.telegram]             # set via `phantombot telegram`
token = "..."
poll_timeout_s = 30
allowed_user_ids = [7995070089] # empty = anyone (with a startup warning)
```

Env-var overrides for one-off testing: `PHANTOMBOT_CLAUDE_MODEL=sonnet phantombot run`. Resolution priority (highest wins): env vars > `state.json` > `config.toml` > defaults.

## Memory

Local SQLite at `~/.local/share/phantombot/memory.sqlite`. One table:

```sql
turns(id, persona, conversation, role, text, created_at)
```

Each persona × conversation gets its own namespace (`telegram:<chatId>`, e.g.). No vector retrieval; if you want it later, prefer SQLite FTS5 (built into bun:sqlite) before reaching for sqlite-vec or embeddings.

## OpenClaw persona import

```bash
phantombot import-persona /path/to/openclaw-agent --as robbie [--no-telegram]
```

Recognized files (any layout works):

| Slot | Filenames (first match wins) |
|---|---|
| identity (required) | `BOOT.md` → `SOUL.md` → `IDENTITY.md` |
| persistent memory | `MEMORY.md` |
| tools / hints | `tools.md` → `AGENTS.md` |

Bonus `.md` files come along too. SQLite, JSONL, dotfiles, subdirs are skipped with reasons in the summary. **Conversation history is not imported in v1.**

By default the import also sniffs `~/.openclaw/openclaw.json` for a Telegram bot block; if found, it writes to `[channels.telegram]`. Pass `--no-telegram` to skip.

## Design principles

- **Small.** The CLI surface is 7 commands. The codebase is ~3,000 lines including tests. If you're tempted to build a model-provider abstraction, a tool-call translator, or a multi-tenant model, stop — you're rebuilding what we're explicitly *not* using.
- **Harness-agnostic interface, harness-specific implementations.** Every harness wrapper translates the same `HarnessRequest` into its CLI's specific flags. No shared "model spec." See `src/harnesses/claude.ts` for the reference shape.
- **Personality lives in markdown files, not config.** Persona changes are commits to `BOOT.md`, not config-knob flips. The TUI is bootstrap-only.
- **Memory is local.** SQLite on disk. No cloud sync. If you need durable shared docs across machines, use a separate vault and let the harness's tools read/write it.
- **OAuth on host. Phantombot holds no model API keys.** Claude / Pi are pre-configured by you; phantombot just spawns them and `ANTHROPIC_API_KEY` is filtered out so claude uses its OAuth credentials.
- **Single-operator.** Phantombot has no multi-tenant story. One person, one machine, one persona at a time (per Telegram chat — different chats can share a persona).

## Testing in Docker

If you don't want to install Bun on the host (~150 MB), there's a docker-compose for build + test:

```bash
docker compose run --rm test         # bun test
docker compose run --rm typecheck    # bun tsc --noEmit
docker compose run --rm build        # produces ./dist/phantombot on the host (use --target=bun-linux-x64-baseline if older CPU)
```

The container runs as your UID so `dist/` ends up writable.

## Acknowledgements

The motivating insight ("the harness can do its own tools — let it") and the initial Claude harness implementation came from work on a Claude-Code proxy (`~/clawd/claude-proxy/` on the OpenClaw VPS). The five-patch reasoning at the top of `src/harnesses/claude.ts` (stdin prompt, `--system-prompt` separation, `bypassPermissions`, `--fallback-model`, no `--bare`) is the basis for the harness here.
