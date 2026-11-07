/**
 * GHSA-w7w8: the escort for a sandboxed (untrusted) turn. The harness has no
 * tools of its own there, so the escort runs at the session boundary instead
 * of in a harness hook: every sandbox command and host notify/memory call is
 * judged before it runs, on the same decision model and threshold as before.
 */
import {
  escortBlockMessage,
  escortCheck,
  type EscortContext,
  recordEscortHold,
} from "../lib/escort.ts";
import type { SessionGate } from "./session.ts";

export function sessionEscortGate(
  ctx: EscortContext,
  opts: Parameters<typeof escortCheck>[2] = {},
): SessionGate {
  return async (action) => {
    const d = await escortCheck(ctx, action, opts);
    if (d.allow) return undefined;
    return escortBlockMessage(d.reason, recordEscortHold(ctx, action));
  };
}
