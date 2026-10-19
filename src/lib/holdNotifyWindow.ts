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
 *   - `lastNotifiedAt` — when the last outage alert went out. Window expiry
 *     is measured from here.
 *   - `suppressed` — outage holds recorded since that alert and not yet
 *     reported in any header count. Carried across an outage boundary so a
 *     batch's tail is never dropped silently; the next alert reports it.
 *
 * Deliberate properties (mirroring decisionModelHealth.ts):
 *   - BEST EFFORT. Errors are swallowed and logged at debug; a failure to
 *     consult or update the ledger must never fail the screen. On any
 *     uncertainty the caller falls back to NOTIFYING — bounded volume is a
 *     nicety, a lost ping is not.
 *   - OUTCOMES ONLY. No untrusted payload, reason or preview is ever written
 *     here (the ledger is plaintext on disk); counts and timestamps only.
 *   - ATOMIC WRITES (tmp + rename) and a per-file in-process queue so
 *     concurrent holds of one persona serialize their read-modify-write.
 *     A cross-process race can lose one increment (daemon vs one-off CLI);
 *     accepted — this is a notification window, not an accounting ledger.
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
  /** ISO time of the last outage-hold notification. */
  lastNotifiedAt?: string;
  /** Outage holds since that notification, not yet reported in a count. */
  suppressed: number;
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
    };
  } catch {
    return { ...EMPTY };
  }
}

/**
 * One in-flight write chain per ledger file, so concurrent holds serialize
 * their read-modify-write (see decisionModelHealth.ts for the same pattern).
 */
const ledgerQueues = new Map<string, Promise<void>>();
/** Disambiguates tmp names for writers in the same process. */
let tmpCounter = 0;

async function writeState(
  personaDir: string,
  next: HoldNotifyState,
): Promise<void> {
  const target = holdNotifyPath(personaDir);
  const tail = ledgerQueues.get(target) ?? Promise.resolve();
  const run = tail
    .catch(() => {})
    .then(async () => {
      const tmp = `${target}.${process.pid}.${tmpCounter++}.tmp`;
      await writeFile(tmp, JSON.stringify(next, null, 2) + "\n", "utf8");
      await rename(tmp, target);
    });
  ledgerQueues.set(target, run);
  try {
    await run;
  } catch (e) {
    log.debug(`hold-notify: could not write ledger: ${(e as Error).message}`);
  } finally {
    if (ledgerQueues.get(target) === run) ledgerQueues.delete(target);
  }
}

/**
 * Record one outage hold ("screening was unavailable") and decide whether
 * THIS hold's notification goes out.
 *
 * Notify when the outage streak is new (first hold after a reachable screen)
 * or the window has expired since the last alert; the returned `count` is
 * this hold plus every hold suppressed since that alert. Otherwise suppress:
 * the hold is counted and the caller closes the episode locally.
 */
export async function recordOutageHold(
  personaDir: string,
  now: Date = new Date(),
): Promise<OutageHoldDecision> {
  const state = await loadHoldNotifyState(personaDir);
  const last = state.lastNotifiedAt ? Date.parse(state.lastNotifiedAt) : NaN;
  const freshOutage = !state.outageOngoing;
  const windowExpired =
    !Number.isFinite(last) || now.getTime() - last >= HOLD_NOTIFY_WINDOW_MS;

  if (freshOutage || windowExpired) {
    const count = state.suppressed + 1;
    await writeState(personaDir, {
      outageOngoing: true,
      lastNotifiedAt: now.toISOString(),
      suppressed: 0,
    });
    return { notify: true, count };
  }

  await writeState(personaDir, {
    ...state,
    outageOngoing: true,
    suppressed: state.suppressed + 1,
  });
  return { notify: false, count: state.suppressed + 1 };
}

/**
 * A screen ANSWERED (a verdict, or a judge that responded without a
 * scoreable verdict) — close an open outage streak so the first hold of the
 * next outage notifies immediately. No-op (no write) when nothing is open.
 */
export async function noteScreeningReachable(personaDir: string): Promise<void> {
  const state = await loadHoldNotifyState(personaDir);
  if (!state.outageOngoing) return;
  await writeState(personaDir, { ...state, outageOngoing: false });
}
