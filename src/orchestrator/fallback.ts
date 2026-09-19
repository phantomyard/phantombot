/**
 * Run a HarnessRequest through a chain of harnesses, advancing on
 * recoverable errors and stopping on success or terminal error.
 *
 * Yields chunks from whichever harness ends up handling the turn. The
 * caller doesn't need to know which one won; it just consumes the stream.
 *
 * Pre-spawn precheck: if a harness declares maxPayloadBytes and the turn
 * would exceed it, the orchestrator skips that harness without spawning
 * a subprocess. This matters for Pi, which takes its payload via argv
 * and is bounded by Linux ARG_MAX. The skip is treated as a recoverable
 * error so the chain falls through to the next harness (typically claude,
 * which has no payload ceiling).
 *
 * Cooldown semantics (see src/lib/cooldown.ts):
 *   - Each recoverable failure (recoverable error chunk, or a harness
 *     that throws) bumps the harness's cooldown counter. An empty `done`
 *     does NOT: the process ran cleanly, so the empty output is a
 *     model-output flake rather than a health signal — cooling the
 *     harness for it benches the one working fallback behind a dead
 *     primary (#499).
 *   - A successful turn (done with non-empty finalText, OR a "best we
 *     can do" empty-done from the last harness) clears the harness's
 *     counter. Note that the alerter does NOT treat that empty-done as a
 *     success: nothing was delivered, so its incident stays open and three
 *     in a row fire a DEGRADED push (#501).
 * Resume-with-context (issue #459): a harness killed by the idle watchdog
 * AFTER it had already streamed output is respawned ONCE, in the same chain
 * slot, with a preamble describing what it had said and which tool calls were
 * in flight. Only then does the chain advance. See orchestrator/resume.ts.
 *
 *   - At turn start, a snapshot is taken; harnesses whose cooldown is
 *     active are skipped in chain order. Escape hatch: if EVERY harness
 *     in the chain is currently cooled, the snapshot is ignored and we
 *     try them in chain order anyway. Better to give the user a
 *     possibly-flaky reply than to refuse outright.
 */

import type { Harness, HarnessChunk, HarnessRequest } from "../harnesses/types.ts";
import { type CooldownStore, cooldownStore as defaultStore } from "../lib/cooldown.ts";
import {
  classifyFailure,
  type HarnessAlerter,
  type HarnessFailureCause,
  harnessAlerter as defaultAlerter,
} from "../lib/harnessAlert.ts";
import { log } from "../lib/logger.ts";
import type { AuditSink } from "../lib/auditLog.ts";
import {
  buildResumeRequest,
  MAX_RESUME_ATTEMPTS,
  PartialAttempt,
  shouldResume,
} from "./resume.ts";

/**
 * Who last served each conversation. Drives the "announce the SWITCH, not the
 * state" rule for the fallback reply tag.
 *
 * A quota window is hours long, so tagging every fallback-served reply appends
 * "answered by X fallback (...)" to every message for an entire afternoon.
 * That is drama, not transparency: the user learns nothing after the first
 * one, and the tag goes out in front of third parties in group chats each
 * time. The brain CHANGING is news; the brain STAYING changed is not.
 *
 * Process-local and bounded — losing it across a restart costs exactly one
 * redundant tag, which is the safe direction to fail.
 */
const MAX_SERVED_HISTORY = 500;

export function rememberServed(
  history: Map<string, string>,
  conversation: string,
  harnessId: string,
): boolean {
  const changed = history.get(conversation) !== harnessId;
  if (changed && history.size >= MAX_SERVED_HISTORY) {
    // Map iterates in insertion order: the oldest key is the coldest
    // conversation. Evicting it can only cause a redundant tag later.
    const oldest = history.keys().next();
    if (!oldest.done) history.delete(oldest.value);
  }
  history.set(conversation, harnessId);
  return changed;
}

const servedHistory = new Map<string, string>();

/** Test seam: forget who served what. */
export function resetServedHistory(): void {
  servedHistory.clear();
}

