# AGENTS.md — guide for any agent contributing to phantombot

This file is for **any agent (human or LLM) working on the phantombot codebase itself**. If you're a Claude Code session, an OpenAI-Codex agent, a future maintainer, or just yourself catching up after time away — read this before opening a PR. It captures the small set of project-specific conventions that aren't obvious from the code.

> **Naming-collision warning.** This `/AGENTS.md` (project root) is **not the same as** `personas/<name>/AGENTS.md` (a persona-specific tool-hint file phantombot reads when loading that persona). They share a name because OpenClaw uses the same convention for persona files; phantombot's persona loader accepts both `tools.md` and `AGENTS.md` as the persona-tools slot. If a contributor refers to "AGENTS.md" without context, they almost always mean *this* file (the repo-level one). If you're editing a file under `personas/` or `agents/`, you're touching a persona, not the contributor guide.

## The contributing discipline (READ FIRST)

**Every PR that changes user-facing behavior, architecture, or developer workflow must update both `README.md` and this file in the same PR.** No exceptions. Reviewers should reject PRs where the docs don't match the code.

What "user-facing behavior" means:
- New / removed / renamed CLI subcommand or flag
- Change to systemd unit shape (added/removed timer, new `EnvironmentFile=`, etc.)
- Change to where files live (config path, memory db path, persona dir, lockfile)
- Change to credential discovery / hygiene rules
- Change to release pipeline (asset names, version scheme, trigger)
- Change to architecture invariants (single persona at runtime, runLock, etc.)

What's *not* user-facing and doesn't need a docs update:
- Pure refactors that preserve behavior
- Bug fixes that restore the documented behavior
- Internal lib changes with no public API change
- Tests

If unsure, update the docs. Cheaper than the post-merge "wait, the README says X but the code does Y" archeology.

## Build / test / typecheck

```bash
~/.bun/bin/bun install                  # install deps (cron-parser, citty, smol-toml, @clack/prompts)
~/.bun/bin/bun tsc --noEmit             # typecheck
~/.bun/bin/bun test                     # full test suite
~/.bun/bin/bun test tests/lib-X.test.ts # one file
~/.bun/bin/bun run build                # → dist/phantombot (linux x64-baseline; ~98 MB)
~/.bun/bin/bun run build:arm64          # → dist/phantombot-arm64 (cross-compile)
```

`bun-version` is pinned to `1.x` in CI for reproducibility (see `.github/workflows/release.yml`).

The build target **must remain `bun-linux-x64-baseline`** (not plain `bun-linux-x64`). The supervisor box that runs kai is pre-AVX2 silicon; the non-baseline binary SIGILLs on launch there. If you "optimise" to plain x64, you'll break production. See PR #37 for the post-mortem.

## Repo layout

