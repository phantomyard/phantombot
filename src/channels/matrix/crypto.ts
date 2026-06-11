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
): Promise<BootstrapResult> {
  // 1. Cross-signing. authUploadDeviceSigningKeys re-auths the signing-key
  //    upload. setupNewCrossSigning:false → reuse existing if already present
  //    (idempotent re-run during a retried setup).
  log.info("matrix: bootstrapping cross-signing");
  await crypto.bootstrapCrossSigning({
    setupNewCrossSigning: false,
    authUploadDeviceSigningKeys: authCallback,
  });

  // 2. Generate the recovery key ourselves so we can capture its encoded form
  //    BEFORE handing it to secret-storage bootstrap. createSecretStorageKey
  //    is the callback bootstrapSecretStorage invokes to mint the 4S key; we
  //    intercept it to keep the encoded key.
  let captured: string | undefined;
  log.info("matrix: bootstrapping secret storage + key backup");
  await crypto.bootstrapSecretStorage({
    setupNewKeyBackup: true,
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

  return { recoveryKey: captured };
}
