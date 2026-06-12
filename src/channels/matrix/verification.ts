/**
 * Self-verification auto-responder.
 *
 * THE FIX FOR THE "UNVERIFIED" BADGE. Our invisible-E2EE setup encrypts and
 * decrypts perfectly, but a freshly-minted device is not cross-signed until
 * SOMEONE verifies it — and that "someone" is an interactive SAS (emoji)
 * handshake other clients drive. With no human on the bot's side, the handshake
 * never completes and the device shows "Unverified" forever.
 *
 * This wires the bot to be a willing PARTNER in that handshake: when the
 * operator clicks "Verify" on the bot's session from their OWN Element (a
 * self-verification between two of their own devices), the bot:
 *
 *   1. auto-ACCEPTS the verification request,
 *   2. drives the SAS method to the point emojis are exchanged, and
 *   3. auto-CONFIRMS the SAS match.
 *
 * Because the SAS proves both sides hold the same keys, completing it lets the
 * operator's Element (which holds the cross-signing private keys) sign the
 * bot's device — the badge clears for good, and stays clear across restarts
 * (the signature lives in the crypto store).
 *
 * SAFETY: we ONLY auto-handle SELF-verification — a request from one of the
 * bot's OWN user's devices. A request from any OTHER user is ignored (left to
 * time out); the bot never auto-trusts a third party. This mirrors the trust
 * posture everywhere else: only the principal's own identity is auto-honoured.
 *
 * Enum values below are inlined as the literal strings/numbers matrix-js-sdk's
 * crypto-api uses, rather than deep-importing its enums — that keeps this
 * module decoupled from the SDK's internal module layout. They are stable
 * across the 41.x line (see crypto-api/CryptoEvent + crypto-api/verification).
 */

import { log } from "../../lib/logger.ts";

/** `CryptoEvent.VerificationRequestReceived`. */
const EV_VERIFICATION_REQUEST_RECEIVED = "crypto.verificationRequestReceived";
/** `VerificationRequestEvent.Change`. */
const EV_REQUEST_CHANGE = "change";
/** `VerifierEvent.ShowSas`. */
const EV_SHOW_SAS = "show_sas";
/** SAS (emoji/decimal) verification method id. */
const SAS_METHOD = "m.sas.v1";

// `VerificationPhase` numeric values (crypto-api/verification.ts).
const PHASE_READY = 3;
const PHASE_CANCELLED = 5;
const PHASE_DONE = 6;

/** Subset of `ShowSasCallbacks` we touch. */
interface ShowSasCallbacks {
  confirm(): Promise<void>;
  mismatch(): void;
  cancel(): void;
}

/** Subset of `Verifier` we touch. */
interface Verifier {
  verify(): Promise<void>;
  getShowSasCallbacks(): ShowSasCallbacks | null;
  on(event: string, cb: (...args: unknown[]) => void): void;
  off?(event: string, cb: (...args: unknown[]) => void): void;
}

/** Subset of `VerificationRequest` we touch. */
export interface VerificationRequestLike {
  readonly isSelfVerification: boolean;
  readonly otherUserId: string;
  readonly phase: number;
  readonly verifier: Verifier | undefined;
  accept(): Promise<void>;
  startVerification(method: string): Promise<Verifier>;
  on(event: string, cb: () => void): void;
  off?(event: string, cb: () => void): void;
}

/** Subset of the `CryptoApi` event emitter we touch. */
export interface CryptoApiEmitter {
  on(
    event: string,
    cb: (request: VerificationRequestLike) => void,
  ): void;
  off?(
    event: string,
    cb: (request: VerificationRequestLike) => void,
  ): void;
}

/** Subset of the matrix-js-sdk client we need to wire the responder. */
export interface VerifiableClient {
  getUserId(): string | null;
  getCrypto?(): CryptoApiEmitter | undefined;
}

/**
 * Install the self-verification auto-responder on a crypto-enabled client.
 * No-op (returns a no-op unsubscribe) when the client has no crypto. The
 * returned function removes the listener.
 */
export function installSelfVerificationAutoResponder(
  client: VerifiableClient,
): () => void {
  const crypto = client.getCrypto?.();
  if (!crypto) return () => {};
  const selfId = client.getUserId();

  const onRequest = (request: VerificationRequestLike) => {
    void handleVerificationRequest(request, selfId);
  };
  crypto.on(EV_VERIFICATION_REQUEST_RECEIVED, onRequest);
  log.info("matrix: self-verification auto-responder installed");
  return () => crypto.off?.(EV_VERIFICATION_REQUEST_RECEIVED, onRequest);
}

/**
 * Handle one inbound verification request. Exported for unit testing with a
 * fake request; production reaches it via the installed listener.
 */
export async function handleVerificationRequest(
  request: VerificationRequestLike,
  selfId: string | null,
): Promise<void> {
  // SAFETY GATE: only ever auto-verify the principal's OWN devices. Anything
  // else is ignored (it will time out) — we never auto-trust a third party.
  if (!request.isSelfVerification) return;
  if (selfId && request.otherUserId !== selfId) return;

  try {
    log.info("matrix: auto-accepting self-verification request");
    await request.accept();
    await driveSasToConfirmation(request);
  } catch (e) {
    log.warn("matrix: self-verification did not complete", {
      error: (e as Error).message,
    });
  }
}

/**
 * Drive the request through SAS to an auto-confirm. Resolves when the request
 * reaches a terminal phase (Done/Cancelled) or the SAS verifier settles.
 *
 * Handles both directions: if the other side starts SAS, a verifier appears via
 * the request's `change` event and we confirm it; if the request reaches Ready
 * with no verifier, we proactively start SAS ourselves (glare with the other
 * side starting is resolved by the SDK), so the flow completes regardless of
 * which end initiates the method.
 */
function driveSasToConfirmation(
  request: VerificationRequestLike,
): Promise<void> {
  return new Promise<void>((resolve) => {
    let verifierHandled = false;
    let sasStarted = false;
    let settled = false;

    const finish = () => {
      if (settled) return;
      settled = true;
      request.off?.(EV_REQUEST_CHANGE, onChange);
      resolve();
    };

    const handleVerifier = (verifier: Verifier) => {
      if (verifierHandled) return;
      verifierHandled = true;

      const onShowSas = () => {
        const cbs = verifier.getShowSasCallbacks();
        if (cbs) {
          // It's our own device — the SAS is guaranteed to match, so confirm
          // without comparing. This is the headless half of the handshake.
          log.info("matrix: auto-confirming SAS for own device");
          void cbs.confirm();
        }
      };
      verifier.on(EV_SHOW_SAS, onShowSas);

      verifier.verify().then(
        () => {
          log.info("matrix: self-verification complete — device cross-signed");
          finish();
        },
        (e: unknown) => {
          log.warn("matrix: SAS verifier ended without success", {
            error: (e as Error).message,
          });
          finish();
        },
      );
    };

    const onChange = () => {
      const phase = request.phase;
      if (request.verifier) {
        handleVerifier(request.verifier);
      } else if (!sasStarted && phase === PHASE_READY) {
        sasStarted = true;
        request.startVerification(SAS_METHOD).then(handleVerifier, () => {
          /* the other side may have started first; its verifier arrives via change */
        });
      }
      if (phase === PHASE_CANCELLED || phase === PHASE_DONE) finish();
    };

    request.on(EV_REQUEST_CHANGE, onChange);
    // Kick once: the request may already be past Requested by the time we attach.
    onChange();
  });
}