```
phantombot/
├── README.md                 # user-facing docs
├── AGENTS.md                 # ← this file
├── docs/
│   ├── architecture.md
│   └── adding-a-harness.md
├── .github/workflows/release.yml   # auto-release per merged PR
├── package.json
├── bunfig.toml
├── tsconfig.json
├── src/
│   ├── index.ts              # entry point: runs Citty dispatcher
│   ├── version.ts            # CI sed-replaces "0.1.0-dev" with "1.0.<PR_NUMBER>"
│   ├── config.ts             # XDG paths + TOML loader (env vars > config > defaults)
│   ├── state.ts              # phantombot-managed state (default persona)
│   ├── persona/
│   │   ├── loader.ts         # accepts BOOT.md / SOUL.md / IDENTITY.md, MEMORY.md, tools.md / AGENTS.md
│   │   └── builder.ts        # buildSystemPrompt + MEMORY_TOOLS_SECTION + CREDENTIALS_SECTION
│   ├── memory/
│   │   └── store.ts          # bun:sqlite store: turns table + capture_log table
│   │                         #   (capture_log backs the 30-turn nudge + doctor)
│   ├── importer/
│   │   └── openclaw.ts       # OpenClaw → phantombot persona import
│   ├── orchestrator/
│   │   ├── turn.ts           # one-turn coordinator (persona → memory → screen → harness → persist)
│   │   ├── fallback.ts       # harness chain (primary → fallback)
│   │   ├── screen.ts         # makeScreener: threat-screen wiring for UNTRUSTED turns (see "Security perimeter")
│   │   ├── retrieval.ts      # makeRetriever: hybrid (Gemini) or OKF BM25F + link-graph recall of prior turns/memory for the prompt
│   │   ├── recovery.ts       # generateRecoveryReply: graceful user-facing message on harness failure
│   │   └── turnIndexer.ts    # makeTurnIndexer: embeds persisted turns for later retrieval
│   ├── channels/             # channel-agnostic core + per-channel adapters (see "Channel layer")
│   │   ├── core/
│   │   │   ├── types.ts      # Channel / ChannelTransport / ChannelMessage + capabilities + encrypt/decrypt seam
│   │   │   ├── engine.ts     # the streaming turn engine + server loop (channel-blind)
│   │   │   ├── routing.ts    # group-reply decision logic (pure)
│   │   │   └── prompts.ts    # channel-layer prompt suffixes (VOICE_REPLY_INSTRUCTION, capture nudge, …)
│   │   ├── telegram/
│   │   │   ├── transport.ts  # HttpTelegramTransport (HTTP client; Number(conversationId) at the API boundary)
│   │   │   ├── parse.ts      # update parsing → ChannelMessage (String(chat.id) on ingest)
│   │   │   └── channel.ts    # Telegram adapter: capabilities + identity encrypt/decrypt (no crypto)
│   │   ├── telegram.ts       # backward-compat barrel re-export (preserves the old public surface)
│   │   ├── telegramFormat.ts # markdown → Telegram HTML
│   │   ├── streamSegmenter.ts # splits a streaming reply into Telegram-sized segments (fence/table/list-aware)
│   │   └── commands.ts       # slash-command handling (/stop, /update, /coder, /chattiness, …)
│   ├── cli/                  # one file per Citty subcommand
│   │   ├── index.ts          # dispatcher; subcommand registration list lives here
│   │   ├── run.ts            # the long-running listener
│   │   ├── ask.ts            # phantombot ask (programmatic single turn — an UNTRUSTED entry point; screened)
│   │   ├── init.ts           # phantombot init (first-run setup)
│   │   ├── install.ts uninstall.ts
│   │   ├── update.ts         # phantombot update (consumes the GH releases feed)
│   │   ├── env.ts            # phantombot env (manages ~/.env)
│   │   ├── notify.ts         # phantombot notify — broadcasts text/voice to all authorized recipients on every channel
│   │   ├── task.ts           # phantombot task (CRUD over scheduled tasks)
│   │   ├── tick.ts           # phantombot tick (called by phantombot-tick.timer every minute)
│   │   ├── voice.ts          # phantombot voice (TUI: TTS/STT provider config)
│   │   ├── telegram.ts       # phantombot telegram (TUI: token + allowed users)
│   │   ├── harness.ts        # phantombot harness (TUI: chain) + maybePromptRestart helper
│   │   ├── memory.ts         # phantombot memory (search/get/today/index/list/capture)
│   │   ├── heartbeat.ts nightly.ts  # nightly is 5 checkpointed stages (--resume)
│   │   ├── doctor.ts         # phantombot doctor (memory health check + nightly auto-repair)
│   │   ├── embedding.ts      # phantombot embedding (TUI: Gemini config)
│   │   ├── persona.ts        # phantombot persona (consolidates create / import / restore / switch)
│   │   ├── create-persona.ts import-persona.ts  # implementation files; no top-level subcommand
│   ├── harnesses/
│   │   ├── types.ts          # HarnessRequest / HarnessChunk discriminated union
│   │   ├── buildChain.ts     # build Harness[] from config — single source of truth (was duplicated in run.ts + tick.ts)
│   │   ├── claude.ts         # Bun.spawn `claude --print --output-format stream-json …` (OAuth-only; ANTHROPIC_API_KEY filtered)
│   │   ├── pi.ts             # Bun.spawn `pi --print --mode json …` (OAuth on host; ARG_MAX guard)
│   │   └── codex.ts          # Bun.spawn `codex …` (OpenAI Codex CLI harness)
│   └── lib/
│       ├── logger.ts io.ts configWriter.ts envFile.ts format.ts
│       ├── coderSwap.ts chattiness.ts  # per-conversation overrides: coding-brain swap + progress-bubble on/off (JSON state under xdgStateHome)
│       ├── threatJudge.ts    # tool-less untrusted-input judge (see "Security perimeter")
│       ├── redact.ts         # secret redaction for log lines + task_runs audit table
│       ├── platform.ts       # cross-platform service-manager router (systemd ↔ launchd ↔ Task Scheduler)
│       ├── systemd.ts        # Linux unit generators + install/uninstall + ensureUnitCurrent
│       ├── launchd.ts        # macOS LaunchAgent (plist) generators + install/uninstall (mirrors systemd.ts)
│       ├── windowsJob.ts      # Windows Job Object process-tree ownership
│       ├── envBootstrap.ts   # self-load ~/.env + .config/.env at startup; reloadEnvFiles() before each spawn
│       ├── harnessRunner.ts  # shared spawn/kill/idle-timeout/abort coordination for all harnesses
│       ├── harnessAvailability.ts cooldown.ts  # binary-on-PATH detection + per-harness fast-fallback cooldown
│       ├── tasks.ts          # task store (bun:sqlite tasks table) + CRUD
│       ├── cronSchedule.ts scheduleParser.ts   # cron-parser wrapper + duration→cron + review-interval defaults
│       ├── timerHealth.ts    # timer fire-markers (heartbeat/tick) so doctor can flag silent timers
│       ├── processGroup.ts fetchTimeout.ts      # process-group helpers + fetch with timeout
│       ├── binaryUpdate.ts   # phantombot update: download + sha256 + atomic swap
│       ├── githubReleases.ts updateNotify.ts    # latest-release discovery + post-update notify
│       ├── audio.ts          # TTS/STT dispatch (ElevenLabs/OpenAI/Azure Edge)
│       ├── voice.ts telegramApi.ts personaScaffold.ts personaTemplate.ts personaArchive.ts personaDefault.ts
│       ├── memoryIndex.ts   # FTS5 store: OKF field-weighted BM25F + link-graph expansion (no-Gemini path), hybrid RRF when embeddings present
│       ├── okf.ts           # Open Knowledge Format parser: frontmatter/body/headings/links (powers BM25F columns + concept graph)
│       ├── heartbeat.ts nightly.ts embedJob.ts geminiEmbed.ts
│       └── runLock.ts        # single-instance lock (prevents two `phantombot run` on one box)
├── agents/
│   └── phantom/              # placeholder persona used by tests
└── tests/                    # bun test, ~1180 tests across ~79 files
```

