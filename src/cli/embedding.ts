/**
 * `phantombot embedding` — interactive TUI to configure semantic search.
 *
 * Picks a provider (Gemini or None), validates the API key by calling
 * /embedContent once, writes the result to [embeddings] in config.toml.
 *
 * No-key (provider=none) is a real choice: phantombot's memory search
 * still works, just on FTS5/BM25 only — no semantic similarity.
 */

import { defineCommand } from "citty";
import * as p from "@clack/prompts";

import { type Config, loadConfig } from "../config.ts";
import {
  geminiEmbed,
  type EmbedResult,
} from "../lib/geminiEmbed.ts";
import { setIn, updateConfigToml } from "../lib/configWriter.ts";
import { defaultServiceControl, type ServiceControl } from "../lib/systemd.ts";
import { maybePromptRestart } from "./harness.ts";

const DEFAULT_MODEL = "gemini-embedding-001";
const DEFAULT_DIMS = 1536;

export interface EmbeddingConfigUpdate {
  provider: "gemini" | "none";
  apiKey?: string;
  model?: string;
  dims?: number;
}

export async function applyEmbeddingConfig(
  configPath: string,
  update: EmbeddingConfigUpdate,
): Promise<void> {
  await updateConfigToml(configPath, (toml) => {
    setIn(toml, ["embeddings", "provider"], update.provider);
    if (update.provider === "gemini") {
      setIn(toml, ["embeddings", "gemini", "api_key"], update.apiKey ?? "");
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
    } else {
      // Leave the [embeddings.gemini] block alone if present — preserves
      // the user's key for re-enabling later. Just flip provider to "none".
    }
  });
}

interface RunInput {
  config?: Config;
  validate?: (key: string) => Promise<EmbedResult>;
  serviceControl?: ServiceControl;
}

export async function runEmbedding(input: RunInput = {}): Promise<number> {
  const config = input.config ?? (await loadConfig());
  const svc = input.serviceControl ?? defaultServiceControl();
  const validate =
    input.validate ??
    ((key: string) =>
      geminiEmbed(key, "phantombot key validation test", {
        model: DEFAULT_MODEL,
        dims: DEFAULT_DIMS,
      }));

  p.intro("Configure embeddings");

  const existing = config.embeddings;
  if (existing.provider === "gemini" && existing.gemini?.apiKey) {
    p.note(
      `provider:  gemini\n` +
        `model:     ${existing.gemini.model}\n` +
        `dims:      ${existing.gemini.dims}\n` +
        `api key:   ${maskKey(existing.gemini.apiKey)}`,
      "Existing config",
    );
  } else if (existing.provider === "none") {
    p.note(`provider:  none (FTS5/BM25 search only)`, "Existing config");
  }

  const provider = await p.select<"gemini" | "none" | "cancel">({
    message: "Provider",
    options: [
      {
        value: "gemini",
        label: `Gemini (${DEFAULT_MODEL}, ${DEFAULT_DIMS} dims)`,
        hint: "free tier 1500 req/day, billing kicks in upstream",
      },
      {
        value: "none",
        label: "None — keyword/BM25 search only",
      },
      { value: "cancel", label: "Cancel" },
    ],
    initialValue: existing.provider === "gemini" ? "gemini" : "none",
  });
  if (p.isCancel(provider) || provider === "cancel") {
    p.cancel("cancelled");
    return 0;
  }

  if (provider === "none") {
    await applyEmbeddingConfig(config.configPath, { provider: "none" });
    p.note(
      `provider set to "none"\nsearch will use FTS5/BM25 only`,
      "Saved",
    );
    await maybePromptRestart(svc);
    p.outro("done");
    return 0;
  }

  const key = await p.password({
    message: "Gemini API key (https://aistudio.google.com/app/apikey)",
    validate: (v) => {
      if (!v || v.length === 0) return "key is required";
      return undefined;
    },
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

  await applyEmbeddingConfig(config.configPath, {
    provider: "gemini",
    apiKey: key as string,
    model: DEFAULT_MODEL,
    dims: DEFAULT_DIMS,
  });
  p.note(
    `provider:  gemini\n` +
      `model:     ${DEFAULT_MODEL}\n` +
      `dims:      ${DEFAULT_DIMS}\n` +
      `saved to ${config.configPath}\n\n` +
      `cost note: free up to 1500 req/day on the Gemini free tier;\n` +
      `phantombot's nightly cycle re-embeds changed notes only.`,
    "Saved",
  );

  await maybePromptRestart(svc);
  p.outro("done");
  return 0;
}

function maskKey(k: string): string {
  if (k.length <= 12) return "***";
  return k.slice(0, 6) + "…" + k.slice(-4);
}

export default defineCommand({
  meta: {
    name: "embedding",
    description:
      "Configure the embeddings provider (Gemini or none). Validates the API key before saving.",
  },
  async run() {
    const code = await runEmbedding();
    process.exitCode = code;
  },
});
