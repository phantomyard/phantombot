/**
 * Threat-screen wiring for untrusted turns.
 *
 * `makeScreener` builds the `screen` function runTurn calls on every
 * UNTRUSTED turn (trusted turns skip it — the authenticated principal is
 * the gate). It is the side-effecting orchestration around the pure judge
 * in lib/threatJudge.ts, in the same shape as makeRetriever: a factory that
 * closes over config and returns an injectable per-turn function.
 *
 * Flow, all IN CODE so a model can never fake it (the bug that started this
 * whole redesign was a model *claiming* it had notified/recorded):
 *
 *   1. BRIEFING — the judge runs as the FULL PERSONA, narrowed. This is the
 *      deliberate reversal the principal approved: instead of semantic-
 *      searching three drawers and feeding the judge a handful of TRUNCATED
 *      FTS snippets, the screener loads the persona (identity + MEMORY) and
 *      reads the decisions/people/norms drawers VERBATIM — concatenated and
 *      hard-truncated at a shared DRAWERS_CAP_BYTES budget across all three,
 *      not per drawer; the cut is a raw byte slice, so it can land mid-entry —
 *      then composes them into the judge's system prompt via
 *      buildSystemPrompt + JUDGE_NARROWING.
 *      The judge therefore has the principal's real context — identity, prior
 *      rulings, known senders, documented norms — as verbatim text rather
 *      than snippets, which fixes the old "nuance lost to truncation" problem
 *      (concern #1) for everything that fits under the cap. The drawers are
 *      still scoped to decisions/people/norms (capped at ~16KB), so finances/
 *      inbox stay out of the judge; what changed is they are now verbatim
 *      drawer text, and MEMORY/identity also inform the judge. Best-effort:
 *      if the persona can't load, the judge falls back to the module
 *      JUDGE_SYSTEM classifier (no persona context) and still screens.
 *   2. JUDGE — run the tool-less harness judge over the content, with the
 *      narrowed persona as its system prompt. It returns a score 0–100. The
 *      judge has no tools, so it cannot act on what it reads; we consume only
 *      its number. (The legacy <briefing>/priors channel still EXISTS in
 *      threatJudge — we just stop populating it; persona context replaces it,
 *      so priors is passed empty.)
 *   3. score <  THREAT_THRESHOLD → {action:"pass"}; the turn proceeds
 *      silently. No notification — quiet when safe (the "don't nag" rule).
 *   4. score >= THREAT_THRESHOLD → HOLD (fail-closed):
 *        - The untrusted turn does NOTHING. runTurn returns the heldMessage
 *          instead of running the harness. Untrusted entry points are
 *          one-shot, so "held" == the action simply never happened — the
 *          fail-closed default. There is no paused process to time out; if
 *          the principal wants it done, they say so.
 *        - `phantombot notify` opens a CONVERSATION on Telegram (in CODE):
 *          what arrived, why it tripped, and the concern to weigh —
 *          phrased to be talked through, not answered yes/no.
 *        - GROUNDING WRITE (the crux fix, concern D+E): the held episode is
 *          written into the PRINCIPAL'S telegram conversation(s) — NOT the
 *          untrusted entry point's. See recordHeld below for why.
 *
 * What the screener deliberately does NOT do: write a decision. Decisions
 * are recorded ONLY from a TRUSTED turn — i.e. when the principal talks it
 * through on Telegram and concludes. The judge writes nothing; the untrusted
 * turn writes nothing. That is the whole point: an attacker can never author
 * "the principal approved this". The trusted reply is the only thing that
 * records a ruling, and that ruling is what recall reads next time.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * CONVERSATION SCOPING OF THE HELD EPISODE (concern D+E) — READ THIS.
 *
 * A held untrusted episode arrives under SOME entry-point conversation key
 * (e.g. an email-woken `phantombot ask`), but the principal's approve/deny
 * reply arrives in THEIR telegram conversation (`telegram:<userId>`) — a
 * DIFFERENT conversation, the one the notify lands in. The 30-turn history
 * replay is per-conversation, so for the principal's reply to be GROUNDED in
 * what was held, the held episode must be written into the PRINCIPAL'S
 * telegram conversation, the same one the notify went to.
 *
 * So on HOLD we write a turn PAIR per principal conversation, in order:
 * first a QUARANTINED user turn carrying the raw untrusted payload
 * (embeddable:false — never indexed/embedded; see memory/store.ts + the
 * turnIndexer), written HERE by the screener (recordHeld); then the
 * embeddable assistant turn carrying the judge-notification text, persisted
 * by runNotify as its `[notification] ` row. Ordering matters: the notify
 * row must land LAST, so the assistant-authored, safely-truncated text — not
 * the raw untrusted payload — is the closing row before the principal's
 * reply. Single-writer for the notify text (runNotify only) is what prevents
 * one held event double-counting in retrieval (#381). The pair replays into
 * the principal's next turn so "yes, go ahead" / "no" has a referent. The
 * scoping is done HERE in the screener, correctly targeted at the principal
 * — NOT in turn.ts's hold path (which is scoped to the untrusted entry
 * point, the wrong conversation).
 * ─────────────────────────────────────────────────────────────────────────
 *
 * Fail-OPEN on judge/recall error by design: if screening itself errors
 * (harness down, bad JSON), the screener returns "pass" and logs. A
 * screening outage degrades to "unscreened", never "app down" — chasing
 * fail-closed on infrastructure hiccups would enshittify the assistant.
 * The trusted-source gate remains the real floor regardless. (Note this is
 * distinct from the HOLD fail-closed in step 4, which is about an
 * answered-vs-unanswered escalation, not an infra error.)
 */

