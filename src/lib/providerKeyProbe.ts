/**
 * Lightweight provider-key validation — "is this API key real?" — run the
 * moment a user types one, BEFORE the model slots (whose choices would all
 * need redoing if the key were bad and only the end-of-flow live test caught
 * it).
 *
 * Design:
 *   - One cheap authenticated GET per provider (its models endpoint), 10s
 *     timeout, browser UA (public-internet rule).
 *   - 2xx                     → "verified"  (key accepted)
 *   - 401/403                 → "invalid"   (provider explicitly rejected it —
 *                                              the ONLY verdict that blocks)
 *   - anything else / unknown → "unverified" (we couldn't check; flow continues
 *                                              and the live test still guards)
 *
 * Deliberately conservative about blocking: a wrong endpoint guess, a network
 * blip or a provider outage must never lock a user out of their own valid
 * key. Only an explicit rejection from the provider's own API counts.
 */

export type KeyProbeStatus = "verified" | "invalid" | "unverified";

export interface KeyProbeResult {
  status: KeyProbeStatus;
  /** Human-readable evidence either way (HTTP code, error text). */
  detail: string;
}

/** OpenAI-compatible base URLs whose `/models` answers a Bearer key. */
const OPENAI_COMPATIBLE: Record<string, string> = {
  openai: "https://api.openai.com/v1",
  deepseek: "https://api.deepseek.com/v1",
  groq: "https://api.groq.com/openai/v1",
  mistral: "https://api.mistral.ai/v1",
  xai: "https://api.x.ai/v1",
  together: "https://api.together.xyz/v1",
  fireworks: "https://api.fireworks.ai/inference/v1",
  cerebras: "https://api.cerebras.ai/v1",
  nvidia: "https://integrate.api.nvidia.com/v1",
};

/** Non-OpenAI-shaped providers with a known cheap auth check. */
const SPECIAL: Record<string, (key: string) => { url: string; headers: Record<string, string> }> = {
  anthropic: (key) => ({
    url: "https://api.anthropic.com/v1/models?limit=1",
    headers: {
      "x-api-key": key,
      "anthropic-version": "2023-06-01",
    },
  }),
  google: (key) => ({
    url: "https://generativelanguage.googleapis.com/v1beta/models?pageSize=1",
    headers: { "x-goog-api-key": key },
  }),
  // OpenRouter's /models is public — /key is the endpoint that authenticates.
  openrouter: (key) => ({
    url: "https://openrouter.ai/api/v1/key",
    headers: { Authorization: `Bearer ${key}` },
  }),
  huggingface: (key) => ({
    url: "https://huggingface.co/api/whoami-v2",
    headers: { Authorization: `Bearer ${key}` },
  }),
};

const BROWSER_UA =
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36";

async function check(
  url: string,
  headers: Record<string, string>,
): Promise<KeyProbeResult> {
  try {
    const res = await fetch(url, {
      headers: { "User-Agent": BROWSER_UA, ...headers },
      signal: AbortSignal.timeout(10_000),
    });
    if (res.ok) return { status: "verified", detail: `key accepted by ${new URL(url).host}` };
    if (res.status === 401 || res.status === 403) {
      return { status: "invalid", detail: `rejected by the provider (HTTP ${res.status})` };
    }
    return {
      status: "unverified",
      detail: `unexpected HTTP ${res.status} from ${new URL(url).host}`,
    };
  } catch (err) {
    return {
      status: "unverified",
      detail: err instanceof Error ? err.message : String(err),
    };
  }
}

export async function probeProviderKey(
  providerId: string,
  key: string,
): Promise<KeyProbeResult> {
  const trimmed = key.trim();
  if (!trimmed) return { status: "unverified", detail: "no key to check" };
  const special = SPECIAL[providerId];
  if (special) {
    const { url, headers } = special(trimmed);
    return check(url, headers);
  }
  const base = OPENAI_COMPATIBLE[providerId];
  if (base) return check(`${base}/models`, { Authorization: `Bearer ${trimmed}` });
  return {
    status: "unverified",
    detail: `no known check for provider '${providerId}'`,
  };
}
