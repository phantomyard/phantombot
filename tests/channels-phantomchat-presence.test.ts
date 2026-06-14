/**
 * Tests for the phantomchat presence heartbeat scheduler
 * (src/channels/phantomchat/presence.ts).
 *
 * The scheduler turns "the listener is up" into a stream of NIP-38 kind-30315
 * beats so Andrew's PWA can render a REAL online/offline badge. The contract:
 *   - one beat fires IMMEDIATELY (so "Online" shows without a 60s wait),
 *   - then one per interval,
 *   - an AbortSignal (the listener's) stops it,
 *   - an empty allowlist is a no-op (no timer, no beats),
 * all without ever letting a failed beat kill the interval.
 */

import { describe, expect, test } from "bun:test";
import { startPresenceHeartbeat } from "../src/channels/phantomchat/presence.ts";

/** A transport stub recording each sendPresence call's peer list. */
function makeTransport() {
  const calls: string[][] = [];
  return {
    calls,
    sendPresence(peerHexes: string[]): Promise<void> {
      calls.push(peerHexes);
      return Promise.resolve();
    },
  };
}

describe("phantomchat presence heartbeat", () => {
  test("fires one beat immediately, then on each interval", async () => {
    const transport = makeTransport();
    const peers = ["aa", "bb"];
    const hb = startPresenceHeartbeat({
      transport,
      peerHexes: peers,
      intervalMs: 20,
    });

    // Immediate beat.
    expect(transport.calls.length).toBe(1);
    expect(transport.calls[0]).toEqual(peers);

    await new Promise((r) => setTimeout(r, 70));
    hb.stop();

    // Immediate + at least 3 interval beats in ~70ms at 20ms cadence.
    expect(transport.calls.length).toBeGreaterThanOrEqual(3);
    // Every beat carries the same peer list.
    for (const c of transport.calls) expect(c).toEqual(peers);
  });

  test("stop() halts further beats", async () => {
    const transport = makeTransport();
    const hb = startPresenceHeartbeat({
      transport,
      peerHexes: ["aa"],
      intervalMs: 20,
    });
    hb.stop();
    const after = transport.calls.length; // just the immediate beat
    await new Promise((r) => setTimeout(r, 70));
    expect(transport.calls.length).toBe(after);
  });

  test("stop() is idempotent", () => {
    const transport = makeTransport();
    const hb = startPresenceHeartbeat({
      transport,
      peerHexes: ["aa"],
      intervalMs: 20,
    });
    hb.stop();
    hb.stop(); // must not throw
    expect(transport.calls.length).toBe(1);
  });

  test("an aborted signal stops the heartbeat", async () => {
    const transport = makeTransport();
    const ac = new AbortController();
    startPresenceHeartbeat({
      transport,
      peerHexes: ["aa"],
      intervalMs: 20,
      signal: ac.signal,
    });
    expect(transport.calls.length).toBe(1); // immediate beat
    ac.abort();
    await new Promise((r) => setTimeout(r, 70));
    expect(transport.calls.length).toBe(1); // no further beats after abort
  });

  test("a signal already aborted yields a no-op after the immediate beat", async () => {
    const transport = makeTransport();
    const ac = new AbortController();
    ac.abort();
    startPresenceHeartbeat({
      transport,
      peerHexes: ["aa"],
      intervalMs: 20,
      signal: ac.signal,
    });
    // The immediate beat already fired before we wired/checked abort; the
    // interval must not keep going.
    const after = transport.calls.length;
    await new Promise((r) => setTimeout(r, 70));
    expect(transport.calls.length).toBe(after);
  });

  test("empty allowlist is a complete no-op (no beats, no timer)", async () => {
    const transport = makeTransport();
    const hb = startPresenceHeartbeat({
      transport,
      peerHexes: [],
      intervalMs: 20,
    });
    expect(transport.calls.length).toBe(0);
    await new Promise((r) => setTimeout(r, 50));
    expect(transport.calls.length).toBe(0);
    hb.stop(); // must not throw
  });

  test("a throwing sendPresence does not kill the interval", async () => {
    let calls = 0;
    const transport = {
      sendPresence(): Promise<void> {
        calls += 1;
        throw new Error("boom");
      },
    };
    const hb = startPresenceHeartbeat({
      transport,
      peerHexes: ["aa"],
      intervalMs: 20,
    });
    await new Promise((r) => setTimeout(r, 70));
    hb.stop();
    // Despite every beat throwing synchronously, the interval kept firing.
    expect(calls).toBeGreaterThanOrEqual(3);
  });
});
