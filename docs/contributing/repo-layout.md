# Repo layout

The annotated tree of the phantombot checkout, moved out of [`/AGENTS.md`](../../AGENTS.md) so a session only pays for it when it needs it. Keep the one-line comments current when you move or add a module.

```
phantombot/
├── README.md                 # user-facing docs
├── AGENTS.md                 # contributor guide + invariants index (read first)
├── docs/
│   ├── concepts/architecture.md
│   ├── reference/memory-drawers.md # drawer rows: weight, supersession, decay
│   ├── reference/engine.md   # the embeddable engine: API, trust, root, errors
│   ├── contributing/adding-a-harness.md
│   ├── contributing/repo-layout.md # ← this file
│   └── contributing/invariants/ # the numbered contributor rules, one file per area
├── .github/workflows/release.yml   # auto-release per merged PR
├── package.json
├── bunfig.toml
├── tsconfig.json
├── src/
│   ├── index.ts              # entry point: `__pi` → embedded pi engine; otherwise the Citty dispatcher
│   ├── version.ts            # CI sed-replaces "0.1.0-dev" with "1.0.<PR_NUMBER>"
│   ├── config.ts             # XDG paths + TOML loader (env vars > config > defaults)
│   ├── state.ts              # phantombot-managed state (default persona)
│   ├── persona/
│   │   ├── loader.ts         # accepts BOOT.md / SOUL.md / IDENTITY.md, MEMORY.md, tools.md / AGENTS.md
│   │   └── builder.ts        # buildSystemPrompt + MEMORY_TOOLS_SECTION + CREDENTIALS_SECTION
│   ├── memory/
│   │   ├── store.ts          # bun:sqlite store: turns table + capture_log table
│   │   │                     #   (capture_log backs the 30-turn nudge + doctor)
│   │   ├── drawers.ts        # drawer_entries: ids, supersession, lifecycle, decay
│   │   ├── drawerIngest.ts   # one-way markdown drawer -> rows migration (read-only)
│   │   ├── drawerSync.ts     # heartbeat projection + ranked briefing render
│   │   ├── journal.ts        # journal_entries: one row per capture, tags as a column
│   │   ├── journalIngest.ts  # markdown day -> rows, and today's rendered mirror
│   │   ├── journalRender.ts  # renders a CLOSED day's rows to markdown, verifies, then prunes (#461)
│   │   ├── drawerExport.ts drawerImport.ts  # rows ↔ markdown (--export / --import) with structural id-marker validation
│   │   ├── drawerRetire.ts   # archives the five markdown drawers once the rows are proven the source of truth (#417)
│   │   └── dbBackup.ts       # restore points for memory.sqlite (#417)
│   ├── importer/
│   │   └── openclaw.ts       # OpenClaw → phantombot persona import
│   ├── orchestrator/
│   │   ├── turn.ts           # one-turn coordinator (persona → memory → screen → harness → persist)
│   │   ├── fallback.ts       # harness chain (primary → fallback) + resume-with-context retry
│   │   ├── resume.ts         # #459: chunk log + verify-first preamble for a turn wedged mid-flight
│   │   ├── screen.ts         # makeScreener: threat-screen wiring for UNTRUSTED turns (see invariants/security-perimeter.md)
│   │   ├── retrieval.ts      # makeRetriever: hybrid (Gemini) or OKF BM25F + link-graph recall of prior turns/memory for the prompt
│   │   ├── recovery.ts       # generateRecoveryReply: graceful user-facing message on harness failure
│   │   ├── turnIndexer.ts    # makeTurnIndexer: embeds persisted turns for later retrieval
│   │   ├── promptCache.ts    # opt-in prompt-cache epochs + hostedPromptCacheKey (invariants 39, 42)
│   │   ├── softDeadline.ts   # fits the soft deadline (#639) under a chain-wide wake budget (#668)
│   │   └── durableFacts.ts   # standing facts extracted when a turn ages out of the verbatim window, re-injected into later prompts of the same conversation
│   ├── channels/             # channel-agnostic core + per-channel adapters (see invariants/channels.md)
│   │   ├── core/
│   │   │   ├── types.ts      # Channel / ChannelTransport / ChannelMessage + capabilities + encrypt/decrypt seam
│   │   │   ├── engine.ts     # the streaming turn engine + server loop (channel-blind)
│   │   │   ├── routing.ts    # group-reply decision logic (pure)
│   │   │   ├── prompts.ts    # channel-layer prompt suffixes (VOICE_REPLY_INSTRUCTION, capture nudge, …)
│   │   │   └── streaming.ts  # shared by both chat channels: the narration controller, segmenter options, final-reply reconciliation
│   │   ├── telegram/
│   │   │   ├── transport.ts  # HttpTelegramTransport (HTTP client; Number(conversationId) at the API boundary)
│   │   │   ├── parse.ts      # update parsing → ChannelMessage (String(chat.id) on ingest)
│   │   │   └── channel.ts    # Telegram adapter: capabilities + identity encrypt/decrypt (no crypto)
│   │   ├── phantomchat/      # PhantomChat adapter: Nostr relay pool + NIP-17 gift-wraps, end-to-end encrypted in the adapter (channel.ts unwraps and verifies inbound, transport.ts wraps outbound), relay health quarantine (relayHealth.ts); server.ts mirrors the core engine's streaming loop
│   │   ├── statusProbes.ts   # fresh-on-every-call /status subsystem probes (Telegram getMe, editor connectors, memory, voice)
│   │   ├── telegram.ts       # backward-compat barrel re-export (preserves the old public surface)
│   │   ├── telegramFormat.ts # markdown → Telegram HTML
│   │   ├── streamSegmenter.ts # splits a streaming reply into Telegram-sized segments (fence/table/list-aware)
│   │   └── commands.ts       # slash-command handling (/stop, /update, /coder, /chattiness, …)
│   ├── connectors/
│   │   └── acp/              # ACP (Agent Client Protocol) agent for Zed / VS Code / JetBrains: JSON-RPC 2.0 over stdio
│   │       ├── server.ts     # stdio dispatcher — stdout IS the protocol channel, diagnostics go to stderr
│   │       ├── session.ts    # session registry: a WORKSPACE key (per cwd) and a THREAD key (per editor thread)
│   │       ├── commands.ts   # slash commands over ACP, dispatched out of band ahead of the request queue
│   │       ├── turnBridge.ts # the trusted runTurn driver: HarnessChunk stream → session/update notifications
│   │       └── autoInstall.ts installZed.ts installVscode.ts installJetbrains.ts  # idempotent editor registration
│   ├── mcp/                  # the MCP surface, one registry behind both faces (the `phantombot mcp` CLI and the loopback proxy)
│   │   ├── registry.ts       # per-persona mcp.json, written by the agent via `phantombot mcp add`
│   │   ├── client.ts         # the one place that talks to servers: official SDK transports + the three auth methods from the vault
│   │   ├── hub.ts            # shared upstream connections + token store, opened lazily
│   │   ├── proxy.ts          # loopback aggregated MCP server for MCP-native harnesses — lazy discovery meta-tools, never a flat dump
│   │   └── harnessConfig.ts  # the --mcp-config payload: phantombot's own registered servers and ONLY those
│   ├── p2p/                  # WebRTC transport node (#258, #61): node.ts routes gift-wrap frames, signaling.ts carries the handshake over Nostr, channelBridge.ts feeds frames into the phantomchat channel
│   ├── cli/                  # one file per Citty subcommand
│   │   ├── index.ts          # dispatcher; subcommand registration list lives here
│   │   ├── run.ts            # the long-running listener
│   │   ├── ask.ts            # phantombot ask (programmatic single turn — an UNTRUSTED entry point; screened)
│   │   ├── init.ts           # phantombot init (first-run setup)
│   │   ├── install.ts uninstall.ts
│   │   ├── update.ts         # phantombot update (consumes the GH releases feed)
│   │   ├── env.ts            # phantombot env (DEPRECATED alias → phantombot vault)
│   │   ├── notify.ts         # phantombot notify — broadcasts text/voice to all authorized recipients on every channel
│   │   ├── task.ts           # phantombot task (CRUD over scheduled tasks)
│   │   ├── tick.ts           # phantombot tick (called by phantombot-tick.timer every minute)
│   │   ├── voice.ts          # phantombot voice (TUI: TTS/STT provider config)
│   │   ├── decision-model.ts # phantombot decision-model (TUI: optional decision model — TypeSafe Jev today — for the threat judge / brain-swap router)
│   │   ├── jev.ts            # phantombot jev (DEPRECATED alias → phantombot decision-model) + the shared write path (applyDecisionModelConfig)
│   │   ├── workspace.ts      # phantombot workspace lock/unlock/status — advisory claims on shared checkouts
│   │   ├── telegram.ts       # phantombot telegram (TUI: token + allowed users)
│   │   ├── harness.ts        # phantombot harness (TUI: chain) + maybePromptRestart helper
│   │   ├── memory.ts         # phantombot memory (search/get/today/index/list/capture)
│   │   ├── heartbeat.ts nightly.ts  # nightly is 5 checkpointed stages (--resume)
│   │   ├── doctor.ts         # phantombot doctor (memory health check + nightly auto-repair)
│   │   ├── embedding.ts      # phantombot embedding (TUI: Gemini/OpenAI-compatible/none)
│   │   ├── persona.ts        # phantombot persona (consolidates create / import / restore / switch)
│   │   └── create-persona.ts import-persona.ts  # implementation files; no top-level subcommand
│   ├── harnesses/
│   │   ├── types.ts          # HarnessRequest / HarnessChunk discriminated union
│   │   ├── buildChain.ts     # build Harness[] from config — single source of truth (was duplicated in run.ts + tick.ts)
│   │   ├── claude.ts         # Bun.spawn `claude --print --output-format stream-json …` (OAuth-only; ANTHROPIC_API_KEY filtered)
│   │   ├── pi.ts             # pi engine harness: mode native (`<phantombot> __pi --print --mode json …`, phantombot routing) or host (`pi …`, host config)
│   │   └── codex.ts          # Bun.spawn `codex …` (OpenAI Codex CLI harness)
│   ├── engine/               # embeddable TypeScript API (`phantombot/engine`): createEngine, Persona, EngineEvent, EngineError — see docs/reference/engine.md
│   │                         #   public declarations are GENERATED into /types/engine/ (committed; `bun run build:engine-types`)
│   ├── tui/                  # the full-screen terminal app (Ink). Optional; the CLI never depends on it
│   │   ├── index.tsx         # startTui(launch) + the --no-tui line REPL; seedForOpening() decides what --prompt does
│   │   ├── standalone.tsx    # runs one wizard flow full-screen for a CLI subcommand, then hands the terminal back
│   │   ├── App.tsx           # screen router; chat is home, ^s = this phantom's settings, ^p = the host table
│   │   ├── chatSession.ts    # screen 0's turn pipeline (trusted; see the note in the file). ChatMessage carries an ordered `parts` timeline (narration text runs + tool calls in arrival order) next to the legacy `text`/`tools` pair — the transcript renders from `parts` when present, so narration and tools keep chronological order and stay paragraph-separated
│   │   ├── turnRunner.ts     # the turn lifecycle, owned by the session rather than a screen (#604)
│   │   ├── stdinTap.ts stdinHandover.ts prompts.ts  # the tapped stdin Ink reads, lending the real stdin to a borrower, and the host bracket around it
│   │   ├── terminal.ts       # alternate screen, window size, the gated stdout and forceRepaint
│   │   ├── transcript.ts markdown.ts scroll.ts  # the conversation, markdown and tall screens as ROWS clipped to the window
│   │   ├── textInput.ts      # one keystroke chunk applied to a text field (a newline inside a chunk submits the text before it, never lands in the value)
│   │   ├── logBuffer.ts logSources.ts  # the log pane: a bounded ring of captured lines + every host log stream (#478)
│   │   ├── brainFlow.ts channelsFlow.ts memoryFlow.ts voiceFlow.ts decisionModelFlow.ts  # settings rows as SCREEN questions; the writes stay the CLI's
│   │   ├── mcpFlow.ts        # the MCP row: lists from the registry file only (no network), probes one server per row under its own deadline; same registry readers/writers as `phantombot mcp`
│   │   ├── components/       # Frame, Selectable, Menu, Spinner, personaQuestions — no component knows the terminal width
│   │   ├── screens/          # Chat, Wizard, Dashboard, PersonaDetail / NewPersona / CreatePersona, Keys, Doctor, Mcp, System, Reembed, BrainTest, FileEditor, and the question screens Ask / Choose / MultiChoose / SearchList / Confirm
│   │   ├── slash.ts          # what the chat screen ADVERTISES as slash commands — derived from TELEGRAM_BOT_COMMANDS, never retyped
│   │   └── snapshot.ts actions.ts  # read-only state snapshot + writes AND their consequences
│   ├── dev/tui-sandbox.ts    # boots the real TUI against an isolated root under <repo>/.sandbox/ — never a live persona
│   └── lib/
│       ├── engineScope.ts    # AsyncLocalStorage scope an embedding app runs under: XDG roots + log sink + acting persona; no-op outside it
│       ├── launchCwd.ts      # launchWorkingDir(): the cwd an INTERACTIVE turn runs in (TUI/REPL only; ask + channels stay on $HOME)
│       ├── scratch.ts        # per-conversation scratch workspace under the persona dir, handed to harnesses as PHANTOMBOT_SCRATCH (#661)
│       ├── logger.ts logSink.ts io.ts configWriter.ts envFile.ts format.ts
│       ├── tuiGate.ts        # bare-invocation classifier: tui / repl / usage (TTY-based, never argv-based)
│       ├── personaComplete.ts # the ONE "is this phantom finished?" predicate, shared with doctor
│       ├── personaConfig.ts  # per-persona config.toml layered over the host's global file (invariant 27)
│       ├── coderSwap.ts chattiness.ts  # per-conversation overrides: coding-brain swap + progress-bubble on/off (JSON state under xdgStateHome)
│       ├── threatJudge.ts    # tool-less untrusted-input judge (see invariants/security-perimeter.md)
│       ├── promptSafeText.ts # renders attacker-influenced strings (workspace-lock notice, background digests, the daily journal, the scratch listing) into a prompt
│       ├── decisionModel.ts decisionModelJudge.ts decisionModelRouter.ts decisionModelHealth.ts  # optional TypeSafe Jev decisions backend: client, threat judge, brain-swap router, fallback telemetry
│       ├── redact.ts         # secret redaction for log lines + task_runs audit table
│       ├── platform.ts       # cross-platform service-manager router (systemd ↔ launchd ↔ Task Scheduler)
│       ├── systemd.ts        # Linux unit generators + install/uninstall + ensureUnitCurrent
│       ├── launchd.ts        # macOS LaunchAgent (plist) generators + install/uninstall (mirrors systemd.ts)
│       ├── windowsJob.ts      # Windows Job Object process-tree ownership
│       ├── taskScheduler.ts  # Windows Task Scheduler backend (schtasks), mirrors systemd.ts / launchd.ts
│       ├── windowsPath.ts    # Windows `Path` handling for harness children (#647)
│       ├── logRotate.ts      # size-capped rotation of the launchd / Task Scheduler log files (#428)
│       ├── macSigning.ts     # stable self-signed identity so TCC grants survive self-update (shells out to /usr/bin/openssl)
│       ├── envBootstrap.ts   # withPersonaEnv() per-spawn context (no .env sourcing since #452)
│       ├── vault.ts vaultMigrate.ts vaultSecrets.ts vaultEnvTracking.ts  # per-persona encrypted secrets: the store, the one-way .env import, wizard writes, provenance of injected keys
│       ├── harnessRunner.ts  # shared spawn/kill/idle-timeout/abort coordination for all harnesses
│       ├── harnessAvailability.ts cooldown.ts  # binary-on-PATH detection + per-harness fast-fallback cooldown
│       ├── harnessArgvFiles.ts # spills oversized argv payloads to files (per-string MAX_ARG_STRLEN on Linux, the whole command line on Windows)
│       ├── harnessAlert.ts harnessFailureLog.ts  # owner alerts for a silently degraded primary + bounded on-disk stderr diagnostics (#638)
│       ├── harnessProbe.ts harnessBinPath.ts harnessWriteTarget.ts  # wizard smoke test through the real adapter; platform check of a persisted bin; where harness settings are written
│       ├── embeddedPi.ts     # the pi engine compiled into the binary: `__pi` entry, PI_PACKAGE_DIR assets, native-only attribution
│       ├── nativeAgentDir.ts # the embedded engine's own agent dir — never the user's ~/.pi
│       ├── embeddedPhoton.ts # photon's WASM embedded in the binary; redirects pi's image-resize wasm read to it
│       ├── harnessReconcile.ts # legacy `pi` → native / pi-host: the ONE decision (read time + doctor)
│       ├── harnessConfigRepair.ts # doctor's writer for that decision (backup, atomic write, idempotent)
│       ├── tasks.ts          # task store (bun:sqlite tasks table) + CRUD
│       ├── cronSchedule.ts scheduleParser.ts   # cron-parser wrapper + duration→cron + review-interval defaults
│       ├── timerHealth.ts    # timer fire-markers (heartbeat/tick) so doctor can flag silent timers
│       ├── maintenanceHeal.ts # service-unit self-heal, reachable from run + tick, not just the heartbeat (#510)
│       ├── processGroup.ts fetchTimeout.ts      # process-group helpers + fetch with timeout
│       ├── embeddingModels.ts   # embedding-model discovery for the memory wizard picker: modality tag, then name filter, then typed prompt
│       ├── binaryUpdate.ts   # phantombot update: download + sha256 + atomic swap
│       ├── githubReleases.ts updateNotify.ts    # latest-release discovery + post-update notify
│       ├── audio.ts          # TTS/STT dispatch (ElevenLabs/OpenAI-compatible)
│       ├── voice.ts telegramApi.ts personaScaffold.ts personaTemplate.ts personaArchive.ts personaDefault.ts
│       ├── memoryIndex.ts   # FTS5 store: OKF field-weighted BM25F + link-graph expansion (no-provider path), hybrid RRF when embeddings present
│       ├── okf.ts           # Open Knowledge Format parser: frontmatter/body/headings/links (powers BM25F columns + concept graph)
│       ├── heartbeat.ts nightly.ts embedJob.ts geminiEmbed.ts
│       ├── nightlyCompact.ts nightlyMaintenance.ts nightlyTrigger.ts  # nightly stage three (prompt-file budgets), row housekeeping, event-driven triggers (no 02:00 timer)
│       ├── embedder.ts embeddingSpace.ts  # embedding-provider resolution (none / Gemini / OpenAI-compatible) + the per-row vector-space fingerprint
│       ├── dailyRecall.ts    # which daily journals reach the prompt — decided in code (invariant 22)
│       ├── turnRegistry.ts   # cross-process registry of in-flight turns; backs tick's wake deferral + the sibling notice
│       ├── turnDigest.ts     # what a BACKGROUND turn did, surfaced into the next interactive turn's prompt
│       ├── workspaceLock.ts  # advisory claims on shared working copies (git checkouts) held by a turn
│       ├── processLiveness.ts # "is that pid still the SAME process?" — pid+start-token probe used by the registry
│       └── runLock.ts        # single-instance lock (prevents two `phantombot run` on one box)
├── agents/
│   └── phantom/              # placeholder persona used by tests
└── tests/                    # bun test, ~5700 tests across ~340 files
```
