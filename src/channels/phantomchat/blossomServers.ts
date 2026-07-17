/**
 * Canonical Blossom server list — bot half of phantomchat `/blossom.json`.
 *
 * The server set is maintained in ONE place: a static `blossom.json` served by
 * the PhantomChat PWA (`https://chat.phantomyard.ai/blossom.json`). Continues
 * the same single-source pattern as `relays.json` / `relaysSource.ts`.
 *
 * Hardcoded DEFAULT_BLOSSOM_SERVERS is the disaster net only (offline / 404 /
 * malformed). Shape on the wire: `{ "servers": ["https://…", …] }`.
 *
 * Solid free public set (live write-probe 2026-07-17 for encrypted PhantomChat
 * media as `application/octet-stream`):
 *   nostr.download / ditto.pub / data.haus
 * Dropped: primal (mime-filters octet-stream), band / nostr.build (mime wall),
 * nostrmedia (paid), satellite (auth/flaky).
 */

import { log } from "../../lib/logger.ts";

/** Where the canonical Blossom list is served. Overridable via env. */
export const PHANTOMCHAT_BLOSSOM_URL =
  process.env.PHANTOMCHAT_BLOSSOM_URL?.trim() ||
  "https://chat.phantomyard.ai/blossom.json";

/**
 * Disaster-net list. Must accept NIP-24242 + free `application/octet-stream`
 * PUT and return the blob via GET `/{sha256}`. Prefer ≥3 independent operators.
 */
export const DEFAULT_BLOSSOM_SERVERS: readonly string[] = [
  "https://nostr.download",
  "https://blossom.ditto.pub",
  "https://blossom.data.haus",
];

/** Prefer ≥2 successful PUTs so a single CDN dying mid-day cannot brick a note. */
export const BLOSSOM_MIRROR_MIN = 2;

interface BlossomJsonShape {
  servers?: unknown;
}

function normalizeServer(url: string): string {
  return url.replace(/\/+$/, "");
}

function validServers(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const u of v) {
    if (typeof u !== "string" || !u.startsWith("https://")) continue;
    const n = normalizeServer(u.trim());
    if (n.length <= "https://x".length || seen.has(n)) continue;
    seen.add(n);
    out.push(n);
  }
  return out;
}

/**
 * Fetch the canonical Blossom list from `url` (default: the PWA's served file).
 * Returns the server URLs on success, or `null` on ANY failure so the caller
 * falls back to the hardcoded seed. Never throws.
 */
export async function fetchCanonicalBlossomServers(
  url: string = PHANTOMCHAT_BLOSSOM_URL,
  timeoutMs = 5000,
): Promise<string[] | null> {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: ac.signal });
    if (!res.ok) {
      log.debug("phantomchat: blossom.json fetch non-ok", { status: res.status });
      return null;
    }
    const data = (await res.json()) as BlossomJsonShape;
    const servers = validServers(data?.servers);
    if (servers.length === 0) {
      log.debug("phantomchat: blossom.json had no valid https entries");
      return null;
    }
    return servers;
  } catch (e) {
    log.debug("phantomchat: blossom.json fetch failed", {
      error: (e as Error).message,
    });
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Resolve the server list for this call. Always returns ≥1 URL — either the
 * website list or the disaster-net default. Optional override wins (tests /
 * ops pin).
 */
export async function getBlossomServers(opts?: {
  servers?: readonly string[];
}): Promise<readonly string[]> {
  if (opts?.servers && opts.servers.length > 0) {
    return opts.servers.map((s) => normalizeServer(s));
  }
  const fetched = await fetchCanonicalBlossomServers();
  return fetched && fetched.length > 0 ? fetched : DEFAULT_BLOSSOM_SERVERS;
}

/** Build a hash-addressed mirror URL on a given server (BUD-01). */
export function blossomHashUrl(server: string, sha256: string): string {
  return `${normalizeServer(server)}/${sha256.toLowerCase()}`;
}

/**
 * Expand a primary URL + optional mirror list + known servers into an ordered
 * unique candidate list for receive: primary → listed mirrors → hash GETs on
 * our known servers.
 */
export function expandBlossomFetchUrls(
  primaryUrl: string,
  sha256: string | undefined,
  mirrors: readonly string[] | undefined,
  knownServers: readonly string[] = DEFAULT_BLOSSOM_SERVERS,
): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const add = (u: string | undefined) => {
    if (!u || typeof u !== "string") return;
    const n = u.trim();
    if (!n || seen.has(n)) return;
    seen.add(n);
    out.push(n);
  };

  add(primaryUrl);
  if (mirrors) {
    for (const m of mirrors) add(m);
  }
  if (sha256 && /^[0-9a-fA-F]{64}$/.test(sha256)) {
    for (const s of knownServers) add(blossomHashUrl(s, sha256));
  }
  return out;
}
