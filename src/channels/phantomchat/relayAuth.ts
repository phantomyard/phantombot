/**
 * NIP-42 relay AUTH support for the phantomchat transport.
 *
 * THE PROBLEM (issue #368): a relay configured with `nip42_auth = true`
 * (nostr-rs-relay) demands an authenticated session before it will store our
 * publishes. Without NIP-42 support the relay answers our publish with
 * `OK:true` and then silently DROPS the event — the turn completes cleanly,
 * the recipient never sees the reply, and nothing in the logs says why. That
 * is the worst failure class a transport can have: silent outbound message
 * loss.
 *
 * THE FIX: nostr-tools 2.23.3 already carries the whole NIP-42 machinery —
 * it just needs a signer. Two entry points consume the same signer:
 *
 *   1. `automaticallyAuth` on the SimplePool constructor: when a relay sends
 *      an `["AUTH", <challenge>]` frame (on connect or mid-subscription),
 *      nostr-tools builds the kind-22242 auth event (`makeAuthEvent(relayURL,
 *      challenge)`) and hands it to this callback to sign.
 *   2. The `onauth` param on `pool.publish(...)` / `pool.subscribeMany(...)`:
 *      when a relay rejects a publish with `OK:false "auth-required: ..."` or
 *      closes a subscription with `auth-required:`, nostr-tools authenticates
 *      with this callback and then RETRIES the operation.
 *
 * Both paths converge here: the callback receives a fully-formed
 * EventTemplate (kind 22242, `relay` + `challenge` tags already set) and only
 * has to sign it with the persona's PhantomChat secret key.
 *
 * The signer is intentionally a pure function of the secret key — no relay
 * allowlist. A relay that asks for AUTH gets it; the kind-22242 event is only
 * ever sent to the relay that issued the challenge (nostr-tools enforces the
 * `relay` tag match), so signing does not leak identity to third parties.
 */

import { finalizeEvent } from "nostr-tools/pure";
import type { EventTemplate, VerifiedEvent } from "nostr-tools/core";

import { log } from "../../lib/logger.ts";

/**
 * The signer shape nostr-tools expects for `onauth` / `automaticallyAuth`:
 * given the auth EventTemplate, return the signed kind-22242 event.
 */
export type RelayAuthSigner = (event: EventTemplate) => Promise<VerifiedEvent>;

/**
 * Build the NIP-42 auth signer for a persona's PhantomChat secret key.
 * Cheap and pure — safe to construct per pool and per transport.
 */
export function makeRelayAuthSigner(secretKey: Uint8Array): RelayAuthSigner {
  return async (event: EventTemplate): Promise<VerifiedEvent> => {
    const relayTag = event.tags.find((t) => t[0] === "relay")?.[1];
    log.debug("phantomchat: answering relay AUTH challenge", {
      kind: event.kind,
      relay: relayTag,
    });
    return finalizeEvent(event, secretKey);
  };
}

/**
 * The `automaticallyAuth` option for the SimplePool constructor: return the
 * persona's signer for every relay that challenges us. nostr-tools calls this
 * once per relay at connect time; returning the signer installs it as
 * `relay.onauth`, which answers both the connect-time AUTH challenge and any
 * mid-session re-challenge.
 */
export function automaticallyAuthWith(
  secretKey: Uint8Array,
): (relayURL: string) => RelayAuthSigner {
  const signer = makeRelayAuthSigner(secretKey);
  return () => signer;
}
