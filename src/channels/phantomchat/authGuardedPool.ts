/**
 * A SimplePool that cannot be killed by an unanswered NIP-42 AUTH (issue #401).
 *
 * Kept in its own module, and imported dynamically by both call sites, so the
 * nostr-tools websocket machinery stays out of the module graph for the paths
 * that never touch a relay (a Telegram-only notify, most of the test suite).
 */

import type { AbstractRelay } from "nostr-tools/abstract-relay";
import { SimplePool } from "nostr-tools/pool";

import { log } from "../../lib/logger.ts";
import { automaticallyAuthWith, type RelayAuthSigner } from "./relayAuth.ts";

/**
 * THE BUG: setting `automaticallyAuth` (see relayAuth.ts) is what makes
 * nostr-tools call `relay.auth()` from its `["AUTH", <challenge>]` frame
 * handler — and it makes that call fire-and-forget:
 *
 *   case 'AUTH': {
 *     this.challenge = data[1]
 *     if (this.onauth) {
 *       this.auth(this.onauth)   // not awaited, not caught
 *     }
 *     return
 *   }
 *
 * That promise rejects whenever the relay doesn't answer our kind-22242 event
 * within `publishTimeout` (`Error("auth timed out")`) or answers `OK:false`
 * with a reason of its choosing. Nobody is holding it, so it lands as an
 * `unhandledRejection` — and the process-level guard from #274 re-throws
 * anything that isn't a benign ICE socket error, which is fatal. A relay that
 * rate-limits our AUTH therefore kills the daemon, systemd restarts it, and it
 * reconnects into the same rate limit: a crash loop driven entirely by a
 * remote box's traffic policy, taking every channel and any in-flight nightly
 * sweep down with it.
 *
 * THE FIX: attach a rejection handler to that promise. `auth()` memoises its
 * work in `relay.authPromise` and hands the SAME promise to every caller, so
 * attaching a handler here only marks it as observed — the two call sites that
 * genuinely await the result (the publish retry and the subscription
 * `auth-required:` retry, both of which already catch) still see the rejection
 * and still retry. Nothing is swallowed except the crash.
 *
 * Wrapping the INSTANCE rather than `AbstractRelay.prototype` is deliberate:
 * nostr-tools ships a separate bundled copy of the class in each entry point
 * (`relay.js`, `pool.js`, `abstract-relay.js`), so the prototype our import
 * resolves to is not necessarily the one `SimplePool` instantiates.
 */
const AUTH_GUARDED = Symbol.for("phantombot.relayAuthGuarded");

type AuthGuardable = AbstractRelay & { [AUTH_GUARDED]?: true };

/**
 * Make one relay's `auth()` safe to call without awaiting. Idempotent: pools
 * re-run the `automaticallyAuth` hook on every `ensureRelay`, including for
 * relays they already hold.
 */
export function guardRelayAuthRejection(relay: AbstractRelay): void {
  const target = relay as AuthGuardable;
  if (target[AUTH_GUARDED]) return;
  target[AUTH_GUARDED] = true;

  const original = relay.auth.bind(relay);
  target.auth = (signAuthEvent) => {
    const pending = original(signAuthEvent);
    pending.catch((e: unknown) => {
      // Expected and survivable: a rate limit, a slow relay, a relay that
      // simply never OKs auth events. Log it so a persistently failing relay
      // is visible, and let the retrying call sites decide what to do.
      log.warn("phantomchat: relay AUTH failed", {
        relay: relay.url,
        error: e instanceof Error ? e.message : String(e),
      });
    });
    return pending;
  };
}

/**
 * A `SimplePool` that answers NIP-42 challenges for a persona AND cannot be
 * killed by one going unanswered.
 *
 * The guard is installed from inside the `automaticallyAuth` hook, which the
 * pool calls after registering the relay in `this.relays` and BEFORE
 * `relay.connect()` — the only window that closes before a relay can send its
 * first AUTH frame. Subclassing is what gives us legitimate access to the
 * protected `relays` map; no casts, no reaching into private state.
 */
export class AuthGuardedSimplePool extends SimplePool {
  constructor(
    secretKey: Uint8Array,
    options?: ConstructorParameters<typeof SimplePool>[0],
  ) {
    super(options);
    const signerFor = automaticallyAuthWith(secretKey);
    this.automaticallyAuth = (relayURL: string): RelayAuthSigner => {
      const relay = this.relays.get(relayURL);
      if (relay) guardRelayAuthRejection(relay);
      return signerFor(relayURL);
    };
  }
}
