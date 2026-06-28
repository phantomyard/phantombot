/**
 * Regression tests for the robust opening typing/recording indicator
 * (`emitOpeningIndicator` in src/channels/core/engine.ts).
 *
 * Why this exists: the typing dots kept intermittently NOT showing. Root cause
 * is that on PhantomChat the indicator is a fire-and-forget ephemeral Nostr
 * event — if the relay socket isn't connected at the instant of the FIRST tick,
 * the tick is silently dropped, and a fast turn (reply before the 2s throttle
 * fires a second refresh) then shows no indicator at all. The fix emits the
 * opening tick immediately AND once more a short moment later, so a single
 * cold-socket drop can't swallow the whole indicator.
 *
 * These tests lock in that double-pulse contract with INJECTED timers so they
 * are deterministic (no wall-clock waits): exactly one immediate emit, exactly
 * one scheduled re-emit, and a cancel handle that prevents the re-emit firing
 * into a turn that already finished.
 */

import { describe, expect, test } from "bun:test";

import {
  emitOpeningIndicator,
  OPENING_INDICATOR_REEMIT_MS,
} from "../src/channels/core/engine.ts";

/** A tiny deterministic timer harness: captures scheduled callbacks instead of
 *  running them on the wall clock, so the test decides when "later" happens. */
function fakeTimers() {
  const scheduled: Array<{ id: number; fn: () => void; ms: number }> = [];
  let nextId = 1;
  const cleared: number[] = [];
  return {
    scheduled,
    cleared,
    setTimeoutFn: (fn: () => void, ms: number): unknown => {
      const id = nextId++;
      scheduled.push({ id, fn, ms });
      return id;
    },
    clearTimeoutFn: (handle: unknown): void => {
      cleared.push(handle as number);
    },
    /** Run every still-pending (not cleared) scheduled callback. */
    flush(): void {
      for (const s of scheduled) {
        if (!cleared.includes(s.id)) s.fn();
      }
    },
  };
}

describe("emitOpeningIndicator — robust opening typing indicator", () => {
  test("emits the opening tick immediately (pulse 1)", () => {
    let calls = 0;
    const timers = fakeTimers();
    emitOpeningIndicator(() => calls++, {
      setTimeoutFn: timers.setTimeoutFn,
      clearTimeoutFn: timers.clearTimeoutFn,
    });
    // Pulse 1 is synchronous — the dots appear the instant the turn starts.
    expect(calls).toBe(1);
  });

  test("schedules exactly one re-emit, at the configured short delay", () => {
    let calls = 0;
    const timers = fakeTimers();
    emitOpeningIndicator(() => calls++, {
      setTimeoutFn: timers.setTimeoutFn,
      clearTimeoutFn: timers.clearTimeoutFn,
    });
    // One and only one delayed pulse is scheduled (not a runaway interval).
    expect(timers.scheduled.length).toBe(1);
    expect(timers.scheduled[0]!.ms).toBe(OPENING_INDICATOR_REEMIT_MS);
  });

  test("the scheduled re-emit fires a SECOND tick (covers a dropped first tick)", () => {
    let calls = 0;
    const timers = fakeTimers();
    emitOpeningIndicator(() => calls++, {
      setTimeoutFn: timers.setTimeoutFn,
      clearTimeoutFn: timers.clearTimeoutFn,
    });
    expect(calls).toBe(1); // pulse 1
    timers.flush(); // relay had a beat to connect → pulse 2 lands
    expect(calls).toBe(2);
  });

  test("honours a custom re-emit delay", () => {
    const timers = fakeTimers();
    emitOpeningIndicator(() => {}, {
      extraPulseDelayMs: 250,
      setTimeoutFn: timers.setTimeoutFn,
      clearTimeoutFn: timers.clearTimeoutFn,
    });
    expect(timers.scheduled[0]!.ms).toBe(250);
  });

  test("cancel() prevents the re-emit firing into an already-finished turn", () => {
    let calls = 0;
    const timers = fakeTimers();
    const cancel = emitOpeningIndicator(() => calls++, {
      setTimeoutFn: timers.setTimeoutFn,
      clearTimeoutFn: timers.clearTimeoutFn,
    });
    expect(calls).toBe(1); // pulse 1 already happened
    cancel(); // turn ended before the re-emit window
    expect(timers.cleared).toEqual([timers.scheduled[0]!.id]);
    timers.flush(); // even if the timer somehow ran, it was cleared
    expect(calls).toBe(1); // NO second tick into a dead turn
  });

  test("cancel() is idempotent — calling it twice clears only once", () => {
    const timers = fakeTimers();
    const cancel = emitOpeningIndicator(() => {}, {
      setTimeoutFn: timers.setTimeoutFn,
      clearTimeoutFn: timers.clearTimeoutFn,
    });
    cancel();
    cancel();
    expect(timers.cleared.length).toBe(1);
  });
});