export interface RunWithFallbackOptions {
  /**
   * Cooldown store. Defaults to the process-wide singleton; tests inject
   * a fresh `new CooldownStore()` to avoid cross-test bleed.
   */
  cooldown?: CooldownStore;
  /**
   * Optional tool-call audit sink (issue #282). Called once per tool-call
   * `progress` chunk, whichever harness produced it — this is the single
   * point every harness's chunk stream flows through, so one hook here
   * covers all four adapters. Undefined = no auditing (the default for
   * tests and degraded paths). Contracted to never throw; it must not be
   * able to break the turn.
   */
  onToolCall?: AuditSink;
  /**
   * Health alerter. Defaults to the process-wide singleton, which is silent
   * until `phantombot run` installs a sender — so tests and one-shot CLI
   * paths alert nobody unless they inject their own.
   */
  alerter?: HarnessAlerter;
  /**
   * Who last served each conversation. Defaults to the process-wide map; tests
   * inject a fresh one to avoid cross-test bleed.
   */
  servedHistory?: Map<string, string>;
}

export async function* runWithFallback(
  chain: Harness[],
  req: HarnessRequest,
  options: RunWithFallbackOptions = {},
): AsyncIterable<HarnessChunk> {
  if (chain.length === 0) {
    yield {
      type: "error",
      error: "no harnesses configured",
      recoverable: false,
    };
    return;
  }

  const cooldown = options.cooldown ?? defaultStore;
  const alerter = options.alerter ?? defaultAlerter;
  const served = options.servedHistory ?? servedHistory;
  // Callers with no conversation key (one-shot `ask`, degraded paths) have no
  // "previous reply" for a tag to be redundant against, so they always tag.
  // Bucketing them together instead would make the FIRST such call tag and
  // silently un-tag every later one, which is the wrong way round.
  const servedKey = req.conversation;
  const chainIds = chain.map((h) => h.id);
  // Issue #559 transparency: the chain head is who the user "expects" to
  // answer. When anyone else serves the turn, the done chunk gets stamped
  // (fallbackFor/fallbackReason) so channels can tag the reply, and the
  // switch is logged with from → to, reason, timestamp.
  const headId = chain[0]!.id;
  // Why the head didn't take the turn when it was skipped at snapshot time
  // (cooldown or payload cap). Undefined once the head actually runs or
  // fails — firstFailure then carries the reason.
  let headSkipReason: string | undefined;
  // Remembers the first harness that failed this turn, so that if a LATER
  // harness answers we can tell the owner which one is broken and who is
  // covering for it. Only the first matters: that's the primary.
  let firstFailure:
    | { harnessId: string; error: string; cause?: HarnessFailureCause }
    | undefined;
  const priorKillHarness = new Map<string, string>();
  const repeatedKillCausesLogged = new Set<string>();
  const estimatedBytes = estimatePayloadBytes(req);

  // Snapshot cooldown state at turn start. We don't re-poll within the
  // turn — failures we register as we go are scoped to FUTURE turns,
  // not the rest of this one. (Otherwise a single bad turn could cool
  // every harness in the chain mid-flight and we'd skip the next one
  // we were about to try.)
  const cooledIds = new Set<string>();
  for (const h of chain) {
    if (cooldown.isCooledDown(h.id).cooled) cooledIds.add(h.id);
  }
  const allCooled = cooledIds.size === chain.length;
  if (allCooled && chain.length > 0) {
    // Escape hatch: if everyone's cooled we still need to produce a
    // reply, so ignore the snapshot for this turn. Logged loudly because
    // it indicates Andrew should look at upstream auth/quota.
    log.warn(
      "orchestrator: every harness in cooldown — ignoring cooldown for this turn",
      { harnessIds: chain.map((h) => h.id) },
    );
    cooledIds.clear();
  }

  for (let i = 0; i < chain.length; i++) {
    // Short-circuit if the channel layer has already aborted — otherwise
    // every harness in the chain spawns a subprocess just to discover the
    // signal and kill itself, which is wasteful when the user just typed
    // /stop and meant it.
    if (req.signal?.aborted) {
      yield { type: "error", error: "stopped", recoverable: false };
      return;
    }

    const harness = chain[i]!;
    const isLast = i === chain.length - 1;

    if (cooledIds.has(harness.id)) {
      const status = cooldown.isCooledDown(harness.id);
      log.info(
        "orchestrator: skipping harness — cooldown active",
        {
          harnessId: harness.id,
          consecutiveFailures: status.consecutiveFailures,
          cooldownRemainingMs: Math.max(0, status.untilMs - Date.now()),
        },
      );
      if (harness.id === headId) {
        headSkipReason = `primary in cooldown (${Math.max(
          0,
          Math.round((status.untilMs - Date.now()) / 1000),
        )}s remaining)`;
      }
      // Not the last harness: fall through silently. If somehow we're at
      // the last harness while still being cooled (shouldn't happen given
      // the allCooled escape hatch above, but defensive), yield a
      // terminal error rather than producing nothing.
      if (isLast) {
        const error = `all harnesses in chain skipped (last in cooldown: ${harness.id})`;
        await alerter.noteExhausted({
          harnessId: harness.id,
          error,
          chain: chainIds,
        });
        yield { type: "error", error, recoverable: false };
        return;
      }
      continue;
    }

    if (
      harness.maxPayloadBytes !== undefined &&
      estimatedBytes > harness.maxPayloadBytes
    ) {
      if (!isLast) {
        log.warn(
          "orchestrator: skipping harness — payload exceeds maxPayloadBytes",
          {
            harnessId: harness.id,
            estimatedBytes,
            maxPayloadBytes: harness.maxPayloadBytes,
          },
        );
        if (harness.id === headId) {
          headSkipReason = `primary payload cap exceeded (${estimatedBytes} > ${harness.maxPayloadBytes} bytes)`;
        }
        continue;
      }
      yield {
        type: "error",
        error: `payload ${estimatedBytes} bytes exceeds ${harness.id}'s maxPayloadBytes ${harness.maxPayloadBytes} (no remaining harnesses)`,
        recoverable: false,
      };
      return;
    }

    log.info("orchestrator: trying harness", {
      harnessId: harness.id,
      attempt: i + 1,
      of: chain.length,
    });

    let succeeded = false;
    let recoverableError = false;
    // The done we served was empty and there was nowhere else to go (#501).
    // Distinct from `succeeded`: the harness exited cleanly, but the user
    // got "(no reply)", so it must not close the alerter's incident.
    let servedEmpty = false;
    // A harness that THROWS rather than yielding an error chunk. The most
    // important case is a spawn failure — `Bun.spawn` throws E2BIG/ENOENT/
    // EACCES synchronously, before the generator has produced anything — but
    // any bug in an adapter lands here too. Without this catch the exception
    // propagates straight out of runWithFallback and kills the turn, so the
    // chain never advances: a single unspawnable primary silently disables
    // every fallback behind it (#426). Catching it converts the throw into
    // the recoverable error the rest of this loop already knows how to
    // handle.
    let thrown: unknown;

    // ── resume-with-context (#459) ────────────────────────────────────
    // One harness slot, up to two attempts. The second only happens when the
    // first was killed by the IDLE watchdog after it had already streamed
    // something — a wedge mid-flight, the case with no other recovery path:
    // pi's coder ladder declines it (it refuses to replay side effects) and a
    // single-entry chain has no next harness to fall to, so the turn used to
    // be dropped outright. The retry carries a synthesised preamble naming
    // the in-flight tool calls and telling the model to verify before redoing
    // any of them; see orchestrator/resume.ts for the trade being made.
    //
    // This reuses the streaming-first trade-off documented below: the partial
    // narration is already on the user's screen and stays there. The preamble
    // says so, so the resumed attempt continues rather than repeats.
    let resumeAttemptsUsed = 0;
    let attemptReq = req;
    let resumeRequested = true;
    // Text this slot has already streamed under a PREVIOUS attempt. A resumed
    // slot emits its reply across two processes, and the terminal `done` has
    // to account for both — see the stitch below.
    let carriedText = "";
    while (resumeRequested) {
      resumeRequested = false;
      // Chunk log for THIS attempt only — a resume must describe the attempt
      // that actually wedged, not an earlier one it already recovered from.
      const partial = new PartialAttempt();
      try {
      for await (const chunk of harness.invoke(attemptReq)) {
        if (chunk.type === "error") {
          if (chunk.killCause) {
            const priorHarness = priorKillHarness.get(chunk.killCause);
            if (priorHarness && priorHarness !== harness.id && !repeatedKillCausesLogged.has(chunk.killCause)) {
              repeatedKillCausesLogged.add(chunk.killCause);
              log.warn("orchestrator: repeated kill cause across harnesses", {
                cause: chunk.killCause,
                firstHarnessId: priorHarness,
                secondHarnessId: harness.id,
              });
            } else if (!priorHarness) {
              priorKillHarness.set(chunk.killCause, harness.id);
            }
          }
          // Killed mid-flight with work already done: respawn this same
          // harness once, carrying what it had said and started. Checked BEFORE
          // the fall-through branch so a chain that HAS a next harness still
          // prefers the one that was making progress over a cold hand-off to a
          // different model with none of the context.
          if (shouldResume(chunk, partial, resumeAttemptsUsed)) {
            resumeAttemptsUsed++;
            log.warn(
              "orchestrator: harness wedged after producing output — resuming with context",
              {
                harnessId: harness.id,
                error: chunk.error,
                attempt: resumeAttemptsUsed,
                of: MAX_RESUME_ATTEMPTS,
                narrationChars: partial.text.length,
                toolCalls: partial.toolCalls.length,
              },
            );
            carriedText += partial.rawText;
            attemptReq = buildResumeRequest(req, partial);
            resumeRequested = true;
            break;
          }
          if (chunk.recoverable && !isLast) {
            // ─────────────────────────────────────────────────────────────
            // INTENTIONAL, STREAMING-FIRST TRADE-OFF — do not "fix" this by
            // buffering or by deleting already-sent text.
            //
            // If this harness streamed some text chunks before erroring, that
            // text is ALREADY on the user's screen — we yield chunks live, the
            // instant the harness produces them, because phantombot is a
            // conversational agent and low-latency token streaming is the
            // entire point of the experience. When we now fall through to the
            // next harness, the user may briefly see a truncated partial reply
            // followed by a fresh full reply from a different model.
            //
            // That is the ACCEPTED COST of streaming-first, exactly like the
            // at-most-once Telegram offset trade-off elsewhere. The two
            // "clean" alternatives are both worse:
            //   1. Buffer-until-done before showing anything — kills live
            //      streaming and the conversational feel. Non-starter.
            //   2. Delete the already-sent bubbles on fall-through — a
            //      behaviour-risky transport change, and yanking text a user
            //      may have already read is its own jarring UX.
            //
            // A phantom is a conversation, not a transactional render that must
            // commit atomically. A rare doubled/partial reply on a mid-stream
            // harness failure is a calculated, acceptable price for fluid,
            // immediate streaming. Re-litigate with Andrew before changing it.
            // ─────────────────────────────────────────────────────────────
            log.warn(
              "orchestrator: harness recoverable error, falling through",
              {
                harnessId: harness.id,
                error: chunk.error,
                httpStatus: chunk.httpStatus,
              },
            );
            // Cool the harness off — esp. fast for 4XX (the harness
            // detected an upstream auth/quota/capacity issue and we
            // don't want to keep slamming it). markFailure() handles
            // the exponential backoff bookkeeping — or honors the
            // provider's Retry-After when the harness surfaced one
            // (issue #559).
            cooldown.markFailure(harness.id, { retryAfterMs: chunk.retryAfterMs });
            alerter.noteFailure(
              harness.id,
              chunk.error,
              chunk.httpStatus,
              chunk.stderrTail,
            );
            // Classify HERE, while the stderr tail is still in hand. The
            // error line a CLI harness dies with is "codex exited with code 1"
            // — it names no cause at all, and it is the only thing that
            // survives into the done chunk's fallbackReason. Re-classifying it
            // downstream (channels/core/fallbackTag.ts) therefore rendered
            // every subprocess death as "unavailable", including the rate
            // limits this whole path exists to handle.
            firstFailure ??= {
              harnessId: harness.id,
              error: chunk.error,
              cause: classifyFailure(
                chunk.error,
                chunk.httpStatus,
                chunk.stderrTail,
              ),
            };
            recoverableError = true;
            break;
          }
          // Recoverable-but-nowhere-left-to-go: the chain is exhausted and the
          // user gets no reply, so this is an outage worth waking the owner for
          // — the case that would otherwise only ever be visible as "it stopped
          // replying". A TERMINAL error deliberately does NOT alert: it is
          // yielded to the channel as an error chunk, so the user is already
          // looking at it and a push notification only says it twice.
          if (chunk.recoverable) {
            alerter.noteFailure(
              harness.id,
              chunk.error,
              chunk.httpStatus,
              chunk.stderrTail,
            );
            await alerter.noteExhausted({
              harnessId: harness.id,
              error: chunk.error,
              httpStatus: chunk.httpStatus,
              chain: chainIds,
              stderrTail: chunk.stderrTail,
            });
          }
          yield chunk;
          return;
        }
        // Empty `done` = the harness exited cleanly but produced no
        // assistant text (gemini SIGTERMed mid-stream by an updater
        // restart, or a tool-only run with no final message). On a
        // non-last harness, fall through — pi getting a chance is far
        // better than the user seeing "(no reply)". On the last harness,
        // yield it and let the channel surface "(no reply)" so the user
        // knows something happened.
        // Stitch a resumed slot's two attempts back together. `done.finalText`
        // is contracted to be the sum of every text chunk the slot emitted, and
        // consumers lean on that: runTurn persists it as the assistant message,
        // voice and other non-streaming channels deliver only it, and the
        // Telegram/PhantomChat transports diff it against what they already
        // sent to work out the remaining suffix. Forwarding the recovery
        // attempt's own `finalText` unchanged would drop the pre-kill text from
        // history and from voice, and — because the stream no longer matches
        // its own prefix — make the transports resend the recovery text. So the
        // terminal chunk describes the whole stream, not just its tail.
        const emitted: HarnessChunk =
          chunk.type === "done" && carriedText.length > 0
            ? { ...chunk, finalText: carriedText + chunk.finalText }
            : chunk;
        // Issue #559 transparency: a non-head harness serving a non-empty
        // reply stamps WHO was supposed to answer and WHY they didn't, so
        // channels can tag the visible reply. Empty-done fall-throughs are
        // never stamped (they break before yield; and "(no reply)" needs
        // no attribution).
        // Record who is serving BEFORE deciding to tag: the tag announces a
        // change of brain, so it fires only on the turn the answer actually
        // moves. Recorded for the head too, so moving BACK to the primary and
        // failing over again later is a fresh switch, and tags again.
        const switched =
          emitted.type === "done" && emitted.finalText.length > 0
            ? servedKey === undefined ||
              rememberServed(served, servedKey, harness.id)
            : false;
        const fallbackMeta =
          emitted.type === "done" &&
          emitted.finalText.length > 0 &&
          harness.id !== headId &&
          switched
            ? {
                fallbackFor: headId,
                fallbackReason:
                  firstFailure?.error ?? headSkipReason ?? "primary unavailable",
                ...(firstFailure?.cause
                  ? { fallbackCause: firstFailure.cause }
                  : {}),
              }
            : undefined;
        const stamped: HarnessChunk =
          fallbackMeta && emitted.type === "done"
            ? { ...emitted, meta: { ...emitted.meta, ...fallbackMeta } }
            : emitted;
        if (
          emitted.type === "done" &&
          emitted.finalText.length === 0 &&
          !isLast
        ) {
          log.warn(
            "orchestrator: harness produced empty reply, falling through",
            { harnessId: harness.id },
          );
          // Deliberately NO cooldown.markFailure here (#499). An empty
          // `done` means the harness process exited cleanly — the model
          // just produced no text. That is usually a transient flake
          // (reasoning model that spent its whole output budget), not a
          // harness-health failure, and cooling the harness for it can
          // bench the only healthy fallback while a dead primary gets
          // tried instead on the next turn. A persistently-empty harness
          // is still caught: noteFailure() keeps the alerter's incident
          // counter going, and the alerter classifies "empty reply" as its
          // own `empty` cause, so 3 consecutive empty turns fire a DEGRADED
          // push. The cost of a flake is one wasted round-trip.
          alerter.noteFailure(harness.id, "empty reply");
          firstFailure ??= { harnessId: harness.id, error: "empty reply" };
          recoverableError = true;
          break;
        }
        // Audit hook (#282): record every tool call the harness surfaces.
        // Best-effort and defensive — a misbehaving sink must never break the
        // turn, so we guard even though the production sink already can't throw.
        if (chunk.type === "progress" && chunk.tool && options.onToolCall) {
          try {
            options.onToolCall(chunk.tool);
          } catch (err) {
            log.debug("orchestrator: audit sink threw (ignored)", {
              err: String(err),
            });
          }
        }
        // Fold into this attempt's chunk log so a later idle kill has
        // something to resume FROM. Cheap: bounded narration plus capped tool
        // titles, dropped the moment the attempt ends any other way.
        partial.record(chunk);
        yield stamped;
        if (emitted.type === "done") {
          succeeded = true;
          if (emitted.finalText.length === 0) servedEmpty = true;
        }
      }
      } catch (e) {
        thrown = e;
      }
    }
    // ── end resume-with-context ───────────────────────────────────────

    if (thrown !== undefined) {
      const error = describeInvokeThrow(harness.id, thrown);
      if (!isLast) {
        log.warn("orchestrator: harness threw, falling through", {
          harnessId: harness.id,
          error,
        });
        cooldown.markFailure(harness.id);
        alerter.noteFailure(harness.id, error);
        firstFailure ??= { harnessId: harness.id, error };
        continue;
      }
      // Nowhere left to go: same outage shape as a recoverable error chunk on
      // the last harness, so alert the owner rather than dying silently.
      log.error("orchestrator: harness threw and chain is exhausted", {
        harnessId: harness.id,
        error,
      });
      cooldown.markFailure(harness.id);
      alerter.noteFailure(harness.id, error);
      await alerter.noteExhausted({
        harnessId: harness.id,
        error,
        chain: chainIds,
      });
      yield { type: "error", error, recoverable: true };
      return;
    }

    if (succeeded) {
      // Issue #559: every provider switch is logged — from → to, reason,
      // timestamp. A silent quality/price difference between primary and
      // fallback is a trust bug; this is the operator-visible record.
      if (harness.id !== headId) {
        log.warn(
          "orchestrator: provider switch — fallback served the turn",
          {
            from: headId,
            to: harness.id,
            reason:
              firstFailure?.error ?? headSkipReason ?? "primary unavailable",
            at: new Date().toISOString(),
          },
        );
      }
      // A clean turn — even if the text was empty and we're on the last
      // harness, the CLI did its job. Clear any prior cooldown so the
      // next turn picks the chain back up at the top. This stays
      // unconditional on purpose: cooldown decides what to TRY, and an
      // empty done is not a reason to bench a harness (#499).
      cooldown.markSuccess(harness.id);
      if (servedEmpty) {
        // #501: the chain ran out and the last harness produced no text.
        // Reporting that as a success laundered the whole failure away —
        // noteSuccess() closed the incident, so the consecutive-empty
        // counter never advanced and a harness that is empty on EVERY turn
        // (the kw-phantombot pi-with-an-empty-models-catalogue shape) alerted
        // never, however long it went on. On a multi-harness chain the empty
        // done is a fall-through and already counted upstream; here it is
        // the end of the line, so count it in the same currency.
        log.warn("orchestrator: chain exhausted with an empty reply", {
          harnessId: harness.id,
        });
        alerter.noteFailure(harness.id, "empty reply");
        // No `servedBy`: nobody covered this turn. Below the threshold this
        // is a no-op, so a one-off empty stays as quiet as #499 wants.
        await alerter.noteDegraded({ harnessId: harness.id });
        return;
      }
      alerter.noteSuccess(harness.id);
      // Served, but not by the head of the chain: the owner is paying a
      // fallback to cover a broken primary and nothing else would tell them.
      if (firstFailure && firstFailure.harnessId !== harness.id) {
        await alerter.noteDegraded({
          harnessId: firstFailure.harnessId,
          servedBy: harness.id,
        });
      }
      return;
    }
    if (!recoverableError) {
      yield {
        type: "error",
        error: `harness ${harness.id} ended without 'done' or 'error'`,
        recoverable: false,
      };
      return;
    }
  }
}

