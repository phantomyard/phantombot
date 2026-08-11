/**
 * Live health probes for the `/status` command.
 *
 * `/status` is a troubleshooting tool, so every probe here runs FRESH on each
 * invocation — no cached results. Each probe hits the real subsystem (Telegram
 * getMe, the embedding provider, the voice provider's key-validation endpoint,
 * the local editor-connector registrations) and returns a short one-line
 * summary of "what is it, and is it working right now".
 *
 * Every probe is best-effort and self-contained: a thrown error or a missing
 * config surface yields `undefined` (the line is simply omitted) rather than
 * breaking `/status`. Real network egress happens on each call — that is the
 * deliberate tradeoff for fresh diagnostics (see the PR discussion). The LLM
 * health line is intentionally NOT here; it needs its own design (timeout, cost
 * guard, 429-vs-down semantics) and lands in a follow-up.
 *
 * The concrete probe functions are injected via `StatusProbeDeps` so tests can
 * exercise the formatting and branch logic without real network calls;
 * production callers omit `deps` and get the real implementations.
 */

import type { Config } from "../config.ts";
import { truncateLine } from "../lib/format.ts";
import { telegramGetMe as realTelegramGetMe } from "../lib/telegramApi.ts";
import {
  validateElevenLabsKey as realValidateElevenLabsKey,
  validateOpenAIKey as realValidateOpenAIKey,
  ENV_KEY_FOR_PROVIDER,
} from "../lib/voice.ts";
import { geminiEmbed as realGeminiEmbed } from "../lib/geminiEmbed.ts";
import {
  reconcileEditorConnectors as realReconcileEditorConnectors,
  type EditorConnectorResult,
} from "../connectors/acp/autoInstall.ts";
import { isPhantombotBinary as realIsPhantombotBinary } from "../lib/binaryIdentity.ts";

/** Cap probe error detail so one bad line can't blow up the /status reply. */
const ERR_MAX = 60;

export interface StatusProbeLines {
  /** e.g. "@robbie_bot OK" or "ERR (401 Unauthorized)" */
  telegram?: string;
  /** e.g. "zed ✓, vscode ✓" or "no editors detected" */
  acp?: string;
  /** e.g. "gemini OK", "gemini ERR (429)", or "okf active (local)" */
  memory?: string;
  /** e.g. "elevenlabs onwK…03F9 OK" or "openai nova ERR (…)" */
  voice?: string;
}

/**
 * Injectable probe implementations. All optional — production omits this and
 * the real functions are used. Tests pass stubs to avoid network calls.
 */
export interface StatusProbeDeps {
  telegramGetMe?: typeof realTelegramGetMe;
  validateElevenLabsKey?: typeof realValidateElevenLabsKey;
  validateOpenAIKey?: typeof realValidateOpenAIKey;
  geminiEmbed?: typeof realGeminiEmbed;
  reconcileEditorConnectors?: typeof realReconcileEditorConnectors;
  isPhantombotBinary?: typeof realIsPhantombotBinary;
  env?: Record<string, string | undefined>;
}

function shortErr(e: string): string {
  return truncateLine(e, ERR_MAX);
}

/** Live Telegram token/handle probe via getMe on the persona's bound token. */
async function probeTelegram(
  config: Config | undefined,
  persona: string,
  getMe: typeof realTelegramGetMe,
): Promise<string | undefined> {
  const token =
    config?.channels.telegramPersonas?.[persona]?.token ??
    config?.channels.telegram?.token;
  if (!token) return undefined;
  const r = await getMe(token);
  return r.ok ? `@${r.username} OK` : `ERR (${shortErr(r.error)})`;
}

/** Editor-connector (ACP) registration state — read-only, no writes. */
function probeAcp(
  reconcile: typeof realReconcileEditorConnectors,
  isBinary: typeof realIsPhantombotBinary,
): string | undefined {
  // Only meaningful when running as the real phantombot binary: in a `bun run`
  // dev process, process.execPath is the runtime, not a registrable path.
  if (!isBinary()) return undefined;
  let results: EditorConnectorResult[];
  try {
    results = reconcile({ binaryPath: process.execPath, repair: false });
  } catch {
    return undefined;
  }
  const detected = results.filter((r) => r.action !== "not-detected");
  if (detected.length === 0) return "no editors detected";
  return detected
    .map((r) => `${r.editor} ${r.action === "current" ? "✓" : `⚠ ${r.action}`}`)
    .join(", ");
}

