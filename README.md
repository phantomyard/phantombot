# phantombot

A personality-first chat agent. Phantombot wraps Claude Code, Inflection Pi, and Google Gemini CLI with persona, memory, scheduled tasks, and a Telegram bot — and otherwise stays out of their way. The harness runs its own tool loop. Phantombot does:

1. **Identity** — load the agent's persona files (`BOOT.md` / `SOUL.md` / `IDENTITY.md`, plus `MEMORY.md`, `tools.md` / `AGENTS.md`) and inject them as the harness's system prompt.
2. **Memory** — persist conversation turns to local SQLite, retrieve recent history per turn.
3. **Channel** — Telegram bot via long-polling `getUpdates`.
4. **Schedule** — `phantombot tick` fires user-defined tasks every minute (cron expressions).
5. **Update self** — `phantombot update` fetches the latest GitHub Release, sha256-verifies, atomically swaps the running binary.
6. **Fallback** — primary harness fails → next in chain.

## Commands

```
# First-time / config
phantombot persona                           # TUI: create / import / restore / switch the active persona
phantombot persona <name>                    # switch default persona to <name>
phantombot persona --import <dir> [--as <n>] # non-interactive import (OpenClaw or phantombot-shaped)
phantombot telegram                          # interactive TUI: configure the Telegram channel
phantombot harness                           # interactive TUI: pick primary + fallback harnesses
phantombot voice                             # interactive TUI: pick TTS/STT provider (ElevenLabs/OpenAI/Azure Edge)
phantombot embedding                         # interactive TUI: configure Gemini embeddings (optional)

# Day-to-day
phantombot run                               # foreground long-running listener (Ctrl-C to stop)
phantombot install                           # install systemd --user units (main + heartbeat + nightly + tick)
phantombot uninstall                         # remove the systemd units
phantombot update                            # fetch latest GitHub Release, verify, atomically swap the binary
phantombot update --check                    # just print availability (exit 0 / 2)
phantombot update --force --restart          # cron-friendly: no prompts, restart after install

# Agent-facing tools (the harnessed agent calls these via Bash)
phantombot env set NAME "value"              # safe-write to ~/.env (atomic, mode 0o600)
phantombot env get NAME
phantombot env list                          # names only — never values
phantombot env unset NAME
phantombot notify --message "..."            # send Telegram text to all allowed users
phantombot notify --voice   "..."            # synthesize via configured TTS, send as voice note
phantombot task add --schedule "<cron>" --prompt "..." --description "..."
phantombot task list                         # active tasks for current persona
phantombot task show <id>                    # full detail incl. last/next run + review state
phantombot task cancel <id>
phantombot tick                              # fire any due tasks (called by phantombot-tick.timer)

# Memory (called from harness Bash)
phantombot memory today                      # today's daily journal path
phantombot memory search "<query>" [--scope memory|kb|all] [--limit N]
phantombot memory get <persona-relative-path>
phantombot memory list <persona-relative-dir>
phantombot memory index [--rebuild]

# Periodic maintenance (called by systemd timers, occasionally by hand)
phantombot heartbeat                         # mechanical 30-min pass (no LLM)
phantombot nightly                           # cognitive distillation pass (LLM)
```

Configuration lives in `~/.config/phantombot/config.toml` (TUIs write here) and `~/.local/share/phantombot/state.json` (default persona). Secrets in `~/.config/phantombot/.env` (phantombot-managed) and `~/.env` (user-managed; the agent writes here via `phantombot env set`).

## Why this exists

The author's daily-driver assistant ("Robbie") used to run on [OpenClaw](https://github.com/openclaw/openclaw). OpenClaw provides personality + channels + memory **and** its own model abstraction **and** its own tool layer. The model abstraction is fine. The tool layer fights with how Claude Code, Pi, and Gemini CLI already do tools — better than OpenClaw could. Phantombot keeps the personality + memory + Telegram channel and lets the harness be the brain *and* the hands.

When Phantom is asked to "SSH to the home lab and write a note to the Obsidian vault," the request goes to `claude --print` with Phantom's system prompt installed. Claude Code uses *its* Bash / Write / SSH tools to do the work and returns the final text. Phantombot relays it to Telegram. No tool-call translation layer, no permission gates, no `tools[]` array conversion.

## Personas

> **Heads up — single persona at runtime.** This bit surprises people, including the author once.

A persona is a directory of markdown files (`BOOT.md`, `MEMORY.md`, `tools.md`, etc.). You can have **many** persona directories on disk — each `phantombot import-persona` or `phantombot create-persona` adds one. They all live under `~/.local/share/phantombot/personas/<name>/`.

But **only one persona is active at any time**. Specifically:

