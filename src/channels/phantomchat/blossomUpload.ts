/*
 * PhantomChat media: upload an encrypted blob to Blossom.
 *
 * Port of the PWA's multi-mirror upload (phantomchat blossom-upload-progress.ts).
 * Signs a NIP-24242 auth event with our PhantomChat secret key and PUTs the
 * ciphertext to public Blossom servers until we have ≥BLOSSOM_MIRROR_MIN
 * successes (or the list is exhausted). Returns the primary URL plus every
 * successful mirror so the envelope can carry them for multi-GET receive.
 *
 * Server list comes from the PWA-served /blossom.json (see blossomServers.ts);
 * the hardcoded DEFAULT_BLOSSOM_SERVERS is disaster-net only.
 */
import { finalizeEvent } from "nostr-tools/pure";
import { log } from "../../lib/logger.ts";
import {
  BLOSSOM_MIRROR_MIN,
  DEFAULT_BLOSSOM_SERVERS,
  getBlossomServers,
} from "./blossomServers.ts";

/** @deprecated Prefer DEFAULT_BLOSSOM_SERVERS / getBlossomServers(). */
export const BLOSSOM_SERVERS = DEFAULT_BLOSSOM_SERVERS;

export interface BlossomUploadResult {
  /** Primary URL — first successful PUT. Goes in envelope.url. */
  url: string;
  sha256: string;
  /** Every successful URL including primary. Recipient tries these in order. */
  mirrors: string[];
}

/** Upload window the signed auth event stays valid for (matches the PWA). */
const AUTH_EXPIRATION_SEC = 300;

export async function uploadToBlossom(
  ciphertext: Buffer,
  sha256Hex: string,
  secretKey: Uint8Array,
  mime: string,
  opts?: {
    servers?: readonly string[];
    /** Min successful mirrors (default BLOSSOM_MIRROR_MIN). At least 1. */
    minMirrors?: number;
    signal?: AbortSignal;
    fetchImpl?: typeof fetch;
  },
): Promise<BlossomUploadResult> {
  const servers = await getBlossomServers({ servers: opts?.servers });
  const fetchImpl = opts?.fetchImpl ?? fetch;
  const minMirrors = Math.max(1, opts?.minMirrors ?? BLOSSOM_MIRROR_MIN);
  const now = Math.floor(Date.now() / 1000);

  // NIP-24242 Blossom auth: kind-24242 with the action ('upload'), the blob
  // hash ('x'), and an expiration. Signed with our real key — the upload is
  // not gift-wrapped (the blob is already AES-GCM ciphertext; only the
  // recipient holds the key).
  const event = finalizeEvent(
    {
      kind: 24242,
      created_at: now,
      content: "Upload voice note",
      tags: [
        ["t", "upload"],
        ["x", sha256Hex],
        ["expiration", String(now + AUTH_EXPIRATION_SEC)],
      ],
    },
    secretKey,
  );
  const authHeader = "Nostr " + Buffer.from(JSON.stringify(event)).toString("base64");

  const errors: string[] = [];
  const mirrors: string[] = [];
  let firstSha = sha256Hex;

  for (const server of servers) {
    if (opts?.signal?.aborted) {
      throw new Error("upload aborted");
    }
    if (mirrors.length >= minMirrors) break;

    try {
      const res = await fetchImpl(`${server}/upload`, {
        method: "PUT",
        headers: {
          Authorization: authHeader,
          "Content-Type": mime || "application/octet-stream",
        },
        body: ciphertext,
        signal: opts?.signal,
      });
      if (!res.ok) {
        errors.push(`${server}: HTTP ${res.status}`);
        continue;
      }
      const data = (await res.json()) as { url?: string; sha256?: string };
      if (!data.url) {
        errors.push(`${server}: no url in response`);
        continue;
      }
      if (!mirrors.includes(data.url)) mirrors.push(data.url);
      if (data.sha256) firstSha = data.sha256;
    } catch (e) {
      const msg = (e as Error).message;
      if (msg === "upload aborted") throw e;
      errors.push(`${server}: ${msg}`);
    }
  }

  if (mirrors.length === 0) {
    log.warn("phantomchat: blossom upload failed on all servers", {
      servers: servers.length,
    });
    throw new Error(`all blossom servers failed: ${errors.join("; ")}`);
  }

  return {
    url: mirrors[0]!,
    sha256: firstSha || sha256Hex,
    mirrors,
  };
}
