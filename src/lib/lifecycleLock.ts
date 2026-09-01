/**
 * Single-flight lock for lifecycle commands (phantombot#519).
 *
 * `/update` and `/restart` act on the PROCESS, not on a persona: one
 * phantombot serves every persona on the host, so either command swaps the
 * binary and/or bounces the service for ALL of them.
 *
 * The old guard modelled that as OWNERSHIP — only `default_persona` was
 * allowed to run them — which is the wrong constraint twice over. It is not a
 * hierarchy (`default_persona` is just what the chat TUI falls back to when no
 * persona is named), and when the recorded default named a persona that did
 * not exist on disk the refusal pointed every persona at a ghost, with no
 * in-chat recovery at all (observed on kw-phantombot, 2026-09-01).
 *
 * The constraint that DOES exist is mutual exclusion: two personas must not
 * race the same binary swap. That is what this module enforces. Any served
 * persona may run a lifecycle command; the second concurrent one is told an
 * update is already in flight rather than starting a second swap.
 *
 * In-process by design. The thing being protected is one process's binary and
 * one process's restart, so a module-level holder is exactly the right scope —
 * a file lock would add a stale-lockfile failure mode for no extra safety.
 *
 * STALENESS: a holder is abandoned after `LIFECYCLE_LOCK_TTL_MS`. In the happy
 * path the process restarts and the lock dies with it, so the TTL only ever
 * matters when a swap failed *and* its release was skipped (a throw on a path
 * we did not anticipate). Without the TTL that would wedge lifecycle commands
 * for the lifetime of the daemon — precisely the class of dead end #519 is
 * about.
 */

/** How long a held lock survives without release before it is treated as
 *  abandoned. Generous: a real download+swap on a slow link is minutes. */
export const LIFECYCLE_LOCK_TTL_MS = 10 * 60 * 1000;

export interface LifecycleHolder {
  /** The command that took the lock, e.g. "/update". */
  command: string;
  /** Persona whose chat issued it. For the refusal message and the log. */
  persona: string;
  /** Epoch ms the lock was taken. */
  startedAt: number;
}

export type LifecycleLockResult =
  { ok: true; release: () => void } | { ok: false; holder: LifecycleHolder };

let held: (LifecycleHolder & { token: symbol }) | undefined;

/** True when `h` is still within its TTL. */
function isLive(h: LifecycleHolder, now: number): boolean {
  return now - h.startedAt < LIFECYCLE_LOCK_TTL_MS;
}

/**
 * Take the lifecycle lock, or report who holds it.
 *
 * The returned `release` is idempotent AND identity-checked: it clears the
 * lock only while THIS acquisition still holds it, so a late release from an
 * abandoned (TTL-expired, then re-acquired) run cannot free somebody else's
 * lock.
 */
export function acquireLifecycleLock(
  h: Omit<LifecycleHolder, "startedAt">,
  now: number = Date.now(),
): LifecycleLockResult {
  if (held && isLive(held, now)) {
    const { token: _token, ...holder } = held;
    return { ok: false, holder };
  }
  const token = Symbol("lifecycle");
  held = { ...h, startedAt: now, token };
  return {
    ok: true,
    release: () => {
      if (held?.token === token) held = undefined;
    },
  };
}

/** Who holds the lock right now, or undefined. Expired holders read as free. */
export function lifecycleLockHolder(
  now: number = Date.now(),
): LifecycleHolder | undefined {
  if (!held || !isLive(held, now)) return undefined;
  const { token: _token, ...holder } = held;
  return holder;
}

/** Drop any holder. Test seam — production releases via the acquire result. */
export function resetLifecycleLock(): void {
  held = undefined;
}

/** Human-readable "already in progress" refusal. */
export function lifecycleBusyReply(
  command: string,
  holder: LifecycleHolder,
  now: number = Date.now(),
): string {
  const secs = Math.max(0, Math.round((now - holder.startedAt) / 1000));
  return (
    `${command} is already in progress — ${holder.persona} started ${holder.command} ` +
    `${secs}s ago, and it restarts the whole phantombot process (every persona on ` +
    `this host shares it). Hold on; I'll be back in a moment.`
  );
}
