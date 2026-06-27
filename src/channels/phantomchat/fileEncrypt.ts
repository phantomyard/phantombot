/*
 * PhantomChat media: AES-256-GCM encrypt a file for Blossom upload.
 *
 * Egress counterpart to blossomFetch.ts (which decrypts). The PWA encrypts
 * with Web Crypto `AES-GCM`, which APPENDS the 128-bit (16-byte) auth tag to
 * the ciphertext (output is `ciphertext‖tag`). Node's GCM produces the tag
 * separately via `getAuthTag()`, so we concatenate it ourselves to match the
 * exact byte layout the PWA's decrypt path (and our own fetchAndDecryptBlossom)
 * expects: split the trailing 16 bytes, `setAuthTag`, decrypt the rest.
 *
 *   - 256-bit key (32 bytes), 96-bit IV (12 bytes), both fresh per file and
 *     hex-encoded onto the wire (they travel inside the NIP-17 gift-wrap, so
 *     only the recipient can decrypt).
 *   - The Blossom content address is the sha256 of the ENCRYPTED bytes — the
 *     same value the recipient verifies before spending a decrypt on the blob.
 */
import { createCipheriv, createHash, randomBytes } from "node:crypto";

const KEY_BYTES = 32;
const IV_BYTES = 12;

export interface EncryptedFile {
  /** ciphertext‖tag — the exact byte layout Web Crypto AES-GCM produces. */
  ciphertext: Buffer;
  /** Fresh 256-bit key, hex (travels inside the gift-wrap envelope). */
  keyHex: string;
  /** Fresh 96-bit IV, hex. */
  ivHex: string;
  /** sha256 of `ciphertext` — the Blossom content address. */
  sha256Hex: string;
}

export function encryptFileBytes(plaintext: Buffer): EncryptedFile {
  const key = randomBytes(KEY_BYTES);
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const body = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const tag = cipher.getAuthTag(); // 16 bytes
  const ciphertext = Buffer.concat([body, tag]);
  const sha256Hex = createHash("sha256").update(ciphertext).digest("hex");
  return {
    ciphertext,
    keyHex: key.toString("hex"),
    ivHex: iv.toString("hex"),
    sha256Hex,
  };
}
