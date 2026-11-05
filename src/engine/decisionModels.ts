/**
 * `engine.decisionModels`: a key check and the model list for the decision
 * model slot, for an embedding app's own setup UI.
 *
 * The same building block the `phantombot decision-model` wizard uses
 * (`fetchDecisionModels`), so an app and the TUI offer one list. Pick a
 * provider, type a key, see whether it was accepted, pick a model, then
 * persist the choice with
 * `persona.configure({ decisionModel: { provider, model, apiKey } })`.
 *
 * Only the built-in transports (`openrouter`, `typesafe`) are checkable here:
 * a custom decisions provider has a caller-supplied endpoint, and this
 * method does not take one (no caller-directed egress).
 *
 * Nothing here stores anything. The key is used for the provider's own
 * endpoints and then dropped; it reaches the vault only through `configure`.
 */

import { EngineError } from "./errors.ts";
import {
  DECISION_MODEL_TYPESAFE_BASE_URL,
  fetchDecisionModels,
} from "../lib/decisionModel.ts";
import { probeKeyEndpoint, probeProviderKey, type KeyProbeResult } from "../lib/providerKeyProbe.ts";
import type { DecisionModelCheck, DecisionModelProvider } from "./types.ts";

/** @internal Test seams; not exported from `index.ts`. */
export interface DecisionModelBackends {
  probe: (provider: DecisionModelProvider, key: string) => Promise<KeyProbeResult>;
  models: (provider: DecisionModelProvider, key: string) => Promise<string[]>;
}

/**
 * TypeSafe has no key-info endpoint; `/v1/models` authenticates (401 for a
 * bad token, 403 for none), so its status is the verdict.
 */
function probeTypesafe(key: string): Promise<KeyProbeResult> {
  return probeKeyEndpoint(`${DECISION_MODEL_TYPESAFE_BASE_URL}/models`, {
    Authorization: `Bearer ${key}`,
  });
}

const realBackends: DecisionModelBackends = {
  probe: (provider, key) =>
    provider === "openrouter" ? probeProviderKey("openrouter", key) : probeTypesafe(key),
  models: (provider, key) => fetchDecisionModels(provider, key),
};

let backendsForTesting: DecisionModelBackends | undefined;

/** @internal Tests only. Pass undefined to restore the real network calls. */
export function _setDecisionModelBackendsForTesting(b: DecisionModelBackends | undefined): void {
  backendsForTesting = b;
}

const PROVIDERS: readonly DecisionModelProvider[] = ["openrouter", "typesafe"];
const MAX_KEY_CHARS = 4096;

/**
 * Check `apiKey` against a built-in decision-model provider and list its
 * decision models.
 *
 * `status` has the same meaning as `providers.check`: `"invalid"` only when
 * the provider explicitly rejected the key (401/403), the one verdict to
 * block on. `models` is `[]` for a rejected or missing key, so a list never
 * reads as proof the key works; otherwise it starts with the default model.
 */
export async function checkDecisionModel(
  provider: string,
  apiKey: string,
): Promise<DecisionModelCheck> {
  if (typeof provider !== "string" || !PROVIDERS.includes(provider as DecisionModelProvider)) {
    throw new EngineError(
      "invalid_argument",
      "decision-model provider must be 'openrouter' or 'typesafe'",
      { provider: String(provider) },
    );
  }
  if (typeof apiKey !== "string" || apiKey.length > MAX_KEY_CHARS) {
    throw new EngineError("invalid_argument", "apiKey must be a string");
  }
  const id = provider as DecisionModelProvider;
  const key = apiKey.trim();
  if (key === "") return { status: "unverified", detail: "no key to check", models: [] };
  const b = backendsForTesting ?? realBackends;
  const [probe, models] = await Promise.all([
    b.probe(id, key),
    b.models(id, key).catch(() => [] as string[]),
  ]);
  return {
    status: probe.status,
    detail: probe.detail,
    models: probe.status === "invalid" ? [] : models,
  };
}
