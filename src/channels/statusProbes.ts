/**
 * Live health probes for the `/status` command.
 *
 * `/status` is a troubleshooting tool, so every probe here runs FRESH on each
 * invocation — no cached results. Each probe hits the real subsystem (Telegram
 * getMe, the embedding provider, the voice provider's key-validation endpoint,
 * the local editor-connector registrations) and returns a short one-line
 * summary of "what is it, and is it working right now".
 *
 * Every probe is best-effort and self-contained: a thrown error, a missing
 * config surface, or a probe that exceeds the shared deadline yields
 * `undefined` (the line is simply omitted) rather than breaking `/status`. The
 * whole fan-out is bounded by a single wall-clock deadline (PROBE_DEADLINE_MS)
 * threaded into every client that accepts an AbortSignal and enforced again as
 * a race in gatherStatusProbes, so a dead or stalled provider can never hang
 * the command. Real network egress happens on each call — that is the
 * deliberate tradeoff for fresh diagnostics (see the PR discussion). The LLM
 * health line is intentionally NOT here; it needs its own design (timeout, cost
 * guard, 429-vs-down semantics) and lands in a follow-up.
 *
 * The concrete probe functions are injected via `StatusProbeDeps` so tests can
 * exercise the formatting and branch logic without real network calls;
 * production callers omit `deps` and get the real implementations.
 */

import { existsSync } from "node:fs";

import { type Config, personaDir } from "../config.ts";
import { nightlyHealth as realNightlyHealth } from "../lib/nightly.ts";
import { truncateLine } from "../lib/format.ts";
import { timeoutSignal } from "../lib/fetchTimeout.ts";
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

/**
 * Hard wall-clock cap for the whole live-probe fan-out. `/status` is a
 * troubleshooting command, so a stalled or dead provider must never make it
 * hang. Two layers enforce this:
 *   1. a single shared AbortSignal.timeout is threaded into every client that
 *      accepts a signal (telegram getMe, gemini embed, the voice validators),
 *      so the underlying socket is actually cancelled — no #135-class leak; and
 *   2. gatherStatusProbes races each probe against the same deadline as a
 *      belt-and-suspenders cap, in case a client stalls before its fetch or
 *      ignores the signal entirely.
 */
const PROBE_DEADLINE_MS = 5000;

export interface StatusProbeLines {
  /** e.g. "@robbie_bot OK" or "ERR (401 Unauthorized)" */
  telegram?: string;
  /** e.g. "zed ✓, vscode ✓" or "no editors detected" */
  acp?: string;
  /** e.g. "gemini OK", "gemini ERR (429)", or "okf active (local)" */
  memory?: string;
  /** e.g. "elevenlabs onwK…03F9 OK" or "openai nova ERR (…)" */
  voice?: string;
  /**
   * Nightly distillation health, e.g. "OK (nothing pending)",
   * "RUNNING (2/5 dates, on 2026-06-02)" or "WARN (2 dates pending, …)".
   */
  dreaming?: string;
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
  nightlyHealth?: typeof realNightlyHealth;
  env?: Record<string, string | undefined>;
  /** Override the shared probe deadline (ms). Production omits it; tests use
   *  a tiny value to exercise the cap without waiting the real 5s. */
  deadlineMs?: number;
}

function shortErr(e: string): string {
  return truncateLine(e, ERR_MAX);
}

/** Live Telegram token/handle probe via getMe on the persona's bound token. */
async function probeTelegram(
  config: Config | undefined,
  persona: string,
  getMe: typeof realTelegramGetMe,
  signal?: AbortSignal,
): Promise<string | undefined> {
  const token =
    config?.channels.telegramPersonas?.[persona]?.token ??
    config?.channels.telegram?.token;
  if (!token) return undefined;
  const r = await getMe(token, fetch, signal);
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
  signal?: AbortSignal,
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
    signal,
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
    signal?: AbortSignal;
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
      ? await deps.validateElevenLabsKey(key, fetch, deps.signal)
      : await deps.validateOpenAIKey(key, fetch, deps.signal);
  return r.ok
    ? `${v.provider} ${voiceName} OK`
    : `${v.provider} ${voiceName} ERR (${shortErr(r.error)})`;
}

/**
 * Nightly ("dreaming") health, read straight off the ledger + the daily files
 * on disk. No LLM, no network, and it never does any of the nightly's work —
 * it only reports what the last sweep left behind and what is still pending.
 *
 * Deliberately schedule-blind: a laptop that sweeps at 09:15 on boot is just
 * as healthy as a server that sweeps at 02:00, provided nothing is pending.
 */
async function probeDreaming(
  config: Config | undefined,
  persona: string,
  health: typeof realNightlyHealth,
): Promise<string | undefined> {
  if (!config) return undefined;
  const dir = personaDir(config, persona);
  if (!existsSync(dir)) return undefined;
  const h = await health(dir);
  switch (h.status) {
    case "running":
      return `RUNNING (${h.detail})`;
    case "warning":
      return `WARN (${h.detail})`;
    case "error":
      return `ERR (${h.detail})`;
    default:
      return `OK (${h.detail})`;
  }
}

/**
 * Run all live probes concurrently and return their one-line summaries.
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
  const nightly = deps.nightlyHealth ?? realNightlyHealth;

  // One shared deadline for the whole fan-out. Threaded into every client that
  // accepts a signal (cancels the socket) AND raced in settle() below (hard cap
  // even if a client ignores the signal). See PROBE_DEADLINE_MS.
  const deadline = timeoutSignal(deps.deadlineMs ?? PROBE_DEADLINE_MS);

  const settle = async (
    p: Promise<string | undefined>,
  ): Promise<string | undefined> => {
    const capped = new Promise<undefined>((resolve) => {
      if (deadline.aborted) return resolve(undefined);
      deadline.addEventListener("abort", () => resolve(undefined), {
        once: true,
      });
    });
    try {
      return await Promise.race([p, capped]);
    } catch {
      return undefined;
    }
  };

  const [telegram, memory, voice, dreaming] = await Promise.all([
    settle(probeTelegram(config, persona, getMe, deadline)),
    settle(probeMemory(config, embed, deadline)),
    settle(
      probeVoice(config, {
        validateElevenLabsKey: validateEl,
        validateOpenAIKey: validateOa,
        env,
        signal: deadline,
      }),
    ),
    settle(probeDreaming(config, persona, nightly)),
  ]);
  // ACP probe is synchronous local file reads — no need to race it.
  let acp: string | undefined;
  try {
    acp = probeAcp(reconcile, isBinary);
  } catch {
    acp = undefined;
  }

  return { telegram, acp, memory, voice, dreaming };
}
