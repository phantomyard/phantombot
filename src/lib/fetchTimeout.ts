/**
 * Compose a hard, socket-cancelling timeout into a fetch's AbortSignal.
 *
 * Why this exists instead of a Promise.race timeout wrapper: the
 * withTimeout() helper in telegram.ts races a timer against the promise
 * but, by its own admission, "cannot cancel the underlying request" — the
 * socket stays open and the orphaned fetch keeps holding a connection
 * until the OS eventually gives up. That is the #135-class wedge: a
 * stalled upstream (Telegram file download, TTS/STT provider) hangs the
 * caller indefinitely.
 *
 * AbortSignal.timeout() aborts the request ITSELF, releasing the socket,
 * and AbortSignal.any() composes an optional external caller signal (e.g.
 * a /stop AbortController) so EITHER the timeout OR the caller cancels the
 * fetch. Whichever fires rejects the fetch with a TimeoutError /
 * AbortError the call site already handles via its catch.
 *
 * Pass the returned signal as `signal` in a fetch init.
 */
export function timeoutSignal(
  timeoutMs: number,
  caller?: AbortSignal,
): AbortSignal {
  const deadline = AbortSignal.timeout(timeoutMs);
  return caller ? AbortSignal.any([caller, deadline]) : deadline;
}
