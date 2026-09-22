/**
 * The visible conversation, owned by the SESSION rather than any screen
 * (phantombot#604).
 *
 * `ChatScreen` used to keep the transcript in screen-local React state. But
 * `App` renders screens as an exclusive switch, so every navigation away from
 * chat (`^l`, `^s`, doctor, …) unmounted the screen and destroyed the state;
 * coming back re-seeded from `session.history`, a snapshot built once at
 * session open and never appended to — so the current conversation vanished
 * from the screen (never from the store) on every round trip.
 *
 * The session already lives in `App` state above the screen switch, so its
 * lifetime is exactly the lifetime the transcript needs. This is the
 * subscribable store the session holds: `ChatScreen` becomes a pure view via
 * `useSyncExternalStore`, and the REPL/tests can read `getSnapshot()` without
 * React at all.
 *
 * Deliberately framework-free, like the rest of `chatSession.ts`: the only
 * React contract is the pair `subscribe`/`getSnapshot` —
 *   - `subscribe` returns its own unsubscribe and never throws;
 *   - `getSnapshot` returns the SAME array reference until the next mutation,
 *     so `Object.is` change detection works and the pane neither misses an
 *     update nor re-renders in a loop.
 *
 * Patching is by IDENTITY, the same way the screen always patched: a caller
 * holds the message object it appended and calls `patch(slot, fn)`; the store
 * finds that object in the array, replaces it with `fn(slot)`, hands the new
 * object back so the caller's `slot` variable can follow the streaming turn.
 */

import type { ChatMessage } from "./chatSession.ts";

export class TranscriptStore {
  /**
   * Never mutated in place: every mutation builds a new array and notifies, so
   * `getSnapshot` can hand out the reference without copying and stay stable
   * between notifications.
   */
  private messages: ChatMessage[];
  private readonly listeners = new Set<() => void>();

  constructor(messages: ChatMessage[] = []) {
    this.messages = messages;
  }

  /** The React-facing read: stable identity until the next mutation. */
  getSnapshot(): ChatMessage[] {
    return this.messages;
  }

  /** The React-facing subscription. Returns its own unsubscribe. */
  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /**
   * Append one or more messages (a user bubble and its reply slot, say).
   * Objects are stored as given and later addressed by that same reference.
   */
  append(...messages: ChatMessage[]): void {
    if (messages.length === 0) return;
    this.messages = [...this.messages, ...messages];
    this.notify();
  }

  /**
   * Patch one message by identity and return its replacement, so a caller can
   * keep patching the streaming turn: `slot = store.patch(slot, fn)`.
   *
   * A slot that is no longer in the transcript (a stale turn racing a session
   * switch) is a no-op: the old screen would have patched a message nobody
   * renders, and silently keeping that behaviour is safer than throwing into
   * a streaming loop.
   */
  patch(
    slot: ChatMessage,
    fn: (m: ChatMessage) => ChatMessage,
  ): ChatMessage {
    const index = this.messages.indexOf(slot);
    if (index === -1) return slot;
    const next = fn(slot);
    const out = [...this.messages];
    out[index] = next;
    this.messages = out;
    this.notify();
    return next;
  }

  /** Replace the whole transcript (not currently used by the screen). */
  reset(messages: ChatMessage[]): void {
    this.messages = messages;
    this.notify();
  }

  private notify(): void {
    for (const listener of [...this.listeners]) listener();
  }
}