- `phantombot run` reads `default_persona` from `config.toml` (or `state.json`), looks up that one directory, and binds the Telegram listener to it.
- A `runLock` (`src/lib/runLock.ts`) prevents two `phantombot run` processes from running on the same box, so even spawning a second one for a different persona is blocked.
- The Telegram bot has one token (one slot in `config.toml`), so even without the runLock you can't have two personas answering the same chat.

What you **can** do: switch personas. Memory is partitioned by persona (`turns.persona = 'phantom'` vs `'robbie'`), so switching is config-edit + restart and each persona keeps its own private history forever:

```bash
phantombot import-persona ~/clawd/agents/robbie --as robbie
$EDITOR ~/.config/phantombot/config.toml          # default_persona = "robbie"
systemctl --user restart phantombot               # robbie now answers Telegram

# Later — switch back:
$EDITOR ~/.config/phantombot/config.toml          # default_persona = "phantom"
systemctl --user restart phantombot               # phantom resumes with phantom's memory
```

If you literally need two personas answering simultaneously (different bots, different XDG dirs, separate processes) — that's not supported and would be a real architectural change. Today phantombot is single-operator, single-persona.

## Install + run

### Prerequisites

- **Bun** ≥ 1.1: `curl -fsSL https://bun.sh/install | bash` (only if you build from source — the released binary has no runtime dep)
- **At least one harness** installed and authenticated as the user that will run phantombot:
  - **Claude Code** — `claude /login` (OAuth on host; phantombot filters `ANTHROPIC_API_KEY` so OAuth is the path)
  - **Inflection Pi** — `pi` configured per its own setup
  - **Google Gemini CLI** — `gemini` then OAuth via the in-app `/auth`, OR set `GEMINI_API_KEY` in `~/.env`
