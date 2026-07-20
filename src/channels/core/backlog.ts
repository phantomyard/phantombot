/**
 * Per-conversation backlog epochs — the shared mechanism behind unified
 * interrupt and `/stop` semantics on every channel (GitHub #301).
 *
 * THE PROBLEM
 * -----------
 * Every channel serializes a conversation's work onto a promise chain:
 * `next = prev.then(() => run(msg))`. That keeps one conversation's turns in
 * order, which the LLM's history requires. But a `.then()` callback is
 * COMMITTED the instant it is attached — there is no handle to cancel it. So
 * when the user interrupts (types again while a turn is running, or hits
 * `/stop`), aborting the active turn only kills the turn that is running RIGHT
 * NOW. Anything the user queued behind it still fires, one after another, after
 * the interrupt — the bot works through a backlog of instructions the user has
 * explicitly superseded.
 *
 * THE MECHANISM
 * -------------
 * We cannot un-attach the callbacks, so we make them no-op instead. Each
 * conversation carries a monotonically increasing EPOCH. A task captures the
 * current epoch when it is enqueued and re-checks it when it actually starts
 * running; an interrupt (or `/stop`) bumps the epoch, so every task queued
 * before that moment finds its captured epoch stale and returns without doing
 * anything. Tasks enqueued AFTER the bump carry the new epoch and run normally
 * — which is why the interrupting message itself is unaffected.
 *
 * COUNTING WHAT WAS DROPPED
 * -------------------------
 * `/stop` has to tell the user how many queued messages it threw away, so we
 * also track how many tasks are enqueued-but-not-yet-started. `enqueue()`
 * increments, `claim()` (called at the top of the task body) decrements, so the
 * counter is exactly the backlog depth — the running task has already claimed
 * itself out of it. All pending tasks for a conversation necessarily share one
 * epoch (a flush zeroes the counter and bumps the epoch together), so a single
 * `{ epoch, pending }` slot per conversation is enough; a stale `claim()` is
 * rejected without touching the counter, so superseded tasks unwinding late
 * cannot corrupt the depth of the backlog that replaced them.
 *
 * Keys are channel-neutral conversation ids — whatever that channel already
 * uses for its `activeTurns` map — so `/stop`'s flush and the interrupt path
 * always address the same queue.
 */

import { log } from "../../lib/logger.ts";

interface BacklogSlot {
  /** Current generation. Tasks holding an older value must not run. */
  epoch: number;
  /** Tasks enqueued under `epoch` that have not started running yet. */
  pending: number;
}

/** Why a flush happened — logged, and used by callers for their own logging. */
export type FlushReason = "interrupt" | "stop";

export class ConversationBacklog {
  private readonly slots = new Map<string, BacklogSlot>();

  private slot(key: string): BacklogSlot {
    let s = this.slots.get(key);
    if (!s) {
      s = { epoch: 0, pending: 0 };
      this.slots.set(key, s);
    }
    return s;
  }

  /**
   * Register a task about to be chained onto `key`'s serial queue and return
   * the epoch it must present to {@link claim}. Call this SYNCHRONOUSLY at the
   * enqueue site, before attaching the `.then()`.
   */
  enqueue(key: string): number {
    const s = this.slot(key);
    s.pending++;
    return s.epoch;
  }

  /**
   * Call at the very top of a queued task's body. Returns false if the task has
   * been superseded by a flush since it was enqueued — the caller must then
   * return immediately without doing any work.
   */
  claim(key: string, epoch: number): boolean {
    const s = this.slot(key);
    // Stale: a flush already counted this task as dropped and zeroed the
    // counter. Decrementing here would eat one slot from the NEW backlog.
    if (epoch !== s.epoch) return false;
    if (s.pending > 0) s.pending--;
    return true;
  }

  /** How many tasks are queued for `key` but have not started running. */
  pending(key: string): number {
    return this.slots.get(key)?.pending ?? 0;
  }

  /**
   * Discard `key`'s entire pending backlog and return how many tasks were
   * dropped. The currently-RUNNING task is not counted (it already claimed
   * itself out of the backlog) and is not affected — callers abort it
   * separately via its AbortController.
   */
  flush(key: string, reason: FlushReason): number {
    const s = this.slot(key);
    const dropped = s.pending;
    s.epoch++;
    s.pending = 0;
    if (dropped > 0) {
      // Info level, never user-visible: an interrupt is silent by design, and
      // `/stop` reports the count itself in its reply.
      log.info("backlog: dropped superseded queued messages", {
        conversation: key,
        reason,
        dropped,
      });
    }
    return dropped;
  }

  /**
   * Forget a conversation with no work left, so long-lived servers don't
   * accumulate a slot per peer forever. No-op while anything is still pending —
   * dropping the slot then would reset the epoch to 0 and let stale tasks
   * spuriously re-validate.
   */
  release(key: string): void {
    const s = this.slots.get(key);
    if (s && s.pending === 0) this.slots.delete(key);
  }
}

/**
 * The note `/stop` writes into the conversation so the agent's NEXT turn knows
 * what happened to the last one.
 *
 * `/stop` is break-glass: the user is not asking a question, they are pulling
 * the plug. Without this note the agent's next turn sees a truncated history
 * (a user message with no assistant reply, plus whatever partial work the
 * harness narrated) and its most natural reading is "I was interrupted
 * mid-task, I should pick that back up" — precisely the behaviour the user just
 * hit the panic button to prevent. Written as a `user` turn because that is the
 * role the history replay surfaces as instruction-bearing context.
 */
export function stopNoteText(droppedCount: number): string {
  const backlog =
    droppedCount > 0
      ? ` ${droppedCount} queued message${droppedCount === 1 ? "" : "s"} that had not started yet were discarded as well.`
      : "";
  return (
    "[system] The user issued /stop. The turn that was running was aborted." +
    backlog +
    " Do not resume, retry, or continue that work, and do not report on it" +
    " unless asked. Await further instructions."
  );
}