## Architecture at a glance

- **Citty CLI dispatcher** (`src/cli/index.ts`) → subcommand → orchestrator (for turn-spending commands like `run`, `ask`, `tick`, `nightly`).
- **One-turn coordinator** (`src/orchestrator/turn.ts`) loads persona files, loads recent turns from memory, builds system prompt, **screens untrusted input** (`screen.ts`), runs the harness chain, and persists the user+assistant turns on success.
- **Harness chain** (`src/orchestrator/fallback.ts` + `lib/harnessRunner.ts`) tries primary; if it returns a recoverable error, falls through to the next (with per-harness cooldown for fast fallback).
- **Security perimeter** (`lib/threatJudge.ts` + `orchestrator/screen.ts`) — trusted principals act directly; untrusted input is judged in code before any capable harness sees it. See "Security perimeter".
- **Channels** are a channel-agnostic core + thin per-channel adapters (`src/channels/core/` + `src/channels/telegram/`); `phantombot run` is the long-running process. See "Channel layer".
- **Env bootstrap** (`lib/envBootstrap.ts`) self-sources the `.env` files at startup (required on macOS, no-op on Linux) and re-sources before each harness spawn so `phantombot env set` takes effect mid-session.
- **Tick fires scheduled tasks** (`src/cli/tick.ts`); 1-minute systemd timer; lockfile prevents overlap; missed runs are skipped, not piled up.
- **Heartbeat is mechanical** (no LLM); **nightly is cognitive** (LLM-driven distillation).