/** Which retrieval backend is live: Gemini embeddings (probed) or OKF/FTS. */
async function probeMemory(
  config: Config | undefined,
  embed: typeof realGeminiEmbed,
): Promise<string | undefined> {
  const provider = config?.embeddings.provider;
  if (!provider) return undefined;
  if (provider !== "gemini") {
    // "none" = Open Knowledge Format mode: local BM25/FTS keyword search +
    // link-graph expansion. No external service to probe — it's live as long
    // as the process is (the same index /status already reads for context %).
    return "okf active (local keyword + link-graph)";
  }
  const g = config?.embeddings.gemini;
  if (!g?.apiKey) return "gemini embeddings — no key";
  const r = await embed(g.apiKey, "phantombot status probe", {
    model: g.model,
    dims: g.dims,
  });
  return r.ok ? "gemini embeddings OK" : `gemini embeddings ERR (${shortErr(r.error)})`;
}

/** Voice provider + selected voice + live key validation. */
async function probeVoice(
  config: Config | undefined,
  deps: {
    validateElevenLabsKey: typeof realValidateElevenLabsKey;
    validateOpenAIKey: typeof realValidateOpenAIKey;
    env: Record<string, string | undefined>;
  },
): Promise<string | undefined> {
  const v = config?.voice;
  if (!v) return undefined;
  if (v.provider === "none") return "none";
  if (v.provider === "azure_edge") {
    // Azure Edge TTS needs no API key (unofficial free endpoint).
    return `azure_edge ${v.azure_edge?.voice ?? "?"} (no key)`;
  }

  const voiceName =
    v.provider === "elevenlabs"
      ? v.elevenlabs?.voiceId ?? "?"
      : v.openai?.voice ?? "?";
  const envVar = ENV_KEY_FOR_PROVIDER[v.provider];
  const key = deps.env[envVar];
  if (!key) return `${v.provider} ${voiceName} — no key`;

  const r =
    v.provider === "elevenlabs"
      ? await deps.validateElevenLabsKey(key)
      : await deps.validateOpenAIKey(key);
  return r.ok
    ? `${v.provider} ${voiceName} OK`
    : `${v.provider} ${voiceName} ERR (${shortErr(r.error)})`;
}

/**
 * Run all four live probes concurrently and return their one-line summaries.
 * Any probe that throws or has no config surface is omitted (undefined).
 */
export async function gatherStatusProbes(
  config: Config | undefined,
  persona: string,
  deps: StatusProbeDeps = {},
): Promise<StatusProbeLines> {
  const getMe = deps.telegramGetMe ?? realTelegramGetMe;
  const embed = deps.geminiEmbed ?? realGeminiEmbed;
  const reconcile =
    deps.reconcileEditorConnectors ?? realReconcileEditorConnectors;
  const isBinary = deps.isPhantombotBinary ?? realIsPhantombotBinary;
  const env = deps.env ?? process.env;
  const validateEl = deps.validateElevenLabsKey ?? realValidateElevenLabsKey;
  const validateOa = deps.validateOpenAIKey ?? realValidateOpenAIKey;

  const settle = async (
    p: Promise<string | undefined>,
  ): Promise<string | undefined> => {
    try {
      return await p;
    } catch {
      return undefined;
    }
  };

  const [telegram, memory, voice] = await Promise.all([
    settle(probeTelegram(config, persona, getMe)),
    settle(probeMemory(config, embed)),
    settle(
      probeVoice(config, {
        validateElevenLabsKey: validateEl,
        validateOpenAIKey: validateOa,
        env,
      }),
    ),
  ]);
  // ACP probe is synchronous local file reads — no need to race it.
  let acp: string | undefined;
  try {
    acp = probeAcp(reconcile, isBinary);
  } catch {
    acp = undefined;
  }

  return { telegram, acp, memory, voice };
}
