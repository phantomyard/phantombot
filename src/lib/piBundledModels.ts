/**
 * Pi's BUNDLED model list for one provider: the fallback when the provider's
 * own `/models` cannot be read (no list endpoint, an unverifiable key, an
 * outage). Without it the PhantomChat model picker stays empty and the
 * contact cannot be saved, even though Pi itself knows which models run there.
 *
 * Loaded lazily: the catalogue is large and only `providers.check` needs it.
 * Any failure returns [], which leaves the picker's free-text fallback.
 */

import type { PiModel } from "./piModels.ts";

/** Catalog ids whose Pi provider id differs. */
const PI_PROVIDER_ID: Record<string, string> = {
  "azure-openai-responses": "azure",
};

export async function bundledProviderModels(providerId: string): Promise<PiModel[]> {
  const piId = PI_PROVIDER_ID[providerId] ?? providerId;
  try {
    const pi = await import("@earendil-works/pi-ai/providers/all");
    if (!(pi.getBuiltinProviders() as string[]).includes(piId)) return [];
    const rows = pi.getBuiltinModels(piId as never) as { id?: unknown; input?: unknown }[];
    const out: PiModel[] = [];
    const seen = new Set<string>();
    for (const m of rows) {
      if (typeof m.id !== "string" || !m.id || seen.has(m.id)) continue;
      seen.add(m.id);
      const input = Array.isArray(m.input) ? m.input : [];
      out.push({ provider: providerId, model: m.id, supportsImages: input.includes("image") });
    }
    return out;
  } catch {
    return [];
  }
}