## Channel layer (core + adapters)

As of #168 the channel layer is split into a **channel-agnostic core** and **thin per-channel adapters**, so a second transport (Matrix, Slack, …) is a small adapter rather than a fork of the engine.

- **`src/channels/core/`** is channel-blind. `engine.ts` holds the streaming turn engine + server loop (moved verbatim out of the old `telegram.ts`); `routing.ts` is the pure group-reply decision; `prompts.ts` holds the channel-layer prompt suffixes (`VOICE_REPLY_INSTRUCTION`, the capture nudge, the voice-unavailable message); `types.ts` defines the contract: `Channel` / `ChannelTransport` / `ChannelMessage`, a `ChannelCapabilities` object (`voice` / `typing` / `attachments` / `encryption`), and `encrypt`/`decrypt` hook signatures.
- **`src/channels/telegram/`** is the first adapter: `transport.ts` (HTTP client), `parse.ts` (update → `ChannelMessage`), `channel.ts` (capabilities + encrypt/decrypt).
- **`src/channels/telegram.ts`** is now a **backward-compat barrel** that re-exports the core + adapter symbols under their old names, so importers and the test suite kept their surface unchanged across the refactor.

Two invariants worth knowing before you touch this:

1. **IDs are channel-neutral strings.** The core speaks `conversationId: string` / `senderId: string`. Telegram's numeric ids are normalized at the adapter boundary only — `String(chat.id)` on ingest (`parse.ts`), and `Number(conversationId)` right before the Telegram API call (`transport.ts`). Don't reintroduce a numeric id into the core contract; Matrix/Slack ids aren't numbers. The numeric update-notify recipient ids (`updateNotify.ts`, `notify.ts`) and the slash-command logging id are separate, Telegram-specific, and converted at their own boundary.
2. **The encrypt/decrypt seam is placed but empty.** Telegram's `encrypt`/`decrypt` are identity pass-throughs (Telegram bots have no E2EE) with `encryption: false`. They return `T | Promise<T>` so async crypto (Matrix Megolm) can slot in later with no signature change. There is deliberately **zero crypto code and zero Matrix code** — the actual Matrix adapter + E2EE are parked for the community discussion in issue #154.

## Security perimeter — trusted vs untrusted input

Phantombot runs a **two-tier perimeter**, enforced in code (not by trusting a model's say-so — the bug that prompted this design was a model *claiming* it had notified/recorded when it hadn't).

