import type { Config } from "../config.ts";
import {
  normalizeOpenAICompatibleBaseUrl,
  openAICompatibleCredentialCandidates,
} from "./voice.ts";
import { getPersonaSecretStrict } from "./vaultSecrets.ts";

export interface StoredOpenAICompatibleCredential {
  name: string;
  value: string;
  /** Found only in legacy/current config and must be copied into the vault. */
  needsWrite: boolean;
}

/**
 * Find a credential whose configured endpoint matches `baseUrl`.
 * Reads only the requested persona's vault/config and never logs the value.
 */
export async function findOpenAICompatibleCredential(
  config: Config,
  persona: string,
  baseUrl: string,
): Promise<StoredOpenAICompatibleCredential | undefined> {
  const normalized = normalizeOpenAICompatibleBaseUrl(baseUrl);
  const names = [...openAICompatibleCredentialCandidates(normalized)];
  const voice = config.voice?.openaiCompatible;
  if (voice && normalizeOpenAICompatibleBaseUrl(voice.baseUrl) === normalized) {
    names.unshift(voice.keyEnv);
  }
  const embedding = config.embeddings?.openaiCompatible;
  if (
    config.embeddings?.provider === "openai-compatible" &&
    embedding &&
    normalizeOpenAICompatibleBaseUrl(embedding.baseUrl) === normalized
  ) {
    names.unshift("PHANTOMBOT_OPENAI_COMPATIBLE_API_KEY");
  }
  for (const name of new Set(names)) {
    const value = await getPersonaSecretStrict(config, name, persona);
    if (value) return { name, value, needsWrite: false };
  }
  if (
    config.embeddings?.provider === "openai-compatible" &&
    embedding?.apiKey &&
    normalizeOpenAICompatibleBaseUrl(embedding.baseUrl) === normalized
  ) {
    return {
      name: "PHANTOMBOT_OPENAI_COMPATIBLE_API_KEY",
      value: embedding.apiKey,
      needsWrite: true,
    };
  }
  return undefined;
}
