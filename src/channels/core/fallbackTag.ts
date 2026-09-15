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
 * Contracted to return undefined for every "primary answered normally"
 * shape so callers can append unconditionally.
 */

/** Cap on the embedded reason so a verbose harness error can't flood the tag. */
const MAX_REASON_CHARS = 80;

export function buildFallbackReplyTag(
  meta: Record<string, unknown> | undefined,
): string | undefined {
  const servedBy = readString(meta?.harnessId);
  const fallbackFor = readString(meta?.fallbackFor);
  if (!servedBy || !fallbackFor || servedBy === fallbackFor) return undefined;
  const reason = readString(meta?.fallbackReason) ?? "primary unavailable";
  return `— answered by ${servedBy} fallback (${fallbackFor}: ${
    reason.slice(0, MAX_REASON_CHARS)
  })`;
}

/** Append the tag to outgoing TEXT reply text (never the voice path). */
export function appendFallbackReplyTag(
  outText: string,
  meta: Record<string, unknown> | undefined,
): string {
  const tag = buildFallbackReplyTag(meta);
  if (!tag) return outText;
  return outText.length > 0 ? `${outText}\n\n${tag}` : tag;
}

function readString(v: unknown): string | undefined {
  return typeof v === "string" && v.length > 0 ? v : undefined;
}