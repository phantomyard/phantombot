/**
 * Fallback attribution tag for delivered replies (issue #559).
 *
 * When the orchestrator's chain head cannot take a turn and a fallback
 * harness answers instead, the user is talking to a different model than
 * the one they expect — a silent quality/price difference is a trust bug.
 * The orchestrator stamps the `done` chunk's meta (`fallbackFor`,
 * `fallbackReason`; the serving harness is already in `harnessId` from the
 * adapter's buildDoneMeta) and each channel renders this tag as a visible
 * suffix on the TEXT reply.
 *
 * Deliberately NOT appended to the voice path: the tag is visual metadata
 * and would be spoken aloud by TTS.
 *
 * The reason is rendered COARSE (review on #561): group chats and peer
 * conversations put this tag in front of third parties, and the raw
 * harness error (paths, provider internals, request ids) has no business
 * there. The coarse class is enough to know why the brain changed; the
 * raw error stays in the switch log, where it belongs.
 *
 * Contracted to return undefined for every "primary answered normally"
 * shape so callers can append unconditionally.
 */

import { classifyFailure } from "../../lib/harnessAlert.ts";

/**
 * Map a raw fallback reason to a coarse, audience-safe class. The
 * orchestrator's reasons are either a harness error (classified by the
 * shared failure classifier) or one of its own skip stamps ("primary in
 * cooldown (…)", "primary payload cap exceeded (…)"), so a handful of
 * substring checks cover every producer.
 */
export function coarseFallbackReason(reason: string): string {
  const r = reason.toLowerCase();
  if (r.includes("cooldown")) return "cooldown";
  if (r.includes("payload cap")) return "payload cap";
  return coarseCause(classifyFailure(reason));
}

/** Audience-safe rendering of an already-classified cause. */
export function coarseCause(cause: string): string {
  switch (cause) {
    case "rate_limit":
      return "rate limit";
    case "auth":
      return "auth failure";
    case "timeout":
      return "timeout";
    case "empty":
      return "no output";
    default:
      return "unavailable";
  }
}

export function buildFallbackReplyTag(
  meta: Record<string, unknown> | undefined,
): string | undefined {
  const servedBy = readString(meta?.harnessId);
  const fallbackFor = readString(meta?.fallbackFor);
  if (!servedBy || !fallbackFor || servedBy === fallbackFor) return undefined;
  // Prefer the cause the ORCHESTRATOR classified. It had the dying harness's
  // stderr in hand; all that survives into `fallbackReason` is the exit line
  // ("codex exited with code 1"), which names no cause, so re-deriving the
  // class here rendered every subprocess death — rate limits included — as
  // the catch-all "unavailable". The reason string stays as the fallback for
  // skip stamps (cooldown, payload cap) and for older stamped metadata.
  const cause = readString(meta?.fallbackCause);
  const coarse = cause
    ? coarseCause(cause)
    : coarseFallbackReason(
        readString(meta?.fallbackReason) ?? "primary unavailable",
      );
  return `— answered by ${servedBy} fallback (${fallbackFor}: ${coarse})`;
}

/** Append the tag to outgoing TEXT reply text (never the voice path).
 *
 * Skipped when the outgoing text is empty: on the streaming transports
 * that means the reply already went out as live final bubbles, and
 * appending then would send a bubble whose ONLY content is metadata — a
 * lone tag bubble is noise, not transparency (review on #561). The tag
 * is never stamped on an empty reply anyway (the orchestrator only stamps
 * `finalText.length > 0`), so nothing legitimate is lost.
 */
export function appendFallbackReplyTag(
  outText: string,
  meta: Record<string, unknown> | undefined,
): string {
  const tag = buildFallbackReplyTag(meta);
  if (!tag || outText.length === 0) return outText;
  return `${outText}\n\n${tag}`;
}

function readString(v: unknown): string | undefined {
  return typeof v === "string" && v.length > 0 ? v : undefined;
}