import { readFile } from "node:fs/promises";
import { join } from "node:path";

import {
  type Config,
  personaDir,
} from "../config.ts";
import type { Harness } from "../harnesses/types.ts";
import { log } from "../lib/logger.ts";
import {
  buildSystemPrompt,
  type ChannelContext,
} from "../persona/builder.ts";
import { loadPersona, type PersonaFiles } from "../persona/loader.ts";
import { loadPhantomchatPersonaConfig } from "../channels/phantomchat/personaStore.ts";
import type { MemoryStore } from "../memory/store.ts";
import {
  JUDGE_NARROWING,
  judgeThreat,
  makeChainJudgeComplete,
  THREAT_THRESHOLD,
  type JudgeResult,
} from "../lib/threatJudge.ts";
import { runNotify } from "../cli/notify.ts";
import type { DrawerKind } from "../memory/drawers.ts";
import { drawerPath } from "../memory/drawerIngest.ts";
import {
  drawerSection,
  openDrawerStore,
  type DrawerBriefingSection,
} from "../memory/drawerSync.ts";

export interface ScreenVerdict {
  /** "pass" → run the turn normally; "hold" → already escalated, stop. */
  action: "pass" | "hold";
  /** Threat score (0–100). */
  score: number;
  /** Why — the judge's rationale. */
  reason: string;
  /** The concern put to the principal (hold only). */
  question?: string;
  /** What runTurn shows the untrusted caller in place of a real reply. */
  heldMessage?: string;
}

const PASS_ON_ERROR = (score: number, reason: string): ScreenVerdict => ({
  action: "pass",
  score,
  reason,
});

/**
 * The threat judge's briefing drawers — and ONLY these. Decisions (prior
 * rulings), people (known senders), norms (what's routine in the principal's
 * world). Scoping the persona-as-judge briefing to these three keeps it
 * threat-relevant and keeps sensitive operational memory (finances, inbox,
 * daily dumps, commitments) out of the judge entirely.
 *
 * Since #410 the briefing is built from RANKED `drawer_entries` rows: highest
 * decayed score first, superseded and dormant entries excluded. The markdown
 * file is the fallback for a drawer with no rows yet (fresh persona, first
 * heartbeat not yet run, wiped database), so the judge is never briefed on an
 * empty drawer just because the projection is cold.
 *
 * The order still matters — the three are concatenated IN THIS ORDER — but a
 * long early drawer no longer starves a later one: each gets a share of the
 * byte budget and gives its unused share back (see `packBriefing`).
 */
