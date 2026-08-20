/**
 * Single-turn coordinator.
 *
 * Given a user message + a configured persona / harness chain / memory store,
 * runTurn:
 *   1. Loads the persona files from disk.
 *   2. Loads the most recent N turns from memory (skipped if noHistory).
 *   3. Builds the system prompt via persona/builder.
 *   4. Runs the harness chain via orchestrator/fallback, streaming chunks
 *      out to the caller as they arrive.
 *   5. On success — and only on success — persists the user turn followed
 *      by the assistant turn to memory. A failed turn leaves no trace,
 *      so the user can retry without polluting history with half-turns.
 *
 * runTurn is an async generator of HarnessChunk. The caller iterates,
 * surfaces text/progress to wherever (stdout, REPL, future channel
 * adapter), and persistence happens as a side effect when the stream ends.
 *
 * Errors that aren't part of the harness stream (persona missing, memory
 * write failed) propagate as thrown exceptions — the caller is expected
 * to catch them and present cleanly.
 */

import { join } from "node:path";

import { runWithFallback } from "./fallback.ts";
import { createAuditSink } from "../lib/auditLog.ts";
import { log } from "../lib/logger.ts";
import {
  registerTurn,
  siblingNotice,
  siblingTurns,
} from "../lib/turnRegistry.ts";
import {
  DigestCollector,
  digestNotice,
  isBackgroundOrigin,
  isInteractiveOrigin,
  markDelivered,
  MAX_DIGESTS_PER_TURN,
  pendingDigests,
  recordDigest,
} from "../lib/turnDigest.ts";
import {
  listWorkspaceLocks,
  workspaceLockNotice,
} from "../lib/workspaceLock.ts";
import {
  buildSystemPrompt,
  PRE_TOOL_NARRATION_INSTRUCTION,
} from "../persona/builder.ts";
import { loadPersona } from "../persona/loader.ts";
import { buildDailyRecall } from "../lib/dailyRecall.ts";
import { isNightlyConversation } from "../lib/nightly.ts";
import type { Harness, HarnessChunk } from "../harnesses/types.ts";
import type { ToolCallDetail } from "../harnesses/toolNote.ts";
import type { MemoryStore, TurnOrigin } from "../memory/store.ts";
import type { FactSource } from "../config.ts";
import type { ScreenVerdict } from "./screen.ts";

export const DEFAULT_HISTORY_LIMIT = 30;

