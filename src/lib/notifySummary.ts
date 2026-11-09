/**
 * The one-line summary `phantombot notify` prints after its fan-out, and the
 * parser the security broker uses to read it back.
 *
 * Why the broker parses it (duplicate notifications, 09-11-2026): a sandboxed
 * turn notifies through the broker, which runs `phantombot notify` on the host
 * under a 60 s kill. If notify delivered but the process then failed to exit
 * (a relay socket keeping the event loop alive), the kill turned a SUCCESSFUL
 * send into "notify failed / unavailable" — and the turn, reasonably, retried,
 * so the owner got the same message twice. The summary line is written only
 * after every send has settled, so it is the ground truth for "did anything
 * land", independent of how the process later exited.
 *
 * Format and parser live together so they cannot drift apart.
 */

export interface NotifyCounts {
  telegramText: number;
  telegramVoice: number;
  phantomchatText: number;
}

export function formatNotifySummary(
  persona: string,
  channels: readonly string[],
  c: NotifyCounts,
): string {
  return `notify: persona=${persona} channels=[${channels.join(", ")}] telegram(text=${c.telegramText} voice=${c.telegramVoice}) phantomchat(text=${c.phantomchatText})\n`;
}

const SUMMARY_RE =
  /^notify: persona=\S* channels=\[[^\]\n]*\] telegram\(text=(\d+) voice=(\d+)\) phantomchat\(text=(\d+)\)$/m;

/**
 * Total deliveries reported by a notify summary line in `output`, or
 * `undefined` when there is no summary (notify died before finishing its
 * fan-out — nothing can be claimed delivered).
 */
export function notifySummaryDelivered(output: string): number | undefined {
  const m = SUMMARY_RE.exec(output);
  if (!m) return undefined;
  return Number(m[1]) + Number(m[2]) + Number(m[3]);
}

/**
 * Whether a host-side `phantombot notify` run delivered anything, given its
 * exit code and captured output. Exit 0 is success; a non-zero exit (including
 * a timeout kill) still counts as delivered when the summary line reports at
 * least one send — retrying that would duplicate the message.
 */
export function notifyLanded(code: number, output: string): boolean {
  if (code === 0) return true;
  return (notifySummaryDelivered(output) ?? 0) > 0;
}