/**
 * Render a thrown harness failure into an operator-legible error string.
 *
 * E2BIG gets an explicit gloss because the raw message ("argument list too
 * long") points at the wrong limit: it is almost never the 2 MB `ARG_MAX` that
 * `getconf` reports, but Linux's per-string MAX_ARG_STRLEN of 131,071 bytes,
 * which no ulimit can raise. Saying so here is what turns a mystifying wedge
 * into a one-line diagnosis in the log.
 *
 * Exported for testing.
 */
export function describeInvokeThrow(harnessId: string, e: unknown): string {
  const message = e instanceof Error ? e.message : String(e);
  const hint = /E2BIG/i.test(message)
    ? " (a single argv string exceeded the kernel's 131,071-byte MAX_ARG_STRLEN — the prompt should have been spilled to a temp file)"
    : "";
  return `harness ${harnessId} threw: ${message}${hint}`;
}

/**
 * Estimate the rendered payload size for the precheck. Sums the system
 * prompt, every history turn, the new user message, plus a constant
 * per turn for the `<previous_response>` wrapper bytes. Conservative —
 * actual Pi argv may include a few additional flag bytes which this
 * doesn't account for, but the slack is well under the typical budget.
 *
 * Exported for testing.
 */
export function estimatePayloadBytes(req: HarnessRequest): number {
  let total = Buffer.byteLength(req.systemPrompt, "utf8");
  for (const turn of req.history) {
    total += Buffer.byteLength(turn.text, "utf8");
    total += turn.role === "assistant" ? 36 : 0; // <previous_response>...</previous_response> markers
    total += 2; // joiner newlines
  }
  total += Buffer.byteLength(req.userMessage, "utf8");
  return total;
}
