# AGENTS.md — guide for any agent contributing to phantombot

This file is for **any agent (human or LLM) working on the phantombot codebase itself**. If you're a Claude Code session, an OpenAI-Codex agent, a future maintainer, or just yourself catching up after time away — read this before opening a PR. It captures the small set of project-specific conventions that aren't obvious from the code.

> **Naming-collision warning.** This `/AGENTS.md` (project root) is **not the same as** `personas/<name>/AGENTS.md` (a persona-specific tool-hint file phantombot reads when loading that persona). They share a name because OpenClaw uses the same convention for persona files; phantombot's persona loader accepts both `tools.md` and `AGENTS.md` as the persona-tools slot. If a contributor refers to "AGENTS.md" without context, they almost always mean *this* file (the repo-level one). If you're editing a file under `personas/` or `agents/`, you're touching a persona, not the contributor guide.

## The contributing discipline (READ FIRST)

**Every PR that changes user-facing behavior, architecture, or developer workflow must update `README.md` and the contributor docs it affects in the same PR**: the rule's text in its area file under [`docs/contributing/invariants/`](docs/contributing/invariants/README.md), plus its line in this file's index when a rule is added or retitled. No exceptions. Reviewers should reject PRs where the docs don't match the code.

What "user-facing behavior" means:
- New / removed / renamed CLI subcommand or flag
- Change to systemd unit shape (added/removed timer, new `EnvironmentFile=`, etc.)
- Change to where files live (config path, memory db path, persona dir, lockfile)
- Change to credential discovery / hygiene rules
- Change to release pipeline (asset names, version scheme, trigger)
- Change to architecture invariants (the persona model, runLock, etc.)

What's *not* user-facing and doesn't need a docs update:
- Pure refactors that preserve behavior
- Bug fixes that restore the documented behavior
- Internal lib changes with no public API change
- Tests

If unsure, update the docs. Cheaper than the post-merge "wait, the README says X but the code does Y" archeology.

## Rules that apply to every change

Pointers, not the rules themselves: the linked text is authoritative.