export const BRIEFING_KINDS: readonly DrawerKind[] = [
  "decisions",
  "people",
  "norms",
];

/**
 * The same three drawers as file paths — the per-drawer FILE FALLBACK only.
 *
 * DERIVED from BRIEFING_KINDS rather than restated, so the scaffold coupling
 * test below cannot pass while the row path and the file path disagree about
 * which drawers the judge briefs from.
 *
 * Exported so the scaffold can be tested against it: a drawer the judge briefs
 * from but `ensurePersonaScaffold` never seeds is invisible on a fresh persona
 * (missing files are silently skipped below), so the coupling is asserted in
 * tests rather than left to memory. These paths never appear in prompt text
 * (issue #419): the briefing heading is the bare drawer kind.
 */
export const BRIEFING_DRAWERS: readonly string[] =
  BRIEFING_KINDS.map(drawerPath);

/**
 * Cap on the concatenated drawer text injected into the judge's prompt.
 * Verbatim drawer text (concern #1's fix) but bounded so a runaway drawer
 * can't blow the judge's context. The slice is by BYTES, not entries: an
 * oversized briefing is cut wherever the budget runs out, not rounded down to
 * an entry boundary. ~16KB ≈ 4K tokens — generous for three drawers.
 */
const DRAWERS_CAP_BYTES = 16 * 1024;

/** Cap on the raw untrusted payload written into the principal's history. */
const HELD_PAYLOAD_CAP = 2000;

/**
 * A held-episode write into one principal conversation: the quarantined raw
 * payload. The judge's notify text is deliberately NOT part of this write —
 * runNotify persists it (#381: single writer, no double-counted retrieval).
 */
export interface HeldEpisode {
  conversation: string;
  payload: string;
}

export interface ScreenerDeps {
  /**
   * Override recall (tests / back-compat). Returns prior-rulings text, or ""
   * for none. Production no longer sets this — the persona context replaces
   * the FTS briefing — but the hook is kept so older tests that still pass a
   * `recall` (and assert it reaches the judge as priors) keep working.
   */
  recall?: (content: string, signal?: AbortSignal) => Promise<string>;
  /** Override the judge (tests). */
  judge?: (
    content: string,
    priors: string,
    signal?: AbortSignal,
  ) => Promise<JudgeResult>;
  /** Override the notify side-effect (tests). Returns 0 on success. */
  notify?: (message: string) => Promise<number>;
  /**
   * Override the held-episode grounding write (tests). Production writes the
   * quarantined payload into each principal conversation via the MemoryStore;
   * tests inject a stub to assert what would be written without a real store.
   */
  recordHeld?: (episode: HeldEpisode) => Promise<void>;
}

/**
 * Build the per-turn screen function for `persona` / `conversation`.
 *
 * Unlike the previous Gemini-keyed design, this ALWAYS returns a screener:
 * the judge runs on the harness, which is always present, so there is no
 * "no key ⇒ screening silently off" hole.
 *
 * `memory` is the open store; on a HOLD the screener writes the held episode
 * into the principal's telegram conversation(s) through it (concern D+E). The
 * persona files are loaded ONCE here (best-effort) and cached for the life of
 * the screener so every screened turn reuses the same narrowed-judge prompt.
 */
