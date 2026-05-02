# phantombot

A personality-first chat agent for Telegram. Wraps Claude Code, Inflection Pi, and Google Gemini CLI — and otherwise stays out of their way. The harness runs its own tool loop; phantombot does identity, memory, channel, scheduling, and self-update.

---

## Install

```bash
curl -fsSL https://raw.githubusercontent.com/andrewagrahamhodges/phantombot/main/install.sh | sh
```

The script:

- Detects host arch (`x86_64` / `aarch64`).
- Fetches the latest GitHub Release tag.
- Downloads the matching binary + `SHA256SUMS`, **verifies the checksum**, refuses on mismatch.
- Creates `~/.local/bin/` if needed and installs `phantombot` at mode 0755.
- Warns if `~/.local/bin` isn't on your `PATH`.
- Launches `phantombot persona` so you can set up your first persona — unless stdin/stdout aren't a TTY (e.g. running headless or piped from `curl … | sh` in a non-interactive context), in which case it prints a "run this next" hint and exits cleanly.

Environment overrides:

| Variable | Default | Purpose |
|---|---|---|
| `PHANTOMBOT_INSTALL_DIR` | `~/.local/bin` | Where to install the binary |
| `PHANTOMBOT_SKIP_TUI` | unset | Set to skip the post-install persona TUI (useful in CI / unattended provisioning) |
| `GITHUB_TOKEN` | unset | Sent as `Authorization: Bearer …` for the GitHub API call (lifts unauth rate limits) |

After install, subsequent updates use:

```bash
phantombot update                       # interactive TUI
phantombot update --check               # exit 2 if newer available, 0 if current
phantombot update --force --restart     # cron-friendly: no prompts, restart after install
```

Updates download to `${binPath}.update.tmp`, SHA256-verify, atomically rename over the live binary, and clean up after themselves — no `.bak` files left in your install dir.

---

## Quick start

After `install.sh` completes (or builds-from-source — see below):

```bash
phantombot persona              # TUI — create or import (OpenClaw works) your first persona
phantombot harness              # pick claude / pi / gemini chain
phantombot telegram             # paste your @BotFather bot token + allowlisted user IDs
phantombot voice                # (optional) pick TTS/STT provider for voice messages

phantombot run                  # foreground — Ctrl-C to stop. Try sending a Telegram message.
phantombot install              # then install as a systemd --user service (survives logout)
journalctl --user -u phantombot -f
```

> **First-import note**: when you import a persona on a fresh box, `phantombot persona --import` automatically sets it as `default_persona` (unless you already have a persona configured). Without this, the built-in fallback `"phantom"` would be the default and `phantombot run` would fail with *"persona 'phantom' not found."* Switch later with `phantombot persona <name>`.

---

## Prerequisites

- **At least one harness** installed and authenticated as the user that will run phantombot:
  - **Claude Code** — `claude /login` (OAuth on host; phantombot filters `ANTHROPIC_API_KEY` so OAuth is the path)
  - **Inflection Pi** — `pi` configured per its own setup
  - **Google Gemini CLI** — `gemini` then OAuth via the in-app `/auth`, OR set `GEMINI_API_KEY` in `~/.env`
