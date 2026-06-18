/*
 * PhantomChat media: fetch a file from Blossom and AES-256-GCM decrypt it.
 *
 * Counterpart to the PWA's encrypt path (phantomchat/src/lib/phantomchat/
 * file-crypto.ts). The PWA encrypts with Web Crypto `AES-GCM`:
 *   - 256-bit key (32 bytes), 96-bit IV (12 bytes), both hex on the wire
 *   - Web Crypto APPENDS the 128-bit (16-byte) auth tag to the ciphertext
 *     (output is ciphertext‖tag), whereas Node's GCM wants the tag supplied
 *     separately — so we split the trailing 16 bytes and `setAuthTag`.
 * The encrypted bytes live at a Blossom URL; the key/iv travel inside the
 * NIP-17 gift-wrap envelope, so only the recipient can decrypt.
 */
import { createDecipheriv, createHash } from "node:crypto";

const GCM_TAG_BYTES = 16;
const KEY_BYTES = 32;
const IV_BYTES = 12;

export async function fetchAndDecryptBlossom(
  url: string,
  keyHex: string,
  ivHex: string,
  opts?: { expectedSha256Hex?: string; signal?: AbortSignal },
): Promise<Buffer> {
  const key = Buffer.from(keyHex, "hex");
  const iv = Buffer.from(ivHex, "hex");
  if (key.length !== KEY_BYTES) {
    throw new Error(`blossom: bad key length ${key.length} (want ${KEY_BYTES})`);
  }
  if (iv.length !== IV_BYTES) {
    throw new Error(`blossom: bad iv length ${iv.length} (want ${IV_BYTES})`);
  }

  const res = await fetch(url, { signal: opts?.signal });
  if (!res.ok) {
    throw new Error(`blossom fetch ${url}: HTTP ${res.status}`);
  }
  const ciphertext = Buffer.from(await res.arrayBuffer());

  // Blossom is content-addressed by sha256 of the (encrypted) bytes. Verifying
  // it catches a corrupt/tampered/wrong-blob fetch before we waste a GCM auth
  // failure on it (and before STT spends a paid API call on garbage).
  if (opts?.expectedSha256Hex) {
    const got = createHash("sha256").update(ciphertext).digest("hex");
    if (got !== opts.expectedSha256Hex.toLowerCase()) {
      throw new Error("blossom: sha256 mismatch (corrupt or tampered file)");
    }
  }

  if (ciphertext.length < GCM_TAG_BYTES) {
    throw new Error("blossom: ciphertext shorter than the GCM auth tag");
  }
  const tag = ciphertext.subarray(ciphertext.length - GCM_TAG_BYTES);
  const body = ciphertext.subarray(0, ciphertext.length - GCM_TAG_BYTES);

  const decipher = createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(body), decipher.final()]);
}