export function makeScreener(
  config: Config,
  persona: string,
  // Decisions/recall are global to the persona, not conversation-scoped, so
  // this is unused today — kept for call-site symmetry with makeRetriever and
  // so a future conversation-scoped recall needs no signature change.
  _conversation: string,
  // The turn's harness chain — the judge runs on the PRIMARY harness in it
  // (chain[0], whichever binary the user configured). An empty chain (e.g. a
  // test fake chain with no harness) → screening fails open and spawns nothing.
  harnesses: Harness[],
  // The open memory store. On a HOLD the screener writes the held episode
  // into the principal's telegram conversation(s) so their approve/deny reply
  // is grounded. Pass-through from the engine's `input.memory`.
  memory: MemoryStore,
  deps: ScreenerDeps = {},
): (content: string, signal?: AbortSignal) => Promise<ScreenVerdict> {
  // Load + cache the persona ONCE per screener so the judge runs as the full
  // narrowed persona (persona-as-judge). Lazy + best-effort: if it throws
  // (persona dir missing, unreadable), we fall back to undefined so the judge
  // uses the module JUDGE_SYSTEM classifier and still screens.
  let personaFilesPromise: Promise<PersonaFiles | undefined> | undefined;
  const loadPersonaFiles = (): Promise<PersonaFiles | undefined> => {
    if (!personaFilesPromise) {
      personaFilesPromise = (async () => {
        try {
          return await loadPersona(personaDir(config, persona));
        } catch (e) {
          log.warn(
            `screen: persona load failed, judging with fallback classifier: ${(e as Error).message}`,
          );
          return undefined;
        }
      })();
    }
    return personaFilesPromise;
  };

  const judge =
    deps.judge ??
    (async (
      content: string,
      _priors: string,
      signal?: AbortSignal,
    ): Promise<JudgeResult> => {
      // Spawn the judge in the persona's own dir, never the ambient cwd — an
      // inaccessible cwd makes the harness spawn EACCES, which would fail the
      // screen OPEN (silently unscreened). personaDir is owned by the running
      // persona user; threatJudge floors it at homedir() as a backstop. Resolve
      // defensively: a degenerate config must degrade to that floor, not throw
      // on the screening path.
      let judgeCwd: string | undefined;
      try {
        judgeCwd = personaDir(config, persona);
      } catch {
        judgeCwd = undefined; // → threatJudge floors at homedir()
      }
      const complete = makeChainJudgeComplete(harnesses, config, judgeCwd);
      if (!complete) {
        // No harness available to screen with (empty chain) — fail open.
        return { ok: false, error: "no harness in chain for screening" };
      }
      // Compose the judge's system prompt from the FULL narrowed persona: the
      // persona's own system prompt (identity + MEMORY + the full drawers in
      // the retrievedMemory slot), then JUDGE_NARROWING to collapse it to the
      // one rating job. If the persona didn't load, systemPrompt stays
      // undefined and threatJudge falls back to JUDGE_SYSTEM.
      const personaFiles = await loadPersonaFiles();
      let systemPrompt: string | undefined;
      if (personaFiles) {
        const untrustedCtx: ChannelContext = {
          channel: "screen",
          conversationId: _conversation,
          timestamp: new Date(),
          trusted: false,
        };
        const drawersText = await readBriefingDrawers(config, persona);
        systemPrompt =
          buildSystemPrompt(personaFiles, untrustedCtx, drawersText) +
          "\n\n" +
          JUDGE_NARROWING;
      }
      // priors is intentionally empty in production — the persona context
      // replaces the old FTS briefing. The <briefing> channel still exists in
      // threatJudge; we just don't feed it. (deps.recall, when set by an older
      // test, is still honoured below and passed through as priors.)
      return judgeThreat(content, {
        complete,
        priors: _priors,
        systemPrompt,
        signal,
      });
    });

  // Back-compat: an older test may inject `recall` (expecting its output to
  // reach the judge as priors). Honour it; production leaves it unset and the
  // persona context is the briefing.
  const recall = deps.recall;

  // Route the escalation notify for THIS persona. runNotify reaches the first
  // owner of every configured channel (persona-bound Telegram bot — falling back
  // to the default bot — AND the persona's phantomchat identity), which is
  // exactly the set principalConversations() grounds into, so the owner's
  // approve/deny reply always has a referent regardless of which channel they
  // answer on. (Generalises the PR #172 fix from telegram-only to multi-channel.)
  const notify =
    deps.notify ??
    ((message: string) => runNotify({ config, message, persona }));

  // The grounding write. Default: write ONLY the quarantined payload into
  // the principal's conversation. The judge's notification text is NOT
  // written here — runNotify already persists it into the same conversation
  // (prefixed `[notification] `, origin `notification`), so writing it again
  // lands two embeddable, indexed copies of one event and double-counts it
  // in retrieval (#381). runNotify is the single writer of the notify text.
  //
  // Trade-off accepted: if notify delivery fails outright, no assistant
  // grounding row lands — but then the principal never saw the notification
  // either, and the quarantined payload row below still anchors the episode.
  const recordHeld =
    deps.recordHeld ??
    (async (episode: HeldEpisode): Promise<void> => {
      await memory.appendTurn({
        persona,
        conversation: episode.conversation,
        role: "user",
        // QUARANTINED: raw untrusted payload — replays in history to ground
        // the principal's reply, but never indexed/embedded (embeddable
        // false) and purged once a trusted turn rules. See store.ts.
        text: episode.payload,
        embeddable: false,
      });
    });

  return async (content: string, signal?: AbortSignal): Promise<ScreenVerdict> => {
    // 1. Optional legacy recall (best-effort; never throws → ""). Production
    //    leaves recall unset; the persona context is the briefing now.
    let priors = "";
    if (recall) {
      try {
        priors = await recall(content, signal);
      } catch (e) {
        log.warn(`screen: recall failed, judging without priors: ${(e as Error).message}`);
      }
    }

    // 2. Judge (fail-open on any judge error). The default judge runs as the
    //    narrowed persona (it closes over _conversation for its channel
    //    context); an injected test judge uses the legacy 3-arg shape.
    let result: JudgeResult;
    try {
      result = await judge(content, priors, signal);
    } catch (e) {
      log.warn(`screen: judge threw, failing open: ${(e as Error).message}`);
      return PASS_ON_ERROR(0, "screen error (failed open)");
    }
    if (!result.ok) {
      log.warn(`screen: judge unavailable, failing open: ${result.error}`);
      return PASS_ON_ERROR(0, `screen unavailable (failed open): ${result.error}`);
    }

    const v = result.verdict;
    if (v.score < THREAT_THRESHOLD) {
      return { action: "pass", score: v.score, reason: v.reason };
    }

    // 3. GROUNDING WRITE (concern D+E) — BEFORE notifying. Write the held
    //    episode into each principal telegram conversation so the principal's
    //    approve/deny reply (which lands in telegram:<userId>, NOT this
    //    untrusted entry point) replays the payload and is grounded.
    //    runNotify (step 4) then closes the episode with safe, truncated text
    //    as the LAST row — so the principal's next reply is preceded by the
    //    notify message, not raw untrusted payload (#395 review: turn
    //    ordering). Best-effort: a failure logs but must NEVER downgrade the
    //    hold to a pass and must never throw out of the screener. No-op when
    //    telegram isn't configured or the allowlist is empty.
    const concern =
      v.question && v.question.trim().length > 0
        ? v.question.trim()
        : "I'm not sure this is safe to act on — can we talk it through?";
    const preview = content.replace(/\s+/g, " ").trim().slice(0, 280);
    const notifyMessage =
      `🔒 I held an untrusted request (threat ${v.score}/100) — nothing was done.\n` +
      `Why: ${v.reason}\n` +
      `What it asked: "${preview}"\n` +
      `${concern}`;

    try {
      const payload = content.replace(/\s+/g, " ").trim().slice(0, HELD_PAYLOAD_CAP);
      for (const conversation of principalConversations(config, persona)) {
        try {
          await recordHeld({ conversation, payload });
        } catch (e) {
          log.warn(
            `screen: held-episode write failed for ${conversation} (hold still stands): ${(e as Error).message}`,
          );
        }
      }
    } catch (e) {
      // Defensive belt-and-suspenders: resolving the principal list must never
      // bring down the screener or weaken the hold.
      log.warn(`screen: held-episode grounding skipped: ${(e as Error).message}`);
    }

    // 4. NOTIFY — AFTER the grounding write so the notify text is the last
    //    row in the principal's conversation. runNotify persists the notify
    //    message into the same conversation (single writer, #381), closing
    //    the episode with safe, truncated text rather than raw payload.
    try {
      const code = await notify(notifyMessage);
      if (code !== 0) log.warn(`screen: notify exited ${code} for held request`);
    } catch (e) {
      log.warn(`screen: notify failed for held request: ${(e as Error).message}`);
    }

    return {
      action: "hold",
      score: v.score,
      reason: v.reason,
      question: concern,
      heldMessage:
        "🔒 That request touched something sensitive, so I've paused it and " +
        "pinged the owner to talk it through before doing anything. Nothing was done.",
    };
  };
}

