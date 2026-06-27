/*
 * PhantomChat media: upload an encrypted blob to Blossom.
 *
 * Port of the PWA's uploadToBlossom (phantomchat/src/lib/phantomchat/
 * blossom-upload.ts). Signs a NIP-24242 auth event with our PhantomChat secret
 * key and PUTs the ciphertext to a fallback chain of public Blossom servers,
 * returning the URL of the first server that accepts it. The content address is
 * the sha256 of the encrypted bytes (computed by the caller and carried in the
 * auth event's `x` tag).
 */
import { finalizeEvent } from "nostr-tools/pure";
import { log } from "../../lib/logger.ts";

export const BLOSSOM_SERVERS = [
  "https://blossom.primal.net",
  "https://cdn.satellite.earth",
  "https://blossom.band",
] as const;

export interface BlossomUploadResult {
  url: string;
  sha256: string;
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
    signal?: AbortSignal;
    fetchImpl?: typeof fetch;
  },
): Promise<BlossomUploadResult> {
  const servers = opts?.servers ?? BLOSSOM_SERVERS;
  const fetchImpl = opts?.fetchImpl ?? fetch;
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
  for (const server of servers) {
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
      return { url: data.url, sha256: data.sha256 || sha256Hex };
    } catch (e) {
      errors.push(`${server}: ${(e as Error).message}`);
    }
  }

  log.warn("phantomchat: blossom upload failed on all servers", {
    servers: servers.length,
  });
  throw new Error(`all blossom servers failed: ${errors.join("; ")}`);
}
