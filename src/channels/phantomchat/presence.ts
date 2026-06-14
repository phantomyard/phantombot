/**
 * phantomchat presence heartbeat.
 *
 * While a persona's phantomchat listener is up, we want Andrew's PWA to show a
 * REAL "Online" badge for that persona — and a real "last seen at HH:MM" the
 * moment the service goes down. Nostr has no connection-level presence, so we
 * synthesize one: republish a NIP-38 kind-30315 status event (see
 * transport.sendPresence) on a fixed interval, p-tagged to the allowlist peers.
 *
 * The PWA treats each beat as liveness: it shows the persona online while beats
 * keep arriving and flips to offline (stamping the last beat as "last seen")
 * once they stop for longer than its threshold. So the heartbeat interval must
 * be comfortably shorter than the PWA's `OFFLINE_THRESHOLD_MS` (180s) — 60s
 * tolerates two dropped beats before a false "offline".
 *
 * This is deliberately tiny and side-effect-only: it owns a single setInterval,
 * fires one beat immediately so "online" shows without a 60s wait, and tears the
 * timer down on either an explicit `stop()` or the listener's AbortSignal.
 */

import { log } from "../../lib/logger.ts";
import type { PhantomchatTransport } from "./transport.ts";

/**
 * How often we republish the presence beacon. Must stay well under the PWA's
 * offline threshold (phantomchat `OFFLINE_THRESHOLD_MS = 180_000`) so a single
 * slow/dropped publish never flickers the persona to "offline".
 */
export const PRESENCE_HEARTBEAT_MS = 60_000;

export interface PresenceHeartbeat {
  /** Stop the heartbeat and clear its timer. Idempotent. */
  stop(): void;
}

/**
 * Start a presence heartbeat that publishes a kind-30315 beacon to `peerHexes`
 * immediately and then every `intervalMs`. Returns a handle whose `stop()` tears
 * the timer down; if a `signal` is supplied, abort also stops it (so it dies
 * with the listener). A no-op (no timer, no beats) when `peerHexes` is empty —
 * there's no one to advertise presence to (TOFU / open-bot personas).
 */
export function startPresenceHeartbeat(input: {
  transport: Pick<PhantomchatTransport, "sendPresence">;
  peerHexes: string[];
  signal?: AbortSignal;
  intervalMs?: number;
}): PresenceHeartbeat {
  if (input.peerHexes.length === 0) {
    return { stop() {} };
  }

  const intervalMs = input.intervalMs ?? PRESENCE_HEARTBEAT_MS;
  let stopped = false;

  const beat = (): void => {
    if (stopped) return;
    // sendPresence is itself best-effort (never throws), but guard anyway —
    // both a synchronous throw and a rejected promise must be swallowed so a
    // single bad beat can never tear the interval down.
    try {
      void Promise.resolve(input.transport.sendPresence(input.peerHexes)).catch(
        (e: unknown) => {
          log.debug("phantomchat: presence heartbeat beat failed", {
            error: (e as Error).message,
          });
        },
      );
    } catch (e) {
      log.debug("phantomchat: presence heartbeat beat threw", {
        error: (e as Error).message,
      });
    }
  };

  // Fire once now so "Online" shows immediately, then on the interval.
  beat();
  const timer = setInterval(beat, intervalMs);

  const stop = (): void => {
    if (stopped) return;
    stopped = true;
    clearInterval(timer);
    if (input.signal) input.signal.removeEventListener("abort", stop);
  };

  if (input.signal) {
    if (input.signal.aborted) stop();
    else input.signal.addEventListener("abort", stop, { once: true });
  }

  return { stop };
}
