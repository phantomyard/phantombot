# Phantombot

Phantombot gives a terminal AI harness a durable soul: one persistent
identity, long-term memory with semantic search, and a presence that reaches
you across PhantomChat, Telegram, and your editor — the same persona and
memory behind every surface.

**It is LLM-agnostic and swaps brains without losing the thread.** Running on
the recommended [Pi](https://pi.dev) harness, a single conversation routes the
*right model for the moment* — a fast, personable Primary for everyday talk, a
Vision model when you share an image, and a heavyweight Coder when the work
turns to code — all inside one continuous turn. Because the harness rebuilds
the full context every turn (persona + history + retrieved memory + images),
the coding brain inherits everything natively. No lossy hand-off, no losing
the plot mid-task.

**It owns the work — it doesn't scatter it.** Phantombot is one continuous
agent that holds a task end to end. It does not shard your request across a
swarm of throwaway sub-agents that hand back half-finished, unvetted output
for you to stitch together. What comes back is coherent and accountable,
because one Phantom — with its own memory and judgment — saw it through.

**It compounds.** Every Phantom keeps a private, local memory of your
decisions, lessons, people, and standing preferences, authored in the
**[Open Knowledge Format](https://cloud.google.com/blog/products/data-analytics/how-the-open-knowledge-format-can-improve-data-sharing/)**
(OKF — Google Cloud's open standard for agent knowledge) and searchable by
*meaning* with Gemini embeddings + hybrid vector/keyword retrieval. No Gemini
key? Memory still gets superpowers: OKF **field-weighted BM25** plus
**concept-graph expansion** — far sharper than plain keyword search. It doesn't
reset between sessions; it accumulates. So the
longer a Phantom works with you, the more it understands your code and your
world — and complex projects and long-lived codebases need *less* prompting
and *less* re-explaining over time, exactly where most assistants fall off.

Under the hood it stays out of the harness's way: it implements no rival
tool-calling layer. The harness already knows how to use Bash, files, SSH, and
the browser — Phantombot provides the surrounding runtime (identity, memory,
channels, scheduling, voice, atomic self-update) and lets the harness do the
work.

**One soul, every channel:**

- **[PhantomChat](https://github.com/phantomyard/phantomchat)** — an
  end-to-end-encrypted (Nostr) text and voice DM channel, on desktop and
  mobile. The recommended way to talk to your Phantom; onboard at
  [chat.phantomyard.ai](https://chat.phantomyard.ai).
- **Telegram** — first-class text, voice, group, and attachment I/O, right
  from your pocket.
- **[VS Code & Zed extensions](#editors-vs-code--zed)** — the same persona,
  memory, and judgment inside your editor's chat panel over ACP. Pick
  *Phantombot* from the agent list and code with an agent that already knows
  your repo, your decisions, and you.

Supported harnesses:

- [Pi](https://pi.dev) - recommended primary harness.
- Claude Code - first-class fallback or primary.
- Google Gemini CLI - first-class fallback or primary.
- OpenAI Codex CLI - first-class fallback or primary.

## Contents

- [Why Phantombot Exists](#why-phantombot-exists)
- [Install](#install)
- [Quick Start](#quick-start)
- [Windows (preview)](#windows-preview)
- [Configuration](#configuration)
- [Command Reference](#command-reference)
- [Telegram](#telegram)
- [PhantomChat](#phantomchat)
- [Editors: VS Code & Zed](#editors-vs-code--zed)
- [Pi Capability Routing](#pi-capability-routing)
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
- [Policies & Guidelines](#policies--guidelines)
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
- A [PhantomChat](https://github.com/phantomyard/phantomchat) (Nostr, end-to-end-encrypted) DM channel, running alongside Telegram. Onboard at [chat.phantomyard.ai](https://chat.phantomyard.ai).
- First-party [VS Code and Zed extensions](#editors-vs-code--zed) — the same persona, memory, and judgment, right inside your editor over ACP.
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
- Installs service units with a deterministic PATH that includes stable
  per-user shim locations such as `~/.local/bin` and
  `~/.local/share/pi-node/{bin,current/bin}`.
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

Headless services do not inherit your interactive shell PATH. If a harness
installer puts the real binary under a versioned npm/node directory,
Phantombot records the discovered absolute path in its runtime state and uses
that path directly on later starts. `phantombot run` never refuses to start
because a harness is missing; it logs a loud warning and keeps the service
alive. `phantombot doctor` checks the configured harness chain from the
service PATH plus common npm/pi-node locations, and repair mode saves any
paths it finds.

Then configure phantombot:

```bash
phantombot persona     # create or import a persona
phantombot harness     # choose primary and fallback harnesses
phantombot telegram    # paste BotFather token and allowed user IDs
phantombot voice       # optional TTS/STT setup
phantombot embedding   # recommended semantic memory setup

phantombot run         # foreground listener
phantombot install     # install systemd --user units

phantombot start       # start the installed background service
phantombot stop        # stop it (and keep it stopped)
phantombot restart     # bounce it
phantombot logs        # tail its logs (Ctrl-C to stop; --no-follow to dump)
```

For a headless Linux service account, enable linger so the user service keeps
running after logout:

```bash
sudo loginctl enable-linger "$USER"
```

## Windows (preview)

Phantombot runs on Windows (x64 and arm64). The port shares ~95% of its code
with the Linux and macOS builds; the platform-specific pieces (data paths,
process tree-kill, run-lock, credential-store ACL, the background service, and
self-update) have native Windows implementations.

Every release publishes prebuilt, unsigned Windows binaries -
`phantombot-<tag>-windows-x64.exe` and `phantombot-<tag>-windows-arm64.exe` -
alongside the SHA256SUMS file.

**Install (preview) - PowerShell one-liner:**

```powershell
iwr -useb https://raw.githubusercontent.com/phantomyard/phantombot/main/install.ps1 | iex
```

This detects your architecture (x64/arm64), downloads the matching binary,
verifies its SHA256, runs `Unblock-File` so SmartScreen does not flag it,
installs to `%LOCALAPPDATA%\Programs\phantombot\phantombot.exe` (per-user, no
admin), adds that dir to your PATH, and launches `phantombot init`. It is the
Windows parallel to the Linux/macOS `install.sh`. Marked **(preview)** while the
Windows port settles.

**Or install manually** - download the `.exe` for your architecture, verify its
checksum, and drop it into the same per-user location:

```powershell
# Unblock the downloaded file (SmartScreen marks internet downloads):
Unblock-File .\phantombot-<tag>-windows-x64.exe
mkdir "$env:LOCALAPPDATA\Programs\phantombot"
copy .\phantombot-<tag>-windows-x64.exe "$env:LOCALAPPDATA\Programs\phantombot\phantombot.exe"
```

**Or build from source** (needs [Bun](https://bun.sh) on the Windows machine):

```powershell
git clone https://github.com/phantomyard/phantombot.git
cd phantombot
bun install
bun run build:win        # produces dist\phantombot.exe
```

Then configure it exactly as on Linux (`phantombot persona`, `harness`,
`telegram`, …).

**Data location.** Windows uses the same home-relative XDG layout as Linux and
macOS, so a persona's on-disk tree is identical across all three: config in
`%USERPROFILE%\.config\phantombot`, data (personas, memory database, logs) in
`%USERPROFILE%\.local\share\phantombot`, and state (timer/lock bookkeeping) in
`%USERPROFILE%\.local\state\phantombot`. Setting `XDG_DATA_HOME` (or the
`XDG_CONFIG_HOME` / `XDG_STATE_HOME` overrides) relocates them, exactly as on
Linux. The crown-jewel `identity.json` is created with an owner-only ACL
(`icacls`, inheritance stripped) so other accounts on the box cannot read it.

**Install as a background service.**

```powershell
phantombot install      # installs the per-user logon task and periodic tasks
phantombot uninstall    # removes the service and tasks
```

`install` registers four tasks in the current user's `\\Phantombot\\` folder:
the always-on daemon (`run`) and the periodic `heartbeat`, `nightly`, and
`tick` tasks. They use the current user's SID and `InteractiveToken`, so no
password, elevation, or machine-wide service is required. The daemon starts at
logon, retries after failure, and its process-tree cleanup keeps stop/restart
deterministic while that user is logged in.

**Self-update.** `phantombot update` and the `/update` chat command work on
Windows. Because Windows locks a running `.exe` against overwrite, the updater
renames the live binary aside to `phantombot.exe.old` (allowed while it runs),
drops the verified new binary into place, then exits cleanly; the scheduled
task's keep-alive trigger relaunches the agent on the new binary while the user
is logged in. In-place self-update needs the task installed (`phantombot install`).

**Logs.** Service stdout/stderr are redirected to
`%USERPROFILE%\.local\share\phantombot\logs\*.out.log` / `*.err.log`. These
currently grow unbounded (no built-in rotation yet) - prune them periodically
if the box runs for a long time.

Status: the Windows port is exercised by a dedicated `windows-latest` CI job on
every pull request. Treat it as a **preview** — solid enough to run, but newer
than the Linux/macOS paths.

## Service lifecycle (`start` / `stop` / `restart` / `logs`)

Once the background service is installed (`phantombot install`), four
OS-agnostic verbs control it. They resolve to the right service manager for the
host automatically — you type the same command everywhere:

```bash
phantombot start      # start the installed service
phantombot stop       # stop it and keep it down
phantombot restart    # bounce it
phantombot logs       # tail its logs (Ctrl-C to stop)
phantombot logs --no-follow --lines 200   # dump the last 200 lines and exit
```

| Verb | Linux (systemd) | macOS (launchd) | Windows (Task Scheduler) |
|---|---|---|---|
| `start` | `systemctl --user start` | `bootstrap` (or `kickstart`) | `schtasks /Change ... /ENABLE` + `/Run` |
| `stop` | `systemctl --user stop` | `bootout` | `schtasks /Change ... /DISABLE` + `/End` |
| `restart` | `systemctl --user restart` | `kickstart -k` | `schtasks /End` + `/Run` |
| `logs` | `journalctl --user -u phantombot` | `tail` the out/err log files | `Get-Content -Wait` the out log |

**Why `stop` does more than kill the process.** On macOS the agent is a
KeepAlive LaunchAgent; a plain kill would be relaunched within seconds. On
Windows, Task Scheduler owns the per-user daemon and `stop` disables and ends the task. On Linux the main unit is
`Restart=on-failure`, so a clean `stop` already stays stopped with nothing extra
to do.

`start`/`stop`/`restart` exit `0` on success and `1` on failure, printing a
copy-pasteable manual command if the backend refuses — so they're safe to script
in health checks or deploy hooks. These are the *external* controls (run from a
terminal); the in-chat `/restart` and `/update` commands still bounce the running
service from inside itself.

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
| `phantombot phantomchat` | Configure the PhantomChat (Nostr DM) channel |
| `phantombot voice` | Configure TTS/STT providers |
| `phantombot embedding` | Configure semantic memory |
| `phantombot acp install zed` | Register phantombot as an ACP agent in Zed |
| `phantombot acp install jetbrains` | Register phantombot as an ACP agent in JetBrains IDEs (Rider, IntelliJ, …) |
| `phantombot acp install vscode` | Install the first-party VS Code extension |

Runtime:

| Command | Purpose |
|---|---|
| `phantombot run` | Foreground Telegram listener |
| `phantombot install` | Install the host service and periodic jobs |
| `phantombot uninstall` | Remove the host service and periodic jobs |
| `phantombot start` | Start the installed background service (systemd/launchd/Windows Task Scheduler) |
| `phantombot stop` | Stop the background service and keep it down until `start` |
| `phantombot restart` | Restart the background service |
| `phantombot logs [--no-follow] [--lines N]` | Tail the service logs (journalctl/launchd files/Windows log) |
| `phantombot ask "<prompt>"` | One-shot prompt through the persona and harness chain |
| `phantombot update [--check] [--force] [--restart]` | Check, install, or restart after updates |
| `phantombot p2p status` | Show relay-free P2P transport config and whether a local node is listening |

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

## Shell completion

`phantombot install` sets up `<TAB>` completion for `bash`, `zsh`, and `fish`
automatically — no extra command, no separate opt-in. `phantombot update`
refreshes it, and `phantombot uninstall` removes it. Open a new shell after
installing to pick it up.

Completion is dynamic: a small stub in your shell calls back into the binary on
every `<TAB>`, so it always matches the available subcommands and flags —
`phantombot p<TAB>` → `persona`, `phantomchat`, `p2p`; `phantombot p2p <TAB>` →
`status`; `phantombot logs --<TAB>` → `--follow`, `--no-follow`, `--lines`.

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
| `/coder` | Force the coding brain on for this chat (`off` / `default` to revert) |
| `/chattiness` | Show or hide progress bubbles in this chat (`on` / `off` / `<on\|off> default`) |
| `/help` | Show the command list |

Unknown slash commands fall through to the harness so personas can define
their own conventions.

### Reply Pacing

Telegram and PhantomChat replies are shaped for phone chats:

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

### Chattiness (quiet mode)

While a phantom works, it streams interim **progress bubbles** — the running
"checking your calendar…" commentary that fills the silence before a tool call.
Some people like the play-by-play; others just want the answer. `/chattiness`
toggles those interim bubbles **per conversation** (the final reply and any
errors always come through either way):

- `/chattiness off` — quiet: no progress bubbles, just the final reply.
- `/chattiness on` — show the progress bubbles.
- `/chattiness default` — clear this chat's setting; follow the standing default.
- `/chattiness off default` (or `on default`) — also write the standing default
  to `config.toml` so **new** chats start that way.

Scoped to Telegram + PhantomChat (voice and the CLI never emit these bubbles).
The editor (Zed/VS Code) surface follows the config default only.

**The standing default is on.** Unless you explicitly set `chattiness`, a
phantom **narrates** — it streams the running commentary as it works. This is
deliberate: the play-by-play keeps the agent anchored across long, tool-heavy
runs and empirically produces more reliable work on large tasks. The default
holds whether there's no `config.toml`, an empty one, or a `config.toml` that
simply omits the key. Opt out of the commentary by setting it:

```toml
# Top-level. true (or unset) = show progress bubbles everywhere; false = quiet.
chattiness = false
```

## PhantomChat

> **Onboard at [chat.phantomyard.ai](https://chat.phantomyard.ai).** That's the
> live PhantomChat app — open it on desktop or mobile, create your account, and
> start a DM with your persona using the npub the bot prints below. PhantomChat
> is our recommended channel; Telegram remains fully supported and first-class.

[PhantomChat](https://github.com/phantomyard/phantomchat) is a decentralized,
end-to-end-encrypted messenger built on [Nostr](https://nostr.com) (NIP-17
gift-wrapped DMs). This channel lets phantombot join the **same** network as a
client and answer DMs from the PhantomChat app, **alongside** Telegram — both
channels run at once. There is no server: the bot is just another Nostr client.

Set it up per persona:

```bash
phantombot phantomchat --persona <name>
```

This generates the persona's Nostr keypair on first run (stored 0600 in the
persona's own `phantomchat.json`) and prints an **npub** — paste that into the
PhantomChat app to start a DM with the persona. On start the bot publishes its
profile (display name = the persona name, flagged as a bot) and greets the npubs
on its allowlist. The allowlist is the trust boundary: listed npubs become
trusted principals (same grant as Telegram's allow-listed users); an empty
allowlist arms trust-on-first-use. Authorization keys on the **cryptographic
sender** (`rumor.pubkey`), never the attacker-controllable envelope `from`.

Relays come from a shared canonical list and can be edited by re-running the
command. See the [PhantomChat repo](https://github.com/phantomyard/phantomchat)
for the app itself and the wire-protocol details.

### Multiple bots in one group

When several persona bots share a PhantomChat group, each one would otherwise
answer **every** message — three bots, three replies to one question. PhantomChat
gives you the Telegram behaviour (only the bot you addressed responds)
**automatically, with no configuration**:

- A bot replies only when its **persona name** appears in the message ("hey
  **Lena**, …"), or when it's the bot currently holding the thread (so a no-name
  follow-up still reaches it). Address a different bot by name and the previous
  one falls quiet.
- A bot **never reacts to another bot's** messages — in a group *or* a 1:1 DM —
  so one bot's reply can't trigger another and start a back-and-forth loop. Only
  humans drive the conversation.

This works out of the box because every Phantom publishes a NIP-24 **`bot: true`**
flag and a display name in its Nostr profile (kind-0). Each bot reads the
profiles of the group's members, so it learns who the *other* bots are — and
their names — straight from the protocol. Nothing to wire up; just add the bots
to a group.

**Optional override.** If you want deterministic behaviour from the very first
message (before profiles resolve), or to force-mark a specific account as a
sibling bot, you can still seed the roster per-persona with a `group_bots` list
in `phantomchat.json`. It's merged with what's auto-detected:

```json
{
  "nsec": "nsec1…",
  "allowed_npubs": ["npub1…"],
  "group_bots": [
    { "name": "kai",  "npub": "npub1kai…" },
    { "name": "robbie", "npub": "npub1robbie…" }
  ]
}
```

Most setups won't need it — the auto-detection covers them.

## Relay-free P2P transport (preview)

Normally every PhantomChat message round-trips through a public Nostr relay. That
relay is both a latency floor (even two peers on the same desk pay a relay hop)
and a dependency you don't control. The P2P transport (issue #258) demotes relays
from "carry every message" to **signaling + fallback only**: your phantombot
becomes your personal P2P node, and messages travel **directly node-to-node** over
an encrypted WebRTC data channel with no relay in the hot path.

**How it fits together**

```
  PWA (browser)                                    PWA (browser)
     │  ws://localhost:<discovered>                   │  ws://localhost:<discovered>
     ▼                                                ▼
  [phantombot node] ◀── werift WebRTC data channel ──▶ [phantombot node]
     ╲                    (direct, encrypted)                    ╱
      ╲···· Nostr relays: WebRTC handshake (signaling) only ····╱
```

- **No hardcoded port — the PWA discovers it.** Each node binds an **OS-ephemeral
  loopback port** (`port = 0`), so any number of personas can host a node on one
  machine with **zero port collisions**. The node publishes its real bound port in
  its capability advert, in **plaintext** — a loopback port bound to `127.0.0.1` is
  reachable only from this machine, so it's not a secret, and any same-machine PWA
  (a *different* Nostr identity than the node) reads the port and dials
  `ws://localhost:<that port>`. (An earlier design self-encrypted the port to the
  node's own key; that was wrong — the PWA is a different identity and could never
  decrypt it. LAN IPs aren't advertised at all: ICE discovers LAN host candidates
  live on the node↔node WebRTC path.)
- The node exposes that loopback bridge for the same-machine PWA (loopback
  is a secure context, so an HTTPS PWA may open it — no TLS-cert wall). The bridge
  **gates WebSocket upgrades on the browser `Origin`**: loopback binding keeps the
  port off the LAN, but any website you visit could otherwise reach it (WebSocket
  isn't CORS-preflighted). Clients that send no `Origin` header (CLI/tooling) and
  localhost origins (the dev PWA) are always allowed; other browser origins must
  be in `allowed_origins` (defaults to the production PhantomChat origin) or the
  upgrade is refused with **403**. A literal `Origin: null` — what a browser emits
  from an *opaque* origin (sandboxed iframe, `data:`/`file:` page, some redirects)
  — is treated as untrusted and refused too, so it can't be used to slip the gate.
- Two nodes negotiate a **werift** (pure-TypeScript WebRTC) data channel. werift
  is used instead of Hyperswarm/`node-datachannel` because it's the only stack
  that survives `bun build --compile` into the shipped single binary — no native
  addon, no sidecar.
- **Nostr carries only the WebRTC handshake** (SDP offer/answer + ICE candidates),
  encrypted with NIP-44 on a dedicated ephemeral event kind — never your message
  contents, which stay end-to-end sealed. Public **STUN** handles NAT traversal
  (STUN only reflects your IP back, it never relays — so there's still no
  infrastructure of ours in the path).
- If no direct route can be established, everything **falls back to the existing
  relay path**, so nothing ever breaks.

**On by default — but still zero-cost when unused.** The subsystem runs, but it
only ever *adds* a fast path: if no direct route exists, everything falls back to
the relay, and the node relays only the opaque gift-wrap between peers — it never
holds a key for your message contents. The advert is inert until a peer's PWA
reads it.

**Tuning** (all optional) in `~/.config/phantombot/config.toml`:

```toml
[p2p]
enabled = true          # default true
port = 0                # 0 = OS-ephemeral (default); pin a number only for debugging
stun_servers = [        # public reflexive-only STUN (no infra of ours)
  "stun:stun.l.google.com:19302",
  "stun:stun1.l.google.com:19302",
]
allowed_origins = [     # browser origins allowed to open the loopback bridge
  "https://chat.phantomyard.ai",   # (localhost + no-Origin clients always allowed)
]
```

Env overrides (highest precedence): `PHANTOMBOT_P2P_ENABLED=0` to disable,
`PHANTOMBOT_P2P_PORT=0`, `PHANTOMBOT_P2P_STUN="stun:a:3478,stun:b:3478"`,
`PHANTOMBOT_P2P_ALLOWED_ORIGINS="https://chat.phantomyard.ai"`.

Check it with `phantombot p2p status` — it prints the resolved config and probes
the loopback port to tell you whether a node is actually listening on this
machine.

> **Note.** Every persona on a host runs its own node on its own ephemeral port
> and advertises it under its own npub — so multi-persona machines "just work."
> The companion phantomchat change reads a node's self-advert to discover the
> local port and a contact's advert to light up the ladder.

## Editors: VS Code, Zed & JetBrains

Your Phantom runs **inside your editor** as a first-class agent over the
[Agent Client Protocol (ACP)](https://agentclientprotocol.com) — VS Code, Zed
and JetBrains IDEs (Rider, IntelliJ, …) all supported. It's the *same* Phantom:
one persona, one memory store, one
set of tools, served from your machine. Start a thread in the editor, pick it
up later from PhantomChat or Telegram — there's only ever one soul behind all
the surfaces.

```bash
phantombot acp install zed       # merge the ACP registration into Zed's settings.json
phantombot acp install jetbrains # merge the ACP registration into ~/.jetbrains/acp.json (Rider, IntelliJ, …)
phantombot acp install vscode    # install the bundled first-party VS Code extension (.vsix)
```

All installers are idempotent and version-aware: Zed and JetBrains get a
JSONC-safe settings merge (your original is backed up), and VS Code installs the
bundled extension through the `code` CLI, skipping cleanly if the editor isn't
present.

The connector sits **beside** the channel layer — it calls the turn engine
directly with `trusted: true`. The principal is the local OS user who launched
the editor; they already have full filesystem access to everything phantombot
owns, so the untrusted-input threat judge is skipped for this surface.

Why it's better for real coding work:

- **Less prompting.** The editor extension carries your repo and editing
  context, so you re-explain far less per turn.
- **Built for complex projects.** Persona, memory, and tools live server-side
  and persist across sessions — the longer a Phantom works with you, the more
  it knows about your codebase, your conventions, and you. That accumulated
  context sharpens its judgment, raises its confidence, and cuts hallucinations
  and misaligned decisions.
- **One soul, every surface.** Editor, phone, terminal — same persona and
  memory behind all of them.

### Threads and workspace context

**A new editor thread is a new conversation.** Turn history is keyed per
*thread*, not per project directory, so a fresh thread starts empty — say
"hello" and you get a hello, not the resumption of whatever you were doing
yesterday.

A fresh thread is still *informed*, though. Recent activity from the other
threads in the same workspace (the editor's cwd) is supplied as a **read-only
briefing** in system context — explicitly framed as finished sessions whose
approvals are void. So your Phantom knows what you shipped and what's still
open, and can answer "where are we?" without a lookup, but it acts only on the
turn you actually typed.

Reopening a thread from the editor's history resumes it **verbatim**, with its
full turn history, exactly as you left it.

> Previously the conversation was keyed on the workspace directory alone, so
> every "new" thread silently replayed the last 30 turns for that folder — as
> *user* messages. A fresh thread opened onto a trailing queue of instructions
> (*"open a PR…"*, *"Go."*) and the Phantom would pick the last one up and start
> working, with nothing visible in the editor to cancel.

### Editor Commands

Slash commands are advertised to the editor, so they appear in its `/`-menu:

| Command | Purpose |
|---|---|
| `/stop` | Abort the turn that's currently running |
| `/reset` | Clear this thread's history |
| `/status` | Show harness, uptime, and context usage |
| `/harness` | List or switch the active harness |
| `/help` | Show the available commands |

They are dispatched **out of band** — ahead of the serial request queue — so
`/stop` can kill the long-running turn that is *blocking* that queue. (Your
editor's own cancel/stop button takes the same path and has always worked.)

`/update` and `/restart` are deliberately **not** offered here: they swap the
binary and bounce a service whose lifecycle the editor owns. They stay on
Telegram. Unknown slash commands fall through to the harness, same as every
other surface, so personas keep their own conventions.

## Pi Capability Routing

The recommended [Pi](https://pi.dev) harness routes **one brain per job**
within a single turn — Primary, Vision, and Coder — instead of forcing one
model to do everything:

- **Primary** — the orchestrator model that runs the turn and holds the thread.
- **Vision** — when the primary isn't multimodal, image work is delegated to an
  image model via a `look_at_image` tool registered by the bundled Pi
  extension. A multimodal primary keeps vision in-house and the delegate is
  skipped.
- **Coder** — for substantial code work, phantombot swaps the primary's
  `--model` to your configured coding model **for that turn only**. Because the
  Pi harness rebuilds the full context every turn (system prompt + history +
  retrieved memory + images), the coding model inherits all of it natively — no
  lossy hand-off to an isolated sub-agent.

The coder swap is decided by a [ModSecurity-CRS-style](https://coreruleset.org)
weighted scorer that reads the recent conversation **in context** (a
recency-decayed window with a small-sample prior), not just the latest message.
That keeps a Phantom on the coding brain through natural follow-ups in a review,
then releases it the moment the topic moves off code — stateless and
self-correcting, no sticky mode. Force it with `/coder`, disable with
`/nocoder`, or clear back to scoring with `/coder default`.

Configure all three roles with the `phantombot harness` wizard; the choices are
mirrored into `config.toml` under `[harnesses.pi.routing]` and visible to
`phantombot doctor`.

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

Notifications broadcast to **every** authorized recipient on **every**
configured channel for the persona — all Telegram allowed users and all
phantomchat allowed npubs (deduped, so an id authorized twice is contacted
once). Everyone authorized to talk to the persona hears about a material event,
not just a single primary. Each recipient is an independent send: one failing
(blocked bot, dead relay) is logged and skipped, never aborting delivery to the
others. Phantombot refuses to notify if no allowed recipients are configured on
any channel.

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
> present. A Gemini key ([`phantombot embedding`](#memory-search-okf-superpowers-by-default-gemini-semantic-on-top)) only
> sharpens the judge's **briefing recall** (decisions/people/norms): without it,
> recall falls back to OKF field-weighted BM25 (lexical), which is a quality degrade, not a security
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

### Memory search: OKF superpowers by default, Gemini semantic on top

Phantombot stores memory in the **[Open Knowledge Format](https://cloud.google.com/blog/products/data-analytics/how-the-open-knowledge-format-can-improve-data-sharing/)**
(OKF) — Google Cloud's open, vendor-neutral standard for the knowledge AI
agents consume: atomic markdown files with YAML frontmatter, linked into a
concept graph. Because the knowledge is *structured*, the default no-key search
path is much stronger than plain keyword matching:

- **Field-weighted BM25 (BM25F)** — frontmatter `title`, `tags`, and `aliases`
  are indexed as their own weighted columns, so a hit in a title or tag
  outranks the same word buried in prose.
- **Tag / alias controlled vocabulary** — author-time synonyms collapse the
  vocabulary-mismatch gap (e.g. "credential cycling" finds a note titled
  "Secret Rotation").
- **Concept-graph expansion** — after the lexical match, Phantombot walks the
  OKF link graph one hop (outbound *and* inbound) and folds in connected
  concepts a bare-keyword query would miss. A keyword-only stand-in for the
  "semantic spread" embeddings give you — with **zero API keys**.

This is the default. Every phantom gets it for free, no setup.

**Add Gemini embeddings** (optional, recommended for production) to layer true
**semantic** retrieval on top — matching by *meaning*, not just words. With a
key, search becomes **hybrid**: OKF field-weighted BM25 *and* vector similarity,
fused with reciprocal-rank fusion.

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

Without embeddings, search degrades cleanly to OKF field-weighted BM25 with
link-graph expansion — never to plain keyword.

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
Telegram adapter  (channels/telegram)
        |
        |-- transport: HTTP getUpdates / sendMessage
        |-- parse: raw update -> ChannelMessage
        |-- convert numeric chat/user ids -> string at the boundary
        |-- encrypt / decrypt seam (identity pass-through today)
        |
        v
Channel core  (channels/core, channel-blind)
        |
        |-- slash command handler
        |-- group routing gate
        |-- attachment / voice handling
        |-- streaming turn engine + server loop
        |
        v
Turn coordinator
        |
        |-- load persona markdown
        |-- load rolling conversation context
        |-- retrieve memory / KB hits
        |-- threat-screen untrusted input (see Security)
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

The channel layer is split into a channel-blind core and per-platform
adapters. The core deals only in string `conversationId` / `senderId` ids and
plaintext `ChannelMessage`s; each adapter converts its platform's native id
types and (in future) decrypts on ingest / encrypts on egress at its own
boundary. Telegram is the only adapter today; the encrypt/decrypt hooks are
identity pass-throughs and there is no Matrix or crypto code yet.

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
      core/        channel-blind types, routing, prompts, turn engine
      telegram/    Telegram adapter: transport, parse, channel
      telegram.ts  backward-compat barrel re-export
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

## Policies & Guidelines

Lessons written in blood. These are decisions that cost us real time, real
pain, and a closed PR before we learned them. Read them before you propose
something that "should be easy."

### Chat channels must be bot-friendly — or we don't build them

**Policy:** A new chat channel is not even *evaluated* unless it is
bot-friendly. The bar is non-negotiable:

- **First-class bot identity** — bots are a supported account type, not a human
  account in a trench coat.
- **Headless token auth** — log in with a token or app password from a config
  file. No GUI. No phone. No QR codes.
- **Zero human-in-the-loop verification** — no "is this really you?" popups, no
  emoji-comparison device verification, no security prompts on other sessions
  that only a human can dismiss.
- **Stable, long-lived credentials** — tokens don't silently self-invalidate
  and strand the bot mid-holiday.
- **Headless provisioning** — an account and its credentials can be created and
  rotated from a terminal, start to finish.
- **Single-binary friendly** — no heavyweight client runtime or native crypto
  store that fights a static build.

Telegram clears every one of these. That's why it's our daily driver.

**Case study — Matrix (don't reopen this):** We tried. It turned into colera and
shit. End-to-end encryption sounds great until you live it: GUI-only onboarding
through `app.element.io`, recovery keys that go stale the moment a human resets
recovery in their client, orphaned devices whose private keys live in exactly
one snapshot that the still-running process happily clobbers, the *entire bot*
crash-looping (Telegram included) when the on-disk crypto store drifts from the
configured device, and "prove it's you" popups that are unsuppressable by design
because they're aimed at a human, not a bot. An afternoon of a person's life,
gone, for a device that *still* showed unverified.

Read the full post-mortem before you ever think "maybe Matrix isn't that bad":
**[Issue #154 — Matrix channel: won't do, and why](https://github.com/phantomyard/phantombot/issues/154)**
(PR #175 closed unmerged).

If a channel can't pass the bar above, the answer is no — and "but it's popular"
is not a counterargument to "it requires a human to babysit every login."

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
