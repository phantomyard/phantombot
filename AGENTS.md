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
│   │   └── store.ts          # bun:sqlite turn store (turns table)
│   ├── importer/
│   │   └── openclaw.ts       # OpenClaw → phantombot persona import
│   ├── orchestrator/
│   │   ├── turn.ts           # one-turn coordinator (persona → memory → harness → persist)
│   │   └── fallback.ts       # harness chain (primary → fallback)
│   ├── channels/
│   │   └── telegram.ts       # Telegram adapter (HttpTelegramTransport + long-poll loop)
│   ├── cli/                  # one file per Citty subcommand
│   │   ├── index.ts          # dispatcher; subcommand registration list lives here
│   │   ├── run.ts            # the long-running listener
│   │   ├── install.ts uninstall.ts
│   │   ├── update.ts         # phantombot update (consumes the GH releases feed)
│   │   ├── env.ts            # phantombot env (manages ~/.env)
│   │   ├── notify.ts         # phantombot notify (Telegram text/voice)
│   │   ├── task.ts           # phantombot task (CRUD over scheduled tasks)
│   │   ├── tick.ts           # phantombot tick (called by phantombot-tick.timer every minute)
│   │   ├── voice.ts          # phantombot voice (TUI: TTS/STT provider config)
│   │   ├── telegram.ts       # phantombot telegram (TUI: token + allowed users)
│   │   ├── harness.ts        # phantombot harness (TUI: chain) + maybePromptRestart helper
│   │   ├── memory.ts         # phantombot memory (search/get/today/index/list)
│   │   ├── heartbeat.ts nightly.ts
│   │   ├── embedding.ts      # phantombot embedding (TUI: Gemini config)
│   │   ├── persona.ts        # phantombot persona (consolidates create / import / restore / switch)
│   │   ├── create-persona.ts import-persona.ts  # implementation files; no top-level subcommand
│   ├── harnesses/
│   │   ├── types.ts          # HarnessRequest / HarnessChunk discriminated union
│   │   ├── buildChain.ts     # build Harness[] from config — single source of truth (was duplicated in run.ts + tick.ts)
│   │   ├── claude.ts         # Bun.spawn `claude --print --output-format stream-json …` (OAuth-only; ANTHROPIC_API_KEY filtered)
│   │   ├── pi.ts             # Bun.spawn `pi --print --mode json …` (OAuth on host; ARG_MAX guard)
│   │   └── gemini.ts         # Bun.spawn `gemini -p <user_msg> -o text -y` (stdin = system + history; v1 text mode)
│   └── lib/
│       ├── logger.ts io.ts configWriter.ts envFile.ts
│       ├── systemd.ts        # unit generators + install/uninstall + ensureUnitCurrent
│       ├── tasks.ts          # task store (bun:sqlite tasks table) + CRUD
│       ├── cronSchedule.ts   # cron-parser wrapper + review-interval defaults
│       ├── binaryUpdate.ts   # phantombot update: download + sha256 + atomic swap
│       ├── githubReleases.ts # phantombot update: latest-release discovery
│       ├── audio.ts          # TTS/STT dispatch (ElevenLabs/OpenAI/Azure Edge)
│       ├── voice.ts telegramApi.ts personaScaffold.ts personaTemplate.ts personaArchive.ts
│       ├── memoryIndex.ts heartbeat.ts nightly.ts embedJob.ts geminiEmbed.ts
│       └── runLock.ts        # single-instance lock (prevents two `phantombot run` on one box)
├── agents/
│   └── phantom/              # placeholder persona used by tests
└── tests/                    # bun test, ~430 tests across ~50 files
```

## Architecture at a glance

- **Citty CLI dispatcher** (`src/cli/index.ts`) → subcommand → orchestrator (for turn-spending commands like `run`, `tick`, `nightly`).
- **One-turn coordinator** (`src/orchestrator/turn.ts`) loads persona files, loads recent turns from memory, builds system prompt, runs the harness chain, and persists the user+assistant turns on success.
- **Harness chain** (`src/orchestrator/fallback.ts`) tries primary; if it returns a recoverable error, falls through to the next.
- **Channels listen** (`src/channels/telegram.ts`); `phantombot run` is the long-running process.
- **Tick fires scheduled tasks** (`src/cli/tick.ts`); 1-minute systemd timer; lockfile prevents overlap; missed runs are skipped, not piled up.
- **Heartbeat is mechanical** (no LLM); **nightly is cognitive** (LLM-driven distillation).

## Persona model — single at runtime

**One persona is active at a time.** This surprises people. The persona "library" on disk (under `~/.local/share/phantombot/personas/`) can have many directories, but `phantombot run` binds to one — `config.defaultPersona` — and the `runLock` (`src/lib/runLock.ts`) prevents two `phantombot run` processes from coexisting on the same box. If a feature needs "different personas for different chats" or "two personas at once," that's a real architectural change (per-persona Telegram tokens, per-persona XDG dirs, lifted runLock) — not a config knob. The README's [Personas](README.md#personas) section is the authoritative explanation; if you change this model, update both.

## Systemd model

`phantombot install` creates **four** systemd-user units:

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
7. **Importing a persona on a fresh box without setting it as default** — the built-in fallback `default_persona = "phantom"` doesn't have a directory; `phantombot run` would fail with "persona 'phantom' not found." `runImportPersona` now adopts the imported persona as default if the current default's dir doesn't exist. If you add another path that creates a persona, do the same — see `maybeAdoptAsDefault` in `src/cli/import-persona.ts`.
8. **`install.sh` piped to `sh` runs without a TTY** — interactive @clack TUIs would misbehave. The script detects this with `[ -t 0 ] && [ -t 1 ]` before launching the persona TUI, and prints the next-step hint instead. If you add interactive setup steps to the install flow, repeat the check.
9. **Adding a new harness — three places that must be touched, not one.** `src/harnesses/buildChain.ts` (factory: instantiate the wrapper class), `src/cli/harness.ts` (`SUPPORTED_HARNESSES` for the TUI + `detectAvailability` for the binary-on-PATH check), and `src/config.ts` (Config type slot + loader for `[harnesses.<id>]`). Plus inline test fixtures across ~12 files that have a literal Config object. If you forget any, typecheck + tests catch it — but it's tedious; the buildChain.ts extraction was specifically to retire the *fourth* duplicate that was about to land with each new harness.

## Process for updating this file

If your PR does any of the things in the "contributing discipline" list above, **before opening the PR**:

1. Re-read the relevant section here. Does it still describe what the code does?
2. If not, edit. The PR description should mention `AGENTS.md` updated alongside `README.md` and the code.
3. If your change introduces a new common pitfall (something a future contributor would trip on), add it to the **Common pitfalls** section.

This file is short on purpose. Don't pad it. Each section earns its place by saving someone else 20 minutes of archeology.
