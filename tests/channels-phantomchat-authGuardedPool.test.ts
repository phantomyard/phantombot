/**
 * Tests for the NIP-42 AUTH crash guard (issue #401).
 *
 * THE BUG: nostr-tools answers a relay's `["AUTH", <challenge>]` frame by
 * calling `relay.auth(this.onauth)` and throwing the promise away — no await,
 * no catch. When the relay then rate-limits us and never OKs the kind-22242
 * event we sent back, that promise rejects with nobody holding it, the
 * rejection reaches `unhandledRejection`, and the #274 guard re-throws
 * anything that isn't a benign ICE socket error. A remote box's traffic policy
 * crash-loops the daemon.
 *
 * Two properties pin the fix: the fire-and-forget call must not produce an
 * unhandled rejection, and the callers that DO await `auth()` (the publish
 * retry and the `auth-required:` subscription retry) must still see it, or
 * NIP-42 silently stops retrying and #368 regresses.
 */

import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import type { AbstractRelay } from "nostr-tools/abstract-relay";
import type { EventTemplate } from "nostr-tools/core";
import { generateSecretKey, getPublicKey, verifyEvent } from "nostr-tools/pure";

import {
  AuthGuardedSimplePool,
  guardRelayAuthRejection,
} from "../src/channels/phantomchat/authGuardedPool.ts";

const AUTH_TEMPLATE: EventTemplate = {
  kind: 22242,
  created_at: Math.floor(Date.now() / 1000),
  tags: [
    ["relay", "wss://ratelimited.example"],
    ["challenge", "abc123"],
  ],
  content: "",
};

/**
 * The slice of AbstractRelay the guard touches: a url and an `auth()` that
 * rejects the way a rate-limiting relay makes it reject.
 */
function fakeRelay(): {
  relay: AbstractRelay;
  authCalls: () => number;
} {
  let authCalls = 0;
  const relay = {
    url: "wss://ratelimited.example",
    auth(): Promise<string> {
      authCalls += 1;
      return Promise.reject(new Error("auth timed out"));
    },
  };
  return {
    relay: relay as unknown as AbstractRelay,
    authCalls: () => authCalls,
  };
}

/**
 * The crash is a whole-process event, and `bun:test` intercepts unhandled
 * rejections rather than letting them reach a `process.on` listener — so the
 * only honest way to assert "the daemon stays up" is to run the scenario in a
 * real subprocess and look at its exit code. That also reproduces the
 * production failure exactly: `error: auth timed out`, exit 1, systemd
 * restarts, repeat.
 *
 * The two runs differ by ONE line: whether the relay is guarded.
 */
// A file:// URL, not a bare path: a Windows path in a dynamic import()
// is not a valid specifier.
const MODULE = pathToFileURL(
  join(import.meta.dir, "..", "src/channels/phantomchat/authGuardedPool.ts"),
).href;

async function runFireAndForgetAuth(
  guarded: boolean,
): Promise<{ code: number; stdout: string }> {
  const script = [
    `const { guardRelayAuthRejection } = await import(${JSON.stringify(MODULE)});`,
    `const relay = {`,
    `  url: "wss://ratelimited.example",`,
    `  auth: () => Promise.reject(new Error("auth timed out")),`,
    `};`,
    guarded ? `guardRelayAuthRejection(relay);` : ``,
    `// Exactly what nostr-tools does on an ["AUTH", challenge] frame:`,
    `// call auth() and drop the promise on the floor.`,
    `relay.auth(async () => {});`,
    // Generous on purpose. The unhandled-rejection crash fires on the very
    // next microtask drain, so this window only has to outlast scheduling
    // jitter on a loaded CI runner — a tight one buys nothing but flakes.
    `setTimeout(() => { console.log("SURVIVED"); process.exit(0); }, 500);`,
  ].join("\n");
  const proc = Bun.spawn([process.execPath, "-e", script], {
    stdout: "pipe",
    stderr: "pipe",
  });
  const stdout = await new Response(proc.stdout).text();
  return { code: await proc.exited, stdout };
}