export interface TurnInput {
  /** Persona name — used for memory scoping and log clarity. */
  persona: string;
  /** Conversation key — e.g. "cli:default", "telegram:42". */
  conversation: string;
  /** The new user message. */
  userMessage: string;
  /** Path to the persona directory (BOOT.md / SOUL.md / IDENTITY.md etc. live here). */
  agentDir: string;
  /**
   * cwd for harness subprocesses. REQUIRED — there is deliberately no
   * default (see #387). Affects:
   *   - pi:     where relative-path tools resolve (no sandbox).
   *   - claude: same + the "trusted dir" framing for the workspace, AND
   *             the root that Glob/Grep walk when the agent searches.
   *   - gemini: the *workspace sandbox root* — gemini hard-rejects tool
   *             calls that touch paths outside cwd + its temp dir.
   * Persona files load via absolute paths regardless of this setting.
   *
   * This used to silently default to `homedir()`, which meant a background
   * turn woke up in `$HOME` unable to see its own `memory/` — so its file
   * search walked the whole home tree looking for them. On macOS that walk
   * crosses `~/Library/Containers` and trips the TCC
   * `kTCCServiceSystemPolicyAppData` prompt ("phantombot would like to
   * access data from other apps"), once per spawned process. A default
   * nobody passes is a default nobody audits: make every call site say
   * which tree this turn is allowed to treat as home.
   *
   *   - Interactive/chat surfaces pass `homedir()` — the owner asks for work
   *     on repos all over their home dir, so scoping those down is wrong.
   *   - Machine-driven background turns (nightly) pass the persona dir.
   */
  workingDir: string;
  /** Harness chain in priority order; first that succeeds wins. */
  harnesses: Harness[];
  /** Open memory store; runTurn appends to it on success. */
  memory: MemoryStore;
  /** Kill subprocess after this long with no chunk on stdout. Resets per chunk. */
  idleTimeoutMs: number;
  /** Hard wall-clock ceiling regardless of activity. */
  hardTimeoutMs?: number;
  /** Kill subprocess if it emits no output at all within this long (startup/init wedge guard). Omit to disable. */
  startupTimeoutMs?: number;
  /** Number of prior turns to load. Default 30. */
  historyLimit?: number;
  /** Skip loading prior turns AND skip persisting this one. Default false. */
  noHistory?: boolean;
  /** Extra text appended to the system prompt. Used by nightly to inject distillation directives. */
  systemPromptSuffix?: string;
  /**
   * Run this turn with ZERO MCP servers. Set by background callers (nightly)
   * so an unauthenticated remote claude.ai connector can't wedge the
   * non-interactive `--print` startup handshake. See HarnessRequest.mcpMode.
   */
  mcpMode?: "none";
  /**
   * Restrict the harness's built-in tool surface for this turn. Omitted =
   * the normal full surface. `{ allow: [...] }` is a positive grant used by
   * background turns whose job is known up front (nightly); claude honours
   * it, pi/codex ignore it. See HarnessRequest.toolsMode — and note it is
   * defence-in-depth, NOT a trust boundary.
   */
  toolsMode?: { allow: string[] };
  /**
   * Append PRE_TOOL_NARRATION_INSTRUCTION to the system prompt — asks
   * the model to say one short sentence before each tool call so
   * streaming channels have something to render during the silence
   * while a tool runs.
   *
   * Off by default. Channels that stream assistant text in real time
   * should set this true:
   *   - Telegram text-in/text-out (text streams as it lands)
   *   - `phantombot ask --stream` (stdout flushes per text chunk;
   *     Twilio's voice relay tee'd off this)
   *
   * Leave false for one-shot consumers — the CLI's `ask` (no stream),
   * nightly distillation, the heartbeat — where there's no live
   * channel to fill silence on.
   *
   * Telegram voice-in/voice-out should also leave this false: the
   * voice reply is one synthesized clip at the end, not a stream, so
   * narration would just bloat the spoken output.
   */
  toolNarration?: boolean;
  /** External abort signal from channel layer (e.g. /stop command). Propagated to harnesses. */
  signal?: AbortSignal;
  /**
   * Optional turn-time auto-retrieval. When provided, runTurn calls it with
   * the incoming user message before building the system prompt and injects
   * whatever it returns into the "Retrieved context for this turn" slot —
   * the instinct layer that surfaces relevant memory/kb without the agent
   * having to search by hand.
   *
   * Built by `orchestrator/retrieval.ts#makeRetriever`. Contracted to never
   * throw (it swallows its own failures and returns undefined); runTurn
   * still guards defensively so a misbehaving retriever can't break a turn.
   *
   * Omitted by system turns (tick, nightly) so their prompts stay clean.
   */
  retrieve?: (
    query: string,
    signal?: AbortSignal,
  ) => Promise<string | undefined>;
  /**
   * Optional post-persist hook. Used by the conversation-turn indexer to
   * backfill searchable old turns on a cadence. Must never break a turn.
   */
  indexTurns?: () => Promise<void>;
  /**
   * Optional per-turn durable-fact pull. When provided, runTurn calls it at
   * prompt-assembly time (alongside `retrieve`) and injects whatever it
   * returns into the "# Durable facts" prompt slot. This is the READ half of
   * the durable-facts feature and is contractually PURE SQL — it must NEVER
   * invoke an LLM (see orchestrator/durableFacts.ts#pullDurableFacts). Built
   * by `makeDurableFactPuller`; omitted by system turns (tick, nightly).
   * Contracted not to throw; runTurn guards defensively regardless.
   */
  pullFacts?: (signal?: AbortSignal) => Promise<string | undefined>;
  /**
   * Optional out-of-band durable-fact EXTRACTION hook — the WRITE half. Fired
   * (NOT awaited) after a successful turn is persisted, so its temp-0 pass on
   * the primary harness never delays the interactive reply. `false` (or
   * undefined) skips it; a fn runs it. A throw is swallowed — a failing
   * extraction must never break the turn. Built by `makeFactExtractor`.
   */
  extractFacts?: false | (() => Promise<void>);
  /**
   * Security-perimeter provenance bit. True when an authenticated allowed
   * principal issued this turn (the Telegram channel sets it after the
   * allowed-user check passes) OR when the caller is machine-authored
   * maintenance operating on its own persona dir with no ambient/external
   * content in play — nightly is the one non-chat caller that opts in, for
   * exactly that reason (see cli/nightly.ts#runNightlyTurn). Defaults
   * false/undefined for every other entry point — `phantombot ask`, tick,
   * voice — so the system FAILS CLOSED.
   *
   * Three effects:
   *   1. It selects the SECURITY_PERIMETER prompt block (trusted = treat
   *      input as commands; untrusted = treat input as data to triage).
   *   2. It gates the threat screen below: trusted turns skip the screen
   *      entirely (the principal is the gate); untrusted turns are
   *      screened by the tool-less judge before any capable harness runs.
   *   3. A trusted turn that succeeds also calls `purgeQuarantined` on its
   *      conversation. For nightly this is a guaranteed no-op — nothing is
   *      ever quarantined on `system:nightly:<date>` — but it's a real
   *      behavioural consequence of the bit, not just the prompt-block pick.
   */
  trusted?: boolean;
  /**
   * Suppress daily-journal injection for this turn.
   *
   * Set by the nightly sweep, which is handed the exact date it is distilling
   * and would otherwise read the same file twice. Stated intent, rather than
   * inferred from a `conversation` id the caller controls — a channel that let
   * a conversation id start with the nightly namespace would otherwise turn
   * journal injection off for that thread.
   */
  skipDailyRecall?: boolean;
  /**
   * Optional override for the USER-turn durable-fact provenance tier.
   *
   * By default the user turn is stamped `principal` when `trusted`, else
   * `other` — the security-perimeter framing: the owner speaking vs. a third
   * party in a shared context. That default is right for human-authored input,
   * but a `tick` task wake is neither: it feeds its OWN scheduled prompt and
   * then, mid-turn, may ingest UNTRUSTED content (an email body, a web page, a
   * Plane issue) via tools — content the threat judge never screened, because
   * it arrives as tool output, not as a judged `ask` turn (see #327). If facts
   * extracted from such a turn landed at `self` (weight 0.6), a prompt-injected
   * email a poller summarises could poison the persona-wide fact pool one tier
   * below the owner. So task callers pass BOTH `userSource` and
   * `assistantSource` = `"other"`: everything a task turn produces lands in the
   * untrusted tier (weight 0.3, 7-day half-life, injected only tagged
   * `unverified`, never recall-bumped) and can never masquerade as first-hand
   * `self` knowledge. Deliberately conservative — we can't tell at the turn
   * layer which task wakes actually ingested untrusted content, so all of them
   * are treated as if they did. #327 tracks doing this per-fact by tool input.
   *
   * Decoupled from `trusted` on purpose: provenance-tier and the
   * security-perimeter bit answer different questions and must not be conflated
   * (a task wake is `other`-provenance and still NOT `trusted` — it gets neither
   * the principal's command authority nor self-tier trust). Undefined preserves
   * the legacy `trusted ? "principal" : "other"` behaviour exactly.
   */
  userSource?: FactSource;
  /**
   * Optional override for the ASSISTANT-turn durable-fact provenance tier.
   *
   * The persona's own reply is stamped `unverified` by default (#327): the
   * harness reply may carry untrusted tool-ingested content we can't separate
   * from the persona's own reasoning, so it is not trusted first-hand until the
   * principal engages with it. A `tick` task wake is even more clearly untrusted
   * (it autonomously ingests emails/web/issues), so task callers still pass
   * `assistantSource: "other"` to pin it to the third-party tier explicitly — see
   * the `userSource` doc above. Undefined preserves the `unverified` default.
   */
  assistantSource?: FactSource;
  /**
   * ORIGIN axis for both turns of this exchange (see Turn.origin) —
   * separate from the trust axis above. Defaults to `channel`, which is
   * right for every chat surface; scheduled task wakes pass `task` so their
   * output is distinguishable later from a human's message. Both turns of a
   * wake share one origin: the prompt and the reply were produced by the
   * same mechanism.
   */
  origin?: TurnOrigin;
  /**
   * AUDIENCE axis — who will actually SEE this turn's reply. Separate from
   * origin (which surface produced the wake) and from `trusted` (who is
   * speaking): trust authenticates the speaker, it says nothing about who
   * else is in the room or whether a reply is rendered at all.
   *
   * This gates post-turn digest delivery (#405). A digest is persona-private
   * operational state — what the nightly touched, which repos and paths a
   * poller wrote to — so it is handed ONLY to a `private` turn: a 1:1 reply
   * rendered in front of the principal and nobody else.
   *
   *   - "shared"  — a trusted GROUP turn. The reply is broadcast to every
   *     member, so injecting a digest would disclose persona-private state
   *     to the room.
   *   - "silent"  — a wake-but-silent turn (reactions). The harness reply
   *     defaults to never being sent, so delivering a digest here would
   *     CONSUME it into the void: marked delivered, never seen, and the
   *     next real conversation gets nothing.
   *
   * Omitted = "silent" (fail closed). A caller that does not state its
   * reply is private-and-visible receives no digests and, just as
   * importantly, consumes none — they stay pending for the turn that can
   * actually show them.
   */
  replyAudience?: "private" | "shared" | "silent";
  /**
   * Optional threat screen for UNTRUSTED turns (built by
   * orchestrator/screen.ts#makeScreener). Called with the incoming user
   * message before the harness chain runs. If it returns a `hold`
   * verdict, runTurn does NOT run the harness — the request has already
   * been escalated to the principal (notify + audit happen inside the
   * screener, in code, so a model can't fake them). A `pass` verdict
   * lets the turn proceed normally and silently.
   *
   * Only consulted when `trusted !== true`. Trusted turns never screen.
   * Contracted to never throw; runTurn still guards defensively and
   * fails OPEN (proceeds) if the screen itself errors, so a judge/API
   * outage degrades to "unscreened" rather than "app down" — see the
   * design doc for why fail-open is the deliberate choice here.
   */
  screen?: (
    content: string,
    signal?: AbortSignal,
  ) => Promise<ScreenVerdict | undefined>;
}

