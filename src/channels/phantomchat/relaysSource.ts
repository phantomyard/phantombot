/**
 * Canonical relay source.
 *
 * The relay set is maintained in ONE place: a static `relays.json` served by
 * the PhantomChat PWA (`https://chat.phantomyard.ai/relays.json`). The PWA reads
 * it at startup and phantombot fetches the SAME URL on startup — so neither side
 * carries a duplicate, drifting copy of the list.
 *
 * phantombot's fallback chain is: fetched canonical → the relays already cached
 * in the persona's `phantomchat.json` → the hardcoded seed
 * (`DEFAULT_PHANTOMCHAT_RELAYS`). The fetch result is cached back into each
 * persona's `phantomchat.json` so a later offline start still uses the most
 * recent known-good set.
 *
 * The URL is overridable with `PHANTOMCHAT_RELAYS_URL` (e.g. to point at a
 * staging PWA, or a self-hosted mirror).
 */

import { log } from "../../lib/logger.ts";

/** Where the canonical relay list is served. Overridable via env. */
export const PHANTOMCHAT_RELAYS_URL =
  process.env.PHANTOMCHAT_RELAYS_URL?.trim() ||
  "https://chat.phantomyard.ai/relays.json";

/** On-disk/on-wire shape of relays.json: `{ "relays": ["wss://…", …] }`. */
interface RelaysJsonShape {
  relays?: unknown;
}

function validRelays(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  return v.filter(
    (u): u is string =>
      typeof u === "string" &&
      (u.startsWith("wss://") || u.startsWith("ws://")),
  );
}

/**
 * Fetch the canonical relay list from `url` (default: the PWA's served file).
 * Returns the relay URLs on success, or `null` on ANY failure (network error,
 * non-200, malformed body, empty-after-validation) so the caller falls back to
 * the cached/seed relays. Never throws.
 *
 * `timeoutMs` bounds the fetch so a hung relays host can't wedge startup.
 */
export async function fetchCanonicalRelays(
  url: string = PHANTOMCHAT_RELAYS_URL,
  timeoutMs = 5000,
): Promise<string[] | null> {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: ac.signal });
    if (!res.ok) {
      log.debug("phantomchat: relays.json fetch non-ok", { status: res.status });
      return null;
    }
    const data = (await res.json()) as RelaysJsonShape;
    const relays = validRelays(data?.relays);
    if (relays.length === 0) {
      log.debug("phantomchat: relays.json had no valid wss entries");
      return null;
    }
    return relays;
  } catch (e) {
    log.debug("phantomchat: relays.json fetch failed", {
      error: (e as Error).message,
    });
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/** True when two relay lists are the same set in the same order. */
export function sameRelays(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}
