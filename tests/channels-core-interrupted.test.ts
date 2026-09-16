/**
 * persistInterruptedTurn: a /stop'd turn must keep the user's message in
 * history (2026-09-16: a stopped PhantomChat "yes, apply it" vanished).
 */
import { describe, expect, test } from "bun:test";
import {
  INTERRUPTED_MARKER,
  persistInterruptedTurn,
} from "../src/channels/core/interrupted.ts";

function fakeMemory(fail = false) {
  const pairs: Array<[Record<string, unknown>, Record<string, unknown>]> = [];
  return {
    pairs,
    memory: {
      async appendTurnPair(u: never, a: never) {
        if (fail) throw new Error("db locked");
        pairs.push([u, a]);
      },
    },
  };
}

const base = {
  persona: "max",
  conversation: "phantomchat:abc",
  userMessage: "yes, apply it to all 7",
  trusted: true,
  channel: "phantomchat",
};

describe("persistInterruptedTurn", () => {
  test("stop: persists the user message with principal provenance", async () => {
    const m = fakeMemory();
    expect(await persistInterruptedTurn({ ...base, memory: m.memory, reason: "stop" })).toBe(true);
    expect(m.pairs).toHaveLength(1);
    const [u, a] = m.pairs[0]!;
    expect(u).toMatchObject({ role: "user", text: base.userMessage, source: "principal", conversation: base.conversation });
    expect(a).toMatchObject({ role: "assistant", text: INTERRUPTED_MARKER, source: "unverified" });
  });

  test("keeps already-streamed text ahead of the marker", async () => {
    const m = fakeMemory();
    await persistInterruptedTurn({ ...base, memory: m.memory, reason: "interrupt", partialReply: "Applying now.\n" });
    expect(m.pairs[0]![1].text).toBe(`Applying now.\n\n${INTERRUPTED_MARKER}`);
  });

  test("untrusted sender is stamped other", async () => {
    const m = fakeMemory();
    await persistInterruptedTurn({ ...base, trusted: false, memory: m.memory, reason: "stop" });
    expect(m.pairs[0]![0].source).toBe("other");
  });

  test("reset and empty messages are skipped", async () => {
    const m = fakeMemory();
    expect(await persistInterruptedTurn({ ...base, memory: m.memory, reason: "reset" })).toBe(false);
    expect(await persistInterruptedTurn({ ...base, userMessage: "  ", memory: m.memory, reason: "stop" })).toBe(false);
    expect(m.pairs).toHaveLength(0);
  });

  test("a store failure never throws", async () => {
    const m = fakeMemory(true);
    expect(await persistInterruptedTurn({ ...base, memory: m.memory, reason: "stop" })).toBe(false);
  });
});
