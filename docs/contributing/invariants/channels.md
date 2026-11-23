# Channels — contributor invariants

Part of the phantombot contributor guide: the channel-agnostic core, the Telegram / PhantomChat / ACP adapters, streaming and reply modality. The index of every invariant is in [`/AGENTS.md`](../../../AGENTS.md). Numbers are stable identifiers — code comments and tests cite them — so a new rule takes the next free number and nothing is renumbered or reused (the one-time renumbering into 71–73 and 77 is recorded in AGENTS.md). Only the `### N.` headings below, each with its `inv-N` anchor, are numbered invariants; a numbered list in an intro section is prose, so never cite its item numbers. Each rule records a real incident; a deliberate, documented trade-off is not a defect.

## Channel layer (core + adapters)

As of #168 the channel layer is split into a **channel-agnostic core** and **thin per-channel adapters**, so a second transport (Matrix, Slack, …) is a small adapter rather than a fork of the engine.

- **`src/channels/core/`** is channel-blind. `engine.ts` holds the streaming turn engine + server loop (moved verbatim out of the old `telegram.ts`); `routing.ts` is the pure group-reply decision; `prompts.ts` holds the channel-layer prompt suffixes (`VOICE_REPLY_INSTRUCTION`, the capture nudge, the voice-unavailable message); `types.ts` defines the contract: `Channel` / `ChannelTransport` / `ChannelMessage`, a `ChannelCapabilities` object (`voice` / `typing` / `attachments` / `encryption`), and `encrypt`/`decrypt` hook signatures.
- **`src/channels/telegram/`** is the first adapter: `transport.ts` (HTTP client), `parse.ts` (update → `ChannelMessage`), `channel.ts` (capabilities + encrypt/decrypt).
- **`src/channels/telegram.ts`** is now a **backward-compat barrel** that re-exports the core + adapter symbols under their old names, so importers and the test suite kept their surface unchanged across the refactor.

Two invariants worth knowing before you touch this:

1. **IDs are channel-neutral strings.** The core speaks `conversationId: string` / `senderId: string`. Telegram's numeric ids are normalized at the adapter boundary only — `String(chat.id)` on ingest (`parse.ts`), and `Number(conversationId)` right before the Telegram API call (`transport.ts`). Don't reintroduce a numeric id into the core contract; Matrix/Slack ids aren't numbers. The numeric update-notify recipient ids (`updateNotify.ts`, `notify.ts`) and the slash-command logging id are separate, Telegram-specific, and converted at their own boundary.
2. **The encrypt/decrypt seam is placed but empty.** Telegram's `encrypt`/`decrypt` are identity pass-throughs (Telegram bots have no E2EE) with `encryption: false`. They return `T | Promise<T>` so async crypto (Matrix Megolm) can slot in later with no signature change. There is deliberately **zero crypto code and zero Matrix code** — the actual Matrix adapter + E2EE are parked for the community discussion in issue #154.

## Invariants

<a id="inv-10"></a>
### 10. Channel-specific behavior belongs in the channel layer, not in personas.