/**
 * Resolve the principal conversation key(s) for this persona — one per
 * configured channel's PRIMARY (first) owner, matching where `notify` lands the
 * held-request alert. The principal's approve/deny reply arrives in one of these
 * conversations, so the held episode must be grounded into each.
 *
 *   - Telegram: persona-bound bot if configured, else the default bot; the
 *     first allowed user id → `telegram:<userId>`.
 *   - Phantomchat: the persona's first allowed npub → `phantomchat:<hex>` (the
 *     server keys conversations by the lowercase sender hex).
 *
 * Empty when neither channel is configured / has an owner (grounding no-op).
 *
 * NOTE: Telegram uses the FIRST id only now (not every id), to mirror notify's
 * first-owner-per-channel routing — the grounding target must match the notify
 * recipient or the reply has no referent.
 */
function principalConversations(config: Config, persona: string): string[] {
  const out: string[] = [];

  const account =
    config.channels.telegramPersonas?.[persona] ?? config.channels.telegram;
  const firstId = account?.allowedUserIds[0];
  if (firstId !== undefined) {
    out.push(`telegram:${firstId}`);
  }

  try {
    const pc = loadPhantomchatPersonaConfig(personaDir(config, persona));
    const firstHex = pc?.allowedHex[0];
    if (firstHex) {
      out.push(`phantomchat:${firstHex.toLowerCase()}`);
    }
  } catch {
    // No phantomchat config / unresolvable persona dir — telegram-only grounding.
  }

  return out;
}