/**
 * Register this turn for the duration, then run it (issue #391).
 *
 * A thin wrapper on purpose. Registration belongs HERE rather than at each
 * call site because every entry point — Telegram, phantomchat, `ask`, tick,
 * nightly, ACP — funnels through `runTurn`, so doing it once covers all of
 * them and, more importantly, makes it impossible for a future entry point to
 * forget. The `finally` is the only place that can reliably see the end of the
 * turn: the body returns early on a screened hold, throws on a harness
 * failure, and streams normally otherwise.
 *
 * `finally` in an async generator runs when the consumer drains the stream,
 * breaks out of its `for await` (which calls `.return()`), or throws. The one
 * case it cannot cover is a generator abandoned without being closed — which is
 * why a stale entry is bounded by MAX_TURN_LIFETIME_MS rather than trusted
 * until deleted.
 */
export async function* runTurn(input: TurnInput): AsyncGenerator<HarnessChunk> {
  const handle = registerTurn({
    persona: input.persona,
    conversation: input.conversation,
    origin: input.origin ?? "channel",
  });
  try {
    yield* runTurnBody(input, handle.id);
  } finally {
    handle.release();
  }
}

async function* runTurnBody(
  input: TurnInput,
  turnId: string,
): AsyncGenerator<HarnessChunk> {
  const origin: TurnOrigin = input.origin ?? "channel";
  const startedAt = new Date();
  const persona = await loadPersona(input.agentDir);

  const history = input.noHistory
    ? []
    : await input.memory.recentTurns(
        input.persona,
        input.conversation,
        input.historyLimit ?? DEFAULT_HISTORY_LIMIT,
      );

  // Threat screen — runs BEFORE retrieval (Blocker B). For an UNTRUSTED turn,
  // the tool-less judge sees the content first; only a `pass` lets the turn go
  // on to pull the principal's private memory/kb into a prompt. This ordering
  // is the whole point: screening AFTER retrieval would let untrusted content
  // ride into a memory-laden prompt before anyone judged it — a memory-exfil
  // path where a low-scoring "summarise & reply" still leaks context. On a
  // `hold` the screener has already notified the principal and recorded the
  // audit IN CODE (a model can never fake "I escalated this"); we stop here
  // and NO retrieval ever happens. Trusted turns skip the screen entirely (the
  // authenticated principal is the gate). The screen contracts not to throw;
  // the catch is belt-and-suspenders and fails OPEN so a judge outage degrades
  // to "unscreened", never "app down".
  if (input.trusted !== true && input.screen) {
    let verdict: ScreenVerdict | undefined;
    try {
      verdict = await input.screen(input.userMessage, input.signal);
    } catch {
      verdict = undefined;
    }
    if (verdict?.action === "hold") {
      // NOTE: the screener already did the grounding write — it wrote the
      // held episode (quarantined payload) into the PRINCIPAL'S
      // telegram conversation, which is the correct scope (that's where the
      // approve/deny reply lands). We deliberately do NOT write anything here:
      // this entry point's conversation is the wrong one to ground against.
      // See orchestrator/screen.ts (recordHeld + the conversation-scoping
      // comment). We just surface the held message and stop.
      const held =
        verdict.heldMessage ??
        "🔒 This request touched something sensitive, so I've paused it and asked the owner to confirm. Nothing was done.";
      yield { type: "text", text: held };
      yield { type: "done", finalText: held, meta: { screenedHold: true } };
      return;
    }
  }

  // Instinct layer: pull relevant memory/kb for this message and inject it
  // into the prompt's "Retrieved context" slot. Belt-and-suspenders try/catch
  // — the retriever already swallows its own errors, but a turn must never
  // die on retrieval. Reached only for trusted turns or untrusted turns that
  // PASSED the screen above.
  let retrievedMemory: string | undefined;
  if (input.retrieve) {
    try {
      retrievedMemory = await input.retrieve(input.userMessage, input.signal);
    } catch {
      retrievedMemory = undefined;
    }
  }

  // Durable facts: a plain SQL pull of the top standing facts for this
  // persona/conversation, injected into the "# Durable facts" slot. NO LLM on
  // this path (that's the whole point — it runs on every turn). Belt-and-
  // suspenders try/catch: pullFacts already swallows its own failures, but a
  // turn must never die on the fact read.
  let durableFacts: string | undefined;
  if (input.pullFacts) {
    try {
      durableFacts = await input.pullFacts(input.signal);
    } catch {
      durableFacts = undefined;
    }
  }

  // Daily journal: today's file always, yesterday's only when the nightly
  // ledger says its sweep never completed. Deliberately NOT a caller-supplied
  // hook like `retrieve`/`pullFacts` — which daily files a turn sees is part
  // of the memory system itself, so no channel, config or persona file gets a
  // say in it (issue #410). Skipped only for the nightly sweep's own turns,
  // which are handed the exact date they are distilling and would otherwise
  // read the same content twice. Pure disk + JSON, no LLM, never throws.
  let dailyRecall: string | undefined;
  if (!input.skipDailyRecall && !isNightlyConversation(input.conversation)) {
    try {
      dailyRecall = (await buildDailyRecall(input.agentDir)).block;
    } catch {
      dailyRecall = undefined;
    }
  }

  const baseSystemPrompt = buildSystemPrompt(
    persona,
    {
      channel: "cli",
      conversationId: input.conversation,
      timestamp: new Date(),
      trusted: input.trusted === true,
    },
    retrievedMemory,
    durableFacts,
    dailyRecall,
  );
  // Channel-layer overlays in append order:
  //   1. systemPromptSuffix — caller-provided (e.g. Telegram's
  //      reply-style + voice-brevity rules; nightly's distillation
  //      directives).
  //   2. siblingNotice — #391. Sits between the caller's suffix and the
  //      narration rule: it is a constraint on WHAT the turn may do, so it
  //      outranks the formatting directive, but it must not displace the
  //      channel's own framing. Absent (and free) whenever nothing else is
  //      running, which is the overwhelming majority of turns.
  //   3. PRE_TOOL_NARRATION_INSTRUCTION — opt-in via toolNarration,
  //      added LAST so its directive sits closest to the user message
  //      and is the most prominent format-of-reply rule the model sees.
  const overlays: string[] = [];
  if (input.systemPromptSuffix) overlays.push(input.systemPromptSuffix);
  const siblings = siblingTurns(input.persona, turnId);
  const notice = siblingNotice(siblings);
  if (notice) {
    overlays.push(notice);
    log.info("turn: sibling turn in flight", {
      persona: input.persona,
      conversation: input.conversation,
      siblings: siblings.map((sib) => sib.conversation),
    });

    // 2b. Workspace claims (#405). Only meaningful WHILE a sibling is in
    // flight: a lock outliving its turn is already pruned as stale, and a lock
    // this turn holds itself is not news to it. Filtering by the live sibling
    // set also keeps the block off the 99% of prompts with nothing to say.
    const siblingIds = new Set(siblings.map((sib) => sib.id));
    const heldElsewhere = listWorkspaceLocks().filter(
      (lock) =>
        lock.persona === input.persona &&
        lock.turn_id !== turnId &&
        (lock.turn_id === undefined || siblingIds.has(lock.turn_id)),
    );
    const lockNotice = workspaceLockNotice(heldElsewhere);
    if (lockNotice) {
      overlays.push(lockNotice);
      log.info("turn: workspaces held by sibling", {
        persona: input.persona,
        workspaces: heldElsewhere.map((lock) => lock.workspace),
      });
    }
  }

  // 3. Post-turn digests (#405). Background turns reply into their own
  // transcripts, which the principal never opens; this is the only moment they
  // become visible. Delivered ONLY to an interactive turn — handing a task
  // wake the digest of another task wake tells nobody anything, and would let
  // two background turns bounce a report between themselves forever.
  //
  // And only to a turn whose reply the principal will actually SEE, alone
  // (see TurnInput.replyAudience). Trust authenticates the speaker; it says
  // nothing about the audience. A trusted GROUP turn is `origin: channel`
  // and `trusted: true`, but its reply is broadcast to every member —
  // injecting persona-private paths and summaries into its prompt is a
  // disclosure AND an injection surface, since the group's text lands in
  // the same prompt. A wake-but-silent REACTION turn is worse in the other
  // direction: its reply defaults to never being sent, so a digest
  // delivered there is consumed into the void — marked delivered, never
  // seen, and the next real conversation gets nothing. Shared and silent
  // turns therefore neither receive nor mark digests; they stay pending
  // for the private turn that comes after.
  const deliverDigests =
    isInteractiveOrigin(origin) &&
    input.trusted === true &&
    input.replyAudience === "private";
  const digests = deliverDigests ? pendingDigests(input.persona) : [];
  // Oldest first, so a backlog drains front-to-back instead of starving its
  // tail — see pendingDigests.
  const shownDigests = digests.slice(0, MAX_DIGESTS_PER_TURN);
  const digestBlock = digestNotice(
    shownDigests,
    digests.length - shownDigests.length,
  );
  if (digestBlock) {
    overlays.push(digestBlock);
    log.info("turn: delivering background digests", {
      persona: input.persona,
      pending: digests.length,
      shown: shownDigests.length,
    });
  }
  if (input.toolNarration) overlays.push(PRE_TOOL_NARRATION_INSTRUCTION);
  const systemPrompt =
    overlays.length > 0
      ? baseSystemPrompt + "\n\n" + overlays.join("\n\n")
      : baseSystemPrompt;

  let finalText = "";
  let succeeded = false;

  // Tool-call audit (#282): default-on, writes to `<agentDir>/audit/<date>.log`.
  // Every runTurn caller (Telegram, phantomchat, ask, tick, nightly, ACP) gets
  // it for free; the sink self-disables when PHANTOMBOT_AUDIT_TOOL_CALLS is off.
  const auditSink = createAuditSink(input.agentDir);

  // Digest collection (#405) rides the same hook but is INDEPENDENT of the
  // audit sink: auditing has its own kill switch, and an operator who turns off
  // the on-disk audit log has not asked to go blind to what background turns
  // did. Only background turns collect — an interactive turn's actions were
  // already streamed to the principal as they happened.
  const digestCollector = isBackgroundOrigin(origin)
    ? new DigestCollector()
    : undefined;
  const toolSink =
    auditSink || digestCollector
      ? (detail: ToolCallDetail) => {
          try {
            digestCollector?.record(detail);
          } catch {
            // Digest bookkeeping must never break a tool call.
          }
          auditSink?.(detail);
        }
      : undefined;

  // Written in a `finally` rather than after a clean drain, on purpose: a
  // background turn that pushed a commit and THEN died is the single most
  // important case to surface, and gating the digest on success would hide
  // exactly that turn. The generator's `finally` also covers the consumer
  // breaking out of its `for await`.
  const flushDigest = () => {
    if (!digestCollector) return;
    const { actions, omitted } = digestCollector.snapshot();
    try {
      recordDigest({
        persona: input.persona,
        conversation: input.conversation,
        origin,
        trigger: input.userMessage,
        summary: finalText,
        startedAt,
        actions,
        omitted,
      });
    } catch (e) {
      log.debug("turn: digest write failed", { error: (e as Error).message });
    }
  };

  try {
    for await (const chunk of runWithFallback(
      input.harnesses,
      {
        systemPrompt,
        userMessage: input.userMessage,
        history,
        persona: input.persona,
        conversation: input.conversation,
        // #405: lets `phantombot workspace lock/unlock` attribute a claim to the
        // turn that made it, so a release from a different turn is refused.
        turnId,
        workingDir: input.workingDir,
        // Harness temp files land under the persona's own dir, not the shared
        // system /tmp (issue #365) — per-persona isolation + survives a full /tmp.
        tmpBaseDir: join(input.agentDir, "tmp"),
        idleTimeoutMs: input.idleTimeoutMs,
        hardTimeoutMs: input.hardTimeoutMs,
        startupTimeoutMs: input.startupTimeoutMs,
        mcpMode: input.mcpMode,
        toolsMode: input.toolsMode,
        signal: input.signal,
      },
      { onToolCall: toolSink },
    )) {
      if (chunk.type === "text") finalText += chunk.text;
      if (chunk.type === "done") {
        // The done chunk carries the authoritative finalText — prefer it
        // over our running accumulation in case the harness reformatted.
        finalText = chunk.finalText;
        succeeded = true;
      }
      yield chunk;
    }
  } finally {
    flushDigest();
  }

  // Mark delivered only now that the turn actually SUCCEEDED. At-least-once by
  // design — a turn that dies mid-flight re-delivers on the next one. Marking
  // at injection time would drop a background turn's only trace precisely when
  // the box is unhealthy, which is when it matters most.
  // ONLY the digests actually shown. The overflow appeared as a bare count, so
  // nobody has read it; marking it delivered here would destroy the record of a
  // background turn the principal never saw, which is precisely the gap #405
  // exists to close. It stays pending and leads the next turn's batch.
  if (succeeded && shownDigests.length > 0) {
    markDelivered(shownDigests.map((d) => d.id));
  }

  if (succeeded && !input.noHistory) {
    await input.memory.appendTurnPair(
      {
        persona: input.persona,
        conversation: input.conversation,
        role: "user",
        text: input.userMessage,
        // Provenance for durable-fact extraction. A TRUSTED turn is the
        // principal (owner) speaking → highest trust. An untrusted turn is a
        // third party in a shared context → `other`, down-weighted and
        // fast-decayed so a group member's claim can't masquerade as something
        // the owner told us in the persona-wide fact pool. `userSource` lets a
        // self-scheduled caller (tick task wake) override this to `self` so its
        // own prompt isn't stamped as an untrusted stranger — see the field doc.
        source:
          input.userSource ?? (input.trusted === true ? "principal" : "other"),
        origin: input.origin ?? "channel",
      },
      {
        persona: input.persona,
        conversation: input.conversation,
        role: "assistant",
        text: finalText,
        // The persona's own reply enters `unverified`, NOT `self` — this is the
        // #327 fix. An assistant turn is a blend of the persona's reasoning and
        // whatever untrusted bytes a tool (curl, gog, headless chrome, exec)
        // pulled in mid-turn, and we cannot separate them at this layer, so
        // nothing the persona emits is trusted first-hand until the principal
        // engages with it (which re-asserts the claim on a `principal` turn and
        // promotes the fact). Fail-closed: the default is untrusted, and it takes
        // an interaction to earn trust, not a flag to lose it. `assistantSource`
        // still lets an autonomous caller (tick task wake) pin `other` explicitly.
        source: input.assistantSource ?? "unverified",
        origin: input.origin ?? "channel",
      },
    );

    // Purge-after-ruling. On a TRUSTED turn that SUCCEEDS, drop any
    // quarantined held-payload rows in THIS conversation. Rationale: by the
    // time the principal has taken a trusted turn here, the held untrusted
    // payload has already been replayed into context once (this very turn),
    // grounding their approve/deny, and the agent has had its chance to
    // record the ruling — the judge-reasoning turn (embeddable assistant
    // turn) and any `memory capture --tag decision` are KEPT; only the raw
    // verbatim untrusted payload (embeddable=0) is dropped. Deliberate
    // tradeoff: the raw payload is retained for grounding for exactly one
    // trusted turn, then purged so verbatim untrusted text isn't kept long-
    // term. Best-effort: a purge failure must never break the turn.
    // purgeQuarantined is a no-op (returns 0) when there are no quarantined
    // rows, so calling it unconditionally on trusted success is safe.
    if (input.trusted === true) {
      try {
        await input.memory.purgeQuarantined(input.persona, input.conversation);
      } catch {
        // Quarantine cleanup must never turn a successful reply into an error.
      }
    }

    if (input.indexTurns) {
      try {
        await input.indexTurns();
      } catch {
        // Derived indexing must never turn a successful reply into an error.
      }
    }

    // Durable-fact extraction at the eviction cliff — the WRITE half. Fired
    // OUT OF BAND: unlike indexTurns (a cheap embed we await), extraction runs
    // a full model call on the primary harness, so awaiting it would delay the
    // interactive turn's completion. We deliberately do NOT await — the reply
    // is already fully streamed by now; extraction catches up in the
    // background. A throw is swallowed so a failing extraction can never break
    // the turn. `false`/undefined skips it entirely (the test seam).
    if (input.extractFacts) {
      const extract = input.extractFacts;
      void Promise.resolve()
        .then(() => extract())
        .catch(() => {
          // Out-of-band extraction must never surface to the user.
        });
    }
  }
}
