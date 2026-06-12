/**
 * Tests for the self-verification auto-responder (clears the "unverified"
 * badge). No SDK, no crypto: hand-rolled fakes for the VerificationRequest +
 * Verifier event surface mirror matrix-js-sdk's crypto-api enums by their
 * literal string/number values.
 */

import { describe, expect, test } from "bun:test";

import {
  handleVerificationRequest,
  installSelfVerificationAutoResponder,
  type VerificationRequestLike,
} from "../src/channels/matrix/verification.ts";

const PHASE_READY = 3;
const PHASE_DONE = 6;

/** A fake Verifier that fires ShowSas on verify() and records confirm(). */
function fakeVerifier() {
  const listeners: Record<string, Array<(...a: unknown[]) => void>> = {};
  let confirmed = false;
  const emit = (ev: string) => (listeners[ev] ?? []).forEach((f) => f());
  const verifier = {
    confirmed: () => confirmed,
    on(ev: string, cb: (...a: unknown[]) => void) {
      (listeners[ev] ??= []).push(cb);
    },
    getShowSasCallbacks() {
      return {
        confirm: async () => {
          confirmed = true;
        },
        mismatch: () => {},
        cancel: () => {},
      };
    },
    async verify() {
      // Real SDK emits show_sas while verify() is in flight, then resolves once
      // the MAC round-trips. Model that: fire ShowSas, let confirm() run, done.
      emit("show_sas");
      await Promise.resolve();
    },
  };
  return verifier;
}

/** A fake VerificationRequest driven into Ready→(verifier)→Done. */
function fakeRequest(opts: {
  isSelf: boolean;
  otherUserId: string;
}): {
  request: VerificationRequestLike;
  accepted: () => boolean;
  startCount: () => number;
  sasConfirmed: () => boolean;
} {
  const changeListeners: Array<() => void> = [];
  const verifier = fakeVerifier();
  let accepted = false;
  let startCount = 0;
  let phase = PHASE_READY; // already Ready when the responder attaches
  let currentVerifier: ReturnType<typeof fakeVerifier> | undefined;

  const fireChange = () => changeListeners.forEach((f) => f());

  const request: VerificationRequestLike = {
    get isSelfVerification() {
      return opts.isSelf;
    },
    get otherUserId() {
      return opts.otherUserId;
    },
    get phase() {
      return phase;
    },
    get verifier() {
      return currentVerifier as never;
    },
    accept: async () => {
      accepted = true;
    },
    startVerification: async () => {
      startCount += 1;
      currentVerifier = verifier;
      // Verifier now exists; announce it, then settle the request once SAS done.
      queueMicrotask(() => {
        fireChange();
        verifier.verify().then(() => {
          phase = PHASE_DONE;
          fireChange();
        });
      });
      return verifier as never;
    },
    on: (_ev, cb) => {
      changeListeners.push(cb);
    },
    off: () => {},
  };

  return {
    request,
    accepted: () => accepted,
    startCount: () => startCount,
    sasConfirmed: () => verifier.confirmed(),
  };
}

describe("self-verification auto-responder", () => {
  test("accepts a self-verification and auto-confirms the SAS", async () => {
    const f = fakeRequest({ isSelf: true, otherUserId: "@me:hs" });
    await handleVerificationRequest(f.request, "@me:hs");
    expect(f.accepted()).toBe(true);
    expect(f.startCount()).toBe(1);
    expect(f.sasConfirmed()).toBe(true);
  });

  test("ignores a request from another user (never accepts)", async () => {
    const f = fakeRequest({ isSelf: false, otherUserId: "@attacker:evil" });
    await handleVerificationRequest(f.request, "@me:hs");
    expect(f.accepted()).toBe(false);
    expect(f.startCount()).toBe(0);
    expect(f.sasConfirmed()).toBe(false);
  });

  test("ignores a non-self request even if userId happens to match", async () => {
    // isSelfVerification is the authoritative gate; if the SDK says it's not a
    // self-verification we don't touch it, regardless of otherUserId.
    const f = fakeRequest({ isSelf: false, otherUserId: "@me:hs" });
    await handleVerificationRequest(f.request, "@me:hs");
    expect(f.accepted()).toBe(false);
  });
});

describe("installSelfVerificationAutoResponder", () => {
  test("no-op (no throw) when the client has no crypto", () => {
    const unsub = installSelfVerificationAutoResponder({
      getUserId: () => "@me:hs",
      getCrypto: () => undefined,
    });
    expect(typeof unsub).toBe("function");
    unsub(); // must not throw
  });

  test("subscribes to verification requests and dispatches self ones", async () => {
    let handler: ((req: VerificationRequestLike) => void) | undefined;
    const crypto = {
      on: (_ev: string, cb: (req: VerificationRequestLike) => void) => {
        handler = cb;
      },
      off: () => {},
    };
    const unsub = installSelfVerificationAutoResponder({
      getUserId: () => "@me:hs",
      getCrypto: () => crypto,
    });
    expect(handler).toBeDefined();

    const f = fakeRequest({ isSelf: true, otherUserId: "@me:hs" });
    handler!(f.request);
    // Let the async handler run.
    await new Promise((r) => setTimeout(r, 10));
    expect(f.accepted()).toBe(true);
    expect(f.sasConfirmed()).toBe(true);
    unsub();
  });
});