/**
 * Which persona name to route the escalation notify through, mirroring
 * principalConversations()'s account selection: the persona's own bot when
 * `channels.telegram.personas.<persona>` is configured, else undefined (route
 * through the default bot). Returning the name — not the account object — keeps
 * it aligned with runNotify's `persona` option, so notify reuses runNotify's
 * own account resolution and error messaging. Exported for regression tests.
 */
export function resolveNotifyPersona(
  config: Config,
  persona: string,
): string | undefined {
  return config.channels.telegramPersonas?.[persona] !== undefined
    ? persona
    : undefined;
}

/**
 * Build the threat judge's drawer briefing.
 *
 * Ranked rows first (`drawer_entries`, highest decayed score, `active` only),
 * markdown file as the per-drawer fallback. Sections are concatenated in
 * BRIEFING_KINDS order and packed into DRAWERS_CAP_BYTES by `packBriefing`.
 *
 * Best-effort throughout: a database that will not open, a missing drawer, an
 * unreadable file — each degrades to less briefing, never to a throw. This
 * runs ahead of every untrusted turn, so a failure here must not be able to
 * take the screen down with it.
 *
 * Returns undefined when no drawer yields anything, so buildSystemPrompt omits
 * the retrieved-context slot entirely.
 */
async function readBriefingDrawers(
  config: Config,
  persona: string,
): Promise<string | undefined> {
  let dir: string;
  try {
    dir = personaDir(config, persona);
  } catch {
    return undefined;
  }

  const sections = await collectBriefingSections(config, dir, persona);
  if (sections.length === 0) return undefined;
  return packBriefing(sections, DRAWERS_CAP_BYTES);
}