- **Trusted** input — an authenticated Telegram principal — is acted on directly. The principal *is* the gate; no screening.
- **Untrusted** input — email, web, Twilio, webhooks, raw `phantombot ask`, any future app — is read by a **tool-less threat judge** (`lib/threatJudge.ts`) before any capable harness runs. `orchestrator/screen.ts` (`makeScreener`, wired into `turn.ts` like `makeRetriever`) does the side-effecting orchestration around the pure judge: it first **briefs** the judge with semantic recall from the threat-relevant drawers (`decisions` = prior rulings, `people` = known senders, `norms` = what's routine), then the judge returns a 0–100 threat score. Below threshold → green-lit silently; at/above → the untrusted turn is **HELD** (does nothing) and surfaced to the principal.
- A **ruling is only recorded from a trusted turn** — the judge and the untrusted turn never write decisions. When the principal concludes, the ruling (with its weight) is captured to the `decisions` drawer so the next similar screening recalls it.

If you add a new untrusted entry point (a new inbound channel, a new `ask`-style API), it MUST route through the screener — don't let untrusted content reach a harness unscreened.

## Persona model — single at runtime

**One persona is active at a time.** This surprises people. The persona "library" on disk (under `~/.local/share/phantombot/personas/`) can have many directories, but `phantombot run` binds to one — `config.defaultPersona` — and the `runLock` (`src/lib/runLock.ts`) prevents two `phantombot run` processes from coexisting on the same box. If a feature needs "different personas for different chats" or "two personas at once," that's a real architectural change (per-persona Telegram tokens, per-persona XDG dirs, lifted runLock) — not a config knob. The README's [Personas](README.md#personas) section is the authoritative explanation; if you change this model, update both.

## Service model (systemd + launchd + Windows Task Scheduler)

Phantombot ships on **Linux (systemd --user)**, **macOS (launchd, per-user LaunchAgents)**, and **Windows (per-user Task Scheduler logon task plus three periodic tasks)**. `lib/platform.ts` is the single router that decides which backend to talk to; each backend sits behind a common `ServiceControl` surface with an injectable runner so tests never touch the real service manager. Windows uses `InteractiveToken` and the current user's SID, so installation needs no password or elevation; installation preserves healthy existing task definitions and only repairs missing/stale entries. Windows `start`/`restart` re-enable the task and use a hidden native detached launch for SSH/terminal control because Task Scheduler cannot `/Run` an interactive-token task from a non-interactive session. `windowsJob.ts` assigns harness children to kill-on-close Job Objects.

On Linux, `phantombot install` creates **four** systemd-user units:

| Unit | Cadence | What it does |
|---|---|---|
| `phantombot.service` | always-on | `phantombot run` — Telegram listener |
| `phantombot-heartbeat.timer` → `.service` | every 30 min | mechanical maintenance, no LLM |
| `phantombot-nightly.timer` → `.service` | daily 02:00 | cognitive distillation, LLM |
| `phantombot-tick.timer` → `.service` | every 1 min | fires due scheduled tasks |

Every service has **two `EnvironmentFile=` lines**:

```
EnvironmentFile=-%h/.config/phantombot/.env    # phantombot's own secrets (TTS keys)
EnvironmentFile=-%h/.env                        # user's general credentials
```

Leading `-` makes both optional (no error if either file is absent). The merged `process.env` is what spawned harnesses inherit, so the agent finds credentials without re-reading either file.

**macOS has no `EnvironmentFile=` equivalent.** launchd plists can't source a file, so on macOS `lib/envBootstrap.ts` self-loads both `.env` files into `process.env` at startup (existing values win, so nothing already set is clobbered). On Linux this is a cheap no-op because systemd already sourced them. Either way, harnesses also call `reloadEnvFiles()` before each spawn so a freshly-written `phantombot env set` secret is visible mid-session without a restart.

Service units also set a deterministic `PATH` that includes `~/.local/bin` plus stable user harness shim locations such as `~/.local/share/pi-node/bin` and `~/.local/share/pi-node/current/bin`. Do not rely on interactive shell startup files for service harness discovery. When Phantombot finds a harness in PATH or common npm/pi-node versioned locations, it saves the absolute path in `state.json` and executes that path directly on later starts. `phantombot run` must never fail startup just because a harness binary is missing; log loudly, keep the headless service alive, and let `phantombot doctor` report/repair the configured chain.

If you change a unit body (any `generate*` function in `src/lib/systemd.ts`), `ensureUnitCurrent` will detect the on-disk unit as stale on the next `phantombot voice` / `phantombot harness` / etc. run and rewrite it automatically. The previous body is preserved as `${unitPath}.bak` for rollback.

## Credentials

Two .env files, two roles:

- **`~/.config/phantombot/.env`** — phantombot-managed (TTS keys, written by `phantombot voice`).
- **`~/.env`** — user-managed (`GITHUB_TOKEN` etc., written by `phantombot env set`).

The agent NEVER `echo … >> ~/.env`. It uses `phantombot env set NAME "value"` (atomic write, mode 0o600). The full credential discovery + hygiene rules are baked into every persona's system prompt via `CREDENTIALS_SECTION` in `src/persona/builder.ts` — the agent inherits them automatically. If you change those rules, update both `CREDENTIALS_SECTION` and the README's [Credentials](README.md#credentials-phantombot-env) section.

## Release pipeline

Every merged PR auto-releases `v1.0.<PR_NUMBER>`. The workflow at `.github/workflows/release.yml`:

1. Triggers on `pull_request: closed` + `merged == true` + `branches: main`.
2. Checks out the merge-commit SHA (not main HEAD; pins to exactly the code that merged).
3. Runs `bun tsc --noEmit` and `bun test` as gates.
4. `sed -i "s/0.1.0-dev/1.0.${PR_NUMBER}/" src/version.ts` (replaces only the literal placeholder, preserves the doc comment block).
5. Cross-compiles `bun-linux-x64-baseline` and `bun-linux-arm64`.
6. Computes `SHA256SUMS`.
7. `gh release create v1.0.<PR_NUMBER> --target <merge_commit_sha> …` so the git tag is pinned to the commit, not the moving HEAD.

`phantombot update` reads this feed via the GitHub Releases API.

**Versioning is intentionally not semver.** `1.0.<PR_NUMBER>` — patch is the PR number, ordered by merge time, not semantic impact. Don't bolt semver-aware logic on (`phantombot update --major-only` etc.); the version string can't carry that information.

## How to add a new subcommand

1. **Write the file** at `src/cli/<name>.ts`. Export `defineCommand({ … })` as default and a `run<Name>` function for testability (the function takes injectable deps + returns an exit code).
2. **Register** in `src/cli/index.ts` `subCommands` (alphabetical order).
3. **Update the test** in `tests/cli.test.ts` — the `expect(names).toEqual([…])` list must include the new subcommand.
4. **Test the function directly** (in `tests/cli-<name>.test.ts`) by injecting fake deps. Don't drive `defineCommand` end-to-end; @clack/prompts is non-TTY-hostile in tests.
5. **Update README** — add the command to the "Commands" section.
6. **Update AGENTS.md** if the command introduces new conventions (a new lockfile, a new file location, a new credential interaction).

## Testing conventions

- **Per-test `mkdtemp`**, never write to real `~/.config/phantombot/` or `~/.local/share/phantombot/`. Each test creates an isolated workdir in `os.tmpdir()` and cleans it in `afterEach`. The `installPhantombotUnit` test pollution from PR #44 was exactly this problem (untracked).
- **Mock external IO** via fetch override (`globalThis.fetch = …`), `SystemctlRunner` injection, `TelegramTransport` injection, etc.
- **Don't drive @clack/prompts** in tests — it requires a TTY and will hang in CI. Either extract a prompt-free helper (the `maybeUpgradeUnit` / `ConfirmFn` pattern) or inject a stub confirm.
- **Tests should pass on a fresh clean Linux runner.** If a test passes locally but fails in the GH workflow, suspect environment leakage (real systemd dir, real $HOME, etc.) — see PR #43 / #44.

## Common pitfalls

1. **`bun-linux-x64` instead of baseline** — SIGILLs on pre-AVX2 hardware. Use `bun-linux-x64-baseline`. Documented at the top of `.github/workflows/release.yml`.
2. **`echo … > src/version.ts` in CI** — would clobber the comment block. Use `sed -i "s/0.1.0-dev/$VERSION/" src/version.ts` instead. The placeholder literal must round-trip exactly; if you change `version.ts`, also update the sed pattern in the workflow.
3. **`sudo cp` to install someone's binary** — leaves `.bak` root-owned, blocks future `phantombot update` from the unprivileged user. Use `sudo install -o <user> -g <group> -m 755 …`. Documented in PR #47's repro.
4. **`copyFile` over an existing foreign-owned file** — fails with EACCES because `O_TRUNC` checks the existing file's mode. `applyUpdate` unlinks `.bak` first; if you add similar copy logic, do the same.
5. **@clack/prompts confirm in non-TTY context** — returns the cancel sentinel. If you write code that calls `p.confirm` directly and expect a boolean, tests will hit the cancel path silently. Prefer `ConfirmFn` injection (see `src/cli/harness.ts`).
6. **Forgetting `tests/cli.test.ts` subcommand list** — every new subcommand needs to be added there or that test fails on PR merge.
7. **Creating/importing/restoring a persona on a fresh box without setting it as default** — the built-in fallback `default_persona = "phantom"` doesn't have a directory; `phantombot run` would fail with "persona 'phantom' not found." Every persona-producing path (`runImportPersona`, `runImportFromPath`, `runRestoreArchive`, `applyPersona`) calls `adoptAsDefaultIfMissing` from `src/lib/personaDefault.ts` so the new persona becomes default when there's no working default. If you add another persona-producing path, call it too — and add a `state.json` isolation `beforeEach` to its tests so they don't pollute the real `~/.local/share/phantombot/state.json`.
8. **`install.sh` piped to `sh` runs without a TTY** — interactive @clack TUIs would misbehave. The script detects this with `[ -t 0 ] && [ -t 1 ]` before launching the persona TUI, and prints the next-step hint instead. If you add interactive setup steps to the install flow, repeat the check.
9. **Adding a new harness — three places that must be touched, not one.** `src/harnesses/buildChain.ts` (factory: instantiate the wrapper class), `src/cli/harness.ts` (`SUPPORTED_HARNESSES` for the TUI + `detectAvailability` for the binary-on-PATH check), and `src/config.ts` (Config type slot + loader for `[harnesses.<id>]`). Plus inline test fixtures across ~12 files that have a literal Config object. If you forget any, typecheck + tests catch it — but it's tedious; the buildChain.ts extraction was specifically to retire the *fourth* duplicate that was about to land with each new harness. Gemini CLI is retired; Gemini embeddings remain under `[embeddings]`.
10. **Channel-specific behavior belongs in the channel layer, not in personas.** Brevity for voice replies, formatting for Slack, etc. should be appended to the system prompt at the channel boundary (see `VOICE_REPLY_INSTRUCTION` in `src/channels/core/prompts.ts`, passed via `runTurn`'s `systemPromptSuffix`). Putting "be brief on voice" in a persona's BOOT.md/SOUL.md throttles text replies too — and persists across all the persona's contexts where verbosity is fine. Channel-layer suffixes are scoped to the turn that needs them.

11. **Reply modality is mirror-input by default, with a per-message text override available.** `processChatMessage` in `src/channels/core/engine.ts` picks the wire format (sendMessage vs sendVoice) via `replyModalityOverride()` from `src/lib/audio.ts`: when the user's message (post-STT, so voice transcripts count) contains an explicit directive like *"reply in text"*, *"no voice"*, or *"send a voice note"*, that wins; otherwise modality mirrors input. The override is parsed by a small, deliberately conservative regex set — anchored on reply-verbs and unmistakable shorthand, no bare-noun matches ("text message to John" must not trigger). Voice is still capped by `ttsSupported(config)`: an override asking for voice when no TTS provider is configured degrades to text gracefully, same as the original no-TTS fallback. If you extend the regex set, add cases to `replyModalityOverride` in `tests/lib-audio.test.ts` AND to the three end-to-end scenarios in `tests/channels-telegram.test.ts` (voice-in→text, text-in→voice, text-in→voice-without-TTS).

12. **`GITHUB_TOKEN` for `phantombot update` isn't always safe to send.** GitHub App installation tokens are scoped to a single org's repos; using one against the public `phantomyard/phantombot` releases endpoint returns 401 even though the endpoint is anonymously reachable. `findLatestRelease` in `src/lib/githubReleases.ts` therefore retries once *without* the auth header on 401/403 before failing, and the final error mentions org-scoping explicitly. If you add another auth'd GitHub API call (e.g. for changelog fetch, asset metadata, etc.), reuse the `buildHeaders(withAuth)` helper and replicate the unauth-retry path — otherwise users with org-scoped tokens hit a dead end on what should be a public read. See issue #115 / PR #120.

13. **The narration/streaming loop is DUPLICATED across the two chat channels — gate both.** `src/channels/core/engine.ts` (Telegram) and `src/channels/phantomchat/server.ts` (PhantomChat) each carry their own near-identical `flushNarration` + segment-send state machine; PhantomChat *mirrors* engine.ts rather than calling into it. Any change to how interim progress bubbles are emitted (the `/chattiness` gate is the current example — a `resolveNarrationEnabled()` check at the top of both `flushNarration`s) must be applied in **both** files or half of it silently doesn't work. Both sites carry a `TODO(dedup)` breadcrumb. Scope is Telegram + PhantomChat only — the editor (ACP) surface is deliberately left untouched. Per-conversation overrides live in `src/lib/chattiness.ts` (JSON under `xdgStateHome`, mirroring `coderSwap.ts`). See issue #243.

14. **ACP has TWO scopes — a workspace and a thread — and history must only ever load into the thread one.** `src/connectors/acp/session.ts` derives both: the WORKSPACE key `acp:<sha256(cwd)[0..12]>` (stable per project directory) and the CONVERSATION key `acp:<cwdhash>:<threadid>` (stable per editor thread). Turn history is keyed on the **conversation**, so a new thread starts empty. This is load-bearing, not cosmetic: the conversation used to be keyed on cwd alone, so every "new" editor thread replayed the previous thread's turns **as USER messages** — a fresh thread opened onto a trailing queue of *"open a PR…" / "Go."*, and the model, reading the last thing the user had apparently asked for, went off and did unrequested work with nothing visible in the editor to cancel. If you touch the keying, keep the two scopes distinct and never widen the conversation key back to the workspace. Workspace-wide context is supplied *instead* by `briefing.ts` — prior turns rendered into a **system-role** block explicitly framed as finished sessions with void approvals, via `recentTurnsForConversationPrefix` in `src/memory/store.ts`. **Role is the whole mechanism**: the same bytes as `user` turns are live instructions; as a system briefing they're inert reference. Don't "simplify" the briefing back into history injection. The thread id rides inside the opaque sessionId (`acp_<cwdhash>_<thread>`), so `session/load` resumes a thread verbatim; legacy tokens with no thread segment still resolve to the old cwd-wide conversation, so pre-existing threads keep their history.

15. **Slash commands on the ACP surface must be dispatched OUT OF BAND, ahead of the serial request queue.** `src/connectors/acp/commands.ts` owns the allowlist (`/stop`, `/reset`, `/status`, `/harness`, `/help`) and delegates *behaviour* to the same `handleSlashCommand` in `src/channels/commands.ts` that Telegram uses — don't reimplement it. The dispatch point in `server.ts` is the part with a trap in it: `/stop` exists to kill the long-running prompt that is **currently blocking the queue**, so queueing it behind that prompt means it only fires once the turn it was meant to cancel has already finished. Route it out of band, the same exemption `session/cancel` already has. Commands are also advertised **per session** — an `available_commands_update` notification (`protocol.ts`) sent on both `session/new` and `session/load`, *not* in the `initialize` result — or the editor's `/`-menu is empty and users can't discover them. If you add a session-creating path, it must send that notification too. The allowlist is enforced in the ACP module *before* delegation, so this surface can't silently inherit a new Telegram-only command; `/update` and `/restart` are deliberately excluded (they bounce a service whose lifecycle the editor owns). Anything not on the list must fall through to the harness — personas define their own slash-isms, and a prompt that merely starts with `/` (a path, a regex) must not be swallowed.

## Process for updating this file

If your PR does any of the things in the "contributing discipline" list above, **before opening the PR**:

1. Re-read the relevant section here. Does it still describe what the code does?
2. If not, edit. The PR description should mention `AGENTS.md` updated alongside `README.md` and the code.
3. If your change introduces a new common pitfall (something a future contributor would trip on), add it to the **Common pitfalls** section.

This file is short on purpose. Don't pad it. Each section earns its place by saving someone else 20 minutes of archeology.
