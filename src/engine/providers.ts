/**
 * `engine.providers`: the model providers an application can offer its user,
 * a key check for one of them, and that account's model list.
 *
 * These are the same building blocks the `phantombot harness` wizard uses
 * (`PI_PROVIDER_CATALOG`, `probeProviderKey`, `fetchProviderModels`), exposed
 * so an embedding app can drive the same flow in its own UI: pick a provider,
 * type a key, see whether it was accepted, pick a model, then persist the
 * choice with `persona.configure({ brain: { native: { provider, model, apiKey } } })`.
 *
 * Nothing here stores anything. A key passed to `check` is used for the
 * provider's own models endpoint and then dropped; it reaches the vault only
 * through `configure`.
 */

import { EngineError } from "./errors.ts";
import { PI_PROVIDER_CATALOG } from "../lib/piModels.ts";
import {
  customProviderAllowsKeyless,
  customProviderSpec,
} from "../lib/piCustomProvider.ts";
import { probeProviderKey, type KeyProbeResult } from "../lib/providerKeyProbe.ts";
import { fetchProviderModels } from "../lib/providerModelCatalog.ts";
import type { PiModel } from "../lib/piModels.ts";
import type {
  ProviderCheck,
  ProviderCheckOptions,
  ProviderInfo,
  ProviderModel,
} from "./types.ts";

/** @internal Test seams; not exported from `index.ts`. */
export interface ProviderBackends {
  probe: (id: string, key: string, opts: { baseUrl?: string }) => Promise<KeyProbeResult>;
  models: (id: string, key: string, opts: { baseUrl?: string }) => Promise<PiModel[]>;
}

const realBackends: ProviderBackends = {
  probe: (id, key, opts) => probeProviderKey(id, key, opts),
  models: (id, key, opts) => fetchProviderModels(id, key, fetch, opts),
};

let backendsForTesting: ProviderBackends | undefined;

/** @internal Tests only. Pass undefined to restore the real network calls. */
export function _setProviderBackendsForTesting(b: ProviderBackends | undefined): void {
  backendsForTesting = b;
}

/** Every provider the native engine can run, in menu order. */
export function listProviders(): ProviderInfo[] {
  return PI_PROVIDER_CATALOG.map((p) => {
    const custom = customProviderSpec(p.id);
    return {
      id: p.id,
      label: p.label,
      needsBaseUrl: custom?.needsBaseUrl ?? false,
      keyOptional: customProviderAllowsKeyless(p.id),
      ...(custom?.defaultModel ? { defaultModel: custom.defaultModel } : {}),
    };
  });
}

const MAX_KEY_CHARS = 4096;
const MAX_BASE_URL_CHARS = 2048;

/**
 * Check `apiKey` against `providerId` and list the models that account can use.
 *
 * `status` is `"verified"` (the provider accepted the key), `"invalid"` (it
 * explicitly rejected it: 401/403, the only verdict an app should block on) or
 * `"unverified"` (it could not be checked: no known endpoint, network error,
 * outage). `models` is the provider's live list, or [] when it could not be
 * read; an empty list is not by itself a reason to reject the key.
 */
export async function checkProvider(
  providerId: string,
  apiKey: string,
  options: ProviderCheckOptions = {},
): Promise<ProviderCheck> {
  if (typeof providerId !== "string" || !PI_PROVIDER_CATALOG.some((p) => p.id === providerId)) {
    throw new EngineError("invalid_argument", "unknown provider", { provider: String(providerId) });
  }
  if (typeof apiKey !== "string" || apiKey.length > MAX_KEY_CHARS) {
    throw new EngineError("invalid_argument", "apiKey must be a string");
  }
  const baseUrl = options.baseUrl;
  if (baseUrl !== undefined && (typeof baseUrl !== "string" || baseUrl.length > MAX_BASE_URL_CHARS)) {
    throw new EngineError("invalid_argument", "baseUrl must be a string");
  }
  const spec = customProviderSpec(providerId);
  if (spec?.needsBaseUrl && !baseUrl?.trim()) {
    throw new EngineError("invalid_argument", `provider '${providerId}' needs a baseUrl`, {
      provider: providerId,
    });
  }
  const b = backendsForTesting ?? realBackends;
  const opts = baseUrl?.trim() ? { baseUrl: baseUrl.trim() } : {};
  const [probe, rows] = await Promise.all([
    b.probe(providerId, apiKey, opts),
    b.models(providerId, apiKey, opts).catch(() => [] as PiModel[]),
  ]);
  // A rejected key lists nothing, even when the catalogue is public
  // (OpenRouter): showing models for a key the provider refused invites the
  // user to save it.
  const models: ProviderModel[] =
    probe.status === "invalid"
      ? []
      : rows.map((m) => ({ id: m.model, supportsImages: m.supportsImages }));
  return { status: probe.status, detail: probe.detail, models };
}
