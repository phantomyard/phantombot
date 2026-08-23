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
- **[VS Code & Zed extensions](#editors-vs-code-zed--jetbrains)** — the same persona,
  memory, and judgment inside your editor's chat panel over ACP. Pick
  *Phantombot* from the agent list and code with an agent that already knows
  your repo, your decisions, and you.

Supported harnesses:

- [Pi](https://pi.dev) - recommended primary harness.
- Claude Code - first-class fallback or primary.
- OpenAI Codex CLI - first-class fallback or primary.

## Contents

- [Why Phantombot Over a Naked Harness](#why-phantombot-over-a-naked-harness)
- [Why Phantombot Exists](#why-phantombot-exists)
- [Install](#install)
- [Quick Start](#quick-start)
- [Windows](#windows)
- [Configuration](#configuration)
- [Command Reference](#command-reference)
- [Multiple personas](#multiple-personas)
- [Telegram](#telegram)
- [PhantomChat](#phantomchat)
- [Editors: VS Code, Zed & JetBrains](#editors-vs-code-zed--jetbrains)
- [Pi Capability Routing](#pi-capability-routing)
- [Model Management (`/model`)](#model-management-model)
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

## Why Phantombot Over a Naked Harness

A raw harness — Claude Code, Codex, or Pi on its own — is powerful and
*exposed*. Whatever the model decides to do, it does, and everything it learns
about you lives inside the vendor's ecosystem: their servers, their retention,
their telemetry. Phantombot wraps that same harness in the two things a bare
CLI doesn't give you — **a security perimeter in front of it, and a local-first
vault around it.** The model keeps all of its power; you stop handing your
attack surface and your data to someone else's cloud.

Think of it as a **firewall on top of naked Claude Code / Codex / Pi.**

**A firewall in front of the model.** A bare harness acts on whatever reaches
it — including text from email, web pages, and webhooks that may be trying to
*instruct* it. Phantombot sits in front of that as a
[capability-and-trust perimeter](#security): a **two-tier trust model** (input
is judged by *origin*, not content) and a **tool-less threat judge** that reads
every untrusted turn — *before any of your memory is even loaded into a prompt*
— and holds anything dangerous for you to talk through on your trusted channel.
Same mental model as a firewall in front of an exposed box: the harness is
still there, but nothing reaches it unfiltered.

**Your data stays under your control.** With a naked proprietary harness, your
memory, secrets, and context are stored inside the vendor's ecosystem.
Phantombot keeps that state on the machine *you* run it on: an **encrypted
per-persona vault** (AES-256-GCM, keyed to your identity) for secrets, and a
**local markdown + SQLite memory store** on your own disk for decisions,
lessons, people, and preferences — no proprietary cloud account holding it
hostage. (Prompts and tool calls still go to whichever model provider you
configure — Claude, Codex, or Pi — so their retention and privacy terms apply
to what's sent; Phantombot's boundary is that *storage and secrets* stay local,
and the threat judge decides what's allowed into a prompt in the first place.)

**One capability layer on every harness.** Phantombot exposes external tools
(MCP servers — Drive, GitHub, Linear, Home Assistant, and more) through a
single `phantombot mcp` facade with **lazy discovery** (`search` → `describe`
→ `call`) instead of dumping every schema into the prompt up front. The same
capabilities work on Claude Code, Codex, *and* Pi — you aren't locked to one
vendor's tool ecosystem.

**Persistence and autonomy the CLI doesn't have.** One durable persona instead
of a fresh, amnesiac session each time: long-term memory that *compounds*,
durable scheduled tasks that survive restarts, a multi-persona fleet, and a
sanctioned proactive channel so your Phantom can reach *you* on Telegram when
something material happens — not just answer when spoken to.

> **Honest framing.** This is defence *at the capability layer* — designed to
> run natively without a disposable throwaway VM, and backed by an ongoing
> [security-audit practice](#security). It dramatically shrinks the blast
> radius; it is **not** a claim that the agent can't be compromised. A firewall
> in front of the box, not an impenetrable box.

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
- First-party [VS Code and Zed extensions](#editors-vs-code-zed--jetbrains) — the same persona, memory, and judgment, right inside your editor over ACP.
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
phantombot run --if-not-running  # supervisor keep-alive; quiet success if already running
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

## Windows

Phantombot runs on Windows (x64 and arm64). The port shares ~95% of its code
with the Linux and macOS builds; the platform-specific pieces (data paths,
process tree-kill, run-lock, credential-store ACL, the background service, and
self-update) have native Windows implementations.

Every release publishes prebuilt, unsigned Windows binaries -
`phantombot-<tag>-windows-x64.exe` and `phantombot-<tag>-windows-arm64.exe` -
alongside the SHA256SUMS file.

**Install - PowerShell one-liner:**

```powershell
iwr -useb https://raw.githubusercontent.com/phantomyard/phantombot/main/install.ps1 | iex
```

This detects your architecture (x64/arm64), downloads the matching binary,
verifies its SHA256, runs `Unblock-File` so SmartScreen does not flag it,
installs to `%LOCALAPPDATA%\Programs\phantombot\phantombot.exe` (per-user, no
admin), adds that dir to your PATH, and launches `phantombot init`. It is the
Windows parallel to the Linux/macOS `install.sh`.

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

`install` first asks: **"Run phantombot when you are logged off?"** The prompt
**defaults to whatever you chose last time** (a first-ever install defaults to
**no** — interactive/login mode). It then ensures the tasks in the current
user's `\Phantombot\` folder, named per persona so multi-persona boxes stay
identifiable in taskschd.msc: the always-on daemon (`phantombot-<persona>`) and
the periodic `heartbeat-<persona>`, `nightly-<persona>`, and `tick-<persona>`
tasks.

For example, a persona named `robbie` gets:

```text
\Phantombot\phantombot-robbie
\Phantombot\heartbeat-robbie
\Phantombot\nightly-robbie
\Phantombot\tick-robbie
```

- **Interactive mode (default)** — the tasks use the current user's SID and
  `InteractiveToken`, so no password, elevation, or machine-wide service is
  required. The daemon starts at logon, retries after failure, and its
  process-tree cleanup keeps stop/restart deterministic while that user is
  logged in.
- **Logged-off mode** — answering yes prompts for the Windows password and
  registers the tasks with `LogonType Password` plus a `BootTrigger`, so the
  daemon starts at boot with **no interactive session** — the headless-VM /
  Windows-update-reboot scenario. The password is held by Task Scheduler;
  phantombot persists only the mode and username (never the password) in
  `windows-logon-<persona>.json` beside the launcher, so the heartbeat
  self-heal regenerates matching task XML. In this mode `start` / `restart`
  and the self-update relaunch go through `schtasks /Run`, so the daemon runs
  in session 0 owned by the scheduler and is never reaped when the launching
  SSH/console session ends.

  - **Password validation + reuse.** Before committing to logged-off mode the
    entered password is validated (`ValidateCredentials`). A blank or wrong
    password never registers a boot task that would fail on every reboot —
    install falls back to interactive/login mode with a clear message instead.
    A validated password is saved to the persona's encrypted **vault**
    (`WINDOWS_PASSWORD` key), so the next `install` lets you **press Enter to
    reuse it** — the same UX as harness API tokens.
  - **Login-fallback task.** Logged-off mode also registers a fifth task,
    `login-<persona>` — an interactive twin of the daemon that starts at logon.
    If the stored password later goes stale (corporate password rotation) and
    the boot task can no longer authenticate, this still brings the agent up
    the next time you log in. It is a no-op when the boot task already started
    the daemon (the single-instance run-lock dedupes them), and is removed
    automatically if you reinstall in interactive mode.
  - **Update-safe boot machinery.** Each install stamps a boot-schema version
    into the marker. On every `phantombot run` startup the daemon compares it
    against the version the running binary expects; if a self-update changed the
    boot-task shape, it re-runs the idempotent install to migrate the tasks in
    place — so an update that changes the boot method can't brick the box. A
    password-mode migration reuses the saved vault password; if none is saved it
    logs loudly and asks you to re-run `phantombot install`.

For scripted installs, `--run-logged-off` / `--interactive` skip the prompt and
`--windows-password` (or `PHANTOMBOT_WINDOWS_PASSWORD`, or a saved vault value)
supplies the credential non-interactively. On an existing installation,
`install` leaves healthy task definitions unchanged and only repairs missing
tasks or paths pointing at an older binary.

**Cold-start recovery.** `phantombot install` is idempotent and is *the*
recovery path when the boot machinery is gone. If all of a persona's
`\Phantombot\*` tasks disappear at once — an AV false-positive quarantining the
launcher, a cleanup script or Windows feature update purging Task Scheduler
entries — the box goes dark: no daemon, no heartbeat, no self-heal, nothing left
to run. Because nothing survives to trigger an automatic repair, recovery is a
deliberate manual step (mirroring the Linux/macOS `install` / `uninstall`
lifecycle): log in and run `phantombot install` again. It re-registers the full
task set from scratch, prompting for the password (Enter to reuse the saved
vault value) only if you had logged-off mode. Partial damage — one task deleted,
a moved binary, a deleted launcher script — is repaired automatically by the
heartbeat self-heal without any manual step.

**Self-update.** `phantombot update` and the `/update` chat command work on
Windows. Because Windows locks a running `.exe` against overwrite, the updater
renames the live binary aside to `phantombot.exe.old` (allowed while it runs),
drops the verified new binary into place, then exits cleanly. Before exiting
it schedules a **detached relaunch watcher** — a tiny PowerShell process that
outlives our process tree, waits for the old process to exit and release the
single-instance run-lock, then starts the new binary (via `schtasks /Run` in
logged-off mode). The scheduled task's keep-alive trigger remains as a
backstop. In-place self-update needs the task installed (`phantombot install`).

**Logs.** Service stdout/stderr are redirected to
`%USERPROFILE%\.local\share\phantombot\logs\*.out.log` / `*.err.log`. These
currently grow unbounded (no built-in rotation yet) - prune them periodically
if the box runs for a long time.

Status: the Windows port is exercised by a dedicated `windows-latest` CI job on
every pull request and runs the full test suite alongside the Linux/macOS
builds. The published binaries are unsigned, so SmartScreen may prompt on first
run (the installer runs `Unblock-File` to minimize this).

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

**Log rotation.** On Linux the units log to journald, which applies its own
retention. On macOS and Windows phantombot writes plain files
(`~/Library/Logs/phantombot/`, `<data>/phantombot/logs/`), so the heartbeat
caps them every 30 minutes: any log over 16 MB is copied to `<name>.log.1` and
truncated in place, keeping 3 generations (~64 MB per log, worst case).
Override with `PHANTOMBOT_LOG_MAX_BYTES` and `PHANTOMBOT_LOG_KEEP`;
`phantombot doctor` prints the directory's current size.

| Verb | Linux (systemd) | macOS (launchd) | Windows (Task Scheduler) |
|---|---|---|---|
| `start` | `systemctl --user start` | `bootstrap` (or `kickstart`) | enable task + hidden detached launch |
| `stop` | `systemctl --user stop` | `bootout` | `schtasks /Change ... /DISABLE` + `/End` |
| `restart` | `systemctl --user restart` | `kickstart -k` | end/kill tree + hidden detached launch |
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
2. TOML at `<personas-root>/<persona>/config.toml` — that persona's own settings.
3. TOML at `$XDG_CONFIG_HOME/phantombot/config.toml` or `PHANTOMBOT_CONFIG`.
4. Built-in defaults.

Layers 2 and 3 merge **per key**, with the persona file winning each conflict.
A key the persona file doesn't mention falls back to the global file — never to
a built-in default — so a host with no persona files behaves exactly as it
always has.

Some keys describe the *machine* and are only ever read from the global file:
`default_persona`, `autostart_personas`, `update_channel`, `personas_dir` and
`memory_db`. A persona cannot elect itself default or move the personas root.

The first time a newer phantombot starts, it **copies** the persona-scoped keys
out of the global file into each persona's own file. It never deletes anything:
the global file keeps working on an older binary, so an update — or a rollback —
is safe in either direction and can be run at any time.

Common paths:

| Path | Purpose |
|---|---|
| `~/.config/phantombot/config.toml` | Main config |
| `~/.config/phantombot/.env` | Phantombot runtime secrets, such as voice provider keys |
| `~/.env` | General credentials available to the harness |
| `~/.local/share/phantombot/memory.sqlite` | Rolling turns, tasks, capture log |
| `~/.local/share/phantombot/personas/<name>/` | Persona markdown memory and KB |
| `~/.local/share/phantombot/personas/<name>/config.toml` | That persona's own settings (channels, voice, chattiness) |

Minimal config example:

```toml
default_persona = "phantom"

# Personas started at boot ALONGSIDE the default, in the same process.
# Absent or empty = the default persona only. See "Multiple personas".
autostart_personas = ["lena", "kai"]

# Release ring this host follows: "stable" (default) or "preview".
# See "Release rings" under Maintenance.
update_channel = "stable"

[harnesses]
chain = ["pi", "claude", "codex"]

# Optional. Amanda uses this chain. Other personas use the global chain above.
[harnesses.personas.amanda]
chain = ["claude", "codex"]

[channels.telegram]
token = "123456:telegram-bot-token"
allowed_user_ids = [123456789]
```

Harness notes:

- Pi is the recommended primary harness.
- When the `phantombot harness` wizard takes a Pi provider API key (e.g.
  OpenRouter), it merge-writes the key into Pi's own auth store
  (`~/.pi/agent/auth.json`) — the same place an interactive `pi` login
  writes — so `pi --list-models` and the wizard's model pickers populate. An
  existing OAuth entry for the same provider is left untouched. Note that
  auth.json stores one API key per provider: if you have multiple keys for
  the same provider (e.g. two OpenRouter keys), the merge-write replaces the
  previous key, and Pi's model catalog only uses the one on file.
- Claude Code is normally authenticated with OAuth on the host.
- Gemini remains available for optional semantic-memory embeddings via `phantombot embedding`; it is not an agent harness.
- Codex can use `codex login` or `OPENAI_API_KEY`.
- `chain` order is primary to fallback.
- A `[harnesses.personas.<name>]` `chain` overrides the global chain for that
  persona. If the block is absent or its chain is empty, the persona uses the
  global chain. Run `phantombot harness --persona <name>` to set an override.
- Falling back is silent in chat, but not silent to you: if the primary
  harness fails authentication several turns running, phantombot sends you
  one Telegram alert naming the host and which harness is covering for it
  (a broken OAuth token never recovers on its own, and the fallback may be
  billed per token). If the whole chain is exhausted and no reply could be
  produced at all, you get an alert for that too. Both are deduped per
  incident, so a long outage does not spam you.

## Command Reference

Interactive setup:

| Command | Purpose |
|---|---|
| `phantombot persona` | Create, import, restore, switch personas, or pick which start at boot |
| `phantombot harness` | Choose the global harness chain |
| `phantombot harness --persona <name>` | Choose one persona's harness chain |
| `phantombot telegram` | Configure Telegram token and allowlist |
| `phantombot phantomchat` | Configure the PhantomChat (Nostr DM) channel |
| `phantombot voice [--persona <name>]` | Configure TTS/STT providers for one persona |
| `phantombot embedding` | Configure semantic memory |
| `phantombot acp install zed` | Register phantombot as an ACP agent in Zed |
| `phantombot acp install jetbrains` | Register phantombot as an ACP agent in JetBrains IDEs (Rider, IntelliJ, …) |
| `phantombot acp install vscode` | Install the first-party VS Code extension |

`phantombot persona <name>` switches the daemon-wide default persona.
Because that re-points the default every listener binds to, the switch is
gated on an explicit confirmation: interactive terminals get a @clack confirm
prompt, and non-interactive contexts (agent Bash, cron, CI) require the
`--yes` flag or exit 2 without touching `state.json`. A persona agent running
under `PHANTOMBOT_PERSONA` is always refused (exit 2) — it can't re-point the
daemon-wide default; use `--persona` for per-invocation scope instead.

```bash
phantombot persona robbie          # interactive: prompts to confirm
phantombot persona robbie --yes    # non-interactive: explicit consent
```

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
| `printf '%s' "$VALUE" \| phantombot vault set NAME` | Save a credential without exposing it in argv |
| `phantombot vault set NAME --allow-empty </dev/null` | Explicitly store an empty credential from stdin |
| `phantombot notify --message "..."` | Send a Telegram text notification |
| `phantombot notify --voice "..."` | Send a Telegram voice notification |
| `phantombot task add "<prompt>" "<description>" --every 1h` | Schedule an LLM-backed task |
| `phantombot task add "<prompt>" "<description>" --every 1h --command "/path/to/script"` | Schedule a command-backed task |
| `phantombot task list / show / cancel` | Inspect and manage scheduled tasks |
| `phantombot task add/list/selftest --persona <name>` | Target another persona's schedule |
| `phantombot memory today / search / get / list / index` | Inspect memory and KB |
| `phantombot memory capture "<text>" --tag decision` | Append a tagged memory capture |
| `phantombot memory drawers [--kind norms] [--sync]` | Show the ranked drawer entries the threat judge is briefed from |

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

## Multiple personas

One phantombot process serves every persona on the host. There is no supervisor
and no child process per persona: the daemon builds one set of channel listeners
per persona and runs them side by side.

Which personas come up at boot is a config choice:

```toml
default_persona = "robbie"
autostart_personas = ["lena", "kai"]
```

The default persona always starts; `autostart_personas` names the others. The
list is explicit on purpose — a persona directory that merely exists (an import,
a restored archive) never starts talking to the world on its own, and that
applies to PhantomChat identities as much as to Telegram bots. Pick the set
interactively with `phantombot persona` → *Choose which personas start at boot*.

Leaving `autostart_personas` out entirely keeps the host exactly as it behaved
before the key existed: every configured identity starts. Once the key is
present — even as an empty list — it is the whole truth, and a persona outside
it is skipped with a warning naming the fix.

Each persona keeps its own settings in `<personas-root>/<persona>/config.toml`:

```toml
# ~/.local/share/phantombot/personas/lena/config.toml
chattiness = false

[channels.telegram]
token = "222:lena-bot-token"
allowed_user_ids = [123456789]

[voice]
provider = "elevenlabs"
```

The per-persona TUIs write there for you: `phantombot telegram --persona lena`,
`phantombot voice --persona lena`, `phantombot harness --persona lena`,
`phantombot phantomchat --persona lena`. `phantombot task --persona lena` files
and lists that persona's schedule. Each of them writes wherever phantombot will
READ the setting back from: the persona's own file once it exists, the host's
`config.toml` (in its historical shape) on a host that has not been migrated
yet — so a saved change always takes effect on the next restart. A `--persona`
that does not exist is refused before anything is written.

Reading follows one rule: a per-key merge with the persona file winning, and
anything it does not mention falling back to the host file — never to a
built-in default. Env vars still win over both. `default_persona`,
`autostart_personas`, `update_channel`, `personas_dir` and `memory_db` describe
the machine, so they are ignored inside a persona file.

**Lifecycle commands belong to the default persona.** `/update` and `/restart`
swap the binary and bounce the service for *everyone* in the process, so they
are only accepted in the default persona's chats; anywhere else they reply with
who to ask. `/stop` is unaffected — it aborts the current turn in the current
chat and touches nobody else. `/status` shows the release ring and the full
persona roster, marking the default and which persona is answering.

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

Additional persona-bound bots can run inside the same phantombot process. The
preferred place for one is that persona's own `config.toml` (see "Multiple
personas"); the older `[channels.telegram.personas.<name>]` table below is still
read and still works:

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

The unsuffixed vars in the middle column describe the **default persona's**
bot only. A non-default persona reads its suffixed vars and nothing else — it
never falls back to `TELEGRAM_BOT_TOKEN`, so a host that supplies the default
token through the environment (the usual vault → env path) can never hand that
bot to a second persona and put two listeners on one token. Give each persona
either its own `[channels.telegram]` block in
`<personas-root>/<persona>/config.toml`, its
`[channels.telegram.personas.<name>]` entry, or its suffixed env vars; with
none of those, that persona simply has no Telegram.

### Telegram Commands

At startup, phantombot registers the real command menu with Telegram and
overwrites stale BotFather commands. The supported commands are:

| Command | Purpose |
|---|---|
| `/stop` | Abort the current turn |
| `/reset` | Clear this chat's history |
| `/status` | Show phantom name, PID, version, release ring, the persona roster on this host, harness chain with availability, per-harness models, uptime, context usage, the persona's own PhantomChat address (`phantomchat: npub…`), and live subsystem health probes (Telegram, editor connectors, memory/embeddings, voice) |
| `/harness` | List or switch the active harness |
| `/update` | Default persona only. Install the latest phantombot release. `/update resign` (macOS-only) re-signs the current binary in place — no download, reinstall, restart, or version change — to dogfood the re-sign path or repair a signature a macOS update invalidated; a no-op on other platforms |
| `/restart` | Default persona only. Restart the phantombot service |
| `/coder` | Force the coding brain on for this chat (`off` / `default` to revert) |
| `/chattiness` | Show or hide progress bubbles in this chat (`on` / `off` / `<on\|off> default`) |
| `/model` | Show or switch harness models (`list` / `<slug>` / `coding <slug>` / `image <slug>` / `clear`) |
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

### Bridges: the relay tier

A **bridge** is a bot that forwards messages from another network — Matrix,
Slack, a meeting room — into PhantomChat. It signs with its own npub, so putting
it in `allowed_npubs` would be a serious mistake: **the allowlist is the
principal list**. Anything that passes it is treated as the owner speaking, and a
bridge speaks for whoever happens to be in a room somewhere else.

So bridges get their own, lower tier — `relay_npubs`:

```json
{
  "allowed_npubs": ["npub1owner…"],
  "relay_npubs": ["npub1bridge…"]
}
```

A relay npub is **answered, but never obeyed**:

| | allow-listed npub | relay npub |
|---|---|---|
| Threat screen | skipped (principal) | **always screened** |
| Perimeter prompt | trusted | **untrusted** |
| Slash commands (`/restart`, `/reset`, …) | yes | **no** — run as ordinary text |
| Trust-on-first-use | can claim it | **never** |
| Emoji-reaction turns | yes | **no** |
| Private post-turn digests | yes (1:1 DM) | **no** — reply audience is `shared` |

An npub in **both** lists resolves to relay: least privilege wins, so a
copy-paste slip can only ever de-escalate.

Relay messages may carry an attribution header, which phantombot re-renders from
sanitised fields (a far-side speaker name can't smuggle in newlines or fake
prompt structure):

```
[phantombridge-relay:v1]
origin: matrix
room: #ops:example.org
speaker: alice
---
can you check the deploy?
```

`relay_npubs` is **file-only** — the `phantombot phantomchat` wizard doesn't offer
it, because adding a bridge is a security decision, not a setup step. Edit
`phantomchat.json` directly; the wizard preserves the field.

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
| `/status` | Show harness, uptime, context usage, the persona's PhantomChat address (`phantomchat: npub…`), and live subsystem health probes |
| `/harness` | List or switch the active harness |
| `/help` | Show the available commands |

They are dispatched **out of band** — ahead of the serial request queue — so
`/stop` can kill the long-running turn that is *blocking* that queue. (Your
editor's own cancel/stop button takes the same path and has always worked.)

`/update` and `/restart` are deliberately **not** offered here: they swap the
binary and bounce a service whose lifecycle the editor owns. `/model` stays on
the chat surfaces too — it rewrites global model config and restarts the
service, which is the wrong blast radius for an editor thread. (`/coder` and
`/chattiness` are likewise chat-surface commands; typed in the editor they
fall through to the harness.) Unknown slash commands fall through to the
harness, same as every other surface, so personas keep their own conventions.

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
`/coder off`, or clear back to scoring with `/coder default`.

Two safety rails keep a swapped turn from ever being *lost*:

- **No distinct coder → no swap system.** When the coding model is unset — or
  set to the same model as the primary — the whole swap subsystem is skipped:
  no override store, no scorer, no retry ladder. `/coder` says so instead of
  silently pretending.
- **Retry, then fall back.** A swapped turn that fails before producing any
  output of any kind (the intermittent provider-hang case: stream never
  starts, the idle watchdog kills it) is retried up to three times on the
  coding model, and when those are exhausted the turn is re-run once on the
  **primary** — a slower but known-good brain beats a lost turn. "Output"
  means anything: streamed text OR a tool run (pi tools surface as progress
  chunks, not text — and a retry after a bash/notify/vault tool ran would
  replay its side effects). Failures after the attempt got somewhere are
  surfaced as normal harness errors instead, and a hard wall-clock cap kill is
  final — the ladder never multiplies one 60-minute cap into four hours.

Configure all three roles with the `phantombot harness` wizard; the choices are
mirrored into `config.toml` under `[harnesses.pi.routing]` and visible to
`phantombot doctor`. They can also be changed live from chat with
[`/model`](#model-management-model).

## Model Management (`/model`)

`/model` shows and switches the model every configured harness runs — from
chat, with no config-file editing. It works across all three supported
harnesses, and writes are **permanent and survive restarts**: every change
lands in *both* `config.toml` and `~/.env` (env takes precedence at startup,
so a TOML-only write would be silently ignored on installs where the setup
wizard already wrote `PHANTOMBOT_*_MODEL` vars), the in-memory config is
synced, and phantombot restarts itself — the same dance as `/restart`, since
harness model config is baked in at process start.

```text
/model                      what the primary harness is running now
/model list [filter]        Pi model catalog (pi --list-models), optionally filtered
/model <slug>               switch the primary harness's model
/model primary <slug>       same, spelled out (Pi primary role)
/model coding <slug>        set the Pi coding-brain model
/model image <slug>         set the Pi vision/image model
/model clear                remove an override (codex only)
```

Per-harness behavior:

- **Pi** — full routing control: primary, coding, and image roles map to
  `[harnesses.pi.routing]` in `config.toml` and the
  `PHANTOMBOT_PRIMARY_MODEL` / `PHANTOMBOT_CODING_MODEL` /
  `PHANTOMBOT_IMAGE_MODEL` env vars. `/model list` shells out to
  `pi --list-models`, so it shows the models Pi has credentials for. `clear`
  is refused — routing needs an explicit primary.
- **Claude** — a single model, validated against the `opus` / `sonnet` /
  `haiku` aliases (`PHANTOMBOT_CLAUDE_MODEL`). No catalog listing exists, and
  `clear` is refused (there is no default to fall back to) — pick an alias
  explicitly.
- **Codex** — a single model pinned by id (`PHANTOMBOT_CODEX_MODEL`). The CLI
  exposes no model catalog, so `list` is unavailable; `clear` deletes the pin
  and the env var so the CLI's own default applies again.

Model choice is per-harness config, not per-chat — switching brains affects
every conversation that harness serves. `/status` always shows the result: a
`models:` line with each harness's configured model (and provider, for Pi),
next to the phantom name, PID, version, and the availability-annotated
harness chain.

`/status` also reports the persona's own PhantomChat address on its own line
(`phantomchat: npub…`, when the persona has one — easy to copy into the PWA or
an allowlist), plus a block of **live subsystem health probes** run fresh on
every invocation: Telegram (`getMe`), editor connectors (ACP), memory /
embeddings backend, and voice provider + key validation. Each line is omitted
when its subsystem isn't configured. Because `/status` is a troubleshooting
tool, the whole probe fan-out is bounded by a single short wall-clock deadline
(~5s): a stalled or dead provider drops its own line rather than hanging the
command, so `/status` stays usable precisely when something is broken.

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
- A due task is **held** while the principal is mid-conversation — see
  [Turn registry](#turn-registry-concurrent-turns) below.

Manage tasks:

```bash
phantombot task list
phantombot task show <id>
phantombot task cancel <id>
phantombot tick
```

### Turn registry (concurrent turns)

Two turns for the same persona can run at once in **different processes**: the
daemon (`phantombot run`) is answering the principal while `phantombot tick`
wakes a scheduled task and spawns its own harness. The existing locks don't
cover this — `runLock` guards `run` against `run`, `tick.lock` guards `tick`
against `tick`, and neither sits between the two. In practice both turns picked
up the same PR and the same working checkout, and a contributor got duplicate
review comments.

Every turn, from every entry point (`run`, `ask`, `tick`, `nightly`, ACP),
registers itself for its lifetime in a small JSON file under
`$XDG_STATE_HOME/phantombot/turns/`. This is a **registry, not a mutex**: it
never blocks a turn and never queues one behind another. It buys two things:

- **`tick` defers a due task** while an interactive turn is in flight, or within
  3 minutes of one finishing (the conversation, not just the turn, is what a
  wake collides with). Deferral is capped at 15 minutes, after which the task
  fires regardless — a task that silently never runs is the worse failure. The
  task row is untouched while deferred, so `run_count`, one-off deactivation and
  `--count` limits stay accurate, and the next tick re-evaluates a minute later.
  **Command-backed tasks are deferred too**, because the documented poller
  contract is to call `phantombot ask` when work appears, and that starts a full
  turn.
- **A turn that runs anyway is told about its siblings** via a line added to its
  system prompt, so it knows to keep its hands off shared state instead of
  racing a turn it cannot see.

Entries are best-effort cleaned up when a turn ends. A crashed turn leaves one
behind, so an entry only counts as live if its recorded pid is still the same
process *and* it is under an hour old; stale entries are pruned on read.

| Variable | Default | Meaning |
| --- | --- | --- |
| `PHANTOMBOT_TURN_REGISTRY` | on (off under `NODE_ENV=test`) | Kill switch. `0`/`off`/`false`/`no` disables it: every read reports "nobody home", which is the old pre-registry behaviour — no deferral, no sibling notice. |
| `PHANTOMBOT_TURN_REGISTRY_DIR` | `$XDG_STATE_HOME/phantombot/turns` | Relocate the entries without moving the rest of the state dir. |

### Background-turn digests

The registry stops two turns colliding, but it does nothing about *why* the
collisions went unnoticed: a turn woken by `tick` streams its reply into its own
transcript and nowhere else. The principal is reading a Telegram thread; the
background turn commits, comments on a PR, edits a file, and leaves no trace
anywhere they will look.

So a **background turn** (origin `task`, `notification` or `internal`) writes a
digest when it ends: what woke it, the state-changing tool calls it made
(`edit`/`delete`/`move`/`execute` — reads are dropped as noise) with the files
they named, and its own closing summary. The digest lands in
`$XDG_STATE_HOME/phantombot/digests/`.

The next **interactive, trusted, and private** turn for that persona gets the
pending digests injected into its system prompt, alongside the sibling notice,
and decides for itself whether any of it is worth mentioning. That's deliberate: pushing every poller
fire to Telegram would break the "don't notify unless it's material" rule and
train the principal to mute the channel, and writing a synthetic turn into their
conversation history would forge transcript that later retrieval treats as
something they actually said.

Details worth knowing:

- **Delivery is at-least-once.** A digest is marked delivered only after the
  receiving turn *succeeds*, so a turn that dies re-delivers on the next one.
  Marking at injection time would drop a background turn's only trace exactly
  when the box is unhealthy.
- **Written from a `finally`,** so a background turn that pushed a commit and
  *then* crashed still leaves a digest — that's the case that matters most.
- **Only interactive turns receive them.** Handing one background turn another's
  digest informs nobody and would let two of them bounce a report forever.
- **Only *trusted* interactive turns receive them.** Origin is not trust: a raw
  `phantombot ask` carrying an inbound email is origin `channel` and untrusted.
  A digest is persona-private context — what the nightly touched, which repos a
  poller wrote to — so handing it to a turn a stranger is steering is both a
  disclosure and an injection surface. An untrusted turn doesn't consume them
  either; they stay pending for the principal.
- **Only *private* turns receive them.** Trust authenticates the speaker, not
  the audience. A trusted turn in a Telegram group is `origin: channel` and
  `trusted: true`, but its reply is visible to every member — so injecting
  persona-private paths and summaries into its prompt is a disclosure and an
  injection surface, since the group's text lands in the same prompt. A
  wake-but-silent reaction turn is worse: its reply defaults to never being
  sent, so a digest delivered there is consumed into the void — marked
  delivered, never seen. `replyAudience` (defaults to `"silent"`, fail closed)
  gates both: `"shared"` for group/supergroup chats, `"silent"` for reaction
  turns, `"private"` for 1:1 DMs and the only value that receives digests.
- At most 5 digests go into one prompt, **oldest first**, with the rest reported
  as a count and left pending for the next turn. Only what was actually shown is
  marked delivered — marking the overflow would destroy the record of a turn
  nobody ever saw. Draining oldest-first is also what stops the tail of a
  backlog starving under sustained background load. Undelivered digests expire
  after 24h — if you haven't spoken to the persona in a day, a wall of poller
  output is not a briefing.
- **Secrets are redacted at collection time,** through the same `redactForLog`
  the audit log uses, before anything reaches disk. Tool titles are formatted
  command lines, so they carry exactly the shapes that matter (`Bearer …`,
  `FOO_TOKEN=…`); the trigger and summary go through it too.
- Independent of the audit log: turning off `PHANTOMBOT_AUDIT_TOOL_CALLS` isn't
  a request to go blind to what background turns did.

| Variable | Default | Meaning |
| --- | --- | --- |
| `PHANTOMBOT_TURN_DIGEST` | on (off under `NODE_ENV=test`) | Kill switch. `0`/`off`/`false`/`no` disables writing *and* injection. |
| `PHANTOMBOT_TURN_DIGEST_DIR` | `$XDG_STATE_HOME/phantombot/digests` | Relocate the digests. |

### Workspace locks (shared working copies)

The #391 collisions didn't happen in phantombot's state — they happened in a git
checkout two turns shared, with no lock on it at all. The registry makes turns
*aware* of each other; it gives them nowhere to serialise.

```bash
phantombot workspace lock /tmp/phantombot-inspect --purpose "reviewing PR #405"
phantombot workspace status            # all live claims
phantombot workspace status /tmp/x     # just that one
phantombot workspace unlock /tmp/phantombot-inspect
```

`lock` exits **1 immediately** if another live turn holds the path — it never
waits. The right response is a different directory (clone a fresh copy), not a
queue. A claim held by a turn that is still in flight is named in every sibling
turn's system prompt. It also exits 1 if another `lock` is inside its critical
section at that instant (the message says so); that one is a genuine retry.

If the lock directory can't be written — or locking is switched off — `lock`
still exits **0**, because a state file that won't write must not stop the
turn's actual work. It does **not** print `locked`: it says on stderr that the
path is **NOT claimed** and that you are proceeding without protection. `ok` and
`recorded` are different questions, and answering the second with the first
would leave a turn believing it followed the protocol while nobody else can see
its claim.

`unlock` refuses unless you are the turn that took the lock. A caller with **no**
turn id — a plain shell, a script, a harness with the registry off — is refused
too, because dropping a claim you never took is how a cooperative protocol turns
into silent corruption. `--force` is the deliberate override for clearing one by
hand.

`unlock` is guarded exactly as strictly as `lock`, and exits 1 with a retry
message if it can't take the guard. An atomic `unlink` does *not* make
read → ownership-check → unlink atomic: an unguarded release can read the old
record, pass its own ownership check, and unlink *after* a guarded `lock` has
published a new holder's claim — deleting a live claim and leaving the tree
reading as free while that turn works in it. Refusing is the safe direction now
that liveness is turn-based: a refused release self-heals, because the claim
stops being held the moment its turn ends, whether or not anyone unlocked it.

**This is advisory, and cannot be otherwise at this layer.** A turn runs `git`
through the harness's own Bash tool; phantombot isn't in that path and cannot
intercept it, so nothing here *prevents* a write to a checkout you don't hold.
What it provides is a truthful, crash-safe answer to "is another turn in this
tree", which previously did not exist. Real enforcement would need the mutation
path itself to take the lock — a bigger change, and its own issue.

**The holder is a turn, not a process.** Locks are attributed via
`PHANTOMBOT_TURN_ID` (set in the harness environment next to
`PHANTOMBOT_PERSONA`/`PHANTOMBOT_CONVERSATION`), and liveness is delegated to the
turn registry: a lock is held while its turn is running, and released the moment
it is not. Tying liveness to the pid that *wrote* the record — the obvious first
guess — makes the whole feature a no-op, because the only writer is a CLI that
exits milliseconds later, so every lock prunes itself as stale on the next query.
The recorded `pid` is kept for diagnosis only.

A holder that dies leaves a stale file, broken on inspection: the registry
reports the turn gone (it covers both a clean finish and a dead owner) and the
next query prunes the lock. When the registry *can't* answer — it's switched off,
or the turn id predates a state-dir wipe — the lock is kept until it ages out
after an hour: guessing "free" on a claim we cannot verify reintroduces the
collision this exists to prevent, while guessing "held" costs one `git clone`
elsewhere and is bounded by that hour, `unlock`, and `--force`. A lock taken by
hand from a shell carries no turn id and follows the same age rule — held until
someone releases it.

Concurrent `lock` calls are serialised by a guard beside the lock file, so two
turns claiming the same tree at the same instant cannot both read "free" and
both win. The guard is a **ticket queue, not one contested pathname**: each
caller publishes its own uniquely named ticket (written to a temp name and
renamed into place, so a ticket that exists is always complete), and the oldest
live ticket holds the section. Everyone else reports contention and moves on.

That shape is what makes the guard's own cleanup safe. A single well-known
guard path has to be *deleted* to be freed, and a delete by pathname can always
land on a *successor* — the guard is recovered, a new holder creates its own,
and the previous holder's cleanup removes it, putting two callers inside the
section via the code meant to protect it. POSIX has no compare-and-delete to
close that with. A ticket name belongs to exactly one acquisition and is never
reused, so no delete can reach anyone else's claim.

A ticket is surrendered on **ownership, never on age**. A holder that is still
running is a slow critical section — a loaded box, a cold filesystem, a paused
VM — and it can resume at any moment, so its ticket is honoured for as long as
its process lives, however old it gets. A ticket is only ignored when the
kernel says its owner is gone: no such pid, or a pid now held by a different
process (start tokens differ). A start token that can't be read is *not*
evidence of death. The one timeout left applies to a ticket with no readable
owner at all — corruption, or a leftover from an older format, since nothing
this code writes can produce one — which is ignored after a minute because
liveness can't be asked about it.

Pruning a stale lock also happens **under that guard**, and deletes only if the
file's exact bytes are unchanged since they were read. Deciding a lock is stale
isn't instant — it reads the turn registry — so an unguarded prune can read
claim A, have a concurrent `lock` publish claim B over it, and then unlink B.
This is the read-path twin of the release bug above, and it fires far more
often, because every `workspace status` and every prompt render walks it.

If the state directory itself is missing or unwritable, that is reported as an
I/O failure, not as contention: `lock` **fails open** (a lock nobody can write
is a lock nobody can see, and refusing to work because a state file won't write
turns a visibility feature into an outage), while `unlock` says it failed rather
than telling you to retry a loop that can never succeed.

The path, conversation id and `--purpose` of a claim are written by *another*
turn, and that turn's input may have come from email, a webhook or a raw
`phantombot ask`. They're rendered into sibling prompts as inert data — flattened
to one line, stripped of control, zero-width and bidirectional characters,
backtick-free and length-bounded, inside a block that says in the prompt itself
that none of it can authorise an action. Without that, a `--purpose` containing
a newline and a `#` heading ends the list and opens what reads like a new
instruction section, in the system prompt of a trusted, tool-capable turn that
the threat judge never sees. The same treatment applies to background-turn
digests, for the same reason.

| Variable | Default | Meaning |
| --- | --- | --- |
| `PHANTOMBOT_WORKSPACE_LOCKS` | on (off under `NODE_ENV=test`) | Kill switch. Disabled means every `lock` succeeds and every query reports unheld. |
| `PHANTOMBOT_WORKSPACE_LOCK_DIR` | `$XDG_STATE_HOME/phantombot/workspaces` | Relocate the lock files. |
| `PHANTOMBOT_PROCESS_START_PROBE` | on | Off-switch for the process-identity probe that has to spawn a helper (macOS `ps`, Windows `wmic`/PowerShell). Off means the guard falls back to a plain pid check, which cannot detect pid reuse. Linux reads `/proc` and is unaffected either way. |

On Windows and macOS there is no `/proc`, so answering "is the process that
took this ticket still the same process?" costs a child process. That probe
sits on a path budgeted in tens of milliseconds, so it asks the cheapest
available tool first, remembers which one works (including that none does),
caches an answer per pid for a few seconds, and runs every child with
`windowsHide` so a console-less phantombot — the scheduled-task and service
installs — never flashes a black window at you. Set
`PHANTOMBOT_PROCESS_START_PROBE=0` where the interpreter is blocked by policy
or simply unwanted; the lock still works, it just loses pid-reuse detection.

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

Phantombot stores secrets in a per-persona encrypted vault. Values are encrypted
at rest with AES-256-GCM using a key derived from the persona identity and are
loaded into the spawned harness environment at runtime.

Agent-facing credential CLI:

```bash
printf '%s' "$GITHUB_TOKEN" | phantombot vault set GITHUB_TOKEN
phantombot vault list
phantombot vault get GITHUB_TOKEN
phantombot vault unset GITHUB_TOKEN
```

When the value positional is omitted, `vault set` reads stdin and removes one
trailing LF or CRLF. Empty or newline-only stdin is rejected to prevent a
failed pipe from silently overwriting an existing credential; pass
`--allow-empty` to store an intentionally empty stdin value. The existing
`phantombot vault set NAME "value"` form is still supported unchanged for
compatibility, including empty values, but exposes the value in process
arguments and potentially shell history. `phantombot env` remains a deprecated
alias.

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
configured as primary** — Claude, Pi, or Codex. It does **not** assume
a particular CLI is installed: if you install only one of the three, screening
still runs on that one. It is not a keyword engine and not a separate API key.
Its only job is to *read* the incoming content and score it 0–100 for threat.
The screener consumes only that number.

Each harness runs the judge with its CLI's **native** capability-restriction
flag, not a hand-maintained deny-list (which rots as new tools ship):

| Harness | Judge mode | Floor |
|---------|------------|-------|
| Claude  | `--tools ""`            | true zero-tools |
| Pi      | `--no-tools`            | true zero-tools |
| Codex   | `--sandbox read-only`   | read-only (may read, cannot act) |

Claude/Pi reach genuine zero-tools; Codex reaches read-only. Read-only is
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
reads three drawers — as **ranked entries**, highest decayed score first, with
superseded and dormant ones left out — and feeds the judge a briefing:

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
like any other, so *what the judge believes is normal* is auditable —
`phantombot memory drawers --kind norms` prints exactly what the judge will
see, with scores. The briefing is capped at ~16 KiB and the budget is **shared
out** across the three drawers rather than consumed front-to-back, so a large
`decisions` drawer can no longer starve `norms`; a drawer that overflows its
share is trimmed line by line — one ranked entry is one line — rather than cut
mid-entry.

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
    norms.md
  kb/
```

The flow:

1. The agent captures important facts with `phantombot memory capture`.
2. Heartbeat promotes tagged daily lines into structured drawers.
3. Nightly distills drawers and `kb/inbox/` into durable KB notes.
4. `MEMORY.md` stays lean and always-loaded.

#### Which daily journals reach the prompt

Your phantom does not decide this, and neither does a line of prose in a
persona file — it is fixed in the memory system itself:

| File | In the prompt? |
|---|---|
| **Today's journal** | Always. The day is still open, so nothing has been distilled out of it yet — if it is not in the prompt, it is not in the turn. |
| **Yesterday's journal** | Only when the nightly ledger shows that date's sweep did **not** finish — including a file that was appended to *after* its sweep, since the new part was never promoted. |
| **Older journals** | Never automatically. Reachable with `memory search` / `memory get`. |

The asymmetry is the point. Once a day has been swept, its content already
lives in the drawers, `MEMORY.md` and `kb/` in deduplicated, weighted form —
re-injecting the raw file would only add a staler copy of the same day. So the
raw journal is a **fallback for a failed distillation**, and in the healthy
case the only journal in context is the open one.

Injected journals are framed as data, not instructions: earlier turns wrote
them, and some of those turns were driven by untrusted input. They are also
*contained*: a leading `#` on any journal line is escaped, so nothing in a
journal can render as a section of the system prompt, and control, bidi and
zero-width characters are stripped.

A journal that reaches the prompt goes in whole up to a **sanity ceiling of
32 KB** (`DAILY_RECALL_CEILING_BYTES`), and today plus yesterday together are
held under **48 KB** (`DAILY_RECALL_COMBINED_CEILING_BYTES`). Today is served
first and may use the whole per-file ceiling; yesterday gets the remainder,
which the two numbers guarantee is never nothing.

Both numbers come from a hard limit rather than from taste. The assembled
system prompt is handed to the harness as a single command-line argument, and
Linux caps one argument at 131,071 bytes — not the ~2 MB `getconf ARG_MAX`
that bounds argv and the environment in total, and not raisable. The rest of
the prompt is already bounded (persona, `MEMORY.md` at 16 KB, the drawers
briefing at 16 KB, retrieved context), which leaves roughly 50 KB before a
journal puts the turn at risk. A persona that reached 82 KB in one day stopped
answering entirely: every turn died at spawn with `E2BIG`.

The cap used to be the daily *compaction* budget (8 KB), which was wrong for a
different reason: those two numbers measure different things — the compaction
budget is how large a closed, fully-distilled day may stay on disk, while an
open day is the only place its content exists. A heavy day silently lost its
morning, and what fell out was the tagged captures on their way to the
drawers. A day over 32 KB still loses its morning today, so the trim is loud:
it keeps the tail, warns with the dropped byte count, and the injected block
tells the turn to run `phantombot memory get memory/<date>.md` for the rest.
The compaction budget is unchanged and still applies on disk.

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

#### The frontmatter that makes it work

Those three superpowers are only as good as the frontmatter agents actually
write, so the vocabulary is part of the spec rather than a style preference.
Every `kb/` note carries:

| Field | Why the index cares |
|---|---|
| `type` | Controlled vocabulary (below) — its own BM25F column |
| `title` | Highest-weighted field |
| `description` | One sentence: the question the note answers |
| `tags` | Lowercase, hyphenated; weighted above body text |
| `aliases` | **The synonym fix** — the other names this thing goes by |
| `created` / `updated` | Recency signals; `updated` is bumped on reconcile |

`aliases` is the field that earns its keep on the no-key path. BM25 can only
match words that are actually present, so a note titled "Secret Rotation"
is invisible to a search for "credential cycling" *unless the note says so
itself*. Aliases are how a note declares the wrong-but-plausible names a
future query might use.

**Controlled `type` vocabulary.** Left unstated, this field drifts into a
dozen near-synonyms (`note` / `atomic-note` / `concept`) that fragment the
very column meant to sharpen recall. Phantombot declares it once, in
`src/lib/okf.ts`, and generates both the persona prompt and the nightly
prompt from that constant:

- **Core** — `concept`, `runbook`, `procedure`, `reference`, `postmortem`,
  `project`, `person`, `infrastructure`, `index`. These mean the same thing
  in a human-curated OKF vault as they do in a phantom's KB, so notes move
  between the two without translation.
- **Agent-side** — `lesson`, `decision`, `norm`, `account`. Derived from the
  structured drawers; they have no equivalent in a curated vault, because a
  vault records what someone decided was true and these record what the agent
  learned the hard way.

Adopting the vocabulary is **not a migration**. An alias map folds legacy
values (`troubleshooting` → `runbook`, `home` → `index`) onto canonical ones
**at index time**, and each note is indexed under both spellings — the
canonical type *and* the one its frontmatter actually carries — so it stays
findable either way. Bumping the notes-schema version rebuilds an existing
index from disk on next open, so notes written long before the vocabulary
existed converge too, not just newly-authored ones. Nothing on disk is
renamed: the folding lives in the index, and your frontmatter is left exactly
as you wrote it.

> `kb/` is **private to the persona** — not published, not shared between
> agents, not a document store for the operator. It is the agent's own recall.
> OKF is the *format*; where a human-facing vault lives is a separate question.

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

### Cross-conversation retrieval

Auto-retrieval is **persona-scoped by default**: when a turn runs, relevant
excerpts from your *other* chats can surface alongside the current
conversation's. The fix you worked out in a Telegram DM on Monday is
available when the same problem comes up in PhantomChat on Thursday — no
manual `memory search` required.

Guardrails keep it a supplement, never a flood:

- Current-conversation hits always rank first; cross-conversation hits are
  appended after them and hard-capped (default 3 per turn).
- A cross-chat excerpt must clear an **absolute relevance floor** — BM25
  for lexical matches (default 2.0), cosine similarity for vector-only
  matches (default 0.85). Rank-fused scores are positional, so they are
  never used as the bar; the defaults are calibrated against a live
  4,000+-turn index (incidental single-token matches score ≈ 0, genuine
  matches ≈ 4+; random embedding pairs sit at p90 ≈ 0.75).
- **The audience boundary is a retrieval filter, not a prompt rule.** Every
  turn is stamped at index time with an audience class derived from its
  conversation key (`private` for DMs/CLI, `multi-party` for group chats),
  and a memory may only surface in a room at least as wide as the audience
  it was spoken to: private → private ✅, group → private ✅, private →
  group ❌. Enforced in SQL before ranking, so a private-DM turn can never
  reach a group chat however it is paraphrased.
- Every turn is also stamped with its **provenance** (`principal`, `self`,
  `other`, `unverified` — the same tiers durable facts use), carried on
  each hit so retrieval can weigh where a memory came from.
- Every cross-conversation hit is labelled with its source channel and date
  (`cross-conversation: Telegram, May 27`), and the injected prompt
  instructs the persona to let it inform the reply without quoting it
  verbatim or naming the chat it came from — belt-and-braces on top of the
  SQL audience filter.

**No configuration is needed — it is on by default.** The flag exists only
as an escape hatch for sensitive setups:

```toml
[retrieval.cross_conversation]
enabled = false            # restore strict per-conversation retrieval
limit = 3                  # max cross-conversation hits per turn (0 disables)
min_score = 2.0            # absolute BM25 floor for cross hits
min_vec_score = 0.85       # absolute cosine floor for vector-only cross hits
exclude = ["telegram"]     # channels that neither contribute nor receive
```

`exclude` entries match a full conversation key
(`phantomchat:group:abc123`) or a channel prefix (`telegram` matches every
Telegram conversation). An excluded chat's turns never surface in other
chats, and no cross-conversation context is injected into it.

Environment overrides: `PHANTOMBOT_RETRIEVAL_CROSS_ENABLED`,
`PHANTOMBOT_RETRIEVAL_CROSS_LIMIT`, `PHANTOMBOT_RETRIEVAL_CROSS_MIN_SCORE`,
`PHANTOMBOT_RETRIEVAL_CROSS_MIN_VEC_SCORE`, and
`PHANTOMBOT_RETRIEVAL_CROSS_EXCLUDE` (comma-separated).

### Nightly and Doctor

Every `phantombot nightly` run is a **sweep**. It lists the daily files, diffs
them against the ledger in `memory/.nightly-state.json` (mtime + size, then
content hash) and processes every date that is new, that grew since it was
processed, or whose last pass didn't finish:

```text
sweep (code) -> per date: distill ‖ kb -> index refresh (code) -> ledger (code)
                                                            \-> compact (once)
```

* `distill` files the day's captures into the drawers (people / decisions /
  lessons / commitments / norms) and maintains MEMORY.md's `## Recent`.
* `kb` extracts durable knowledge into `kb/` — reconcile, create, sweep inbox.
* `compact` runs **once per sweep**, after every date is distilled, and is the
  only stage that removes anything. See below.

#### Compaction

`distill` and `kb` only ever append, so the always-in-context files grow without
bound — a 663KB drawer set costs tokens on every turn and buries live facts
under dead ones. The compaction stage is the other half of the loop, and it is
built to be safe rather than thorough:

* Only files **over budget** are touched (MEMORY.md 16KB, a fully-distilled
  daily file 8KB). A healthy persona pays one `stat` per file.
* Every candidate is copied verbatim into `memory/archive/<YYYY-MM-DD>/`
  **before** the stage runs. Nothing is ever deleted, and the nightly is the
  only code path that moves a memory file.
* Afterwards each file is re-stat-ed and judged. A pass that removes more than
  its allowance (40%, or 90% for a closed daily file), empties a file or loses
  one is **rolled back from that copy** and recorded as `reverted`.
* Byte accounting per file lands in the ledger under `compaction`, so "is memory
  still growing?" is answerable without grepping the log.
* A daily file is only trimmed once the ledger shows both stages `ok` for it and
  it is at least 30 days old. Because compaction rewrites that file, its ledger
  entry is re-fingerprinted afterwards — otherwise the next sweep would see the
  date as *changed* and pay for both LLM stages again, every night.
* `memory/archive/` is **never indexed**. A rollback copy is a recovery artefact
  for a human with `cp`; indexing it would feed the stale text compaction just
  removed straight back into search as a live document.
* The stage runs even when **no date is pending** — its inputs are whole-file
  sizes, not a day's events, so the steady-state night with a drained backlog is
  exactly the night it matters.

Drawers are measured and reported but **never candidates**: their dedupe and
lifecycle work moves to the database, where it is a uniqueness constraint rather
than an LLM pass over prose. Selecting them would buy a turn whose own prompt
tells it to change nothing. `--no-compact` skips the stage; a `--date` backfill
never runs it; and a sweep in which **any date stage failed** skips it too — a
failed distill can leave MEMORY.md half-rewritten, so the archive would preserve
the damage instead of the clean pre-sweep file. Over-budget files simply wait
for the next clean sweep.

The two stages run **concurrently**: they read the same daily file and write
disjoint targets. Neither writes back to the daily file, which is what keeps
the ledger's hash stable. Once both join, phantombot refreshes the search index
itself (incremental FTS + embeddings), so a new KB note is searchable without
the model having to remember to ask.

The sweep has **no timer**. It is triggered by two events instead: `run` fires
one at startup, and the heartbeat fires one the first time it runs on a new
calendar day (the previous day's file has closed by then). Rollover *detection*
rather than a file-creation watch, because a daily file is created lazily on the
first capture — on a quiet day it may never exist, and a creation hook would
starve. Because the ledger decides what to process, both triggers are safe to
fire redundantly: re-running with nothing pending costs nothing, and a machine
that was off for a week sweeps the backlog when it comes back. There is no
`--resume` and no catch-up mode. Useful flags:
`--date <YYYY-MM-DD>` to reprocess one day, `--max-dates N` to bound a manual
run, `--force` to take over a stuck in-flight marker, `--no-compact` to leave
over-budget files untouched.

A stage runs **scoped to the persona directory**. Its working directory is the
persona dir (not your home dir), it runs with no MCP servers, and it is granted
exactly four tools — `Bash`, `Read`, `Write`, `Edit`. That is the whole job: read
the day's file, write `memory/` and `kb/`, and search through
`phantombot memory search`. It never needs to walk your filesystem, and it is no
longer able to. Before this, stages ran from `$HOME` and would go looking for
their own `memory/` directory; on macOS that search crossed
`~/Library/Containers` and made the system ask *"phantombot would like to access
data from other apps"* over and over — once for every date in the backlog. If
you see that prompt, you are on a build older than #387.

A sweep is **uncapped by default**: it drains the entire backlog in one pass,
so a first run after months of history is one long night rather than a queue
that reappears every morning. The in-flight marker stops the rollover trigger
from starting a second sweep on top of a running one.

`/status` shows a `dreaming:` line — `OK (nothing pending)`,
`RUNNING (2/5 dates, on 2026-06-02)`, `WARN (2 dates pending …)` or `ERR`.
Health is backlog-driven, not schedule-driven: nothing pending is OK no matter
when the last sweep ran, and a backlog of *any* depth is only a WARN while it
drains. It turns into ERR when a sweep errored, when the in-flight marker went
stale, or when dates are pending and no sweep has run for over 24h — a backlog
nobody is picking up. `phantombot doctor` reports the same signal (plus capture
health, timers and connectors) but never runs the nightly itself.

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
| `phantombot-heartbeat.timer` | Every 30 minutes | Mechanical maintenance + fires the nightly sweep on day rollover |

Update commands:

```bash
phantombot update
phantombot update --check
phantombot update --force --restart
```

Updates download to a temporary file, verify SHA256, atomically rename over the
live binary, and clean up after themselves.

### Release rings: stable and preview

Every merge to `main` is published as a GitHub **prerelease**. GitHub's
`/releases/latest` endpoint excludes prereleases, and that is the endpoint a
default host resolves — so a merge does not reach the fleet until a human
presses the promote button on it.

Pick a ring per host in `config.toml`:

```toml
# "stable" (default) — install only releases a human promoted.
# "preview"          — install every merge to main.
update_channel = "preview"
```

`PHANTOMBOT_UPDATE_CHANNEL` overrides the file. An unrecognised value falls
back to `stable` with a warning, so a typo can never move a host onto a ring
you did not pick. `phantombot doctor` prints the active ring and version, so a
bug report from a preview host is interpretable without asking which build it
is on.

The intended shape: put **one** host on `preview`, let it run the new build for
a few days, then promote. Promotion is the "Promote a release to stable"
workflow in Actions — it flips the `prerelease` flag on a release that already
exists, so the binaries stable hosts install are bit-identical to the ones that
soaked. Nothing is rebuilt.

**Rolling back needs no special command.** The updater compares versions for
*equality*, not "is newer", so a host on a bad preview build flips
`update_channel` back to `stable` and the next `phantombot update` installs the
current stable — even though its version number is lower. Same for a bad
*promoted* release: promote the last good tag and every stable host follows it
back down.

A side effect worth naming: stable hosts stop updating on every merge. Fewer,
deliberate updates instead of one per PR.

On Linux the restart runs `systemctl --user restart` from *inside* the service
being restarted, so systemd tears down the whole cgroup — including the
`systemctl` child phantombot just spawned — as soon as it accepts the job. That
child comes back as exit 143 (128+SIGTERM), which is the restart **working**,
not failing, and is treated as success. Only a genuine failure (a bad unit, an
unreachable session bus) logs `restart failed after binary swap`; if you see
that line, the update really did not come back and the pending-update marker is
still on disk for the next start to report. The signal is one-directional: its
ABSENCE is not proof the update came back, because if `systemctl restart` is
accepted and the *new* unit then fails to start (bad binary, unit rejected at
load) the process that would log it is already gone. The pending-update marker
on disk is the check that covers that case.

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
Harness chain: pi -> claude -> codex
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

Versions use `major.minor.patch`, where `patch` is the release workflow's run
number — a per-workflow counter that only ever grows. It is *not* the PR
number: PR numbers can regress when a later PR merges first. The originating PR
is recorded in the release title and notes instead.

This is intentionally not semantic versioning. Do not add semver-aware update
logic — in particular, do not turn the updater's version *equality* check into
a "newer than" comparison. That equality is what lets a host move DOWN a
version when it switches from the preview ring back to stable; see
[Release rings](#release-rings-stable-and-preview).

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
