/*
 * PhantomChat media: upload an encrypted blob to Blossom.
 *
 * Port of the PWA's multi-mirror upload (phantomchat blossom-upload-progress.ts).
 * Signs a NIP-24242 auth event with our PhantomChat secret key and fans PUTs
 * out in parallel to minMirrors hosts (`Promise.allSettled`). Returns the
 * primary URL plus every successful mirror so the envelope can carry them
 * for multi-GET receive.
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
  /** Local sha256 of the ciphertext we uploaded. Never trusted from a server. */
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
    /** Min successful mirrors (default BLOSSOM_MIRROR_MIN). Caps fan-out. */
    minMirrors?: number;
    signal?: AbortSignal;
    fetchImpl?: typeof fetch;
  },
): Promise<BlossomUploadResult> {
  const servers = await getBlossomServers({ servers: opts?.servers });
  const fetchImpl = opts?.fetchImpl ?? fetch;
  const minMirrors = Math.max(1, opts?.minMirrors ?? BLOSSOM_MIRROR_MIN);
  const now = Math.floor(Date.now() / 1000);

  // Match the PWA: open minMirrors hosts in parallel (timing at max(t),
  // not t1+t2) without burning full-list egress.
  const targets = servers.slice(0, minMirrors);

  // NIP-24242 Blossom auth: kind-24242 with the action ('upload'), the blob
  // hash ('x'), and an expiration. Signed with our real key — the upload is
  // not gift-wrapped (the blob is already AES-GCM ciphertext; only the
  // recipient holds the key). One auth event covers every leg.
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

  if (opts?.signal?.aborted) {
    throw new Error("upload aborted");
  }

  const results = await Promise.allSettled(
    targets.map(async (server) => {
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
        throw new Error(`${server}: HTTP ${res.status}`);
      }
      const data = (await res.json()) as { url?: string; sha256?: string };
      if (!data.url) {
        throw new Error(`${server}: no url in response`);
      }
      // Integrity hash is always our local compute. A server-echoed sha is
      // informational only — never authoritative for the envelope / receiver.
      if (data.sha256 && data.sha256.toLowerCase() !== sha256Hex.toLowerCase()) {
        log.debug("phantomchat: blossom server echoed mismatched sha256", {
          server,
          echoed: data.sha256,
          expected: sha256Hex,
        });
      }
      return data.url;
    }),
  );

  // Mid-fan-out abort: shared signal killed every leg; don't surface partials.
  if (opts?.signal?.aborted) {
    throw new Error("upload aborted");
  }

  const errors: string[] = [];
  const mirrors: string[] = [];
  for (const r of results) {
    if (r.status === "fulfilled") {
      if (!mirrors.includes(r.value)) mirrors.push(r.value);
    } else {
      const msg = r.reason instanceof Error ? r.reason.message : String(r.reason);
      if (opts?.signal?.aborted) continue;
      errors.push(msg);
    }
  }

  if (mirrors.length === 0) {
    log.warn("phantomchat: blossom upload failed on all servers", {
      servers: targets.length,
    });
    throw new Error(`all blossom servers failed: ${errors.join("; ")}`);
  }

  return {
    url: mirrors[0]!,
    sha256: sha256Hex,
    mirrors,
  };
}
