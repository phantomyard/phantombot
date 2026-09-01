/**
 * `phantombot embedding` — interactive TUI to configure semantic search.
 *
 * Picks a provider, validates one embedding request, and writes the result to
 * [embeddings] in config.toml.
 *
 * No-key (provider=none) is a real choice: phantombot's memory search
 * still works on OKF field-weighted BM25 with link-graph expansion — the
 * Open Knowledge Format superpowers (frontmatter field weighting, tag/alias
 * controlled vocabulary, concept-graph walk). No semantic similarity, but a
 * markedly stronger lexical recall than plain keyword search.
 */

import { defineCommand } from "citty";
import * as p from "@clack/prompts";

import {
  DEFAULT_OPENAI_COMPATIBLE_MAX_CHUNK_CHARS,
  type Config,
  loadConfigForPersona,
  resolvePersona,
} from "../config.ts";
import {
  geminiEmbed,
  type EmbedResult,
} from "../lib/geminiEmbed.ts";
import { openaiCompatibleEmbed } from "../lib/openaiCompatibleEmbed.ts";
import { getIn, setIn, updateConfigToml } from "../lib/configWriter.ts";
import { personaConfigPath } from "../lib/personaConfig.ts";
import { defaultServiceControl, type ServiceControl } from "../lib/platform.ts";
import {
  setPersonaSecret,
  unsetPersonaSecret,
  type SetPersonaSecretResult,
} from "../lib/vaultSecrets.ts";
import { maybePromptRestart } from "./harness.ts";

const DEFAULT_MODEL = "gemini-embedding-001";
const DEFAULT_DIMS = 1536;

export interface OpenAICompatibleConfigUpdate {
  baseUrl: string;
  model: string;
  apiKey?: string;
  dims?: number;
  queryPrefix?: string;
  documentPrefix?: string;
  maxChunkChars?: number;
}

export interface EmbeddingConfigUpdate {
  provider: "gemini" | "openai-compatible" | "none";
  apiKey?: string;
  model?: string;
  dims?: number;
  openaiCompatible?: OpenAICompatibleConfigUpdate;
}

export interface ApplyEmbeddingConfigInput {
  config: Config;
  persona: string;
  update: EmbeddingConfigUpdate;
  /** Test seam for forcing vault failures without touching a real vault. */
  writeSecret?: (
    config: Config,
    name: string,
    value: string,
    persona?: string,
  ) => Promise<SetPersonaSecretResult>;
  /** Test seam for clearing an optional OpenAI-compatible key. */
  clearSecret?: typeof unsetPersonaSecret;
}

function deleteIn(root: Record<string, unknown>, path: readonly string[]): void {
  let current: Record<string, unknown> = root;
  for (const key of path.slice(0, -1)) {
    const next = current[key];
    if (!next || typeof next !== "object" || Array.isArray(next)) return;
    current = next as Record<string, unknown>;
  }
  delete current[path[path.length - 1]!];
}