describe("guardRelayAuthRejection", () => {
  // The control. This is today's behaviour and it is what kills the daemon —
  // assert the crash is real, or the test below is a false green. The fixture
  // imports the guard module in BOTH runs, so this also proves the fix is
  // per-relay and not some blanket process-level handler.
  test("an unguarded fire-and-forget auth() kills the process", async () => {
    const { code, stdout } = await runFireAndForgetAuth(false);
    expect(code).toBe(1);
    expect(stdout).not.toContain("SURVIVED");
  });

  test("a guarded relay survives the same rejection", async () => {
    const { code, stdout } = await runFireAndForgetAuth(true);
    expect(code).toBe(0);
    expect(stdout).toContain("SURVIVED");
  });

  // Swallowing the rejection outright would break NIP-42 retries: the publish
  // path calls `await r.auth(...)` and republishes on success.
  test("callers that await auth() still see the rejection", async () => {
    const { relay } = fakeRelay();
    guardRelayAuthRejection(relay);
    await expect(
      relay.auth(async () => {
        throw new Error("unused");
      }),
    ).rejects.toThrow("auth timed out");
  });

  // Pools re-run the automaticallyAuth hook on every ensureRelay, including
  // for relays they already hold — double-wrapping would call auth() twice per
  // challenge and publish a second kind-22242 event into the same rate limit.
  test("guarding twice wraps once", async () => {
    const { relay, authCalls } = fakeRelay();
    guardRelayAuthRejection(relay);
    const wrapped = relay.auth;
    guardRelayAuthRejection(relay);
    expect(relay.auth).toBe(wrapped);
    await expect(
      relay.auth(async () => {
        throw new Error("unused");
      }),
    ).rejects.toThrow("auth timed out");
    expect(authCalls()).toBe(1);
  });
});

describe("AuthGuardedSimplePool", () => {
  /** The pool's `relays` map is protected; tests plant a relay in it. */
  function plant(pool: AuthGuardedSimplePool, relay: AbstractRelay): void {
    (
      pool as unknown as { relays: Map<string, AbstractRelay> }
    ).relays.set(relay.url, relay);
  }

  test("guards the relay before it can answer an AUTH challenge", async () => {
    const pool = new AuthGuardedSimplePool(generateSecretKey());
    const { relay } = fakeRelay();
    plant(pool, relay);
    const unguarded = relay.auth;
    // What ensureRelay does after registering the relay and before connecting.
    pool.automaticallyAuth?.(relay.url);
    expect(relay.auth).not.toBe(unguarded);
    // And the wrapper it installed is the real one: it observes the rejection
    // while still handing it to the caller.
    await expect(
      relay.auth(async () => {
        throw new Error("unused");
      }),
    ).rejects.toThrow("auth timed out");
  });

  test("still hands back a signer that signs with the persona key", async () => {
    const sk = generateSecretKey();
    const pool = new AuthGuardedSimplePool(sk);
    const { relay } = fakeRelay();
    plant(pool, relay);
    const signer = pool.automaticallyAuth?.(relay.url);
    expect(typeof signer).toBe("function");
    const signed = await signer!(AUTH_TEMPLATE);
    expect(signed.kind).toBe(22242);
    expect(signed.pubkey).toBe(getPublicKey(sk));
    expect(verifyEvent(signed)).toBe(true);
  });

  // Defensive: the hook must never throw for a url the pool hasn't registered,
  // or one unexpected lookup miss takes out every publish.
  test("an unknown relay url still yields a signer", async () => {
    const sk = generateSecretKey();
    const pool = new AuthGuardedSimplePool(sk);
    const signer = pool.automaticallyAuth?.("wss://never.seen");
    const signed = await signer!(AUTH_TEMPLATE);
    expect(signed.pubkey).toBe(getPublicKey(sk));
  });
});