- A Telegram bot token from [@BotFather](https://t.me/BotFather)
- Linux (`systemd --user` for the service install path; the binary itself is portable)

If you'll run as a headless service account (no login session), enable linger so the unit survives logout:

```bash
sudo loginctl enable-linger $USER
```

**Bun** is only needed if you're building from source — the released binary has no runtime dep.

---

## Build from source (optional)

```bash
git clone https://github.com/andrewagrahamhodges/phantombot.git
cd phantombot
bun install
bun run build                # → ./dist/phantombot (~98 MB, linux-x64-baseline)
# bun run build:arm64        # cross-compile arm64 from an x64 host

mkdir -p ~/.local/bin && cp dist/phantombot ~/.local/bin/
# (or: scp dist/phantombot user@host:~/.local/bin/phantombot)
```

The build target **must remain `bun-linux-x64-baseline`**. If you "optimise" to plain `bun-linux-x64`, the binary will SIGILL on hosts without AVX2.

---

## Commands

### First-time / config (interactive TUIs)

| Command | What it does |
|---|---|
| `phantombot persona` | Create / import / restore / switch the active persona |
| `phantombot persona <name>` | Switch default persona to `<name>` |
| `phantombot persona --import <dir> [--as <n>]` | Non-interactive import (OpenClaw or phantombot-shaped) |
| `phantombot telegram` | Configure the Telegram channel (token + allowed users) |
| `phantombot harness` | Pick primary + fallback harnesses (claude / pi / gemini) |
| `phantombot voice` | Pick TTS/STT provider (ElevenLabs / OpenAI / Azure Edge) |
| `phantombot embedding` | (Optional) configure Gemini embeddings for memory search |

### Day-to-day

| Command | What it does |
|---|---|
| `phantombot run` | Foreground long-running listener (Ctrl-C to stop) |
| `phantombot install` | Install systemd --user units (main + heartbeat + nightly + tick) |
| `phantombot uninstall` | Remove the systemd units |
| `phantombot update [--check] [--force] [--restart]` | Atomic, SHA256-verified self-update |

### Agent-facing tools (the harnessed agent calls these via Bash)

| Command | What it does |
|---|---|
| `phantombot env set NAME "value"` | Atomic write to `~/.env` (mode 0o600) |
| `phantombot env get / list / unset` | Read / list-names-only / remove |
| `phantombot notify --message "…"` | Telegram text to all allowed users |
| `phantombot notify --voice "…"` | Synthesize via configured TTS, send as voice note |
| `phantombot task add --schedule "<cron>" --prompt "…" --description "…"` | Schedule a recurring agent task |
| `phantombot task list / show <id> / cancel <id>` | Manage tasks |
| `phantombot tick` | Fire any due tasks (called every minute by `phantombot-tick.timer`) |
| `phantombot memory today / search / get / list / index` | Read/write the persona's memory + KB |

### Periodic maintenance (called by systemd timers, occasionally by hand)

| Command | What it does |
|---|---|
| `phantombot heartbeat` | Mechanical 30-min pass (no LLM) |
| `phantombot nightly` | Cognitive distillation pass (LLM) |

---

## Personas

> **Heads up — single persona at runtime.** This bit surprises people, including the author once.

A persona is a directory of markdown files (`BOOT.md`, `MEMORY.md`, `tools.md`, etc.). You can have **many** persona directories on disk — each `phantombot persona` (or `--import`) adds one. They all live under `~/.local/share/phantombot/personas/<name>/`.

But **only one persona is active at any time**:

- `phantombot run` reads `default_persona` from `state.json` / `config.toml`, looks up that one directory, and binds the Telegram listener to it.
- A `runLock` (`src/lib/runLock.ts`) prevents two `phantombot run` processes from running on the same box, so even spawning a second one for a different persona is blocked.
- The Telegram channel has one bot token (one slot in `config.toml`), so even without the runLock you can't have two personas answering the same chat.

What you **can** do: switch personas. Memory is partitioned by persona, so switching is one command and each persona keeps its own private history forever:

```bash
phantombot persona --import ~/clawd/agents/robbie --as robbie
phantombot persona robbie                    # switch (writes default_persona to state.json)
systemctl --user restart phantombot          # robbie now answers Telegram

phantombot persona phantom                   # later — switch back; phantom resumes with phantom's memory
```

Two personas answering simultaneously (different bots, separate processes) isn't supported in v1 and would be a real architectural change.

---

## Voice replies in Telegram

When a Telegram voice message comes in (and the configured provider can do TTS), phantombot transcribes via STT, runs the harness, and synthesizes the reply as a voice note. **For these voice-in/voice-out turns only**, phantombot appends a one-paragraph brevity directive to the system prompt — telling the model to keep the reply to 1-3 sentences (~30 seconds of speech, ≈100 tokens), drop work narration ("Let me check…"), and skip markdown the TTS would read awkwardly.

The directive lives at the channel layer (`VOICE_REPLY_INSTRUCTION` in `src/channels/telegram.ts`), not in persona files — so text replies stay as detailed as the persona wants. If voice notes still feel too long after this, the next lever is the persona's tone in BOOT.md/SOUL.md, not a config knob.

---

## Scheduled tasks (`phantombot task` + `phantombot tick`)

The agent can schedule recurring work for itself. You ask Phantom on Telegram: *"every hour, check my email and let me know if anything important comes in."* Phantom (via the harness's Bash tool) runs:

```bash
phantombot task add \
  --schedule "0 * * * *" \
  --description "hourly email check" \
  --prompt "Check my Gmail since the last run. If anything is important, call \`phantombot notify --message \"…\"\`. Reply NONE otherwise."
```

`phantombot-tick.timer` fires every minute and calls `phantombot tick`, which:

1. Reads tasks from `memory.sqlite` where `next_run_at <= now() AND active=1`.
2. Spawns the harness with the stored prompt as the user message.
3. The agent does its thing — including calling `phantombot notify` if the user should hear about it.
4. Records the run, recomputes `next_run_at` from the cron expression.

**Notification is opt-in.** Tasks run silently by default. The agent only calls `phantombot notify` when something genuinely needs surfacing. *"Nothing important happened"* is a successful run.

**Missed runs are skipped.** Box off for 5 hours, hourly task missed 5 fires? The next tick after boot runs it once, not five times. No avalanche.

**Self-review prevents task accretion.** Every task has a `next_review_at` scaled to its cadence (hourly→14d, daily→30d, weekly→90d). When the date arrives, the next tick runs a review prompt — agent decides KEEP / STOP / MODIFY based on recent context. KEEP doubles the review interval. STOP deactivates and notifies you why.

Manage from anywhere: ask Phantom on Telegram *"list my scheduled tasks"* / *"cancel the email check"* — the agent runs `phantombot task list` / `phantombot task cancel <id>`. Or use the same CLI commands directly.

---

## Voice replies in Telegram

When a Telegram voice message comes in (and the configured provider can do TTS), phantombot transcribes via STT, runs the harness, and synthesizes the reply as a voice note. **For these voice-in/voice-out turns only**, phantombot appends a one-paragraph brevity directive to the system prompt — telling the model to keep the reply to 1-3 sentences (~30 seconds of speech, ≈100 tokens), drop work narration ("Let me check…"), and skip markdown the TTS would read awkwardly.

The directive lives at the channel layer (`VOICE_REPLY_INSTRUCTION` in `src/channels/telegram.ts`), not in persona files — so text replies stay as detailed as the persona wants. If your voice notes still feel too long after this, the next lever is the persona's own tone in BOOT.md/SOUL.md, not a config knob.

## `phantombot notify` (agent's voice to you)

```bash
phantombot notify --message "Proxmox upgrade succeeded on all hosts."
phantombot notify --voice   "Heads up — backup failed on pve-3."
phantombot notify --message "Both" --voice "Both"   # text + voice
```

Sends to every chat in `[channels.telegram].allowed_user_ids`. Refuses (exit 2) if the allowlist is empty — no accidental broadcasts. Voice synthesis uses your configured TTS provider (set via `phantombot voice`).

---

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

---

## Why this exists

The author's daily-driver assistant ("Robbie") used to run on [OpenClaw](https://github.com/openclaw/openclaw). OpenClaw provides personality + channels + memory **and** its own model abstraction **and** its own tool layer. The model abstraction is fine. The tool layer fights with how Claude Code, Pi, and Gemini CLI already do tools — better than OpenClaw could. Phantombot keeps the personality + memory + Telegram channel and lets the harness be the brain *and* the hands.

When Phantom is asked to *"SSH to the home lab and write a note to the Obsidian vault,"* the request goes to `claude --print` with Phantom's system prompt installed. Claude Code uses *its* Bash / Write / SSH tools to do the work and returns the final text. Phantombot relays it to Telegram. No tool-call translation layer, no permission gates, no `tools[]` array conversion.

---

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
persona  (bun:sqlite)    (claude → pi → gemini)
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
                  send reply via Telegram sendMessage / sendVoice
```

Tool execution happens entirely inside the harness — phantombot doesn't see it.

Four systemd-user units run alongside `phantombot.service`:

| Unit | Cadence | What it does |
|---|---|---|
| `phantombot.service` | always-on | The long-running Telegram listener |
| `phantombot-tick.timer` | every 1 min | Fires due scheduled tasks |
| `phantombot-heartbeat.timer` | every 30 min | Mechanical maintenance, no LLM |
| `phantombot-nightly.timer` | daily 02:00 | Cognitive distillation pass, LLM |

Every service has **two `EnvironmentFile=` lines** (`~/.config/phantombot/.env` and `~/.env`), both optional. The merged `process.env` is what spawned harnesses inherit, so the agent finds credentials without re-reading either file.

---

## Memory

Local SQLite at `~/.local/share/phantombot/memory.sqlite`. Two tables:

```sql
turns(id, persona, conversation, role, text, created_at)
tasks(id, persona, description, schedule, prompt, created_at,
      last_run_at, next_run_at, run_count,
      next_review_at, review_count, active)
```

Each persona × conversation gets its own namespace (`telegram:<chatId>`, `tick:<task-id>`, etc.). FTS5-based hybrid search via `phantombot memory search` (built into bun:sqlite); optional Gemini embeddings if `phantombot embedding` is configured.

---

## OpenClaw persona import

```bash
phantombot persona --import /path/to/openclaw-agent --as robbie [--no-telegram]
```

Recognized files (any layout works):

| Slot | Filenames (first match wins) |
|---|---|
| identity (required) | `BOOT.md` → `SOUL.md` → `IDENTITY.md` |
| persistent memory | `MEMORY.md` |
| tools / hints | `tools.md` → `AGENTS.md` |

Bonus `.md` files come along too. SQLite, JSONL, dotfiles, subdirs (other than `memory/` and `kb/`) are skipped with reasons in the summary. **Conversation history is not imported in v1.**

By default the import also sniffs `~/.openclaw/openclaw.json` for a Telegram bot block; if found, it writes to `[channels.telegram]`. Pass `--no-telegram` to skip.

---

## Versioning

`major.minor.patch`, where **patch is the GitHub PR number**. Every merged PR auto-tags `v1.0.<PR_NUMBER>`, builds binaries, publishes a release. Intentionally not semver — `1.0.42` is "patch" of `1.0.41` only by coincidence (PRs aren't ordered by semantic impact). Don't bolt semver-aware logic onto `phantombot update`.

---

## Layout

```
phantombot/
├── README.md                      # this file
├── AGENTS.md                      # contributor guide — read first if you're adding code
├── install.sh                     # one-liner installer (curl … | sh)
├── docs/
│   ├── architecture.md
│   └── adding-a-harness.md
├── src/
│   ├── index.ts                   # entry; runs the Citty dispatcher
│   ├── version.ts                 # CI sed-replaces "0.1.0-dev" with "1.0.<PR_NUMBER>"
│   ├── config.ts state.ts
│   ├── persona/                   # loader + builder (system-prompt sections)
│   ├── memory/                    # bun:sqlite turn store
│   ├── importer/                  # OpenClaw → phantombot persona import
│   ├── orchestrator/              # turn coordinator + harness fallback chain
│   ├── channels/telegram.ts       # Telegram adapter (HTTP + long-poll)
│   ├── cli/                       # one file per Citty subcommand
│   ├── harnesses/                 # claude + pi + gemini wrappers
│   └── lib/                       # logger, IO, configWriter, systemd, audio,
│                                  # tasks, cronSchedule, binaryUpdate, githubReleases…
├── agents/phantom/                # placeholder persona used by tests
├── tests/                         # bun test
├── .github/workflows/release.yml  # auto-release per merged PR
└── package.json bunfig.toml tsconfig.json
```

---

## Design principles

- **Small.** The CLI surface is deliberate. If you're tempted to build a model-provider abstraction, a tool-call translator, or a multi-tenant model, stop — you're rebuilding what we're explicitly *not* using.
- **Harness-agnostic interface, harness-specific implementations.** Every harness wrapper translates the same `HarnessRequest` into its CLI's specific flags. No shared "model spec." See `src/harnesses/claude.ts` for the reference shape.
- **Personality lives in markdown files, not config.** Persona changes are commits to `BOOT.md`, not config-knob flips. The TUI is bootstrap-only.
- **Memory is local.** SQLite on disk. No cloud sync.
- **OAuth on host. Phantombot holds no model API keys.** Claude / Pi / Gemini are pre-configured by you; phantombot just spawns them.
- **Single-operator.** One person, one machine, one persona at a time.
- **Updates are atomic.** `phantombot update` rename-swaps the binary on Linux (kernel keeps the running process backed by the original inode), SHA256-verifies before swap, and cleans up after itself — no `.bak` files left behind.

---

## Contributing

Read [`AGENTS.md`](AGENTS.md) first. The contributing discipline: README and AGENTS must stay in sync with the code on every PR.

```bash
bun install
bun tsc --noEmit       # typecheck
bun test               # full suite
bun run build          # → dist/phantombot
```

---

## Acknowledgements

The motivating insight (*"the harness can do its own tools — let it"*) and the initial Claude harness implementation came from work on a Claude-Code proxy on the OpenClaw VPS. The five-patch reasoning at the top of `src/harnesses/claude.ts` (stdin prompt, `--system-prompt` separation, `bypassPermissions`, `--fallback-model`, no `--bare`) is the basis for the harness here.
