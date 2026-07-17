/*
 * PhantomChat media: fetch a file from Blossom and AES-256-GCM decrypt it.
 *
 * Counterpart to the PWA's encrypt path (phantomchat file-crypto.ts) and
 * multi-GET receive (phantomchat-file-fetch.ts). Tries the primary URL first,
 * then any mirrors carried in the envelope, then hash-addressed GETs against
 * our known Blossom server list. Verifies sha256 of the ciphertext when the
 * sender provided one before decrypting.
 *
 * The PWA encrypts with Web Crypto `AES-GCM`:
 *   - 256-bit key (32 bytes), 96-bit IV (12 bytes), both hex on the wire
 *   - Web Crypto APPENDS the 128-bit (16-byte) auth tag to the ciphertext
 *     (output is ciphertext‖tag), whereas Node's GCM wants the tag supplied
 *     separately — so we split the trailing 16 bytes and `setAuthTag`.
 * The key/iv travel inside the NIP-17 gift-wrap envelope, so only the
 * recipient can decrypt. Blossom only ever sees ciphertext.
 */
import { createDecipheriv, createHash } from "node:crypto";
import {
  DEFAULT_BLOSSOM_SERVERS,
  expandBlossomFetchUrls,
  getBlossomServers,
} from "./blossomServers.ts";

const GCM_TAG_BYTES = 16;
const KEY_BYTES = 32;
const IV_BYTES = 12;

export interface FetchDecryptOpts {
  expectedSha256Hex?: string;
  /** Extra mirror URLs from the envelope (`servers` field). */
  mirrors?: readonly string[];
  /** Override known servers used for hash-GET fallback. */
  knownServers?: readonly string[];
  signal?: AbortSignal;
  fetchImpl?: typeof fetch;
}

function decryptCiphertext(
  ciphertext: Buffer,
  key: Buffer,
  iv: Buffer,
): Buffer {
  if (ciphertext.length < GCM_TAG_BYTES) {
    throw new Error("blossom: ciphertext shorter than the GCM auth tag");
  }
  const tag = ciphertext.subarray(ciphertext.length - GCM_TAG_BYTES);
  const body = ciphertext.subarray(0, ciphertext.length - GCM_TAG_BYTES);

  const decipher = createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(body), decipher.final()]);
}

export async function fetchAndDecryptBlossom(
  url: string,
  keyHex: string,
  ivHex: string,
  opts?: FetchDecryptOpts,
): Promise<Buffer> {
  const key = Buffer.from(keyHex, "hex");
  const iv = Buffer.from(ivHex, "hex");
  if (key.length !== KEY_BYTES) {
    throw new Error(`blossom: bad key length ${key.length} (want ${KEY_BYTES})`);
  }
  if (iv.length !== IV_BYTES) {
    throw new Error(`blossom: bad iv length ${iv.length} (want ${IV_BYTES})`);
  }

  const fetchImpl = opts?.fetchImpl ?? fetch;
  const errors: string[] = [];

  // Happy path first: primary URL + envelope mirrors only. Do NOT resolve the
  // website server list until those fail *and* we have a sha256 to hash-GET
  // against — otherwise every inbound voice note pays a blossom.json hop
  // (today often a 404) out of the STT timeout budget.
  const direct = expandBlossomFetchUrls(
    url,
    undefined,
    opts?.mirrors,
    [],
  );

  const tryCandidates = async (candidates: string[]): Promise<Buffer | null> => {
    for (const candidate of candidates) {
      if (opts?.signal?.aborted) {
        throw new Error("blossom fetch aborted");
      }
      try {
        const res = await fetchImpl(candidate, { signal: opts?.signal });
        if (!res.ok) {
          errors.push(`${candidate}: HTTP ${res.status}`);
          continue;
        }
        const ciphertext = Buffer.from(await res.arrayBuffer());

        // Blossom is content-addressed by sha256 of the (encrypted) bytes.
        // Verifying catches a corrupt/tampered/wrong-blob fetch before we waste
        // a GCM auth failure (or a paid STT call) on it.
        if (opts?.expectedSha256Hex) {
          const got = createHash("sha256").update(ciphertext).digest("hex");
          if (got !== opts.expectedSha256Hex.toLowerCase()) {
            errors.push(`${candidate}: sha256 mismatch`);
            continue;
          }
        }

        return decryptCiphertext(ciphertext, key, iv);
      } catch (e) {
        if (opts?.signal?.aborted) throw e;
        errors.push(`${candidate}: ${(e as Error).message}`);
      }
    }
    return null;
  };

  const directHit = await tryCandidates(direct);
  if (directHit) return directHit;

  // Only pay for the known-server list when hash-GET can actually help.
  if (opts?.expectedSha256Hex && /^[0-9a-fA-F]{64}$/.test(opts.expectedSha256Hex)) {
    const known =
      opts?.knownServers ??
      (await getBlossomServers().catch(() => DEFAULT_BLOSSOM_SERVERS));
    const hashUrls = expandBlossomFetchUrls(
      // dummy primary already tried; expand only the hash GETs
      "",
      opts.expectedSha256Hex,
      undefined,
      known,
    ).filter((u) => u && !direct.includes(u));
    const hashHit = await tryCandidates(hashUrls);
    if (hashHit) return hashHit;
  }

  throw new Error(`blossom fetch failed: ${errors.join("; ")}`);
}
