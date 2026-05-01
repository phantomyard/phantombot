# phantombot

A personality-first chat agent. Phantombot connects chat channels (Telegram, Signal, Google Chat) to AI harnesses (Claude Code, OpenAI Codex CLI, Gemini CLI, Pi Coding Agent) and stays out of their way. The harness runs its own tool loop. Phantombot does the four things the harnesses don't:

1. **Identity** — load the agent's persona (BOOT.md, MEMORY.md, etc.) and inject it as the harness's system prompt
2. **Memory** — store conversation history and durable notes; retrieve relevant context per turn
3. **Channels** — receive messages from Telegram/Signal/Google Chat; send replies back
4. **Fallback** — if the primary harness fails or rate-limits, fail over to the next harness in the chain

## Why this exists

The author's daily-driver assistant ("Robbie") used to run on OpenClaw. OpenClaw provided personality + channels + memory *and* its own model abstraction *and* its own tool layer. The model abstraction is fine. The tool layer fights with how Claude Code, Codex CLI, etc. already do tools — better than OpenClaw could. Phantombot keeps the personality + channels + memory and lets the harness be the brain *and* the hands.

Concretely: when Phantom is asked to "SSH to the home lab and write a note to the Obsidian vault," the request goes to `claude --print` with Phantom's system prompt installed. Claude Code uses *its* Bash / Write / SSH tools to do the work and returns a final text reply. Phantombot just hands that reply to Telegram. No tool-call translation layer, no permission gates, no `tools[]` array conversion.

## Architecture

```
                    ┌─────────────────┐
                    │  Phantom agent  │
                    │  BOOT.md /      │
                    │  MEMORY.md /    │
                    │  tools.md       │
                    └────────┬────────┘
                             │ persona + memory
                             ▼
   ┌──────────┐       ┌──────────────┐       ┌──────────────────┐
   │ Telegram │ ────► │              │ ────► │  Claude Code     │
   ├──────────┤       │              │       │  (claude --print)│
   │ Signal   │ ────► │ phantombot   │       └──────────────────┘
   ├──────────┤       │ orchestrator │              │ falls back
   │ G. Chat  │ ────► │              │              ▼
   └──────────┘       │              │       ┌──────────────────┐
                      │              │ ────► │  Codex CLI       │
                      │              │       └──────────────────┘
                      │              │              │ falls back
                      │              │              ▼
                      │              │       ┌──────────────────┐
                      │              │ ────► │  Gemini CLI      │
                      │              │       └──────────────────┘
                      │              │              │ falls back
                      │              │              ▼
                      │              │       ┌──────────────────┐
                      │              │ ────► │  Pi Coding Agent │
                      │              │       └──────────────────┘
                      └──────────────┘
                             ▲
                             │ stores turns + retrieves memory
                             ▼
                      ┌──────────────┐
                      │ SQLite +     │
                      │ sqlite-vec   │
                      └──────────────┘
```

Each harness is a CLI binary phantombot spawns as a subprocess. The system prompt goes via `--system-prompt`, the user message goes via stdin, and the harness's stdout is parsed and streamed back out. Tool execution happens entirely inside the harness — phantombot doesn't see it and doesn't need to.

## Status

🚧 **Skeleton only.** Interfaces are defined, the Claude harness has a real reference implementation, the rest are stubs that throw `NotImplementedError`. See [docs/architecture.md](docs/architecture.md) for what's drafted vs. what needs writing, and [docs/adding-a-harness.md](docs/adding-a-harness.md) / [docs/adding-a-channel.md](docs/adding-a-channel.md) for the recipes.

## Layout

```
phantombot/
├── README.md              # this file
├── docs/
│   ├── architecture.md    # detailed flow + design decisions
│   ├── adding-a-harness.md
│   └── adding-a-channel.md
├── src/
│   ├── index.ts           # entry: load config, register channels + harnesses, run
│   ├── config.ts          # env + agent dir loader
│   ├── persona/           # build the system prompt for a turn
│   ├── memory/            # SQLite store + retrieval
│   ├── channels/          # Telegram, Signal, Google Chat adapters
│   ├── harnesses/         # Claude / Codex / Gemini / Pi wrappers
│   ├── orchestrator/      # routing + harness fallback chain
│   ├── heartbeat/         # scheduled background turns (optional)
│   └── lib/               # logger, small utilities
├── agents/
│   └── phantom/           # personality + memory files for the default agent
├── systemd/
│   └── phantombot.service # example systemd user unit
├── package.json
├── tsconfig.json
├── .env.example
└── LICENSE
```

## Running locally

```bash
# 1. Install
npm install

# 2. Configure
cp .env.example .env
# edit .env — at minimum set TELEGRAM_BOT_TOKEN if you want Telegram

# 3. Build + run
npm run build
node dist/index.js

# Or for development:
npm run dev   # in one terminal — tsc watcher
node dist/index.js  # in another
```

## Running as a service

See `systemd/phantombot.service` for a reference user-mode systemd unit. Install it with:

```bash
mkdir -p ~/.config/systemd/user
cp systemd/phantombot.service ~/.config/systemd/user/
systemctl --user daemon-reload
systemctl --user enable --now phantombot.service
```

## Design principles

- **Small.** The whole orchestrator + adapters should fit in a few thousand lines. If you find yourself building a model-provider abstraction or a tool-call translator, stop — you're rebuilding what we're explicitly *not* using.
- **Harness-agnostic interface, harness-specific implementations.** Every harness wrapper translates the same `HarnessRequest` into its CLI's specific flags. There is no shared "model spec" — each harness is its own binary with its own conventions.
- **Channels are append-only writes.** The orchestrator builds a reply string; the channel adapter sends it. No mid-stream channel-aware logic in the orchestrator.
- **Memory is local.** SQLite + sqlite-vec on disk. No cloud sync. If you need durable shared documentation across machines, use a separate vault (e.g. an Obsidian vault on a NAS) and let the harness's tools read/write it.
- **Personality lives in markdown files**, not config. Persona changes are commits to `agents/<name>/BOOT.md`, not config knob flips.

## Acknowledgements

The motivating insight ("the harness can do its own tools — let it") and the initial Claude harness implementation came from work on a Claude-Code proxy (`~/clawd/claude-proxy/` on the OpenClaw server). That fork's three patches (stdin prompt, `--system-prompt` separation, `--bare` rejection rationale) are the basis for `src/harnesses/claude.ts` here.
