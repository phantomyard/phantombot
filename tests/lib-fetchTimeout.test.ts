import { describe, expect, test } from "bun:test";
import { timeoutSignal } from "../src/lib/fetchTimeout.ts";

describe("timeoutSignal", () => {
  test("returns a non-aborted signal initially", () => {
    const sig = timeoutSignal(10_000);
    expect(sig.aborted).toBe(false);
  });

  test("aborts itself after the timeout elapses", async () => {
    const sig = timeoutSignal(5);
    await new Promise((r) => setTimeout(r, 25));
    expect(sig.aborted).toBe(true);
    // AbortSignal.timeout() aborts with a TimeoutError DOMException.
    expect((sig.reason as Error).name).toBe("TimeoutError");
  });

  test("an external caller abort propagates to the composed signal", () => {
    const caller = new AbortController();
    const sig = timeoutSignal(10_000, caller.signal);
    expect(sig.aborted).toBe(false);
    caller.abort(new Error("stop"));
    expect(sig.aborted).toBe(true);
  });

  test("composed signal still fires on timeout when caller never aborts", async () => {
    const caller = new AbortController();
    const sig = timeoutSignal(5, caller.signal);
    await new Promise((r) => setTimeout(r, 25));
    expect(sig.aborted).toBe(true);
  });
});
