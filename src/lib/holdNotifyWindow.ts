/**
 * Outage hold-notification window (issue #665).
 *
 * A screen nobody answered holds every untrusted turn and notifies the
 * principal — correct behaviour, wrong volume: during a full judge outage
 * (decision model and every harness unreachable) each autonomous turn (task
 * fire, inbound mail, webhook) produces its own near-identical 🔒 ping. A
 * nightly window with a dead link fills the principal's chat with repeats.
 *
 * So the outage-hold NOTIFICATIONS are batched here, per persona: at most one
 * per HOLD_NOTIFY_WINDOW_MS, its header carrying the count of holds it stands
 * for. The holds themselves are untouched — the screener still records and
 * grounds every one of them (see screen.ts), so batching cannot lose a hold,
 * only delay its ping. Ordinary holds (a real threat score) never consult
 * this ledger and always notify.
 *
 * State is a small JSON file per persona (like decisionModelHealth.ts):
 *
 *   - `outageOngoing` — true while the current streak of "nobody answered"
 *     screens is open. The FIRST hold of an outage always notifies (a state
 *     change earns one ping), even inside the window of a previous outage's
 *     last alert; a screen that ANSWERED closes the streak (noteScreeningReachable),
 *     so the next outage starts with an immediate alert again.
 *   - `lastNotifiedAt` — when the last outage alert was DECIDED (the window
 *     anchor; written at decision time so concurrent holds inside one window
 *     batch instead of racing the delivery). Window expiry is measured from
 *     here.
 *   - `suppressed` — outage holds not yet covered by a DELIVERED alert: this
 *     hold plus everything counted since the last successful delivery. Carried
 *     across an outage boundary so a batch's tail is never dropped silently;
 *     the next delivered alert reports it.
 *   - `deliveryFailed` — the last decided alert failed to deliver (or exited
 *     non-zero). The next hold RETRIES the notification instead of staying
 *     silent for a whole window, folding the pending count into its header.
 *     Cleared when a retry is decided (and again when one is confirmed).
 *
 * The alert window is committed in two phases (see #665 review):
 *
 *   1. `recordOutageHold` decides and anchors the window (above).
 *   2. AFTER delivery the caller settles: `confirmAlertDelivered(count)`
 *      covers `count` holds, or `noteAlertDeliveryFailed()` keeps the count
 *      pending and marks the retry. A caller that dies mid-delivery leaves
 *      the anchor in place — bounded volume degrades to batching only.
 *
 * Deliberate properties:
 *   - FAIL TOWARD NOTIFYING. Reads are best-effort: a corrupt or unreadable
 *     ledger reads as empty state, which means "fresh outage" and an alert.
 *     WRITE failures PROPAGATE to the caller (logged at debug as well), so
 *     the screener's catch turns uncertainty into a notification. A failure
 *     to consult or update the ledger must never fail the screen — only the
 *     volume bound.
 *   - OUTCOMES ONLY. No untrusted payload, reason or preview is ever written
 *     here (the ledger is plaintext on disk); counts and timestamps only.
 *   - SERIALIZED READ-MODIFY-WRITE. Every decision runs inside one per-file
 *     in-process queue (load, decide and write as one queued step, the
 *     decisionModelHealth.ts mould), so concurrent holds of one persona can
 *     never read the same pre-write state and clobber each other. A
 *     cross-process race can lose one increment (daemon vs one-off CLI);
 *     accepted — this is a notification window, not an accounting ledger.
 *   - ATOMIC WRITES (tmp + rename).
 */