export async function applyEmbeddingConfig(
  input: ApplyEmbeddingConfigInput,
): Promise<void> {
  const { config, persona, update } = input;
  const configPath = personaConfigPath(config.personasDir, persona);
  const writeSecret = input.writeSecret ?? setPersonaSecret;
  const clearSecret = input.clearSecret ?? unsetPersonaSecret;
  let secretResult: SetPersonaSecretResult | undefined;
  let secretName: string | undefined;

  if (update.provider === "gemini") {
    secretName = "PHANTOMBOT_GEMINI_API_KEY";
    secretResult = await writeSecret(
      config,
      secretName,
      update.apiKey ?? "",
      persona,
    );
  } else if (update.provider === "openai-compatible") {
    secretName = "PHANTOMBOT_OPENAI_COMPATIBLE_API_KEY";
    const key = update.openaiCompatible?.apiKey ?? "";
    secretResult = key
      ? await writeSecret(config, secretName, key, persona)
      : await clearSecret(config, secretName, persona);
  }

  await updateConfigToml(configPath, (toml) => {
    setIn(toml, ["embeddings", "provider"], update.provider);
    if (update.provider === "gemini") {
      if (secretResult?.ok) deleteIn(toml, ["embeddings", "gemini", "api_key"]);
      else setIn(toml, ["embeddings", "gemini", "api_key"], update.apiKey ?? "");
      setIn(
        toml,
        ["embeddings", "gemini", "model"],
        update.model ?? DEFAULT_MODEL,
      );
      setIn(
        toml,
        ["embeddings", "gemini", "dims"],
        update.dims ?? DEFAULT_DIMS,
      );
    } else if (update.provider === "openai-compatible") {
      const o = update.openaiCompatible;
      if (!o) throw new Error("OpenAI-compatible embedding settings are missing");
      setIn(toml, ["embeddings", "openai_compatible", "base_url"], o.baseUrl);
      setIn(toml, ["embeddings", "openai_compatible", "model"], o.model);
      if (secretResult?.ok) {
        deleteIn(toml, ["embeddings", "openai_compatible", "api_key"]);
      } else {
        setIn(toml, ["embeddings", "openai_compatible", "api_key"], o.apiKey ?? "");
      }
      setIn(toml, ["embeddings", "openai_compatible", "dims"], o.dims ?? 0);
      setIn(
        toml,
        ["embeddings", "openai_compatible", "query_prefix"],
        o.queryPrefix ?? "",
      );
      setIn(
        toml,
        ["embeddings", "openai_compatible", "document_prefix"],
        o.documentPrefix ?? "",
      );
      setIn(
        toml,
        ["embeddings", "openai_compatible", "max_chunk_chars"],
        o.maxChunkChars ??
          getIn(toml, ["embeddings", "openai_compatible", "max_chunk_chars"]) ??
          DEFAULT_OPENAI_COMPATIBLE_MAX_CHUNK_CHARS,
      );
    } else {
      // Leave the [embeddings.gemini] block alone if present — preserves
      // the user's key for re-enabling later. Just flip provider to "none".
    }
  });

  if (secretResult && !secretResult.ok) {
    throw new Error(
      `embedding: could not store ${secretName} in the ${secretResult.persona ?? persona} vault; ` +
        `kept the key in config.toml: ${secretResult.error ?? "unknown error"}`,
    );
  }
}

interface RunInput {
  persona?: string;
  config?: Config;
  validate?: (key: string) => Promise<EmbedResult>;
  validateOpenAI?: (
    settings: OpenAICompatibleConfigUpdate,
  ) => Promise<EmbedResult>;
  serviceControl?: ServiceControl;
  /**
   * When true, this runs as a sub-step of another wizard (e.g.
   * `phantombot init`) rather than standalone. Two effects:
   *   - suppresses the standalone intro/outro and the "Existing config"
   *     note (the parent owns the framing; a nested clack intro renders a
   *     stray bracket), and
   *   - skips the post-save restart prompt (the parent installs/starts the
   *     service afterwards, so there is nothing running to restart yet).
   */
  embedded?: boolean;
}

