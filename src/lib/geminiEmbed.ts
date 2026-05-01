/**
 * Tiny Gemini embedding client. Raw HTTPS — no SDK, no extra dep.
 *
 * Used by:
 *   - `phantombot embedding` (validation: one test embed before saving the key)
 *   - the nightly indexer (phase 25: batch-embed every KB note)
 *
 * Endpoint:
 *   POST https://generativelanguage.googleapis.com/v1beta/models/<model>:embedContent?key=<API_KEY>
 *   Body: {model: "models/<model>", content: {parts: [{text}]}, outputDimensionality: <N>}
 *
 * Free tier: 1500 req/day on `gemini-embedding-001`. Paid kicks in
 * automatically when a billing account is attached upstream — phantombot
 * doesn't track or enforce that, just calls and reports any errors.
 */

const DEFAULT_MODEL = "gemini-embedding-001";
const DEFAULT_DIMS = 1536;

export type EmbedResult =
  | { ok: true; values: Float32Array; dims: number }
  | { ok: false; error: string };

export interface GeminiEmbedOptions {
  model?: string;
  dims?: number;
  fetchImpl?: typeof fetch;
  /** Optional AbortSignal to cancel the request mid-flight. */
  signal?: AbortSignal;
}

export async function geminiEmbed(
  apiKey: string,
  text: string,
  opts: GeminiEmbedOptions = {},
): Promise<EmbedResult> {
  const model = opts.model ?? DEFAULT_MODEL;
  const dims = opts.dims ?? DEFAULT_DIMS;
  const fetchImpl = opts.fetchImpl ?? fetch;
  const url =
    `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:embedContent` +
    `?key=${encodeURIComponent(apiKey)}`;

  let res: Response;
  try {
    res = await fetchImpl(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: `models/${model}`,
        content: { parts: [{ text }] },
        outputDimensionality: dims,
      }),
      signal: opts.signal,
    });
  } catch (e) {
    return { ok: false, error: `network: ${(e as Error).message}` };
  }

  let body: {
    embedding?: { values?: unknown };
    error?: { message?: string };
  };
  try {
    body = (await res.json()) as typeof body;
  } catch {
    return { ok: false, error: `non-JSON response (HTTP ${res.status})` };
  }
  if (!res.ok) {
    return {
      ok: false,
      error:
        body.error?.message ?? `HTTP ${res.status}`,
    };
  }
  const values = body.embedding?.values;
  if (!Array.isArray(values) || values.length === 0) {
    return { ok: false, error: "no embedding values in response" };
  }
  const out = new Float32Array(values.length);
  for (let i = 0; i < values.length; i++) {
    const n = Number(values[i]);
    if (!Number.isFinite(n)) {
      return { ok: false, error: "non-numeric value in embedding" };
    }
    out[i] = n;
  }
  return { ok: true, values: out, dims: out.length };
}