- **Untrusted input reaches a harness only through the threat screener** — email, web, webhooks, a raw `phantombot ask`, a scheduled task wake. One gate per channel; a screen with no verdict holds the turn. Never add a second gate or a fail-open path. The opt-in decision-model escort checks a passed turn's tool calls and fails closed; it is not a gate on the input (#702). [Security perimeter](docs/contributing/invariants/security-perimeter.md)
- **Every `runTurn` call states its `workingDir`, and either passes `screen` or is on the trusted-by-construction list** that `tests/perimeter-entrypoints.test.ts` enforces. [Architecture at a glance](docs/contributing/invariants/architecture-and-orchestrator.md)
- **Resolve the persona before loading config, and write where the read path looks.** [27](docs/contributing/invariants/personas-and-config.md#inv-27)
- **Secrets live in the persona's encrypted vault** — never in `.env`, never in a command argument, and a resolved key is never written back into `process.env`. [Credentials](docs/contributing/invariants/personas-and-config.md), [32](docs/contributing/invariants/personas-and-config.md#inv-32)
- **Tool start/end events are paired by stable IDs**; the idle watchdog is suspended while any is in flight, and every terminal path clears the set. [74](docs/contributing/invariants/harnesses.md#inv-74)
- **Slash commands are answered only for an authenticated principal**, enforced once in `handleSlashCommand`. [24](docs/contributing/invariants/security-perimeter.md#inv-24)
- **Tests never touch the developer's real HOME or a live install's stores.** [60](docs/contributing/invariants/testing.md#inv-60), [72](docs/contributing/invariants/testing.md#inv-72)

## Where the rules live (READ SECOND)

The project's hard-won rules are **numbered invariants**, filed by area under [`docs/contributing/invariants/`](docs/contributing/invariants/README.md) and indexed at the bottom of this file. Before touching a subsystem, read its area file end to end — the files are long because each rule records a real incident and the failure that a "simplification" re-opens. The index below is the map; the rule text lives in exactly one place. Numbers are stable identifiers cited by code comments and tests. When the numbering was last reconciled, the later-added copy of each duplicate took the next free number — 71 (embedding providers, was 32), 72 (test isolation, was 62), 73 (nightly render order, was 63) — and three unnumbered rules got one: 74 (the tool watchdog), 75 (the TUI creation wizard) and 76 (settings-snapshot provenance). 77 (the chat prompt's ↑↓ rows) was filed as 71 under the old numbering, so it took the next free number too. Nothing else moved.

**Which file to read first**, by what you are about to touch (a file can matter to several areas — when in doubt, grep the area files for its name):

| You are touching | Read first |
|---|---|
| `src/orchestrator/screen.ts`, `src/lib/threatJudge.ts`, `src/lib/decisionModel*.ts`, `src/lib/promptSafeText.ts`, `src/cli/ask.ts` | [security-perimeter.md](docs/contributing/invariants/security-perimeter.md) |
| `src/orchestrator/turn.ts`, `src/orchestrator/promptCache.ts`, `src/persona/`, `src/engine/`, `src/lib/engineScope.ts`, `src/lib/scratch.ts` | [architecture-and-orchestrator.md](docs/contributing/invariants/architecture-and-orchestrator.md) |
| `src/harnesses/`, `src/orchestrator/fallback.ts`, `src/orchestrator/resume.ts`, `src/orchestrator/softDeadline.ts`, `src/lib/harness*.ts`, `src/lib/embeddedPi.ts`, `src/lib/nativeAgentDir.ts` | [harnesses.md](docs/contributing/invariants/harnesses.md) |
| `src/memory/`, `src/orchestrator/retrieval.ts`, `src/lib/memoryIndex.ts`, `src/lib/dailyRecall.ts`, `src/lib/nightly*.ts`, `src/cli/memory.ts`, `src/cli/nightly.ts` | [memory.md](docs/contributing/invariants/memory.md) |
| `src/channels/`, `src/connectors/acp/` | [channels.md](docs/contributing/invariants/channels.md) |
| `src/cli/tick.ts`, `src/lib/tasks.ts`, `src/lib/turnRegistry.ts`, `src/lib/turnDigest.ts`, `src/lib/workspaceLock.ts` | [scheduler-and-concurrency.md](docs/contributing/invariants/scheduler-and-concurrency.md) |
| `src/config.ts`, `src/lib/personaConfig.ts`, `src/lib/personaDefault.ts`, `src/lib/vault*.ts`, `src/importer/` | [personas-and-config.md](docs/contributing/invariants/personas-and-config.md) |
| `src/lib/platform.ts`, `src/lib/systemd.ts`, `src/lib/launchd.ts`, `src/lib/taskScheduler.ts`, `src/lib/maintenanceHeal.ts`, `src/lib/logRotate.ts`, `src/lib/macSigning.ts`, `src/lib/windowsPath.ts` | [services-and-platforms.md](docs/contributing/invariants/services-and-platforms.md) |
| `.github/workflows/`, `install.sh`, `install.ps1`, `src/cli/update.ts`, `src/lib/binaryUpdate.ts`, `src/version.ts` | [release-and-install.md](docs/contributing/invariants/release-and-install.md) |
| `src/tui/`, `src/lib/tuiGate.ts`, `src/cli/harness.ts`, `src/cli/voice.ts`, `src/cli/embedding.ts`, `src/cli/decision-model.ts` | [cli-tui-and-wizards.md](docs/contributing/invariants/cli-tui-and-wizards.md) |
| `tests/` | [testing.md](docs/contributing/invariants/testing.md) |

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

Moved to [docs/contributing/repo-layout.md](docs/contributing/repo-layout.md) — the annotated tree of `src/`, `tests/` and `docs/`. Open it when you need to find where something lives; it is not needed for every change.

## How to add a new subcommand

1. **Write the file** at `src/cli/<name>.ts`. Export `defineCommand({ … })` as default and a `run<Name>` function for testability (the function takes injectable deps + returns an exit code).
2. **Register** in `src/cli/index.ts` `subCommands` (alphabetical order).
3. **Update the test** in `tests/cli.test.ts` — the `expect(names).toEqual([…])` list must include the new subcommand.
4. **Test the function directly** (in `tests/cli-<name>.test.ts`) by injecting fake deps. Don't drive `defineCommand` end-to-end; @clack/prompts is non-TTY-hostile in tests.
5. **Update README** — add the command to the "Commands" section.
6. **Add it to `HELP_GROUPS`** in `src/cli/help.ts` (exactly one group) and keep its `meta.description` at 20 words or fewer — `tests/cli-help.test.ts` fails otherwise (invariant 84).
7. **Add or update an invariant** (its area file, plus its index line here) if the command introduces new conventions (a new lockfile, a new file location, a new credential interaction).

## Testing conventions

- **Per-test `mkdtemp`**, never write to real `~/.config/phantombot/` or `~/.local/share/phantombot/`. Each test creates an isolated workdir in `os.tmpdir()` and cleans it in `afterEach`. The `installPhantombotUnit` test pollution from PR #44 was exactly this problem (untracked).
- **Mock external IO** via fetch override (`globalThis.fetch = …`), `SystemctlRunner` injection, `TelegramTransport` injection, etc.
- **Don't drive @clack/prompts** in tests — it requires a TTY and will hang in CI. Either extract a prompt-free helper (the `maybeUpgradeUnit` / `ConfirmFn` pattern) or inject a stub confirm.
- **Tests should pass on a fresh clean Linux runner.** If a test passes locally but fails in the GH workflow, suspect environment leakage (real systemd dir, real $HOME, etc.) — see PR #43 / #44.

The isolation rules the suite itself enforces (sandboxed `HOME`/XDG roots, the live-store write guard) are invariants 60 and 72 in [testing.md](docs/contributing/invariants/testing.md).

## Invariants index

One line per rule: its stable number, then its title. Click through for the full text; grep the area file for a symbol when you are not sure which rule applies.

### Architecture and the orchestrator — [architecture-and-orchestrator.md](docs/contributing/invariants/architecture-and-orchestrator.md)

- [29](docs/contributing/invariants/architecture-and-orchestrator.md#inv-29) The plan-then-confirm gate is CHANNEL-AGNOSTIC and lives in the orchestrator — one copy, overridable, and not in a channel suffix (issues #443, #447).
- [39](docs/contributing/invariants/architecture-and-orchestrator.md#inv-39) Prompt-cache ordering and epochs must stay disposable.
- [42](docs/contributing/invariants/architecture-and-orchestrator.md#inv-42) A hosted prompt-cache key follows a CONTEXT EPOCH, never a conversation (issue #504).
- [45](docs/contributing/invariants/architecture-and-orchestrator.md#inv-45) Reply LANGUAGE is stated to the harness as ONE deterministic rule that names the SOURCE — it is never inferred from turn content, never classified in code, and never restated a second time (issues #534, #548, #580).
- [46](docs/contributing/invariants/architecture-and-orchestrator.md#inv-46) Fleet-wide behavioural rules ship as PROSE IN THE BINARY, not as a file on the host.
- [64](docs/contributing/invariants/architecture-and-orchestrator.md#inv-64) The embeddable engine (`src/engine/`) is a FACADE over the daemon's own functions, scoped by AsyncLocalStorage — never by `process.env` (`phantombot/engine`, docs/reference/engine.md).
- [69](docs/contributing/invariants/architecture-and-orchestrator.md#inv-69) A turn's scratch files live under the PERSONA dir, are named INJECTIVELY, and the env var is RUNTIME-owned (issue #661).

### Channels — [channels.md](docs/contributing/invariants/channels.md)

- [10](docs/contributing/invariants/channels.md#inv-10) Channel-specific behavior belongs in the channel layer, not in personas.
- [11](docs/contributing/invariants/channels.md#inv-11) Reply modality is mirror-input by default, with a per-message text override available.
- [13](docs/contributing/invariants/channels.md#inv-13) The narration/streaming loop is DUPLICATED across the two chat channels — gate both.
- [14](docs/contributing/invariants/channels.md#inv-14) ACP has TWO scopes — a workspace and a thread — and history must only ever load into the thread one.
- [15](docs/contributing/invariants/channels.md#inv-15) Slash commands on the ACP surface must be dispatched OUT OF BAND, ahead of the serial request queue.
- [16](docs/contributing/invariants/channels.md#inv-16) `/status` live probes must stay bounded — a dead provider must never hang the diagnostic.
- [57](docs/contributing/invariants/channels.md#inv-57) Relay write quarantine is minute-scale and actively recoverable; publish confirmation is a quorum.
- [82](docs/contributing/invariants/channels.md#inv-82) OpenCode consumes Phantombot as a MODEL via an `aisdk:` provider module, never as an ACP agent (issue #699).
- [83](docs/contributing/invariants/channels.md#inv-83) The OpenCode provider persists its thread TOKEN — never the transcript — and a cold registry RELOADS it instead of minting a new thread (issue #710).

### Security perimeter — [security-perimeter.md](docs/contributing/invariants/security-perimeter.md)

- [24](docs/contributing/invariants/security-perimeter.md#inv-24) The phantomchat allowlist IS the principal list — bridges get their own, lower tier (issue #400).
- [63](docs/contributing/invariants/security-perimeter.md#inv-63) Jev talks to the DECISIONS API, never chat/completions — and its security numbers are calibrated, not assumed (issue #597).

### Personas, config and credentials — [personas-and-config.md](docs/contributing/invariants/personas-and-config.md)

- [7](docs/contributing/invariants/personas-and-config.md#inv-7) Creating/importing/restoring a persona on a fresh box without setting it as default
- [18](docs/contributing/invariants/personas-and-config.md#inv-18) The default-persona switch is gated on confirmation and agent-scoped switches are refused (PR #383 / issue #371).
- [27](docs/contributing/invariants/personas-and-config.md#inv-27) Per-persona config has three rules, and each has already been broken once (issue #439).
- [28](docs/contributing/invariants/personas-and-config.md#inv-28) A persona's brain is persona-scoped, and "cleared" must be SPELLED, not implied (issue #441).
- [32](docs/contributing/invariants/personas-and-config.md#inv-32) `.env` is a ONE-WAY LEGACY IMPORT — no runtime read, no write, and the file is kept rather than deleted (issue #452).
- [38](docs/contributing/invariants/personas-and-config.md#inv-38) A persona-scoped job must CARRY its persona, and the host default must be observable (issue #505).
- [40](docs/contributing/invariants/personas-and-config.md#inv-40) Persona names are case-sensitive keys even where paths are not (PR #475).
- [55](docs/contributing/invariants/personas-and-config.md#inv-55) An import writes for the persona it IMPORTED, never for `config.defaultPersona`.

### Harnesses — [harnesses.md](docs/contributing/invariants/harnesses.md)

Coder-swap empty-result recovery preserves the three-attempt ladder and side-effect
guards; see the [recovery contract](docs/contributing/invariants/harnesses.md#coder-swap-empty-completion-recovery-issue-692).

- [9](docs/contributing/invariants/harnesses.md#inv-9) Adding a new harness — three places that must be touched, not one.
- [26](docs/contributing/invariants/harnesses.md#inv-26) Two different kernel limits govern argv, and the one that bites on Linux is per-STRING (issue #426).
- [31](docs/contributing/invariants/harnesses.md#inv-31) There is ONE harness detector, and a persisted bin is a CACHE that must be platform-checked (issue #450).
- [33](docs/contributing/invariants/harnesses.md#inv-33) A turn wedged mid-flight is RESUMED with context, not dropped — and the trade that buys is stated, not hidden (issue #459).
- [44](docs/contributing/invariants/harnesses.md#inv-44) Two Pi providers are two harness INSTANCES, never one shared Pi config.
- [48](docs/contributing/invariants/harnesses.md#inv-48) `recoverable` on an orchestrator error chunk describes what the ORCHESTRATOR may do, NOT whether the user was spared — never filter on it at a channel.
- [56](docs/contributing/invariants/harnesses.md#inv-56) The native harness runs the pi engine EMBEDDED in the binary; everything else about pi is the host's business.
- [59](docs/contributing/invariants/harnesses.md#inv-59) A failed-over harness dies with its stream, and heartbeats are not progress.
- [61](docs/contributing/invariants/harnesses.md#inv-61) A harness crash may fail a turn; it may not erase the request or its evidence (issue #571).
- [66](docs/contributing/invariants/harnesses.md#inv-66) The hard cap is a backstop, not the deadline — and outage alerts speak for the persona that died (issues #639, #638).
- [74](docs/contributing/invariants/harnesses.md#inv-74) Tool watchdog (issue #552): tool execution is a parser-owned lifecycle, not an idle activity hint.
- [79](docs/contributing/invariants/harnesses.md#inv-79) A bring-your-own-endpoint provider is a `models.json` ENTRY phantombot owns — never a vendor entry, never a guess (issue #694).
- [80](docs/contributing/invariants/harnesses.md#inv-80) PhantomOps asks for a token and a test — never a model selector (issue #696).

### Memory — [memory.md](docs/contributing/invariants/memory.md)

- [21](docs/contributing/invariants/memory.md#inv-21) Drawer entries are rows now, and only THREE of the five drawers decay (issue #410).
- [22](docs/contributing/invariants/memory.md#inv-22) Which daily journals reach the prompt is decided in CODE and must stay there (issue #410).
- [23](docs/contributing/invariants/memory.md#inv-23) The five drawers are ROWS, not files — and the database that holds them has restore points (issue #417).
- [30](docs/contributing/invariants/memory.md#inv-30) Drawer `--import` marker validation is structural, not best-effort (issue #437).
- [34](docs/contributing/invariants/memory.md#inv-34) The daily journal is ROWS; the markdown is a DERIVED artefact the nightly writes (issue #461).
- [68](docs/contributing/invariants/memory.md#inv-68) The memory wizard PICKS the embedding model from the endpoint's own catalogue; the typed prompt is the fallback, not the default.
- [71](docs/contributing/invariants/memory.md#inv-71) Embedding providers are interchangeable transports, not interchangeable vector spaces.
- [73](docs/contributing/invariants/memory.md#inv-73) The nightly renders the just-closed day BEFORE it builds the sweep queue (issue #633).

### Scheduler and concurrency — [scheduler-and-concurrency.md](docs/contributing/invariants/scheduler-and-concurrency.md)

- [19](docs/contributing/invariants/scheduler-and-concurrency.md#inv-19) A turn is registered for its lifetime, and `tick` defers a wake while the principal is talking (issue #391).
- [20](docs/contributing/invariants/scheduler-and-concurrency.md#inv-20) A background turn reports what it did, and a shared checkout can be claimed (issue #405).
- [70](docs/contributing/invariants/scheduler-and-concurrency.md#inv-70) A wake's budget is config, and three things are derived from it — never re-hard-code one of them (issue #668).

### Services and platforms — [services-and-platforms.md](docs/contributing/invariants/services-and-platforms.md)

- [17](docs/contributing/invariants/services-and-platforms.md#inv-17) macOS code-signing must shell out to `/usr/bin/openssl` (LibreSSL), never a PATH-resolved `openssl`.
- [25](docs/contributing/invariants/services-and-platforms.md#inv-25) Exit 143 from a self-restart is our own cgroup teardown, not a failed restart (issue #408).
- [37](docs/contributing/invariants/services-and-platforms.md#inv-37) macOS maintenance is one LaunchAgent PER SERVED PERSONA, and launchd state may never be updated ahead of a CONFIRMED unload (issue #491).
- [41](docs/contributing/invariants/services-and-platforms.md#inv-41) Host maintenance must be healable from a path that does not depend on the thing being healed (issue #510).
- [51](docs/contributing/invariants/services-and-platforms.md#inv-51) Registering a service is not starting one — "installed" must mean the same thing on all three platforms.
- [67](docs/contributing/invariants/services-and-platforms.md#inv-67) On Windows PATH is spelled `Path`, and a persona gets the full interactive-login PATH (issue #647).

### Release and install — [release-and-install.md](docs/contributing/invariants/release-and-install.md)

- [1](docs/contributing/invariants/release-and-install.md#inv-1) `bun-linux-x64` instead of baseline
- [2](docs/contributing/invariants/release-and-install.md#inv-2) `echo … > src/version.ts` in CI
- [3](docs/contributing/invariants/release-and-install.md#inv-3) `sudo cp` to install someone's binary
- [4](docs/contributing/invariants/release-and-install.md#inv-4) `copyFile` over an existing foreign-owned file
- [8](docs/contributing/invariants/release-and-install.md#inv-8) `install.sh` piped to `sh` runs without a TTY
- [12](docs/contributing/invariants/release-and-install.md#inv-12) `GITHUB_TOKEN` for `phantombot update` isn't always safe to send.
- [50](docs/contributing/invariants/release-and-install.md#inv-50) A progress tick must be earned. If a checklist step cannot fail, it is not a step — delete it or make it real.
- [53](docs/contributing/invariants/release-and-install.md#inv-53) `install.ps1` must parse and run under Windows PowerShell 5.1 — that is the floor a fresh Windows box ships, and no Linux check can see it.

### CLI, TUI and wizards — [cli-tui-and-wizards.md](docs/contributing/invariants/cli-tui-and-wizards.md)

- [5](docs/contributing/invariants/cli-tui-and-wizards.md#inv-5) @clack/prompts confirm in non-TTY context
- [6](docs/contributing/invariants/cli-tui-and-wizards.md#inv-6) Forgetting `tests/cli.test.ts` subcommand list
- [35](docs/contributing/invariants/cli-tui-and-wizards.md#inv-35) The TUI is TTY-GATED and strictly additive — the CLI does not change (issue #471).
- [36](docs/contributing/invariants/cli-tui-and-wizards.md#inv-36) The chat screen dispatches slash commands AHEAD of the harness, and renders replies as markdown (issues #480, #481).
- [43](docs/contributing/invariants/cli-tui-and-wizards.md#inv-43) System observability is platform-neutral and failure-tolerant (issue #478).
- [47](docs/contributing/invariants/cli-tui-and-wizards.md#inv-47) A long-lived chat session resolves its harness chain ONCE at open, so any write that can change that chain must REBUILD IT IN PLACE.
- [49](docs/contributing/invariants/cli-tui-and-wizards.md#inv-49) Model pickers are filled from the PROVIDER'S OWN `/models` endpoint, never from a catalogue baked into the binary.
- [52](docs/contributing/invariants/cli-tui-and-wizards.md#inv-52) A wizard that WRITES AS IT GOES must be able to roll back, and its notices must match what is actually on disk.
- [54](docs/contributing/invariants/cli-tui-and-wizards.md#inv-54) Every ask/choose/search overlay request mounts a FRESH screen — keyed per request, never reused.
- [58](docs/contributing/invariants/cli-tui-and-wizards.md#inv-58) OpenAI voice-list probing is a compatibility helper, not the provider contract.
- [62](docs/contributing/invariants/cli-tui-and-wizards.md#inv-62) A seeded prompt is trusted ONLY because a human is watching it run, so a launch with no terminal is refused, never rerouted.
- [65](docs/contributing/invariants/cli-tui-and-wizards.md#inv-65) OpenAI-compatible audio is one endpoint-scoped full loop, not an OpenAI-only TTS special case (issues #618, #622).
- [75](docs/contributing/invariants/cli-tui-and-wizards.md#inv-75) The TUI creation wizard is transactional from the user's perspective.
- [76](docs/contributing/invariants/cli-tui-and-wizards.md#inv-76) Settings snapshots must preserve config-layer provenance.
- [77](docs/contributing/invariants/cli-tui-and-wizards.md#inv-77) ↑↓ in the chat prompt walk the rows AS DRAWN, and only the edge rows scroll (issue #667).
- [78](docs/contributing/invariants/cli-tui-and-wizards.md#inv-78) The chat prompt's Emacs keys are matched on what Ink reports, never on the characters macOS types for Option (issue #677).
- [81](docs/contributing/invariants/cli-tui-and-wizards.md#inv-81) A chat-screen row is a one-row BOX — the layout cannot wrap it, and the width it is laid out at has one source.
- [84](docs/contributing/invariants/cli-tui-and-wizards.md#inv-84) The root `--help` is GROUPED and BOUNDED — every top-level command sits in exactly one group, and its description fits one short line.
- [85](docs/contributing/invariants/cli-tui-and-wizards.md#inv-85) A dropped image is a PATH the terminal typed — the chat box copies it to the inbox at drop time and attaches it the way every other channel does (issue #729).

### Testing — [testing.md](docs/contributing/invariants/testing.md)

- [60](docs/contributing/invariants/testing.md#inv-60) The test suite never runs with the developer's real HOME.
- [72](docs/contributing/invariants/testing.md#inv-72) Test runs never touch a live install's stores, and orphaned tasks are terminal, not retried forever (issue #632).

## Process for updating this file

If your PR does any of the things in the "contributing discipline" list above, **before opening the PR**:

1. Re-read the area file for what you touched. Does it still describe what the code does?
2. If not, edit the rule where it lives (the area file); keep its number and title in sync with the index above. The PR description should mention which invariants file changed alongside `README.md` and the code.
3. If your change introduces a new pitfall (something a future contributor would trip on), append a new invariant to the area file with the next free number (one more than the highest in the index), add its `<a id="inv-N">` anchor, and add one line for it to the index above. If it changes one of the "Rules that apply to every change", update that pointer too. Never renumber or reuse a number — code comments and tests cite them.

This file is an index on purpose, and it is loaded into every agent session — keep it short. A rule's body lives in its area file and nowhere else; the index line is its title, not a summary.
