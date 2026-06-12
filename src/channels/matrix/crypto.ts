/**
 * Matrix invisible-E2EE bootstrap.
 *
 * This is the code path that makes "E2EE just works, the user never sees it"
 * true. Run ONCE at `phantombot chat matrix` setup time, right after a
 * password login + rust-crypto init, on a freshly-created device. It:
 *
 *   1. Auto-bootstraps CROSS-SIGNING (so this device has a cross-signing
 *      identity the homeserver + other clients can reason about).
 *   2. Auto-bootstraps SECRET STORAGE + KEY BACKUP, generating a RECOVERY KEY
 *      automatically (never asking the user, never displaying it).
 *   3. Returns that recovery key's encoded form so the caller can stash it in
 *      ~/.env as MATRIX_RECOVERY_KEY (via `phantombot env set`). It is the
 *      portable root-of-trust: a fresh VM with an empty crypto store can use
 *      it to restore Megolm history from server-side key backup.
 *
 * The principal's hard requirement, encoded here: NO prompts about E2EE,
 * recovery keys, or verification. The recovery key is generated, stored for
 * the agent, and never surfaced. Trade-off (accepted, per spec): with zero
 * manual verification, other clients may render this device "unverified", but
 * messages still encrypt/decrypt correctly. Transparency wins.
 *
 * The work is expressed against a minimal `MatrixCryptoLike` so the CLI wizard
 * can be unit-tested without a live homeserver or real WASM crypto.
 */

import { log } from "../../lib/logger.ts";

/** The bits of matrix-js-sdk's `CryptoApi` the bootstrap touches. */
export interface MatrixCryptoLike {
  bootstrapCrossSigning(opts: {
    setupNewCrossSigning?: boolean;
    authUploadDeviceSigningKeys?: (
      makeRequest: (authData: unknown) => Promise<unknown>,
    ) => Promise<void>;
  }): Promise<void>;
  bootstrapSecretStorage(opts: {
    createSecretStorageKey?: () => Promise<{
      encodedPrivateKey?: string;
      privateKey: Uint8Array;
    }>;
    setupNewKeyBackup?: boolean;
    setupNewSecretStorage?: boolean;
  }): Promise<void>;
  /** Generate a fresh recovery (4S) key without a passphrase. */
  createRecoveryKeyFromPassphrase(password?: string): Promise<{
    encodedPrivateKey?: string;
    privateKey: Uint8Array;
  }>;
  /**
   * True once cross-signing private keys are available to this device (i.e.
   * `bootstrapCrossSigning` established or unlocked them). Optional so test
   * fakes need not implement it. When absent, the self-cross-sign step below is
   * skipped (best-effort).
   */
  isCrossSigningReady?(): Promise<boolean>;
  /**
   * Sign one of our own devices with the self-signing key — the step that flips
   * a freshly-minted device from "unverified" to cross-signed. Optional for the
   * same reason as above.
   */
  crossSignDevice?(deviceId: string): Promise<void>;
}

/** Extra context the bootstrap needs beyond the crypto API + auth callback. */
export interface BootstrapOpts {
  /**
   * This device's id. When provided AND cross-signing ends up ready, the
   * bootstrap explicitly cross-signs this device so it lands VERIFIED instead
   * of merely self-signed — the durable fix for the "unverified" badge on a
   * fresh, bot-owned account.
   */
  deviceId?: string;
}

export interface BootstrapResult {
  /**
   * The encoded recovery key (space-separated base58 per the Matrix spec).
   * The caller persists this as MATRIX_RECOVERY_KEY. NEVER display it.
   */
  recoveryKey: string;
}

/**
 * Run the full invisible-E2EE bootstrap against `crypto`. Returns the
 * auto-generated recovery key for the caller to store.
 *
 * `authCallback` supplies User-Interactive-Auth data for the cross-signing key
 * upload (homeservers require re-auth to upload signing keys). The wizard
 * passes a callback that replays the just-used password login; we take it as a
 * parameter rather than capturing the password here so this module never holds
 * the plaintext password (it's discarded the moment login completes).
 */
export async function bootstrapInvisibleE2ee(
  crypto: MatrixCryptoLike,
  authCallback: (
    makeRequest: (authData: unknown) => Promise<unknown>,
  ) => Promise<void>,
  opts: BootstrapOpts = {},
): Promise<BootstrapResult> {
  // IMPORTANT: the caller MUST have started the client and reached first sync
  // before calling this. bootstrapSecretStorage reads/writes account data; with
  // no running /sync those reads are inconsistent and the bootstrap hangs.
  //
  // 1. Cross-signing — BEST EFFORT. On a clean account this creates the
  //    cross-signing identity (password UIA via authUploadDeviceSigningKeys).
  //    But matrix.org gates RESETTING an EXISTING cross-signing identity behind
  //    a one-time WEB approval (UIA flow `m.oauth` / `org.matrix.cross_signing_
  //    reset` at account.matrix.org) that a headless daemon cannot satisfy. So
  //    if cross-signing can't be established we LOG AND CONTINUE: device-level
  //    E2EE (encrypt/decrypt via device keys + key backup) does not depend on
  //    it — cross-signing only governs cross-client device VERIFICATION, and an
  //    unverified-but-working device is the accepted trade-off (see header).
  log.info("matrix: bootstrapping cross-signing");
  try {
    await crypto.bootstrapCrossSigning({
      setupNewCrossSigning: false,
      authUploadDeviceSigningKeys: authCallback,
    });
  } catch (e) {
    log.warn(
      "matrix: cross-signing bootstrap skipped (E2EE still works; device may show unverified)",
      { error: (e as Error).message },
    );
  }

  // 2. Secret storage + key backup. setupNewSecretStorage:true establishes a
  //    fresh 4S we control (replacing any orphaned one this device can't
  //    unlock) and createSecretStorageKey mints the recovery key — we intercept
  //    it to capture the encoded form BEFORE it's handed to the bootstrap.
  let captured: string | undefined;
  log.info("matrix: bootstrapping secret storage + key backup");
  await crypto.bootstrapSecretStorage({
    setupNewKeyBackup: true,
    setupNewSecretStorage: true,
    createSecretStorageKey: async () => {
      const key = await crypto.createRecoveryKeyFromPassphrase();
      captured = key.encodedPrivateKey;
      return key;
    },
  });

  if (!captured || captured.length === 0) {
    // Should never happen — createRecoveryKeyFromPassphrase always returns an
    // encoded key — but fail loudly rather than store an empty secret.
    throw new Error(
      "matrix: secret-storage bootstrap produced no encoded recovery key",
    );
  }

  // 3. Self-cross-sign this device — BEST EFFORT. With cross-signing + secret
  //    storage now established, signing our own device flips it from
  //    "unverified" to cross-signed, so other clients render it trusted without
  //    any manual SAS. Gated on cross-signing actually being ready: on a
  //    contaminated account where step 1 was skipped (existing identity we
  //    can't unlock), this is a no-op and the device stays self-signed — the
  //    operator clears it later via the runtime self-verification responder.
  try {
    if (opts.deviceId && crypto.isCrossSigningReady && crypto.crossSignDevice) {
      if (await crypto.isCrossSigningReady()) {
        await crypto.crossSignDevice(opts.deviceId);
        log.info("matrix: device cross-signed", { deviceId: opts.deviceId });
      } else {
        log.warn(
          "matrix: cross-signing not ready — device left unverified (verify from your client later)",
        );
      }
    }
  } catch (e) {
    log.warn("matrix: self cross-sign skipped", {
      error: (e as Error).message,
    });
  }

  return { recoveryKey: captured };
}