async function collectBriefingSections(
  config: Config,
  dir: string,
  persona: string,
): Promise<DrawerBriefingSection[]> {
  let opened: Awaited<ReturnType<typeof openDrawerStore>> | undefined;
  try {
    opened = await openDrawerStore(config.memoryDbPath);
  } catch (e) {
    log.warn("screen: drawer rows unavailable, briefing from files", {
      error: (e as Error).message,
    });
  }
  try {
    const sections: DrawerBriefingSection[] = [];
    for (const kind of BRIEFING_KINDS) {
      try {
        const section = opened
          ? await drawerSection(opened.store, dir, persona, kind)
          : await fileSection(dir, kind);
        if (section) sections.push(section);
      } catch {
        // Missing/unreadable drawer — skip it; the judge briefs on what exists.
      }
    }
    return sections;
  } finally {
    opened?.close();
  }
}

/** File-only section, for when the row store could not be opened at all. */
async function fileSection(
  dir: string,
  kind: DrawerKind,
): Promise<DrawerBriefingSection | undefined> {
  const text = (await readFile(join(dir, drawerPath(kind)), "utf8")).trim();
  return text.length > 0 ? { kind, text, from: "file" } : undefined;
}

/**
 * Fit the sections into `capBytes`, dropping whole ENTRIES rather than slicing
 * bytes.
 *
 * The old reader concatenated everything and cut the result at the cap, which
 * had two failure modes that both hurt exactly when the briefing mattered
 * most: a 663 KB `decisions.md` consumed the entire budget and `norms` — the
 * drawer that stops the judge crying wolf — never reached the prompt at all;
 * and the cut landed mid-entry, so the judge read half a ruling as if it were
 * the whole one.
 *
 * So: each section gets an equal share, any section that needs less hands the
 * remainder back, and a section that still overflows is trimmed line by line
 * (an entry is one line — see renderEntry) with an explicit marker. Two passes
 * over at most three drawers; the redistribution is not iterated to a fixed
 * point because the win is almost entirely in the first give-back.
 *
 * Section headers are the bare drawer KIND (`## decisions`), never a file
 * path: the drawers are database rows since #418, and telling the judge its
 * briefing came from a `memory/decisions.md` that no longer exists is a small
 * lie in prompt text (issue #419).
 */
export function packBriefing(
  sections: DrawerBriefingSection[],
  capBytes: number,
): string | undefined {
  if (sections.length === 0) return undefined;
  const rendered = sections.map((s) => `## ${s.kind}\n\n${s.text}`);
  const total = rendered.reduce((n, t) => n + Buffer.byteLength(t, "utf8"), 0);
  const joinCost = 2 * (rendered.length - 1);
  if (total + joinCost <= capBytes) return rendered.join("\n\n");

  const budget = capBytes - joinCost;
  const even = Math.floor(budget / rendered.length);
  const sizes = rendered.map((t) => Buffer.byteLength(t, "utf8"));
  // Give-back pass: everything under its share frees the difference, and the
  // over-share sections split the freed bytes evenly.
  const spare = sizes.reduce((n, size) => n + Math.max(0, even - size), 0);
  const overflowing = sizes.filter((size) => size > even).length;
  const bonus = overflowing > 0 ? Math.floor(spare / overflowing) : 0;

  const out = rendered.map((text, i) =>
    sizes[i]! <= even ? text : trimToBytes(text, even + bonus),
  );
  return out.join("\n\n");
}

/**
 * Trim text to `limit` bytes on a LINE boundary, marking the cut.
 *
 * Never returns a partial line: a half-entry reads to the judge as a complete
 * one, which is worse than a shorter briefing. If even the header line does
 * not fit, the section is dropped to its header alone plus the marker.
 */
function trimToBytes(text: string, limit: number): string {
  const marker = "\n[drawer trimmed at cap]";
  const room = limit - Buffer.byteLength(marker, "utf8");
  const lines = text.split("\n");
  const kept: string[] = [];
  let used = 0;
  for (const line of lines) {
    const cost = Buffer.byteLength(line, "utf8") + (kept.length > 0 ? 1 : 0);
    if (used + cost > room) break;
    kept.push(line);
    used += cost;
  }
  return kept.join("\n") + marker;
}
