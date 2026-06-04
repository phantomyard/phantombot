# Phantombot

Phantombot is a personality-first Telegram agent runner. It gives a terminal
AI harness a durable identity, memory, Telegram presence, scheduled tasks,
voice replies, and atomic self-updates.

It does not implement a model abstraction or a tool-calling layer. The harness
already knows how to use its own tools, so phantombot provides the surrounding
agent runtime and lets the harness do the work.

Supported harnesses:

- [Pi](https://pi.dev) - recommended primary harness.
- Claude Code - first-class fallback or primary.
- Google Gemini CLI - first-class fallback or primary.
- OpenAI Codex CLI - first-class fallback or primary.

## Contents

- [Why Phantombot Exists](#why-phantombot-exists)
- [Install](#install)
- [Quick Start](#quick-start)
- [Configuration](#configuration)
- [Command Reference](#command-reference)
- [Telegram](#telegram)
- [Group Chats](#group-chats)
- [Voice Replies](#voice-replies)
- [Scheduled Tasks](#scheduled-tasks)
- [Notifications](#notifications)
- [Credentials](#credentials)
- [Memory](#memory)
- [Maintenance](#maintenance)
- [Architecture](#architecture)
- [Build From Source](#build-from-source)
- [Project Layout](#project-layout)
- [Design Principles](#design-principles)
- [Contributing](#contributing)

## Why Phantombot Exists

The motivating rule is simple:

> The harness can do its own tools. Let it.

Traditional agent gateways often add a second tool layer in front of a coding
agent that already has Bash, file access, SSH, browser tools, and its own
permission model. That creates slow restarts, brittle tool-call translation,
large config surfaces, and failure modes that the harness already solved.

Phantombot keeps the parts a personal assistant actually needs:

- A persistent persona loaded from markdown.
- Telegram text, group, attachment, and voice I/O.
- Rolling conversation context.
- Durable markdown memory and KB.
- Scheduled tasks.
- Safe credential discovery conventions.
- Atomic binary self-update.
- Systemd user-service installation.

When a user asks, "SSH to the home lab and write a note to the Obsidian vault,"
phantombot builds the persona prompt, loads relevant memory, sends the turn to
the harness, and relays the final answer to Telegram. The harness performs the
SSH, file edits, searches, and command execution through its native tool loop.

## Install

```bash
curl -fsSL https://raw.githubusercontent.com/phantomyard/phantombot/main/install.sh | sh
```

The installer:

- Detects host architecture (`x86_64` or `aarch64`).
- Fetches the latest GitHub release.
- Downloads the matching binary and `SHA256SUMS`.
- Verifies the checksum before installing.
- Installs to `~/.local/bin/phantombot` by default.
- Warns if `~/.local/bin` is not on `PATH`.
- Starts the persona setup TUI when stdin/stdout are interactive.

Installer environment overrides:

| Variable | Default | Purpose |
|---|---|---|
| `PHANTOMBOT_INSTALL_DIR` | `~/.local/bin` | Install destination |
| `PHANTOMBOT_SKIP_TUI` | unset | Skip the post-install TUI |
| `GITHUB_TOKEN` | unset | Optional token for GitHub API rate limits |

## Quick Start

You need:

- A Telegram bot token from [@BotFather](https://t.me/BotFather).
- Your numeric Telegram user ID from [@userinfobot](https://t.me/userinfobot).
- At least one installed and authenticated harness.

Install and authenticate a harness first:

```bash
# Pi, recommended
curl -fsSL https://pi.dev/install.sh | sh
pi

# Claude Code
npm install -g @anthropic-ai/claude-code
claude /login

# Gemini CLI
gemini

# Codex CLI
codex login
```

Then configure phantombot:

```bash
phantombot persona     # create or import a persona
phantombot harness     # choose primary and fallback harnesses
phantombot telegram    # paste BotFather token and allowed user IDs
phantombot voice       # optional TTS/STT setup
phantombot embedding   # recommended semantic memory setup

phantombot run         # foreground listener
phantombot install     # install systemd --user units
```

For a headless Linux service account, enable linger so the user service keeps
running after logout:

```bash
sudo loginctl enable-linger "$USER"
```

## Configuration

Phantombot resolves configuration in this order:

1. `PHANTOMBOT_*` environment variables.
2. TOML at `$XDG_CONFIG_HOME/phantombot/config.toml` or `PHANTOMBOT_CONFIG`.
3. Built-in defaults.

Common paths:

| Path | Purpose |
|---|---|
| `~/.config/phantombot/config.toml` | Main config |
| `~/.config/phantombot/.env` | Phantombot runtime secrets, such as voice provider keys |
| `~/.env` | General credentials available to the harness |
| `~/.local/share/phantombot/memory.sqlite` | Rolling turns, tasks, capture log |
| `~/.local/share/phantombot/personas/<name>/` | Persona markdown memory and KB |

Minimal config example:

```toml
default_persona = "phantom"

[harnesses]
chain = ["pi", "claude", "gemini", "codex"]

[channels.telegram]
token = "123456:telegram-bot-token"
allowed_user_ids = [123456789]
```

Harness notes:

- Pi is the recommended primary harness.
- Claude Code is normally authenticated with OAuth on the host.
- Gemini can use CLI auth or `GEMINI_API_KEY`.
- Codex can use `codex login` or `OPENAI_API_KEY`.
- `chain` order is primary to fallback.

## Command Reference

Interactive setup:

| Command | Purpose |
|---|---|
| `phantombot persona` | Create, import, restore, or switch personas |
| `phantombot harness` | Choose harness chain |
| `phantombot telegram` | Configure Telegram token and allowlist |
| `phantombot voice` | Configure TTS/STT providers |
| `phantombot embedding` | Configure semantic memory |

Runtime:

| Command | Purpose |
|---|---|
| `phantombot run` | Foreground Telegram listener |
| `phantombot install` | Install systemd user service and timers |
| `phantombot uninstall` | Remove systemd user service and timers |
| `phantombot ask "<prompt>"` | One-shot prompt through the persona and harness chain |
| `phantombot update [--check] [--force] [--restart]` | Check, install, or restart after updates |

Agent-facing tools:

| Command | Purpose |
|---|---|
| `phantombot env set NAME "value"` | Save a credential atomically |
| `phantombot notify --message "..."` | Send a Telegram text notification |
| `phantombot notify --voice "..."` | Send a Telegram voice notification |
| `phantombot task add "<prompt>" "<description>" --every 1h` | Schedule an LLM-backed task |
| `phantombot task add "<prompt>" "<description>" --every 1h --command "/path/to/script"` | Schedule a command-backed task |
| `phantombot task list / show / cancel` | Inspect and manage scheduled tasks |
| `phantombot memory today / search / get / list / index` | Inspect memory and KB |
| `phantombot memory capture "<text>" --tag decision` | Append a tagged memory capture |

Maintenance:

| Command | Purpose |
|---|---|
| `phantombot tick` | Fire due scheduled tasks |
| `phantombot heartbeat` | Run mechanical maintenance |
| `phantombot nightly [--resume]` | Run or resume memory distillation |
| `phantombot doctor [--no-repair]` | Check memory health and optionally repair |

## Telegram

Phantombot runs one or more Telegram long-poll listeners. Each listener needs a
unique BotFather token. Reusing one token across listeners is refused because
Telegram allows only one active long-poll consumer per bot token.

The default Telegram account is configured in `[channels.telegram]` and binds
to `default_persona`:

```toml
[channels.telegram]
token = "111:default-bot-token"
allowed_user_ids = [123456789]
poll_timeout_s = 30
```

Additional persona-bound bots can run inside the same phantombot process:

```toml
[channels.telegram]
token = "111:default-bot-token"
allowed_user_ids = [123456789]

[channels.telegram.personas.lena]
token = "222:lena-bot-token"
allowed_user_ids = [123456789]

[channels.telegram.personas.kai]
token = "333:kai-bot-token"
allowed_user_ids = [123456789]
```

Environment variable overrides:

| Setting | Default bot | Persona bot example |
|---|---|---|
| Token | `TELEGRAM_BOT_TOKEN` | `TELEGRAM_BOT_TOKEN_LENA` |
| Allowed users | `PHANTOMBOT_TELEGRAM_ALLOWED_USERS` | `PHANTOMBOT_TELEGRAM_ALLOWED_USERS_LENA` |
| Poll timeout | `PHANTOMBOT_TELEGRAM_POLL_S` | `PHANTOMBOT_TELEGRAM_POLL_S_LENA` |
| Group persona names | `PHANTOMBOT_TELEGRAM_GROUP_PERSONAS` | `PHANTOMBOT_TELEGRAM_GROUP_PERSONAS_LENA` |

Persona env suffixes are uppercased and non-alphanumeric characters become
underscores, so `my-bot.test` uses `TELEGRAM_BOT_TOKEN_MY_BOT_TEST`.

### Telegram Commands

At startup, phantombot registers the real command menu with Telegram and
overwrites stale BotFather commands. The supported commands are:

| Command | Purpose |
|---|---|
| `/stop` | Abort the current turn |
| `/reset` | Clear this chat's history |
| `/status` | Show harness, uptime, and context usage |
| `/harness` | List or switch the active harness |
| `/update` | Install the latest phantombot release |
| `/restart` | Restart the phantombot service |
| `/help` | Show the command list |

Unknown slash commands fall through to the harness so personas can define
their own conventions.

### Reply Pacing

Telegram replies are shaped for phone chats:

- Progress narration is coalesced instead of sent once per tool call.
- Final replies are split into readable bubbles.
- Markdown tables and code fences are kept intact where possible.
- Voice replies are split into short voice notes.

Tuning:

```toml
[channels.telegram.streaming]
narration_flush_ms = 4500
bubble_max_sentences = 4
bubble_max_chars = 700
bubble_delay_ms = 800
voice_max_sentences = 3
```

## Group Chats

Group chats require two separate pieces:

1. Telegram delivery must let each bot receive the human messages.
2. Phantombot must decide which bot should answer.

### Telegram Privacy Mode

For natural group conversations, disable BotFather privacy mode for each bot in
the group.

With privacy mode ON, Telegram only delivers a small subset of group messages
to a bot:

- Slash commands.
- Replies to that bot.
- Some service messages.

Plain `@username` mentions are not reliable as a delivery mechanism under
privacy mode. If the bot never receives the update, phantombot cannot route it.

With privacy mode OFF, Telegram delivers human group messages to every bot in
the group. Phantombot then applies local routing so only the addressed bot
speaks.

### Configure Shared Group Names

Every bot in the same group should know the same list of persona names:

```toml
[channels.telegram]
token = "111:robbie-bot-token"
allowed_user_ids = [123456789]
group_persona_names = ["robbie", "lena", "kai"]

[channels.telegram.personas.lena]
token = "222:lena-bot-token"
allowed_user_ids = [123456789]
group_persona_names = ["robbie", "lena", "kai"]

[channels.telegram.personas.kai]
token = "333:kai-bot-token"
allowed_user_ids = [123456789]
group_persona_names = ["robbie", "lena", "kai"]
```

If `group_persona_names` is omitted, a bot still recognizes its own persona
name. That is enough for a single-bot group, but not enough for clean handoff
between multiple bots.

### Routing Rules

Phantombot's group routing is local and deterministic:

- If a human message names one persona, that persona answers.
- If a human message names several personas, each named bot answers.
- If a human message names another bot, this bot stays silent.
- If a human follow-up names nobody, the last-addressed bot continues.
- If a brand-new group thread names nobody, all bots stay silent.

Examples:

| Human message | Result |
|---|---|
| `Robbie, check this PR` | Robbie answers |
| `Lena and Kai, compare notes` | Lena and Kai both answer |
| `What about the edge case?` after Robbie was addressed | Robbie answers |
| `Anyone around?` in a new group | No bot answers |

The bot strips its own `@username` before sending the message to the harness,
so the assistant sees the user's actual request rather than addressing noise.

#### Routing uses only shared signals — name your bots accordingly

Routing is decided **purely from the persona-name list every bot shares**, never
from a bot's own Telegram `@username` (which the other bots can't see). If one
bot routed on a signal its peers couldn't observe, the bots' "last addressed"
state would drift apart — the mentioned bot would switch while the others kept a
previously-sticky bot answering, so two bots would reply and keep replying to
every no-name follow-up.

A native `@username` mention still routes correctly **when the persona name is
embedded in the username** — `robbie` inside `@robbie_agh_bot` matches on letter
boundaries, and because that match comes from the shared name list, every bot
agrees on it. So give each bot a username that contains its persona name (the
normal case). A bot whose username does *not* contain its persona name can only
be addressed by name in the text, not by a bare `@username`.

A bot that is *not* addressed stays completely silent — it produces no reply and
no `(no reply)` placeholder bubble. Silence in a group is normal, not an error.

### Context Catch-Up

When privacy mode is OFF, a bot can observe messages it did not answer. Each
bot keeps a small in-memory per-chat buffer of recent human messages it saw but
did not deliver to its harness. When the bot is later addressed, phantombot
prepends those messages as context:

```text
[Recent group messages you saw but didn't reply to, for context:
@andrew: Lena, I think option B is cleaner
@andrew: Kai, can you sanity-check the test path?
]

Robbie, what do you think?
```

The buffer is capped at 100 messages per group chat and is not persisted across
process restarts.

### Bot-To-Bot Limitations

Telegram bots cannot see messages sent by other bots. This is a Telegram
platform restriction, not a phantombot setting.

Consequences:

- Bots cannot coordinate by reading each other's Telegram replies.
- A bot only routes from the human message stream it receives.
- Shared `group_persona_names` is required because bots cannot infer the other
  bot roster from bot messages.
- If you need agents to coordinate internally, use an external shared system
  such as Plane, GitHub, files, or a purpose-built handoff mechanism. Do not
  rely on Telegram bot-to-bot conversation.

### Group Setup Checklist

1. Create one BotFather bot per persona.
2. Disable privacy mode for each bot that should participate naturally.
3. Add every bot to the Telegram group.
4. Configure each persona bot with the same `group_persona_names` list.
5. Keep `allowed_user_ids` restricted to trusted human users.
6. Restart phantombot.
7. Test with explicit names first, then no-name follow-ups.

## Voice Replies

When a Telegram voice message arrives, phantombot:

1. Transcribes it with the configured STT provider.
2. Runs the harness turn.
3. Synthesizes the reply with the configured TTS provider.
4. Sends the result as a Telegram voice note.

For voice-in/voice-out turns only, phantombot adds a short brevity directive to
the system prompt. Text replies are unaffected.

Per-message modality overrides:

- Voice in, text out: say "reply in text", "no voice", or "text reply only".
- Text in, voice out: write "send me a voice note", "reply with voice", or
  "voice please".

If TTS is not configured, phantombot degrades to text.

## Scheduled Tasks

`phantombot task` lets the agent schedule durable work in SQLite. The systemd
timer calls `phantombot tick` every minute.

Examples:

```bash
phantombot task add \
  "Check mail. Notify only if something genuinely needs attention." \
  "hourly mail check" \
  --every 1h

phantombot task add \
  "Poll Jira. Call phantombot ask only when new work appears." \
  "jira poll" \
  --every 1h \
  --command "/usr/local/bin/jira-poll" \
  --secret JIRA_API_KEY
```

Task behavior:

- LLM-backed tasks spawn the configured harness.
- Command-backed tasks run a local shell command directly.
- Command tasks receive a minimal environment plus only named `--secret` vars.
- Task stdout, stderr, exit status, and next run are recorded.
- Tasks run silently by default.
- Missed runs are skipped rather than replayed in a burst.
- Recurring LLM tasks get periodic self-review prompts.
- Recurring command tasks do not self-review, so add `--until`, `--count`, or
  `--for` when the poller has a natural end.

Manage tasks:

```bash
phantombot task list
phantombot task show <id>
phantombot task cancel <id>
phantombot tick
```

## Notifications

`phantombot notify` is the agent-facing way to proactively contact the user
from scheduled or background work:

```bash
phantombot notify --message "Backup failed on pve-3."
phantombot notify --voice "Backup failed on pve-3."
phantombot notify --message "Text" --voice "Voice"
```

Notifications are sent to the Telegram allowlist. Phantombot refuses to notify
if no allowed users are configured.

Background work should stay quiet unless something material happened or the
user explicitly asked to be interrupted.

## Credentials

Phantombot uses two environment files:

| File | Purpose |
|---|---|
| `~/.config/phantombot/.env` | Phantombot runtime secrets, usually written by setup commands |
| `~/.env` | General credentials for the harnessed agent |

Systemd units load both files with optional `EnvironmentFile=` entries. The
spawned harness inherits the merged environment, so agents can discover
credentials through `process.env` without pasting secrets into commands.

Agent-facing credential CLI:

```bash
phantombot env set GITHUB_TOKEN "ghp_..."
phantombot env list
phantombot env get GITHUB_TOKEN
phantombot env unset GITHUB_TOKEN
```

Use `phantombot env set` instead of appending to `.env` by hand. It writes
atomically, preserves file permissions, and avoids duplicate entries.

## Security

### Two-Tier Trust

Phantombot treats input by **origin**, not by content:

- **Trusted source** — a message from an allow-listed Telegram principal is
  the authenticated owner. It is acted on directly, with no extra screening.
  The principal is the gate.
- **Untrusted source** — anything else (email, `phantombot ask`, web, a
  webhook) cannot be trusted to only contain data. Its text may try to
  *instruct* the agent. These turns are screened before the harness runs.

### Untrusted-Input Threat Screening

Untrusted turns are passed to a **tool-less threat judge** before any capable
harness sees them — and **before any of your private memory is pulled into a
prompt** (screening runs ahead of memory retrieval, so an untrusted message
can never ride into a memory-laden prompt before it has been judged). The
judge is a bare, capability-restricted completion **on whichever harness you
configured as primary** — Claude, Pi, Gemini, or Codex. It does **not** assume
a particular CLI is installed: if you install only one of the four, screening
still runs on that one. It is not a keyword engine and not a separate API key.
Its only job is to *read* the incoming content and score it 0–100 for threat.
The screener consumes only that number.

Each harness runs the judge with its CLI's **native** capability-restriction
flag, not a hand-maintained deny-list (which rots as new tools ship):

| Harness | Judge mode | Floor |
|---------|------------|-------|
| Claude  | `--tools ""`            | true zero-tools |
| Pi      | `--no-tools`            | true zero-tools |
| Gemini  | `--approval-mode plan`  | read-only (may read, cannot act) |
| Codex   | `--sandbox read-only`   | read-only (may read, cannot act) |

Claude/Pi reach genuine zero-tools; Gemini/Codex reach read-only. Read-only is
a sufficient floor because the screener consumes only the judge's number and
never executes anything it "decides" — so even a fooled judge can at worst move
the number, never *act*.

Why an LLM and not a rule list: an attacker writes natural language, in any of
a hundred languages, specifically to look benign. A keyword/verb table is
brittle, English-shaped theatre that a Cyrillic or Thai payload walks straight
past — and judging by *meaning* is exactly what an LLM is for. The judge is
told to weigh by **effect, not tone**: content engineered to read as calm and
routine while asking for something irreversible is treated as *more*
dangerous, not less.

- **Below threshold** → the turn proceeds silently. Quiet when safe — no
  notification.
- **At or above threshold** → the untrusted turn is **held and does nothing**
  (fail-closed), and you get a Telegram message explaining what arrived and
  why, phrased to be **talked through** rather than answered yes/no. You and
  the agent discuss it on Telegram — the trusted channel — and *that*
  conversation is where the ruling is recorded.

**The judge's briefing.** A judge that knows nothing about your world flags
*everything* — the cry-wolf failure mode. So before judging, the screener
semantic-searches three drawers and feeds the judge a briefing:

- **decisions** — how you've ruled on similar matters before;
- **people** — known, legitimate senders/contacts;
- **norms** — what is *routine* in your world (e.g. "the Plane dashboards
  trigger deploys and DB migrations every day — routine, not an attack").

This is **deliberately scoped to those three drawers, not a raw memory dump**:
the judge doesn't need your finances or inbox to score a threat, and keeping
them out means they never land in a judge log either. A matching prior
approval, a known sender, or a documented norm lowers scrutiny; the briefing
**never clears** it — a genuinely catastrophic request re-escalates regardless.
The `norm` drawer is maintained by the nightly pass and is readable/correctable
like any other, so *what the judge believes is normal* is auditable.

**Who can record a ruling.** Only *you*, from a trusted turn. The judge writes
nothing; the untrusted turn writes nothing. An attacker can therefore never
author "Andrew approved this" — your trusted reply is the only thing that
records a decision, and that decision is what recall reads next time. Captured
rulings are indexed on write, so they're recall-able the same session.

Screening is **fail-open on infrastructure errors**: if the judge call itself
fails, the turn proceeds *unscreened* rather than blocking the assistant — a
screening outage degrades to "unscreened", never "app down". (This is distinct
from the **fail-closed hold** above, which governs an escalated-but-unanswered
request: that simply never runs.)

> **Recommended for production environments.** Threat screening itself needs no
> extra configuration — it runs on your primary harness, which is always
> present. A Gemini key ([`phantombot embedding`](#semantic-search)) only
> sharpens the judge's **briefing recall** (decisions/people/norms): without it,
> recall falls back to keyword-only, which is a quality degrade, not a security
> hole — screening still runs. Screening is **not** a wall —
> a sufficiently clever injection can still fool an LLM judge, just as it can
> fool a human — but it filters the obvious majority and puts a human beat in
> front of the rest.

## Memory

Phantombot memory has two layers:

- SQLite for rolling machine state.
- Markdown for durable human-readable memory and KB.

### SQLite Layer

SQLite lives at `~/.local/share/phantombot/memory.sqlite`.

Important tables:

| Table | Purpose |
|---|---|
| `turns` | Rolling per-conversation context buffer |
| `tasks` | Scheduled task store |
| `task_runs` | Task execution history |
| `capture_log` | Trace of explicit memory captures |

`turns` is not a permanent transcript archive. It is a bounded context buffer
used to keep recent conversations coherent.

### Markdown Layer

Markdown memory lives under each persona directory:

```text
~/.local/share/phantombot/personas/<name>/
  MEMORY.md
  memory/
    YYYY-MM-DD.md
    decisions.md
    lessons.md
    people.md
    commitments.md
  kb/
```

The flow:

1. The agent captures important facts with `phantombot memory capture`.
2. Heartbeat promotes tagged daily lines into structured drawers.
3. Nightly distills drawers and `kb/inbox/` into durable KB notes.
4. `MEMORY.md` stays lean and always-loaded.

Useful commands:

```bash
phantombot memory today
phantombot memory capture "Decision: use Pi as primary harness" --tag decision
phantombot memory search "Pi primary harness"
phantombot memory get memory/decisions.md
phantombot memory list kb
phantombot memory index --rebuild
```

### Semantic Search

Keyword search works by default. Semantic search is optional and recommended.
It uses Gemini embeddings so memory retrieval can match meaning, not just exact
words.

Enable it:

```bash
phantombot embedding
phantombot memory index --rebuild
```

Equivalent TOML:

```toml
[embeddings]
provider = "gemini"

[embeddings.gemini]
api_key = "AIza..."
model = "gemini-embedding-001"
dims = 1536
```

Without embeddings, search degrades cleanly to FTS-only.

### Nightly and Doctor

The nightly distillation is checkpointed in five stages:

```text
essence -> promote -> kb -> compress -> state
```

If it times out or the machine restarts, `phantombot nightly --resume`
continues from the checkpoint.

`phantombot doctor` checks memory health and can auto-repair stale, failed, or
partial nightly runs.

## Maintenance

Install service units:

```bash
phantombot install
```

Installed user units:

| Unit | Cadence | Purpose |
|---|---|---|
| `phantombot.service` | Always on | Telegram listener |
| `phantombot-tick.timer` | Every minute | Scheduled task runner |
| `phantombot-heartbeat.timer` | Every 30 minutes | Mechanical maintenance |
| `phantombot-nightly.timer` | Daily | LLM-backed memory distillation |

Update commands:

```bash
phantombot update
phantombot update --check
phantombot update --force --restart
```

Updates download to a temporary file, verify SHA256, atomically rename over the
live binary, and clean up after themselves.

The heartbeat checks for new releases automatically, waits 72 hours after a
release, then sends a Telegram `/update` heads-up. Manual update commands are
immediate.

## Architecture

```text
Telegram getUpdates
        |
        v
Telegram adapter
        |
        |-- slash command handler
        |-- group routing gate
        |-- attachment / voice handling
        |
        v
Turn coordinator
        |
        |-- load persona markdown
        |-- load rolling conversation context
        |-- retrieve memory / KB hits
        |
        v
Harness chain: pi -> claude -> gemini -> codex
        |
        |-- native harness tool loop
        |-- fallback on recoverable failure
        |
        v
Persist turn and send Telegram reply
```

Tool execution happens inside the harness. Phantombot only coordinates the
turn, memory, channel behavior, and runtime services.

## Build From Source

Bun is only required for source builds. Released binaries have no Bun runtime
dependency.

Important: the x64 build target must remain `bun-linux-x64-baseline`. Building
plain `bun-linux-x64` can produce binaries that SIGILL on hosts without AVX2.

```bash
git clone https://github.com/phantomyard/phantombot.git
cd phantombot
bun install
bun run build

mkdir -p ~/.local/bin
cp dist/phantombot ~/.local/bin/phantombot
```

Arm64 cross-build:

```bash
bun run build:arm64
```

## Project Layout

```text
phantombot/
  README.md
  AGENTS.md
  install.sh
  docs/
    architecture.md
    adding-a-harness.md
  src/
    index.ts
    version.ts
    config.ts
    state.ts
    persona/
    memory/
    importer/
    orchestrator/
    channels/
    cli/
    harnesses/
    lib/
  agents/phantom/
  tests/
  .github/workflows/release.yml
  package.json
  bunfig.toml
  tsconfig.json
```

## OpenClaw Persona Import

```bash
phantombot persona --import /path/to/openclaw-agent --as robbie
```

Recognized files:

| Slot | Filenames, first match wins |
|---|---|
| Identity | `BOOT.md`, `SOUL.md`, `IDENTITY.md` |
| Persistent memory | `MEMORY.md` |
| Tools / hints | `tools.md`, `AGENTS.md` |

Additional markdown files are copied. SQLite, JSONL, dotfiles, and unrelated
subdirectories are skipped with reasons in the summary. Conversation history is
not imported.

By default, import also sniffs `~/.openclaw/openclaw.json` for a Telegram bot
block. Pass `--no-telegram` to skip that.

## Versioning

Versions use `major.minor.patch`, where `patch` is the GitHub PR number.
Merged PR #142 publishes `v1.0.142`.

This is intentionally not semantic versioning. Do not add semver-aware update
logic.

## Design Principles

- Keep the runtime small.
- Let harnesses own tools and model behavior.
- Store personality in markdown, not config knobs.
- Keep memory local and inspectable.
- Prefer host OAuth for model CLIs.
- Make updates atomic.
- Keep Telegram behavior predictable in both DMs and groups.

## Contributing

Read [`AGENTS.md`](AGENTS.md) before changing code.

README and AGENTS must stay in sync with behavior on every PR.

```bash
bun install
bun tsc --noEmit
bun test
bun run build
```

## Acknowledgements

The initial Claude harness design came from work on a Claude Code proxy on the
OpenClaw VPS. The same reasoning carries into phantombot: pass the persona as a
real system prompt, send large prompts through stdin, use the harness's native
permission and fallback mechanisms, and avoid reimplementing its tool layer.