import { existsSync } from "node:fs";
import { readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { log } from "./logger.ts";

/** At most one outage-hold notification per persona per window. */
export const HOLD_NOTIFY_WINDOW_MS = 60 * 60 * 1000;

export interface HoldNotifyState {
  /** True while the current "nobody answered" streak is open. */
  outageOngoing: boolean;
  /** ISO time the last outage alert was decided (window anchor). */
  lastNotifiedAt?: string;
  /** Outage holds not yet covered by a delivered alert. */
  suppressed: number;
  /** The last decided alert failed to deliver; the next hold retries it. */
  deliveryFailed?: boolean;
}

/** The batch decision for ONE outage hold. */
export interface OutageHoldDecision {
  /** True → the caller sends the notification for this hold; false → suppress. */
  notify: boolean;
  /** How many outage holds the notification stands for (>= 1 when notify). */
  count: number;
}

export function holdNotifyPath(personaDir: string): string {
  return join(personaDir, ".hold-notify.json");
}

const EMPTY: HoldNotifyState = { outageOngoing: false, suppressed: 0 };

/** Read the ledger. Empty state when absent or unreadable — never throws. */
export async function loadHoldNotifyState(
  personaDir: string,
): Promise<HoldNotifyState> {
  const p = holdNotifyPath(personaDir);
  if (!existsSync(p)) return { ...EMPTY };
  try {
    const parsed = JSON.parse(await readFile(p, "utf8")) as HoldNotifyState;
    if (!parsed || typeof parsed !== "object") return { ...EMPTY };
    return {
      outageOngoing: parsed.outageOngoing === true,
      suppressed:
        typeof parsed.suppressed === "number" && Number.isFinite(parsed.suppressed)
          ? Math.max(0, Math.floor(parsed.suppressed))
          : 0,
      ...(parsed.lastNotifiedAt ? { lastNotifiedAt: parsed.lastNotifiedAt } : {}),
      ...(parsed.deliveryFailed === true ? { deliveryFailed: true } : {}),
    };
  } catch {
    return { ...EMPTY };
  }
}

/**
 * One in-flight chain per ledger file. EVERY read-modify-write runs inside
 * it (see decisionModelHealth.ts for the same pattern), so concurrent holds
 * of one persona serialize the whole decision, not just the file swap.
 * Errors propagate to the caller but never break the chain for the next one.
 */
const ledgerQueues = new Map<string, Promise<void>>();

function runExclusive<T>(personaDir: string, fn: () => Promise<T>): Promise<T> {
  const target = holdNotifyPath(personaDir);
  const tail = ledgerQueues.get(target) ?? Promise.resolve();
  const run = tail.catch(() => {}).then(fn);
  const keeper: Promise<void> = run.then(
    () => undefined,
    () => undefined,
  );
  ledgerQueues.set(target, keeper);
  return run.finally(() => {
    if (ledgerQueues.get(target) === keeper) ledgerQueues.delete(target);
  });
}

/** Disambiguates tmp names for writers in the same process. */
let tmpCounter = 0;

/**
 * Atomic write (tmp + rename). Only ever called inside runExclusive.
 * Errors PROPAGATE: the caller must know the ledger did not move, so it can
 * fail toward notifying instead of trusting a state nobody persisted.
 */
async function writeState(
  personaDir: string,
  next: HoldNotifyState,
): Promise<void> {
  const target = holdNotifyPath(personaDir);
  const tmp = `${target}.${process.pid}.${tmpCounter++}.tmp`;
  try {
    await writeFile(tmp, JSON.stringify(next, null, 2) + "\n", "utf8");
    await rename(tmp, target);
  } catch (e) {
    log.debug(`hold-notify: could not write ledger: ${(e as Error).message}`);
    throw e;
  }
}

/**
 * Record one outage hold ("screening was unavailable") and decide whether
 * THIS hold's notification goes out.
 *
 * Notify when the outage streak is new (first hold after a reachable screen),
 * the window has expired since the last alert, or the last alert failed to
 * deliver (retry). The returned `count` is this hold plus every hold not yet
 * covered by a delivered alert. Otherwise suppress: the hold is counted and
 * the caller closes the episode locally.
 *
 * The window anchor is written WITH the decision, so a hold racing an
 * in-flight delivery batches instead of double-pinging. The caller settles
 * the alert afterwards: confirmAlertDelivered(count) on delivery,
 * noteAlertDeliveryFailed() when the notify path failed.
 *
 * Write failures reject: uncertainty returns control to a caller that fails
 * toward notifying.
 */
export async function recordOutageHold(
  personaDir: string,
  now: Date = new Date(),
): Promise<OutageHoldDecision> {
  return runExclusive(personaDir, async () => {
    const state = await loadHoldNotifyState(personaDir);
    const last = state.lastNotifiedAt ? Date.parse(state.lastNotifiedAt) : NaN;
    const freshOutage = !state.outageOngoing;
    const windowExpired =
      !Number.isFinite(last) || now.getTime() - last >= HOLD_NOTIFY_WINDOW_MS;
    const notify =
      freshOutage || windowExpired || state.deliveryFailed === true;

    await writeState(personaDir, {
      outageOngoing: true,
      suppressed: state.suppressed + 1,
      ...(notify
        ? { lastNotifiedAt: now.toISOString() }
        : state.lastNotifiedAt
          ? { lastNotifiedAt: state.lastNotifiedAt }
          : {}),
      // A decided retry consumes the failure marker; a fresh one is set
      // again by noteAlertDeliveryFailed if this delivery also fails.
    });
    return { notify, count: state.suppressed + 1 };
  });
}

/**
 * The alert went out (exit code 0): cover the `count` holds it stood for.
 * Only then does the window commit — until this call the count stays
 * pending, so a delivery that failed is retried by the next hold.
 */
export async function confirmAlertDelivered(
  personaDir: string,
  count: number,
): Promise<void> {
  return runExclusive(personaDir, async () => {
    const state = await loadHoldNotifyState(personaDir);
    await writeState(personaDir, {
      ...state,
      suppressed: Math.max(0, state.suppressed - Math.max(0, Math.floor(count))),
      deliveryFailed: false,
    });
  });
}

/**
 * The decided alert did NOT reach the principal (notify threw or exited
 * non-zero). Keep its count pending and make the next hold retry it.
 */
export async function noteAlertDeliveryFailed(
  personaDir: string,
): Promise<void> {
  return runExclusive(personaDir, async () => {
    const state = await loadHoldNotifyState(personaDir);
    await writeState(personaDir, { ...state, deliveryFailed: true });
  });
}

/**
 * A screen ANSWERED (a verdict, or a judge that responded without a
 * scoreable verdict) — close an open outage streak so the first hold of the
 * next outage notifies immediately. No-op (no write) when nothing is open.
 * The unreported tail and any pending retry carry over.
 */
export async function noteScreeningReachable(personaDir: string): Promise<void> {
  return runExclusive(personaDir, async () => {
    const state = await loadHoldNotifyState(personaDir);
    if (!state.outageOngoing) return;
    await writeState(personaDir, { ...state, outageOngoing: false });
  });
}