- **(Optional)** Inflection Pi installed and configured if you want it in the fallback chain
- A Telegram bot token from [@BotFather](https://t.me/BotFather)

### One-liner install (recommended)

```bash
curl -fsSL https://raw.githubusercontent.com/andrewagrahamhodges/phantombot/main/install.sh | sh
```

What it does:

1. Detects host arch (`x86_64` → x64, `aarch64` → arm64).
2. Fetches the latest GitHub release tag.
3. Downloads the matching binary + `SHA256SUMS`, **verifies the checksum**, refuses on mismatch.
4. Installs to `~/.local/bin/phantombot` (mode 0755).
5. Warns if `~/.local/bin` isn't on `PATH`.
6. Launches `phantombot persona` to set up the first persona — unless stdin/stdout aren't a TTY (e.g. running headless), in which case it prints the next-step hint and exits cleanly.

Override the install dir: `PHANTOMBOT_INSTALL_DIR=/opt/bin curl -fsSL … | sh`.
Skip the post-install TUI: `PHANTOMBOT_SKIP_TUI=1 curl -fsSL … | sh` (useful for CI / unattended provisioning).

Subsequent updates use the same release feed:

```bash
phantombot update                       # interactive TUI
phantombot update --check               # exit 2 if newer available, 0 if current
phantombot update --force --restart     # unattended (cron-friendly)
```

CI publishes a fresh release per merged PR, tagged `v1.0.<PR_NUMBER>`. Each release ships:

- `phantombot-v1.0.N-linux-x64`     — x86-64, **baseline** (no AVX2 required)
- `phantombot-v1.0.N-linux-arm64`   — ARM64
- `SHA256SUMS`                      — both `install.sh` and `phantombot update` verify against this

### From source

```bash
git clone https://github.com/andrewagrahamhodges/phantombot.git
cd phantombot
bun install
bun run build                                  # → ./dist/phantombot (~98 MB)
# bun run build:arm64                          # cross-compile arm64 from an x64 host
scp dist/phantombot user@host:~/.local/bin/phantombot
```

The default `build` script targets `bun-linux-x64-baseline`. If you "optimise" to plain `bun-linux-x64`, the binary will SIGILL on hosts without AVX2 — see the May 2026 first-deploy post-mortem in PR #37.

### First-time setup

The one-liner above runs `phantombot persona` for you in interactive mode. Or do it explicitly:

```bash
phantombot persona                           # TUI: create / import / restore / switch
# OR non-interactively:
phantombot persona --import ~/clawd --as robbie

phantombot harness                           # pick primary + fallback (claude / pi / gemini)
phantombot telegram                          # bot token + allowed user IDs
phantombot voice                             # optional: TTS/STT provider for voice messages

phantombot run                               # foreground sanity check (Ctrl-C to stop)
phantombot install                           # then install as a systemd --user service
journalctl --user -u phantombot -f           # tail the logs
```

> **First-import note**: when you import a persona on a fresh box, `phantombot persona --import` automatically sets it as `default_persona` (unless you already have a persona configured). Without this, the built-in fallback `"phantom"` would still be the default and `phantombot run` would fail with "persona 'phantom' not found." Switch later with `phantombot persona <name>`.

If you're a headless service account (no login session), enable linger first:

```bash
sudo loginctl enable-linger $USER
phantombot install
```

## Scheduled tasks (`phantombot task` + `phantombot tick`)

The agent can schedule recurring work for itself. You ask Phantom on Telegram: *"every hour, check my email and let me know if anything important comes in."* Phantom (via the Claude harness's Bash tool) runs:

```bash
phantombot task add \
  --schedule "0 * * * *" \
  --description "hourly email check" \
  --prompt "Check my Gmail for new email since the last run. If anything is important, call \`phantombot notify --message \"…\"\`. Reply with NONE otherwise."
```

`phantombot-tick.timer` fires every minute and calls `phantombot tick`, which:

1. Reads tasks from `memory.sqlite` where `next_run_at <= now() AND active=1`.
2. For each, spawns the harness with the stored prompt as the user message.
3. The agent does its thing — including calling `phantombot notify` if the user should hear about it.
4. Records the run, recomputes `next_run_at` from the cron expression.

**Notification is opt-in, not automatic.** Tasks run silently by default. The agent calls `phantombot notify --message "…"` (or `--voice "…"`) only when something genuinely needs surfacing. *"Nothing important happened"* is a successful run.

**Missed runs are skipped, not piled up.** If the box is off for 5 hours and an hourly task missed 5 fires, the next tick after boot runs it once — not five times. Avoids surprising you with an avalanche of catch-up runs.

**Self-review prevents tasks from growing forever.** Every task has a `next_review_at` scaled to its cadence (hourly → 14d, daily → 30d, weekly → 90d). When that date arrives, the next tick runs a **review prompt** instead of the normal one — asking the agent to decide KEEP / STOP / MODIFY based on recent context. KEEP doubles the review interval (review fatigue is the failure mode). STOP deactivates the task and notifies you why. MODIFY proposes a change via Telegram.

Manage from anywhere: ask Phantom on Telegram *"list my scheduled tasks"* and the agent runs `phantombot task list`. Cancel one: *"cancel the email check"* → `phantombot task cancel <id>`. CLI is the same — `phantombot task list / show / cancel`.

## Voice replies in Telegram

When a Telegram voice message comes in (and the configured provider can do TTS), phantombot transcribes via STT, runs the harness, and synthesizes the reply as a voice note. **For these voice-in/voice-out turns only**, phantombot appends a one-paragraph brevity directive to the system prompt — telling the model to keep the reply to 1-3 sentences (~30 seconds of speech, ≈100 tokens), drop work narration ("Let me check…"), and skip markdown the TTS would read awkwardly.

The directive lives at the channel layer (`VOICE_REPLY_INSTRUCTION` in `src/channels/telegram.ts`), not in persona files — so text replies stay as detailed as the persona wants. If your voice notes still feel too long after this, the next lever is the persona's own tone in BOOT.md/SOUL.md, not a config knob.

## `phantombot notify` (agent's voice to you)

```
phantombot notify --message "Proxmox upgrade succeeded on all hosts."
phantombot notify --voice   "Heads up — backup failed on pve-3."
phantombot notify --message "Both" --voice "Both"        # text + voice
```

Sends to every chat in `[channels.telegram].allowed_user_ids`. Refuses (exit 2) if the allowlist is empty — no accidental broadcasts. Voice synthesis uses your configured TTS provider (set via `phantombot voice`).

## Credentials (`phantombot env`)

Two .env files, two roles:

- **`~/.config/phantombot/.env`** — phantombot's own runtime secrets (TTS keys; written by `phantombot voice`). Don't hand-edit.
- **`~/.env`** — your general-purpose credentials (`GITHUB_TOKEN`, ssh passphrases, anything the harnessed agent needs to call out to). The agent writes here via `phantombot env set`.

Both are sourced into the running phantombot process via systemd `EnvironmentFile=`, so when the agent (Claude harness) is spawned, **all credentials are already in `process.env`** — no command-line value pasting, no fresh file reads, no leakage to bash history.

```bash
# Agent-facing CLI (sanctioned write path: atomic, 0o600, idempotent):
phantombot env set GITHUB_TOKEN "ghp_..."        # acks "saved GITHUB_TOKEN" — never echoes value
phantombot env get GITHUB_TOKEN                  # raw value (avoid in interactive — leaks to scrollback)
phantombot env list                              # names only
phantombot env unset GITHUB_TOKEN
```

The persona system prompt includes a **credential discovery + hygiene** section the agent inherits automatically. It documents the discovery order (`process.env` → `~/.env` → `~/.ssh/` → memory) and forbids `echo … >> ~/.env` (loses atomicity, drops file mode), echoing values back ("acknowledge by name only"), and storing credentials in memory drawers / KB notes.

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

Four systemd-user units run alongside `phantombot.service`:

- `phantombot-tick.timer` (every 1 min) → `phantombot tick`: fires due scheduled tasks.
- `phantombot-heartbeat.timer` (every 30 min) → `phantombot heartbeat`: mechanical maintenance, no LLM.
- `phantombot-nightly.timer` (daily 02:00) → `phantombot nightly`: cognitive distillation pass, LLM.
- `phantombot.service` itself: the long-running Telegram listener.

## Layout

```
phantombot/
├── README.md
├── AGENTS.md                    # if you (or another agent) is contributing — read first
├── docs/
│   ├── architecture.md
│   └── adding-a-harness.md
├── src/
│   ├── index.ts
│   ├── version.ts               # CI sed-replaces "0.1.0-dev" with "1.0.<PR_NUMBER>"
│   ├── config.ts
│   ├── state.ts
│   ├── persona/                 # loader + builder (system-prompt sections incl. memory tools + credentials)
│   ├── memory/                  # bun:sqlite turn store
│   ├── importer/                # OpenClaw → phantombot persona import
│   ├── orchestrator/            # turn coordinator + harness fallback chain
│   ├── channels/                # Telegram adapter
│   ├── cli/                     # one file per Citty subcommand
│   ├── harnesses/               # claude + pi wrappers
│   └── lib/                     # logger, IO, configWriter, systemd, telegramApi, audio,
│                                # tasks (schedule store), cronSchedule, binaryUpdate, githubReleases…
├── agents/
│   └── phantom/                 # placeholder persona (used by tests / example)
├── tests/
├── .github/workflows/release.yml  # auto-release per merged PR
├── package.json
├── bunfig.toml
└── tsconfig.json
```

## Versioning

`major.minor.patch`, where **patch is the GitHub PR number**. Every merged PR auto-tags `v1.0.<PR_NUMBER>`, builds binaries, publishes a release. Intentionally not semver — `1.0.42` is "patch" of `1.0.41` only by coincidence (PRs aren't ordered by semantic impact). Don't bolt semver-aware logic onto `phantombot update`.

## Memory

Local SQLite at `~/.local/share/phantombot/memory.sqlite`. Two tables:

```sql
turns(id, persona, conversation, role, text, created_at)
tasks(id, persona, description, schedule, prompt, created_at,
      last_run_at, next_run_at, run_count,
      next_review_at, review_count, active)
```

Each persona × conversation gets its own namespace (`telegram:<chatId>`, `tick:<task-id>`, etc.). FTS5-based hybrid search via `phantombot memory search` (built into bun:sqlite); optional Gemini embeddings if `phantombot embedding` is configured.

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

- **Small.** The CLI surface is deliberate. If you're tempted to build a model-provider abstraction, a tool-call translator, or a multi-tenant model, stop — you're rebuilding what we're explicitly *not* using.
- **Harness-agnostic interface, harness-specific implementations.** Every harness wrapper translates the same `HarnessRequest` into its CLI's specific flags. No shared "model spec." See `src/harnesses/claude.ts` for the reference.
- **Personality lives in markdown files, not config.** Persona changes are commits to `BOOT.md`, not config-knob flips. The TUI is bootstrap-only.
- **Memory is local.** SQLite on disk. No cloud sync. If you need durable shared docs across machines, use a separate vault and let the harness's tools read/write it.
- **OAuth on host. Phantombot holds no model API keys.** Claude / Pi are pre-configured by you; phantombot just spawns them and `ANTHROPIC_API_KEY` is filtered out so claude uses its OAuth credentials.
- **Single-operator.** One person, one machine, one persona at a time. (See [Personas](#personas) above.)
- **Updates are atomic.** `phantombot update` rename-swaps the binary on Linux (kernel keeps the running process backed by the original inode); SHA256-verified before swap. Old binary preserved as `.bak` for rollback.

## Contributing

Read `AGENTS.md` first. Particularly: README and AGENTS must stay in sync with the code on every PR. PRs that change behavior without updating both will get reviewer pushback.

```bash
bun install
bun tsc --noEmit       # typecheck
bun test               # full suite
bun run build          # → dist/phantombot (~98 MB, baseline x64)
```

## Acknowledgements

The motivating insight ("the harness can do its own tools — let it") and the initial Claude harness implementation came from work on a Claude-Code proxy on the OpenClaw VPS. The five-patch reasoning at the top of `src/harnesses/claude.ts` (stdin prompt, `--system-prompt` separation, `bypassPermissions`, `--fallback-model`, no `--bare`) is the basis for the harness here.