export async function runEmbedding(input: RunInput = {}): Promise<number> {
  const { config, persona } = input.config
    ? { config: input.config, persona: resolvePersona(input.persona, input.config) }
    : await loadConfigForPersona(input.persona);
  const embeddingConfigPath = personaConfigPath(config.personasDir, persona);
  const svc = input.serviceControl ?? defaultServiceControl();
  const embedded = input.embedded ?? false;
  const validate =
    input.validate ??
    ((key: string) =>
      geminiEmbed(key, "phantombot key validation test", {
        model: DEFAULT_MODEL,
        dims: DEFAULT_DIMS,
      }));

  if (!embedded) p.intro("Configure embeddings");

  const existing = config.embeddings;
  if (!embedded && existing.provider === "gemini" && existing.gemini?.apiKey) {
    p.note(
      `provider:  gemini\n` +
        `model:     ${existing.gemini.model}\n` +
        `dims:      ${existing.gemini.dims}\n` +
        `api key:   ${maskKey(existing.gemini.apiKey)}`,
      "Existing config",
    );
  } else if (!embedded && existing.provider === "none") {
    p.note(
      `provider:  none (OKF field-weighted BM25 + link-graph expansion)`,
      "Existing config",
    );
  } else if (!embedded && existing.provider === "openai-compatible" && existing.openaiCompatible) {
    const o = existing.openaiCompatible;
    p.note(
      `provider:  openai-compatible\n` +
        `base URL:  ${o.baseUrl}\n` +
        `model:     ${o.model}\n` +
        `dims:      ${o.dims || "detected on validation"}\n` +
        `max chars: ${o.maxChunkChars ?? DEFAULT_OPENAI_COMPATIBLE_MAX_CHUNK_CHARS}\n` +
        `api key:   ${o.apiKey ? maskKey(o.apiKey) : "none"}`,
      "Existing config",
    );
  }

  // Embeddings improve long-term memory retrieval. Threat screening is a
  // separate path and remains active regardless of the embedding provider.
  p.note(
    `Embeddings add semantic retrieval to long-term memory.\n` +
      `Without an embedding provider, OKF field-weighted BM25 + graph\n` +
      `expansion remains available. Threat screening remains active\n` +
      `independently of the embedding provider.`,
    "Why configure this",
  );

  const provider = await p.select<"gemini" | "openai-compatible" | "none" | "cancel">({
    message: "Provider",
    options: [
      {
        value: "gemini",
        label: `Gemini (${DEFAULT_MODEL}, ${DEFAULT_DIMS} dims)`,
        hint: "semantic search · free tier 1500 req/day",
      },
      {
        value: "openai-compatible",
        label: "OpenAI-compatible (local or remote /embeddings)",
        hint: "llama-server and other standard-compatible endpoints",
      },
      {
        value: "none",
        label: "None — OKF field-weighted BM25 + link-graph expansion",
        hint: "no API key · Open Knowledge Format superpowers, lexical only",
      },
      { value: "cancel", label: "Cancel" },
    ],
    initialValue:
      existing.provider === "gemini" || existing.provider === "openai-compatible"
        ? existing.provider
        : "none",
  });
  if (p.isCancel(provider) || provider === "cancel") {
    p.cancel("cancelled");
    return 0;
  }

  if (provider === "none") {
    await applyEmbeddingConfig({ config, persona, update: { provider: "none" } });
    p.note(
      `provider set to "none"\n` +
        `search uses OKF field-weighted BM25 + link-graph expansion\n` +
        `(frontmatter weighting, tag/alias vocabulary, concept-graph walk)\n` +
        `threat screening stays ACTIVE (runs on your primary harness); judge ` +
        `briefing recall is lexical-only`,
      "Saved",
    );
    if (!embedded) {
      await maybePromptRestart(svc);
      p.outro("done");
    }
    return 0;
  }

  if (provider === "gemini") {
    const key = await p.password({
      message: "Gemini API key (https://aistudio.google.com/app/apikey)",
      validate: (v) => (!v ? "key is required" : undefined),
    });
    if (p.isCancel(key)) {
      p.cancel("cancelled");
      return 0;
    }

    const spinner = p.spinner();
    spinner.start("validating with a one-token embed…");
    const r = await validate(key as string);
    if (!r.ok) {
      spinner.stop(`key rejected: ${r.error}`);
      p.cancel("aborting — key did not validate");
      return 1;
    }
    spinner.stop(`key validated (got ${r.dims} dims)`);

    await applyEmbeddingConfig({
      config,
      persona,
      update: {
        provider: "gemini",
        apiKey: key as string,
        model: DEFAULT_MODEL,
        dims: r.dims,
      },
    });
    p.note(
      `provider:  gemini\n` +
        `model:     ${DEFAULT_MODEL}\n` +
        `dims:      ${r.dims}\n` +
        `settings saved to ${embeddingConfigPath}\n` +
        `API key saved to ${persona}'s encrypted vault\n\n` +
        `cost note: free up to 1500 req/day on the Gemini free tier;\n` +
        `phantombot's nightly cycle re-embeds changed notes only.\n` +
        `After changing provider, model, or document prefix, backfill with:\n` +
        `  phantombot memory index --reembed\n` +
        `Changing query prefix alone does not require rebuilding stored vectors.`,
      "Saved",
    );
  } else {
    const existingOpenAI = existing.openaiCompatible;
    const baseUrl = await p.text({
      message: "OpenAI-compatible base URL (the /v1 part, without /embeddings)",
      initialValue: existingOpenAI?.baseUrl ?? "http://127.0.0.1:8082/v1",
      validate: (v) => (!v?.trim() ? "base URL is required" : undefined),
    });
    if (p.isCancel(baseUrl)) {
      p.cancel("cancelled");
      return 0;
    }
    const model = await p.text({
      message: "Embedding model",
      initialValue: existingOpenAI?.model ?? "",
      validate: (v) => (!v?.trim() ? "model is required" : undefined),
    });
    if (p.isCancel(model)) {
      p.cancel("cancelled");
      return 0;
    }
    const apiKey = await p.password({
      message: "API key (optional; leave empty for local llama-server)",
    });
    if (p.isCancel(apiKey)) {
      p.cancel("cancelled");
      return 0;
    }
    const queryPrefix = await p.text({
      message: "Query prefix (optional)",
      initialValue: existingOpenAI?.queryPrefix ?? "",
    });
    if (p.isCancel(queryPrefix)) {
      p.cancel("cancelled");
      return 0;
    }
    const documentPrefix = await p.text({
      message: "Document prefix (optional)",
      initialValue: existingOpenAI?.documentPrefix ?? "",
    });
    if (p.isCancel(documentPrefix)) {
      p.cancel("cancelled");
      return 0;
    }

    const settings: OpenAICompatibleConfigUpdate = {
      baseUrl: String(baseUrl).trim(),
      model: String(model).trim(),
      apiKey: optionalPromptText(apiKey),
      queryPrefix: optionalPromptText(queryPrefix),
      documentPrefix: optionalPromptText(documentPrefix),
      maxChunkChars:
        existingOpenAI?.maxChunkChars ??
        DEFAULT_OPENAI_COMPATIBLE_MAX_CHUNK_CHARS,
    };
    const spinner = p.spinner();
    spinner.start("validating with a one-token embed…");
    const r = await (input.validateOpenAI
      ? input.validateOpenAI(settings)
      : openaiCompatibleEmbed("phantombot embedding validation test", settings));
    if (!r.ok) {
      spinner.stop(`endpoint rejected: ${r.error}`);
      p.cancel("aborting — endpoint did not validate");
      return 1;
    }
    spinner.stop(`endpoint validated (got ${r.dims} dims)`);
    await applyEmbeddingConfig({
      config,
      persona,
      update: {
        provider: "openai-compatible",
        openaiCompatible: { ...settings, dims: r.dims },
      },
    });
    p.note(
      `provider:  openai-compatible\n` +
        `base URL:  ${settings.baseUrl}\n` +
        `model:     ${settings.model}\n` +
        `dims:      ${r.dims}\n` +
        `settings saved to ${embeddingConfigPath}\n` +
        `${settings.apiKey ? `API key saved to ${persona}'s encrypted vault` : "no API key configured"}\n\n` +
        `After changing provider, model, or document prefix, backfill with:\n` +
        `  phantombot memory index --reembed\n` +
        `Changing query prefix alone does not require rebuilding stored vectors.`,
      "Saved",
    );
  }

  if (!embedded) {
    await maybePromptRestart(svc);
    p.outro("done");
  }
  return 0;
}

/** Empty optional prompts must stay empty, never become the string "undefined". */
export function optionalPromptText(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function maskKey(k: string): string {
  if (k.length <= 12) return "***";
  return k.slice(0, 6) + "…" + k.slice(-4);
}

export default defineCommand({
  meta: {
    name: "embedding",
    description:
      "Configure semantic-memory embeddings (Gemini, OpenAI-compatible, or none).",
  },
  async run() {
    const code = await runEmbedding();
    process.exitCode = code;
  },
});
