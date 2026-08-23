# Architecture

## Goal

Run a chat agent ("Phantom") as a **CLI tool** on the operator's own machine. All model + tool work delegates to a CLI harness (Claude Code primary, [Pi](https://pi.dev) fallback). Phantombot's job is identity + memory + harness fallback.

## What phantombot does

1. **Hosts persona files.** Reads `BOOT.md` / `SOUL.md` / `IDENTITY.md`, optional `MEMORY.md`, optional `tools.md` / `AGENTS.md` from `$XDG_DATA_HOME/phantombot/personas/<name>/`.
2. **Receives one user message** via `phantombot ask "msg"` or via the REPL line loop in `phantombot chat`.
3. **Builds a turn context** for the configured agent: persona + recent memory + retrieved knowledge + the new user message. Retrieval runs over an [Open Knowledge Format](https://cloud.google.com/blog/products/data-analytics/how-the-open-knowledge-format-can-improve-data-sharing/) store: **OKF field-weighted BM25 with link-graph expansion** by default, upgrading to **hybrid BM25 + Gemini-embedding vector search** (reciprocal-rank fusion) when an embeddings provider is configured.
4. **Hands the turn to a harness.** Spawns `claude --print --output-format stream-json` (or `pi --print --mode json`) as a subprocess. Persona goes via `--system-prompt`. The user-side payload (history + new message) goes via stdin (claude) or argv (pi). Anything that would outgrow Linux's 131,071-byte per-argv-string limit is spilled to a temp file under `<personaDir>/tmp` and passed by path (`lib/harnessArgvFiles.ts`); if that write fails the payload goes inline anyway with a warning, since a broken tmp must not cost a turn.
5. **Streams the harness's stdout** back to the user. Text chunks land on stdout as they arrive; the trailing newline marks end-of-reply.
6. **Falls back** to the next harness in the chain on recoverable error (rate limit, transient network, oversize payload pre-skip).
7. **Persists the turn** (user message + assistant reply) to SQLite for future memory retrieval. **On success only** — failed turns leave no trace, so the user can retry without orphan half-turns in history.

## What phantombot does NOT do

- Translate `tools[]` arrays into anything. Each harness brings its own tools.
- Enforce permission gates on tool calls. The harness handles that — Claude is run with `--permission-mode bypassPermissions`.
- *(Updated since v1.)* Retrieval is now implemented: SQLite FTS5 provides OKF field-weighted BM25 + link-graph expansion as the always-on baseline, with optional Gemini embeddings adding a hybrid vector leg. There is no RAG framework dependency — it's plain FTS5 + a local vector table.
- Run a web UI, dashboard, status page, or admin panel.
- Listen on chat channels (Telegram / Signal / Google Chat). The original skeleton was built for that; the current shape is CLI only. Channels can be added later without rearchitecting.
- Hold API keys. OAuth-on-host: claude / pi are configured separately on the operator's machine and read their own credentials at spawn time.

## Module map

| Module | Responsibility | Talks to |
|---|---|---|
| `src/index.ts` | Entry point. Calls `runMain(mainCommand)`. | `cli/` |
| `src/cli/index.ts` | Citty dispatcher. Wires every subcommand. | `cli/*.ts` |
| `src/cli/{ask,chat,import-persona,list-personas,set-default-persona,history,config,doctor}.ts` | One subcommand each. Each exports a `run*` function for testing. | `orchestrator`, `importer`, `state`, `repl` |
| `src/config.ts` | TOML + XDG + env-var loader. Single source of truth for paths and harness chain. Layers `<persona>/config.toml` over the host file per key (`loadConfig(persona)`). | filesystem, env, `state.ts`, `lib/personaConfig.ts` |
| `src/lib/personaConfig.ts` | Per-persona config layering: the per-key merge, the host-only key list, and the copy-only, idempotent migration that seeds `<persona>/config.toml` from the global file. | filesystem, `lib/configWriter.ts` |
| `src/state.ts` | Phantombot-managed runtime state (currently just `default_persona`). Lives at `$XDG_DATA_HOME/phantombot/state.json`. | filesystem |
| `src/persona/loader.ts` | Reads BOOT.md / SOUL.md / IDENTITY.md (required) + MEMORY.md / tools.md / AGENTS.md (optional). | filesystem |
| `src/persona/builder.ts` | Concatenates persona pieces + (deferred) retrieved memory + invocation context into a system prompt string. | `loader.ts` |
| `src/memory/store.ts` | bun:sqlite wrapper. `turns` table (`appendTurn`, `recentTurns`, …) + `capture_log` table (`appendCapture`, `lastCaptureAt`, `countCapturesSince`, turn counters for the nudge/doctor). | `bun:sqlite` |
| `src/lib/nightly.ts` | Stage model + prompt bodies, the `.nightly-state.json` ledger (`sweepDailyFiles`, `dateRecord`), and `nightlyHealth` for `/status` + doctor. | filesystem |
| `src/lib/nightlyCompact.ts` | Compaction budgets, candidate selection, the pre-pass archive under `memory/archive/<date>/`, and the shrink-guard verdict that reverts an over-eager pass. | filesystem, `lib/nightly` |
| `src/lib/nightlyTrigger.ts` | When the sweep runs: `dayRolledOver` (heartbeat trigger) + `spawnNightlySweep` (transient systemd unit on Linux, detached child elsewhere; also used by `run` at startup). | `node:child_process` |
| `src/lib/indexRefresh.ts` | `refreshPersonaIndex`: incremental FTS + embedding refresh, called in code by the nightly after both stages join. | `lib/memoryIndex`, `lib/embedJob` |
| `src/cli/doctor.ts` | `phantombot doctor`: reports the nightly ledger (read-only) + `capture_log`, repairs units/timers/connectors. | `memory/store`, `lib/nightly` |
| `src/importer/openclaw.ts` | Walks an OpenClaw agent dir; copies recognized markdown into the personas dir. | filesystem |
| `src/orchestrator/turn.ts` | `runTurn`: persona → memory → harness chain → persist. The one function every entry point calls. | `loader`, `builder`, `memory`, `fallback` |
| `src/orchestrator/fallback.ts` | `runWithFallback`: tries each harness in order, advances on recoverable error, terminates on success or terminal error. Pre-spawn skip when `maxPayloadBytes` is too small. | `harnesses/*` |
| `src/repl/index.ts` | `runChat` (node:readline loop) + `handleSlash` (command dispatch). | `orchestrator/turn`, `memory` |
| `src/harnesses/types.ts` | `Harness`, `HarnessRequest`, `HarnessChunk` (discriminated union). | — |
| `src/harnesses/claude.ts` | `Bun.spawn claude --print --output-format stream-json …`. Stdin payload, ANTHROPIC_API_KEY filtered out. | `claude` CLI |
| `src/harnesses/pi.ts` | `Bun.spawn pi --print --mode json …`. Argv payload (Pi ignores stdin). Declares `maxPayloadBytes`. | `pi` CLI |
| `src/lib/logger.ts` | Structured logs to stdout. | stdout |
| `src/lib/io.ts` | Shared `WriteSink` interface. | — |
| `src/lib/platform.ts` | Cross-platform service-manager router. Picks the backend (systemd/launchd/Windows Task Scheduler) and exposes one `ServiceControl` (`isActive`/`start`/`stop`/`restart`/`rerenderUnitIfStale`), plus hint strings and `logsSpec()` for tailing. | `systemd.ts`, `launchd.ts`, `taskScheduler.ts` |
| `src/lib/{systemd,launchd,taskScheduler}.ts` | Per-OS backends. Windows Task Scheduler owns the per-user logon daemon and periodic jobs; install/self-heal preserves healthy task definitions and repairs only missing/stale entries. | `systemctl`/`launchctl`/`schtasks` |
| `src/lib/serviceLifecycle.ts` | `runLifecycleAction` — the shared driver behind `phantombot start/stop/restart`. OS-agnostic: only ever calls `ServiceControl`, never a supervisor directly. | `platform.ts` |
| `src/cli/{start,stop,restart,logs}.ts` | Thin CLI wrappers over `serviceLifecycle`/`logsSpec` for the service-lifecycle verbs. | `lib/serviceLifecycle`, `lib/platform` |
| `src/p2p/` | Relay-free P2P transport (issue #258). The node is a dumb, encrypted-wrap relay: it forwards opaque gift-wraps node-to-node and never decrypts them. On by default; each persona binds its own OS-ephemeral loopback port (`config.p2p`). | `werift`, `nostrCrypto`, `RelayPool`, Bun ws |
| `src/p2p/frame.ts` | Wire-frame contract with the PWA: parse/build `["EVENT", <gift-wrap>]` relay frames, read the recipient off the wrap p-tag. Pure. | — |
| `src/p2p/signaling.ts` | WebRTC handshake (SDP/ICE) over Nostr — NIP-44-encrypted on a dedicated ephemeral kind (21050), separate from the chat 1059 plane. Rides the `RelayPool` seam. | `nostrCrypto`, `RelayPool` |
| `src/p2p/peerConnection.ts` | One werift `RTCPeerConnection` + data channel per peer. Readiness is gated on the **data channel** `open` event, not transport `connected` (the channel opens later; flushing early drops the first frame). | `werift` |
| `src/p2p/localBridge.ts` | `ws://localhost:<ephemeral>` server (Bun native, loopback-only) for the same-machine PWA; `boundPort` reads back the OS-assigned port. Frames in → route; peer frames → broadcast to PWA. | Bun ws |
| `src/p2p/node.ts` | Orchestrator. Routes frames by recipient pubkey, dials peers on demand, deterministic initiator (smaller pubkey) + `hello` nudge to avoid offer glare, per-peer outbox buffered until the channel opens. All seams injected for testing. | `peerConnection`, `signaling`, `localBridge` |
| `src/p2p/capability.ts` | Capability advertisement (NIP-78 kind 30078): **plaintext** capability booleans + the actual bound loopback port. The port is a `127.0.0.1`-only ephemeral port (not a secret), so any same-machine PWA reads it and dials `ws://localhost`. | `RelayPool` |
| `src/p2p/index.ts` | Daemon glue: `buildP2PNode` (from a persona's identity/relays/pool) + `runP2PNode` (start, wait for abort, stop), pushed onto `run`'s task list. | all of `src/p2p/*` |
| `src/cli/p2p.ts` | `phantombot p2p status` — read-only view of the config + a loopback probe. | `config` |

## End-to-end flow

```
phantombot ask "what's on my calendar?"
  → ask.ts: load config, resolve persona, open memory, build that persona's harness chain
  → orchestrator.turn.runTurn({ noHistory: true, conversation: "cli:ask", ... })
       → loadPersona(agentDir) → { boot, memory, tools, identitySource, ... }
       → memory.recentTurns(persona, "cli:ask", 20) → [] (skipped: noHistory)
       → buildSystemPrompt(persona, channelCtx) → systemPrompt
       → orchestrator.fallback.runWithFallback([claude, pi], req)
            → estimatePayloadBytes(req) → bytes
            → if bytes > pi.maxPayloadBytes && pi is in chain → log "skipping pi"
            → claude.invoke(req)
                 → Bun.spawn(["claude", "--print", "--output-format", "stream-json", ...,
                              "--system-prompt", systemPrompt],
                              { stdin: "pipe", env: filtered (no ANTHROPIC_API_KEY) })
                 → write history + new message to proc.stdin, close it
                 → for await chunk of proc.stdout: parse stream-json,
                       yield {type:"text"|"progress"|"done"|"error"}
                 → on timeout: state="timed_out", kill SIGTERM, yield error/recoverable
                 → on exit 0: yield {type:"done", finalText, meta:{harnessId,model}}
                 → on exit !=0: yield error/recoverable: code !== 127
            → if recoverable error and chain has more: try pi.invoke(req)
       → on done chunk: skip persistence (noHistory). With --history, append both turns.
  → ask.ts: write the harness's final assistant text to stdout, ensure trailing "\n"
  → exit 0 / 1 / 2
```

### Progress narration in the chat channels

`progress` chunks (and the model text streamed *before* a tool call) become
interim "progress bubbles" — the running "checking your calendar…" commentary.
This is emitted by a per-channel streaming state machine, and that machine is
**duplicated**: `src/channels/core/engine.ts` (Telegram) and
`src/channels/phantomchat/server.ts` (PhantomChat) each carry their own
`flushNarration`. Whether those bubbles appear is gated **per conversation** by
`/chattiness` (`src/lib/chattiness.ts`): a per-conversation override wins, else
the `chattiness` config default decides. The gate lives in **both**
`flushNarration`s — the final reply and error paths are never gated. Scope is
Telegram + PhantomChat only; the editor (ACP) surface is deliberately left
untouched. Any change here touches both channel files (see the `TODO(dedup)`
breadcrumbs) — a future refactor should centralize the loop.

## Memory subsystem

Memory is two layers — see the README `## Memory` section for the operator-facing
picture. From an architecture standpoint:

- **SQLite (`memory.sqlite`)** is machine state. `turns` is a *rolling* per-conversation
  context buffer, deliberately pruned — it is not a transcript archive, and nothing
  should be designed assuming old turns survive. `capture_log` is append-only and
  exists purely as an observability trail.
- **Markdown (the persona dir)** holds the daily journals (`memory/<date>.md`),
  `kb/` atomic notes and `MEMORY.md`. The five structured drawers are NOT here:
  since #417 they are rows (see below).
- **The drawers are rows in `drawer_entries`** — content-derived
  ids (so dedupe is a UNIQUE constraint, not a prompt instruction), supersession,
  per-kind lifecycle, and decay for the three *belief* drawers only. See
  [`memory-drawers.md`](memory-drawers.md); the split that keeps `commitments` and
  `people` out of decay is load-bearing, not an omission. The heartbeat runs the
  ingest of any legacy markdown drawer still on disk (`memory/drawerSync.ts`),
  files today's tagged lines as rows, and then RETIRES the markdown once it has
  proved the content is filed and re-renderable (`memory/drawerRetire.ts`). The
  threat judge's briefing reads the ranked rows. Markdown is an artefact you can
  regenerate (`memory drawers --export`), not a second copy of the truth — which
  is why `memory.sqlite` now carries verified, rotating restore points
  (`memory/dbBackup.ts`) and `doctor` checks its integrity.

Three properties worth knowing when touching this code:

1. **Capture has a CLI** (`phantombot memory capture`). It is the *only* sanctioned
   write path into the daily journal, so every capture leaves a `capture_log` row.
   A CLI cannot *force* a harness to capture — it makes a missed capture observable
   instead of silent.
2. **The 30-turn nudge is mechanical.** `src/channels/telegram.ts` counts user turns
   since the last `capture_log` row; at every multiple of `CAPTURE_NUDGE_INTERVAL`
   (30) it stacks a fixed reminder onto the next system prompt. No LLM decides this.
3. **The nightly is a sweep, and the sweep is the idempotency mechanism.** Each
   run diffs the daily files against a ledger in `.nightly-state.json`
   (mtime + size, then content hash) and processes whatever is new, grew, or
   half-finished. It is triggered by startup and by the heartbeat detecting a
   calendar-day rollover — there is no nightly timer. On systemd the sweep is
   launched as its own transient `--user` unit rather than as a detached child:
   the rollover trigger runs inside `phantombot-heartbeat.service`, which is
   `Type=oneshot`, so its cgroup (and everything left in it) is torn down the
   moment the heartbeat exits. `detached`/`unref` leaves Node's event loop, not
   the cgroup. Per date it runs exactly
   two harness turns — `distill`
   (drawers + MEMORY.md) and `kb` — **concurrently**, because their write
   targets are disjoint; neither may write back to the daily file, or the hash
   would change and the date would reprocess forever. The index refresh that
   used to live in the KB prompt now runs in code after both stages join
   (`refreshPersonaIndex`), which both guarantees it and orders it after the
   writes. There is no `--resume` and no catch-up mode: a half-done date is just
   a date the ledger doesn't call done. `doctor` reports this state; it no longer
   repairs it, so the job has one owner. A third stage, `compact`, runs ONCE per
   sweep (its inputs are whole-file sizes, not one day's events) and is the only
   stage that removes anything: it archives every over-budget file verbatim
   first, then reverts any rewrite that overshoots its shrink allowance. Drawer
   dedupe is deliberately NOT part of it — that lifecycle moves to the database.

4. **Which daily files a turn sees is decided in CODE, not in prose.**
   `src/lib/dailyRecall.ts` runs on the prompt path for every turn
   (`orchestrator/turn.ts`, ahead of `buildSystemPrompt`): today's journal
   always, yesterday's **only** when the `.nightly-state.json` ledger has no
   `ok`-with-all-stages record for that date whose mtime+size still match the
   file (`isDailyDistilled` in `lib/nightly.ts` — one predicate, shared with
   the sweep and the compactor, so they cannot disagree about what "done"
   means). This used to be an instruction
   in a persona's `AGENTS.md`, which failed in both directions — an agent
   could forget it, and anything that can write the persona directory could
   rewrite it. There is deliberately no config switch (a persona that turns it
   off loses a day of memory the first time a sweep fails, and cannot notice)
   and deliberately no lookback past yesterday (two undistilled days is a
   nightly bug to fix, not a reason to grow every prompt). It is pure disk +
   JSON, never throws, and is skipped only for the nightly sweep's own turns
   (`skipDailyRecall`), which are handed the date they are distilling. Both
   files are byte-capped at `DAILY_RECALL_CEILING_BYTES` (32 KB each) and at
   `DAILY_RECALL_COMBINED_CEILING_BYTES` (48 KB together) — derived from
   Linux's 131,071-byte per-argv-string limit on the assembled system prompt,
   not from taste, and deliberately NOT the persona's daily compaction budget,
   which measures how large a closed day may stay on disk — keeping the tail
   and warning when they trim. Journal text is run through `inertBlock`
   first: leading `#` escaped, control/bidi/zero-width stripped, so a journal
   line cannot forge a section of the system prompt (invariant 20).

## Open design questions

1. **Streaming display in the REPL.** Text chunks are written to stdout as they arrive. Looks responsive, but if the harness reformats the final reply (claude sometimes does), the user sees draft text replaced by the canonical version when `done` arrives — currently we just persist the canonical version, which may differ from what was on screen. Acceptable trade-off for v1.

2. **History scope.** `phantombot ask` is stateless by default (conversation `cli:ask`, `noHistory: true`) — fitted to non-interactive callers like the Twilio voice-agent that don't want their tool-calls polluting the persona's rolling memory. Pass `--history --conversation <id>` to thread asks together. The Telegram channel uses distinct keys per chat (`telegram:<chat_id>`).

3. **Multi-line REPL input.** Currently line-by-line via node:readline. Long pasted content works (terminal sends it as one line); explicit multi-line mode (Esc-Enter) is not implemented. Add if it bites.

4. **Conversation history import from OpenClaw.** Skipped in v1 because OpenClaw's transcript format isn't formally documented. Add `phantombot import-history <path>` once we have the schema.

5. **More than two harnesses in the setup wizard.** The config and fallback
   runner accept longer chains, but `phantombot harness` currently asks for one
   primary and one fallback. Operators can set a longer global or per-persona
   chain directly in `config.toml`.

## Non-goals

- Multi-tenant. Phantombot is single-operator.
- Web UI / dashboard. Use the chat itself.
- High availability. One process per host. If it dies, you re-run it.
- Plugins. The codebase is small enough that "fork it and edit" is the supported customization story.
- Tool-call passthrough. The architectural premise is that the harness owns its tools. See the warning at the bottom of `src/harnesses/claude.ts`.