Brevity for voice replies, formatting for Slack, etc. should be appended to the system prompt at the channel boundary (see `VOICE_REPLY_INSTRUCTION` in `src/channels/core/prompts.ts`, passed via `runTurn`'s `systemPromptSuffix`). Putting "be brief on voice" in a persona's BOOT.md/SOUL.md throttles text replies too — and persists across all the persona's contexts where verbosity is fine. Channel-layer suffixes are scoped to the turn that needs them.

<a id="inv-11"></a>
### 11. Reply modality is mirror-input by default, with a per-message text override available.

`processChatMessage` in `src/channels/core/engine.ts` picks the wire format (sendMessage vs sendVoice) via `replyModalityOverride()` from `src/lib/audio.ts`: when the user's message (post-STT, so voice transcripts count) contains an explicit directive like *"reply in text"*, *"no voice"*, or *"send a voice note"*, that wins; otherwise modality mirrors input. The override is parsed by a small, deliberately conservative regex set — anchored on reply-verbs and unmistakable shorthand, no bare-noun matches ("text message to John" must not trigger). Voice is still capped by `ttsSupported(config)`: an override asking for voice when no TTS provider is configured degrades to text gracefully, same as the original no-TTS fallback. If you extend the regex set, add cases to `replyModalityOverride` in `tests/lib-audio.test.ts` AND to the three end-to-end scenarios in `tests/channels-telegram.test.ts` (voice-in→text, text-in→voice, text-in→voice-without-TTS).

<a id="inv-13"></a>
### 13. The narration/streaming loop is DUPLICATED across the two chat channels — gate both.

`src/channels/core/engine.ts` (Telegram) and `src/channels/phantomchat/server.ts` (PhantomChat) each carry their own near-identical streaming accumulator + segment-send state machine (the narration coalescing itself is shared — `createNarrationController` in `core/streaming.ts` — but the loop that feeds it and publishes segments is written out in full in both files); PhantomChat *mirrors* engine.ts rather than calling into it. Any change to how interim progress bubbles are emitted (the `/chattiness` gate is the current example — a `resolveNarrationEnabled()` call right before `createNarrationController` in both files) must be applied in **both** files or half of it silently doesn't work. There is no marker in the code: grep for `createNarrationController` to find both copies. Scope is Telegram + PhantomChat only — the editor (ACP) surface is deliberately left untouched. Per-conversation overrides live in `src/lib/chattiness.ts` (JSON under `xdgStateHome`, mirroring `coderSwap.ts`). See issue #243. The same duplication covers the post-turn **"never switch into voice once text has streamed"** guard: both files must gate it on bubbles that were actually PUBLISHED (`narrationBubblesSent` / `finalBubblesSent`, counted where they are sent), never on `consumedReplyChars`. A tool boundary consumes the pre-tool text whether or not anything went out, and a voice-out turn publishes no text at all — so the character count downgraded every voice-in reply that narrated before a tool call to text, silently, on PhantomChat only. Pinned end to end by the `phantomchat reply modality` tests in `tests/channels-phantomchat-server.test.ts`. The same duplication covers **what a voice-out reply SPEAKS**: both files record `streamedReply.length` at every TOOL-BACKED `progress` chunk — one carrying `chunk.tool` (`toolBoundaries`). Tool-less `progress` (the runner's raw non-JSON stdout lines) is liveness, never a boundary: as one it split the answer and voice dropped the text before it (#688); `narrationStreamGate` and `orchestrator/resume.ts` follow the same contract and synthesize `resolveSpokenReply(...)` (`core/streaming.ts`) — the text after the last tool, or the last stretch between tools that said something when nothing follows the last one — never the whole `fullReply`. `toolNarration: false` only removes the prompt instruction; models narrate anyway, and synthesizing `fullReply` read every pre-tool line aloud (Lena on PhantomChat, 2026-10-21). A recovery reply is spoken whole, and a harness-reformatted reply (prefix mismatch) falls back to the whole reply: duplication beats silence. Pinned by the voice-out tests in `tests/channels-telegram.test.ts` and `tests/channels-phantomchat-server.test.ts`, and by the `resolveSpokenReply` unit tests in `tests/channels-core-streaming.test.ts`.

<a id="inv-14"></a>
### 14. ACP has TWO scopes — a workspace and a thread — and history must only ever load into the thread one.

`src/connectors/acp/session.ts` derives both: the WORKSPACE key `acp:<sha256(cwd)[0..12]>` (stable per project directory) and the CONVERSATION key `acp:<cwdhash>:<threadid>` (stable per editor thread). Turn history is keyed on the **conversation**, so a new thread starts empty. This is load-bearing, not cosmetic: the conversation used to be keyed on cwd alone, so every "new" editor thread replayed the previous thread's turns **as USER messages** — a fresh thread opened onto a trailing queue of *"open a PR…" / "Go."*, and the model, reading the last thing the user had apparently asked for, went off and did unrequested work with nothing visible in the editor to cancel. If you touch the keying, keep the two scopes distinct and never widen the conversation key back to the workspace. Workspace-wide context is supplied *instead* by `briefing.ts` — prior turns rendered into a **system-role** block explicitly framed as finished sessions with void approvals, via `recentTurnsForConversationPrefix` in `src/memory/store.ts`. **Role is the whole mechanism**: the same bytes as `user` turns are live instructions; as a system briefing they're inert reference. Don't "simplify" the briefing back into history injection. The thread id rides inside the opaque sessionId (`acp_<cwdhash>_<thread>`), so `session/load` resumes a thread verbatim; legacy tokens with no thread segment still resolve to the old cwd-wide conversation, so pre-existing threads keep their history.

<a id="inv-15"></a>
### 15. Slash commands on the ACP surface must be dispatched OUT OF BAND, ahead of the serial request queue.

`src/connectors/acp/commands.ts` owns the allowlist (`/stop`, `/reset`, `/status`, `/harness`, `/help`) and delegates *behaviour* to the same `handleSlashCommand` in `src/channels/commands.ts` that Telegram uses — don't reimplement it. The dispatch point in `server.ts` is the part with a trap in it: `/stop` exists to kill the long-running prompt that is **currently blocking the queue**, so queueing it behind that prompt means it only fires once the turn it was meant to cancel has already finished. Route it out of band, the same exemption `session/cancel` already has. Commands are also advertised **per session** — an `available_commands_update` notification (`protocol.ts`) sent on both `session/new` and `session/load`, *not* in the `initialize` result — or the editor's `/`-menu is empty and users can't discover them. If you add a session-creating path, it must send that notification too. The allowlist is enforced in the ACP module *before* delegation, so this surface can't silently inherit a new Telegram-only command; `/update` and `/restart` are deliberately excluded (they bounce a service whose lifecycle the editor owns). Anything not on the list must fall through to the harness — personas define their own slash-isms, and a prompt that merely starts with `/` (a path, a regex) must not be swallowed.

<a id="inv-16"></a>
### 16. `/status` live probes must stay bounded — a dead provider must never hang the diagnostic.

`src/channels/statusProbes.ts` runs the fresh-on-every-call subsystem probes (Telegram `getMe`, ACP editor connectors, memory/embeddings backend, voice provider + key validation) that `handleStatus` in `src/channels/commands.ts` awaits before rendering `/status`. Because `/status` is what you reach for when something is broken, the whole fan-out is capped by a single shared wall-clock deadline (`PROBE_DEADLINE_MS`, ~5s): it's threaded into every client that accepts an `AbortSignal` (so the socket is actually cancelled — no #135-class leak) **and** raced in `gatherStatusProbes.settle` as a hard cap in case a client stalls before its fetch or ignores the signal. If you add a probe, give its client a `signal` param and thread `deadline` through it; a bare `await someFetch()` with no timeout re-opens the exact wedge this guards against. The deadline is injectable via `StatusProbeDeps.deadlineMs` purely for tests. Probe output is **user-facing** (the `phantomchat: npub…` line and the probe block both render in the reply), so any change to what `/status` prints must update the `/status` rows in `README.md` (both the Telegram command table and the editor-commands table) — this is the concrete case of the "user-facing change ⇒ README + AGENTS" rule in [AGENTS.md](../../../AGENTS.md).

<a id="inv-57"></a>
### 57. Relay write quarantine is minute-scale and actively recoverable; publish confirmation is a quorum.

`RelayHealthTracker` excludes repeatedly dropping or slow relays from WRITES for a jittered 3-minute base, doubling to a 15-minute cap, but never narrows READS and never lets the publish set fall below `MIN_PUBLISH_RELAYS`. The inbound catch-up cadence offers at most one warm-spare `{ids:[knownEvent]}` probe per jittered minute; publish traffic never schedules probes, and a successful read probe releases only a dropping quarantine. A SLOW quarantine serves its span because reading an old event does not measure current publish-accept latency. `verifyStored` still records every target relay independently, but delivery logging is aggregate: at least two verified copies logs `delivered via N relays`; fewer than two keeps a truthful loud warning. The pass remains detached from sending. Tests: `tests/channels-phantomchat-relayHealth.test.ts`, `tests/channels-phantomchat-relayAuth.test.ts`.

<a id="inv-82"></a>
### 82. OpenCode consumes Phantombot as a MODEL via an `aisdk:` provider module, never as an ACP agent (issue #699).

`opencode acp` makes *OpenCode* the agent that Zed/JetBrains spawn; it never spawns an ACP client, so there is no setting that points OpenCode at `phantombot acp`. The integration inverts the direction: `phantombot acp install opencode` writes `providers.phantombot` into OpenCode's `opencode.json` and points `package` at a provider module shipped inside this binary (`src/connectors/acp/opencode/provider/index.mjs`, embedded by `scripts/genOpencodeProviderAsset.ts`), which spawns `phantombot acp --persona <model id>` per conversation over stdio. No daemon, no port, no token — it works while the service is down, and the trust boundary is process ancestry, exactly like Zed.

**The specifier must start with `aisdk:`.** The obvious registration — `package: "file://…"` exporting `model()` — cannot work, and fails with a message that reads like a bug in our module: OpenCode validates the returned value with `LanguageModelSchema`, which is `instanceof LanguageModel` against a class inside its own binary, and an external `file://` module cannot import `@opencode/ai` (verified on v2.2.0: every such specifier fails to resolve). The `aisdk:` prefix routes the package through `opencode.provider.dynamic`, which imports the module, takes the FIRST export whose name starts with `create`, calls it with the flattened `settings`, and expects `languageModel(id)` returning a plain duck-typed AI SDK `LanguageModelV3`. So the module exports exactly ONE `create*` symbol — a second one makes the choice order-dependent and silently breaks every model (asserted in `tests/lib-opencodeProviderAsset.test.ts`).

Two provider behaviours are load-bearing rather than stylistic. **Only the unseen turns are sent:** OpenCode replays the whole transcript on every request while Phantombot owns the conversation server-side, so a full replay double-counts history; the module prefix-matches the incoming user turns against what it already sent. **A transcript that does not extend a known conversation starts a new ACP session** — an edited earlier message must never be fed into the thread it was edited out of. Identical openings remain ambiguous (there is no session id on the wire); the whole transcript is compared, not the first message, so the ambiguous case is narrow. OpenCode's session-title requests are answered locally: it asks the same model to name the conversation using the first user message as the prompt, so forwarding that would spend a real turn, write a bogus memory row, and poison the prefix matching (its prompt is a prefix of the real first turn).

Settings reach the factory under `providers.<id>.settings` (**not** `options`, which is the v1 block's key and is silently ignored by v2) — that is where the installer bakes the absolute binary path, since GUI-launched editors on macOS and Windows have a minimal `PATH`. Tests: `tests/connectors-acp-opencodeProvider.test.ts` (translation, dedupe, fork, cancel, child death, missing binary), `tests/connectors-acp-installOpencode.test.ts` (JSONC merge, idempotency, abort-on-malformed, v1-key warning).

<a id="inv-83"></a>
### 83. The OpenCode provider persists its thread TOKEN — never the transcript — and a cold registry RELOADS it instead of minting a new thread (issue #710).

The ACP server keeps no session map by design: `mintSessionId` embeds the thread in the token and `conversationForSessionId` re-derives the conversation key from it, so `session/load` on a token issued by a *previous* child replays the thread verbatim out of the phantom's own memory store. The provider's `runtime.conversations` map is the only place that pointer lived, and it is process memory — so every provider restart (OpenCode restart, reboot, upgrade, `acp install opencode`, a model switch that spawns a new runtime) turned every existing thread into "brand new" and sent the newest turn alone: the user saw a full thread on screen and the phantom answered "what are you referring to?".

The token is therefore written down per persona and spawn identity, under `$XDG_STATE_HOME/phantombot/opencode-provider/<persona>.json` — one record per thread holding `{ key, token, digest, length, touched }`, where `digest` is a sha256 over `${role}\0${text}\0${mediaKey}` lines and `length` is how many entries it covers. Never text, never attachment payloads: a picture's base64 must not be pinned to disk by a resume pointer. On a cold start the provider resumes on the longest record whose digest the incoming transcript *extends* — the same prefix rule `continuesConversation` applies in memory — and falls through to `session/new` for a fork, an edited turn, or two records that match equally well (ambiguity must never be resolved by picking a winner).

Three consequences are load-bearing. A token the server refuses is dropped immediately, or every later turn pays for the same rejected attempt. The record is deliberately NOT pruned when `evictConversations` drops the in-memory entry — that record is the whole reason an evicted thread can come back. And the create path writes the record before the turn runs, so a crash on the first turn does not lose the thread.

Seeding a recap (first ask + the last N turns, char-capped, framed as context only) is defence in depth for the cases persistence cannot cover: a corrupt or absent state file, another machine's thread, a genuinely forked transcript. It is gated on the transcript carrying at least one ASSISTANT entry, so a brand-new chat — always exactly one user entry — can never inherit another thread's words; that gate is the same leak `continuesConversation` refuses to make. Tests: `tests/connectors-acp-opencodeProvider.test.ts` (restart resume, digest fork, refused token, loadSession fallback, recap seeding, never-seed guard, on-disk ambiguity).

Voice model control messages (`phantomchat-voice-models`) are handled before chat ingestion, with the existing local-tools control tag for old-engine compatibility. Freshness, a configured principal allowlist, rumor deduplication, bounded serialization and shutdown draining apply. These model-only messages never change a remote endpoint or move credentials across the relay; providers/keys must already be configured in that runtime. No tools or LLM turns run on this path.

<a id="inv-87"></a>
### 87. A hold notice reaches the owner's other open threads OUT OF BAND — a count in groups, never a turn, never a DM (issue #768).

`src/lib/holdRelay.ts`. The screen appends to `<personaDir>/hold-notices.jsonl` only AFTER the DM was delivered; each long-lived reader (Telegram engine, PhantomChat server, TUI session, ACP server) keeps a `HoldThreadRelay` and polls it. Four rules are load-bearing. **Never write a relayed line to `turns`:** the model would read it back as its own reply in that thread. **Groups get a count only** (`groupHoldLine`): a group has other members, and the DM carries what was held. **A thread is open only because the OWNER was active in it** in the last 60 minutes (`touch` on a principal-authenticated / trusted-tier group message), never because a stranger wrote in it, and owner DMs are never relayed into (they already got the notice). **A PhantomChat group's recipient set is the rumor's member list PLUS the sender** — the list never includes the sender, so the owner would be the one member not told. Delivery is opportunistic: a failed send is swallowed, a restart starts a fresh cursor and never replays. ACP cannot be pushed into from outside, so it streams the line into the reply in flight or opens the next reply with it. Tests: `tests/lib-holdRelay.test.ts`, the "hold relay" blocks in `tests/channels-telegram.test.ts` and `tests/channels-phantomchat-server.test.ts`.

<a id="inv-90"></a>
### 90. A PhantomChat group the human principal is in is a TEAM: its members are trusted there, and a phantom wakes another phantom only by @mention, within a fixed handoff budget a human refills.

**An @mention is an actionable handoff, not a courtesy.** The teammate envelope
never requires mentioning reviewers on every reply. A phantom-woken turn replies
with exactly `SILENT` when nothing remains owed. Only that bare token, alone
after the last tool boundary, is silence. Case, brackets, quotes, emphasis and a
trailing stop are tolerated (`src/lib/silence.ts`, shared with reactions); any
other word makes it prose, which is delivered. The boundary belongs to the
harness that SERVED the turn (`done.finalSegment` from `runWithFallback`): a
failed harness's stream neither hides a fallback's token nor silences its answer.
An interrupted earlier pass's trailing text blocks silence only when the final
pass ran no tool; once it runs one, that text is pre-tool narration like any
other, and a bare token after it is silence.
Empty/whitespace output
retains ordinary coder-swap and outer-fallback recovery, including failure
records when every harness is empty. Errors and cancellation keep their existing
behavior. Human messages and DMs never interpret the token. The channel buffers
phantom final text until completion so no partial token becomes a bubble or
voice note; tool narration still works, with a bare token suppressed there too.
`runTurn` replaces intentional silence with `[Completed without a reply.]` in
history, keeping the control token out of replay. Typing clears in `finally`.

**A handoff is one message.** Mentions are read per message, so a reply split into
bubbles would wake the teammate with only the bubble holding the `@name`. In a
team group with another phantom the final text does not stream: it is held until
the answer ends or a tool starts, then sent whole if it mentions a phantom
(`isWholeHandoff`) and in ordinary bubbles if not. Narration stays its own
message. Above `MAX_WHOLE_HANDOFF_BYTES` (8,000 UTF-8 bytes, kept well under the
NIP-44 cap) a handoff is split like any reply. Not covered: a phantom-woken
turn's pre-tool text is narration, whatever it mentions.

**Queued text phantom handoffs coalesce per conversation.** When one reaches the
front, text phantom handoffs already waiting are independently gated for
team membership, explicit mention and the 60-handoff cap, then the accepted
messages enter one prompt oldest first, each with its own sanitized sender.
Teammate chatter that does not mention this phantom (narration, the earlier
bubbles of a split reply, a handoff to someone else) cannot wake it, so it does
not split a batch: between two handoffs it is inlined in arrival order, labelled
as context, truncated and capped like the catch-up preamble, with no added reply
recipients, and a handoff it makes to someone else still spends the budget in
order. Chatter after the last waiting handoff stays queued, because it may open a
handoff still arriving. An own message or a non-member's is never chatter.
Reply recipients union the rumors and their senders so every requester is covered.
The model is told to act on current state and preserve distinct requests because
later evidence may settle an earlier request. Each handoff still consumes one
budget unit; the pause notice remains once per exhausted episode. Profile refresh happens before consuming followers so a cached bot that is now
human retains its own turn and barrier. Human messages, and media that mentions this phantom, are barriers; no batch crosses them or another conversation.
Existing human interrupt/flush rules remain. Each accepted message appears once
in the turn input/history and once as delivered group context. Group receipts
retain their existing per-member client mechanism; DM receipts are unchanged.
Tests: the `team group` cases in `tests/channels-phantomchat-server.test.ts` and
explicit-silence, empty-failure, and real Pi subprocess regressions.

**A group turn is told where it is.** Every trusted turn in a team group gets a
block in its channel context (`channelDetail`, rendered by
`src/channels/core/groupContext.ts`): the group's name, each member with the exact
`@name` that wakes it, members added or removed since this phantom's last turn
there, and any `@name` its previous message used in vain. A human sees all of that
on screen; a phantom that does not know its picture is stale will not think to
look, so it is pushed and there is no members command. The block is volatile: it
never enters the user message or the stored history. Rules that must hold. **The
name is read only from a control message an allow-listed HUMAN signed**
(`noteGroupName`: create, add, rename), newest event first, the same rule as the
roster. **Control traffic is dropped on its tag before any parse**; it never runs a
turn or joins the catch-up buffer, and its only p-tag is the recipient, so it must
never reach `noteTeamRoster`. Names are other people's text: one capped line,
control characters and brackets removed, stated as a label. A member without a
resolved profile is "not identified", never the principal. The name and the
last-shown members live in `<personaDir>/phantomchat-groups.json`
(`groupState.ts`), best-effort; an existing group's name is unknown until its next
add or rename. None of this decides trust or who can wake whom.

**A mention that matches nobody is reported, not swallowed.** After a team-group
answer, `unmatchedMentions` posts one notice in the group and tells the phantom's
next turn there. It is narrow on purpose (a false notice is noise for the whole
group): only a name opening a line, in the closing run of mentions, or starting
with a phantom member's name, outside code, quotes and links, and never while a
member is nameless. The notice contains no `@`, so it wakes nobody and spends no
budget.

`src/channels/phantomchat/server.ts` (`noteTeamRoster`, `isTeamMember`, the bot gate in `handle`) + `matchAtMentions` / `PHANTOM_HANDOFF_BUDGET` in `src/channels/core/routing.ts`. PhantomChat only; Telegram keeps "a bot never answers a bot". Load-bearing rules: **membership is read ONLY from group messages an allow-listed HUMAN signed** (the rumor's p-tags plus the sender) — never from a phantom's message, never from the group id, so a stranger cannot join by building a group that names the principal, and removing someone in the app takes effect at the principal's next message. **Team trust is scoped to that conversation**: the member's DMs, reactions and other groups stay dropped. **A phantom wakes only on an explicit `@name`** — naming in passing ("Kai and Omar approved") is not a handoff — and a phantom's wake never moves `lastAddressed`. **The budget is a constant (60), not a setting**: every phantom counts every handoff it sees (its own at send time, because the channel skips the live self-copy), any human message resets it, and over budget the woken phantom posts one pause notice and runs no turn. A non-principal speaker is named in the turn input so the model never mistakes a teammate for its principal; that name is self-asserted, so it goes through `sanitizeEnvelopeField` and cannot close the bracket to forge a principal envelope. **Name vouching follows the same scope**: a team member's kind-0 name is shown only in THAT team's group, never in another group it shares. **Team trust never opens a hold-notice thread** (invariant 87): only an allow-listed sender's own message does. Tests: the `team group` and `group context` cases in `tests/channels-phantomchat-server.test.ts`, and `tests/channels-group-context.test.ts`.
