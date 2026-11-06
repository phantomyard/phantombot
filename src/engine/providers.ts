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
  normalizeBaseUrl,
  usesAutoRouting,
} from "../lib/piCustomProvider.ts";
import {
  probeProviderKey,
  providerKeyCheckable,
  type KeyProbeResult,
} from "../lib/providerKeyProbe.ts";
import { fetchProviderModels } from "../lib/providerModelCatalog.ts";
import { bundledProviderModels } from "../lib/piBundledModels.ts";
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
  /** Pi's bundled list, used when `models` comes back empty. */
  bundled?: (id: string) => Promise<PiModel[]>;
}

const realBackends: ProviderBackends = {
  probe: (id, key, opts) => probeProviderKey(id, key, opts),
  models: (id, key, opts) => fetchProviderModels(id, key, fetch, opts),
  bundled: (id) => bundledProviderModels(id),
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
      checkable: providerKeyCheckable(p.id),
      autoModel: usesAutoRouting(p.id),
      ...(custom?.defaultModel ? { defaultModel: custom.defaultModel } : {}),
      ...(custom?.keyLabel ? { keyLabel: custom.keyLabel } : {}),
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
  let normalized: string | undefined;
  if (baseUrl !== undefined && baseUrl.trim() !== "") {
    // Only bring-your-own-endpoint providers honour a base URL; anywhere else
    // the probe would silently send the key to the provider's own host while
    // the caller believes it chose the endpoint.
    if (!spec) {
      throw new EngineError("invalid_argument", `provider '${providerId}' does not take a baseUrl`, {
        provider: providerId,
      });
    }
    // Same predicate as the wizard (#694): a malformed URL is reported as
    // malformed, not as missing.
    const norm = normalizeBaseUrl(baseUrl);
    if (!norm.ok) {
      throw new EngineError("invalid_argument", norm.error, { provider: providerId });
    }
    normalized = norm.value;
  }
  if (spec?.needsBaseUrl && normalized === undefined) {
    throw new EngineError("invalid_argument", `provider '${providerId}' needs a baseUrl`, {
      provider: providerId,
    });
  }
  const b = backendsForTesting ?? realBackends;
  const opts = normalized !== undefined ? { baseUrl: normalized } : {};
  const [probe, rows] = await Promise.all([
    b.probe(providerId, apiKey, opts),
    b.models(providerId, apiKey, opts).catch(() => [] as PiModel[]),
  ]);
  // No models for a key the provider refused, nor for a key the caller never
  // supplied where one is required, even when the catalogue is public
  // (OpenRouter): a list there reads as proof the key is fine.
  const noKey = apiKey.trim() === "" && !customProviderAllowsKeyless(providerId);
  const refused = probe.status === "invalid" || noKey;
  // No live list (no list endpoint, an unverifiable key, an outage): offer the
  // models Pi itself ships for the provider so the picker is never empty. Not
  // for bring-your-own endpoints, whose models are whatever that server runs.
  const listed =
    !refused && rows.length === 0 && !spec && b.bundled
      ? await b.bundled(providerId).catch(() => [] as PiModel[])
      : rows;
  const models: ProviderModel[] = refused
    ? []
    : listed.map((m) => ({ id: m.model, supportsImages: m.supportsImages }));
  return { status: probe.status, detail: probe.detail, models };
}
