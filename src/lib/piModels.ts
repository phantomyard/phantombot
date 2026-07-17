/**
 * Parse `pi --list-models` and reason about model capabilities.
 *
 * Pi prints a fixed-width table (no JSON flag exists for this command, so we
 * parse the text). Columns, in order:
 *
 *   provider · model · context · max-out · thinking · images
 *
 * Example row:
 *   openai      gpt-5.2                400K     128K     yes       yes
 *
 * We only need two columns downstream: the fully-qualified model id
 * (`provider/model`, which is what `pi --model` expects) and whether the
 * model accepts image input (the `images` column → multimodal capability).
 *
 * This module is the phantombot-side mirror of what the Pi extension reads
 * from `ctx.modelRegistry` (each model there carries `input: ["text"]` or
 * `["text","image"]`). We can't import the Pi SDK here — phantombot is a
 * separate binary — so the wizard shells out to `pi --list-models` and parses
 * the table, while the in-process extension uses the structured registry.
 */

/** One row from `pi --list-models`, reduced to what the wizard needs. */
export interface PiModel {
  /** Provider column, e.g. "openai", "openrouter", "deepseek". */
  provider: string;
  /**
   * Bare model name as printed, e.g. "gpt-5.2" or "~anthropic/claude-opus-latest".
   * Pi prefixes some openrouter aliases with "~"; we preserve it verbatim
   * because that is the string `pi --model` accepts.
   */
  model: string;
  /** Whether the model accepts image input (the `images` column = yes). */
  supportsImages: boolean;
}

/**
 * The header row we expect from `pi --list-models`. Used to locate the start
 * of the table and to defend against pi changing its output shape: if we never
 * see this header, we return [] rather than mis-parsing arbitrary lines.
 */
const HEADER_TOKENS = ["provider", "model", "context", "max-out", "thinking", "images"];

function isHeaderLine(line: string): boolean {
  const cols = line.trim().split(/\s+/);
  return HEADER_TOKENS.every((t, i) => cols[i] === t);
}

/**
 * Parse the raw stdout of `pi --list-models` into structured rows.
 *
 * Resilient to:
 *   - leading banner / warning lines before the header
 *   - blank lines
 *   - variable run-length whitespace between columns
 *   - a missing/extra trailing column (we read by position from the left and
 *     treat the LAST whitespace-delimited token as `images`, which is robust
 *     because every documented column after `model` is a single bare token)
 *
 * Returns [] if the header is never found (pi unavailable / output changed).
 */
export function parsePiModels(stdout: string): PiModel[] {
  const lines = stdout.split(/\r?\n/);
  const headerIdx = lines.findIndex(isHeaderLine);
  if (headerIdx === -1) return [];

  const models: PiModel[] = [];
  for (let i = headerIdx + 1; i < lines.length; i++) {
    const raw = lines[i];
    if (raw === undefined) continue;
    if (raw.trim().length === 0) continue;
    // Split on runs of whitespace. provider · model · context · max-out ·
    // thinking · images → exactly 6 tokens for a well-formed row. We require
    // at least 6 so a stray wrapped line can't produce a bogus model.
    const cols = raw.trim().split(/\s+/);
    if (cols.length < HEADER_TOKENS.length) continue;
    const provider = cols[0]!;
    const model = cols[1]!;
    // `images` is the last column. Read it positionally from the right so a
    // future column insertion in the middle doesn't silently flip the flag.
    const imagesCol = cols[cols.length - 1]!;
    models.push({
      provider,
      model,
      supportsImages: imagesCol.toLowerCase() === "yes",
    });
  }
  return models;
}

/**
 * Spawns `pi --list-models` and returns parsed rows. Injectable runner so
 * tests drive parsing/branching without a real `pi` on PATH (mirrors the
 * SystemctlRunner pattern in systemd.ts). Returns [] on non-zero exit or
 * unparseable output — the wizard then falls back to free-text model entry.
 *
 * `bin` defaults to "pi" (PATH lookup); the wizard passes the resolved
 * absolute path from harness availability so it works under the systemd
 * unit's narrow PATH.
 */
export type PiModelsRunner = (
  bin: string,
  /**
   * Extra env for the child, MERGED over the current process env. Used to hand
   * Pi a just-entered key via its native var (see PiProvider.envVar) so the
   * refreshed list includes the newly-keyed provider.
   */
  extraEnv?: Record<string, string>,
) => Promise<{
  exitCode: number;
  stdout: string;
}>;

const defaultRunner: PiModelsRunner = async (bin, extraEnv) => {
  const proc = Bun.spawn([bin, "--list-models"], {
    stdout: "pipe",
    stderr: "ignore",
    // Undefined ⇒ inherit as before; merge (not replace) so PATH/HOME survive
    // and Pi can still read its own auth store.
    env: extraEnv ? { ...process.env, ...extraEnv } : undefined,
  });
  const stdout = await new Response(proc.stdout).text();
  const exitCode = await proc.exited;
  return { exitCode, stdout };
};

export async function listPiModels(
  bin = "pi",
  runner: PiModelsRunner = defaultRunner,
  extraEnv?: Record<string, string>,
): Promise<PiModel[]> {
  try {
    const { exitCode, stdout } = await runner(bin, extraEnv);
    if (exitCode !== 0) return [];
    return parsePiModels(stdout);
  } catch {
    return [];
  }
}

/**
 * A provider the operator can pick in the wizard.
 *
 * `id` is what `pi --provider` expects — Pi's `auth.json` key, which is also the
 * value printed in the `provider` column of `pi --list-models` (e.g. "openrouter",
 * "google", "xai"). NOT the display name: Pi's docs call the Gemini provider
 * "Google Gemini" but its id is `google`.
 */
export interface PiProvider {
  id: string;
  /** Human label from Pi's provider docs (falls back to `id` for unknowns). */
  label: string;
  /**
   * The provider's NATIVE env var (e.g. OPENROUTER_API_KEY) — Pi's own name for
   * it, not phantombot's PHANTOMBOT_PI_API_KEY.
   *
   * Needed because `pi --list-models` reads auth ONLY from ~/.pi/agent/auth.json
   * and these native env vars — it ignores `--api-key`/`--provider` (verified
   * against pi 0.79.1: `pi --list-models --provider openrouter --api-key …`
   * still prints "No models available"). So to refresh the model list with a key
   * the operator just typed (and which is NOT in Pi's store), the wizard must
   * spawn `--list-models` with THIS var injected into the child env.
   *
   * undefined for providers we don't have a documented var for (live-only /
   * post-catalogue providers) ⇒ the refresh is skipped and the pickers fall back
   * to free-text entry.
   */
  envVar?: string;
  /**
   * Whether `pi --list-models` currently returns models for this provider —
   * i.e. Pi already holds a key for it (in ~/.pi/agent/auth.json or the env).
   * Drives an "already keyed" hint; NOT a filter (see providerChoices).
   */
  hasModels: boolean;
}

/**
 * The STATIC provider catalogue, transcribed from Pi's own `docs/providers.md`
 * (the `auth.json key` column → `id`, the `Provider` column → `label`).
 *
 * WHY THIS EXISTS: `pi --list-models` only lists models for providers Pi ALREADY
 * has a key for. On a fresh install it prints "No models available. Use /login…"
 * — so deriving the provider list from it yielded an EMPTY picker precisely when
 * the operator was there to add their first key (the chicken-and-egg: you can't
 * pick a provider to key it, because it isn't listed until it's keyed). The
 * wizard therefore always offers this catalogue, and merges in whatever
 * `--list-models` reports on top (see providerChoices).
 *
 * Keep in sync with Pi's docs/providers.md when Pi adds providers. A provider
 * missing here is not fatal: it still shows up if Pi lists models for it, and
 * the picker's free-text fallback accepts any id.
 *
 * NOTE on the Cloudflare entries: Pi also needs CLOUDFLARE_ACCOUNT_ID (and
 * CLOUDFLARE_GATEWAY_ID for the gateway) alongside the key. We record only the
 * key var, so the post-key model refresh may come back empty for those two and
 * the wizard falls back to free-text — degraded, not broken.
 */
export const PI_PROVIDER_CATALOG: readonly Omit<PiProvider, "hasModels">[] = [
  { id: "anthropic", label: "Anthropic", envVar: "ANTHROPIC_API_KEY" },
  { id: "ant-ling", label: "Ant Ling", envVar: "ANT_LING_API_KEY" },
  {
    id: "azure-openai-responses",
    label: "Azure OpenAI Responses",
    envVar: "AZURE_OPENAI_API_KEY",
  },
  { id: "openai", label: "OpenAI", envVar: "OPENAI_API_KEY" },
  { id: "deepseek", label: "DeepSeek", envVar: "DEEPSEEK_API_KEY" },
  { id: "nvidia", label: "NVIDIA NIM", envVar: "NVIDIA_API_KEY" },
  { id: "google", label: "Google Gemini", envVar: "GEMINI_API_KEY" },
  { id: "mistral", label: "Mistral", envVar: "MISTRAL_API_KEY" },
  { id: "groq", label: "Groq", envVar: "GROQ_API_KEY" },
  { id: "cerebras", label: "Cerebras", envVar: "CEREBRAS_API_KEY" },
  {
    id: "cloudflare-ai-gateway",
    label: "Cloudflare AI Gateway",
    envVar: "CLOUDFLARE_API_KEY",
  },
  {
    id: "cloudflare-workers-ai",
    label: "Cloudflare Workers AI",
    envVar: "CLOUDFLARE_API_KEY",
  },
  { id: "xai", label: "xAI", envVar: "XAI_API_KEY" },
  { id: "openrouter", label: "OpenRouter", envVar: "OPENROUTER_API_KEY" },
  { id: "vercel-ai-gateway", label: "Vercel AI Gateway", envVar: "AI_GATEWAY_API_KEY" },
  { id: "zai", label: "ZAI Coding Plan (Global)", envVar: "ZAI_API_KEY" },
  { id: "zai-coding-cn", label: "ZAI Coding Plan (China)", envVar: "ZAI_CODING_CN_API_KEY" },
  { id: "opencode", label: "OpenCode Zen", envVar: "OPENCODE_API_KEY" },
  { id: "opencode-go", label: "OpenCode Go", envVar: "OPENCODE_API_KEY" },
  { id: "huggingface", label: "Hugging Face", envVar: "HF_TOKEN" },
  { id: "fireworks", label: "Fireworks", envVar: "FIREWORKS_API_KEY" },
  { id: "together", label: "Together AI", envVar: "TOGETHER_API_KEY" },
  { id: "kimi-coding", label: "Kimi For Coding", envVar: "KIMI_API_KEY" },
  { id: "minimax", label: "MiniMax", envVar: "MINIMAX_API_KEY" },
  { id: "minimax-cn", label: "MiniMax (China)", envVar: "MINIMAX_CN_API_KEY" },
  { id: "xiaomi", label: "Xiaomi MiMo", envVar: "XIAOMI_API_KEY" },
  {
    id: "xiaomi-token-plan-cn",
    label: "Xiaomi MiMo Token Plan (China)",
    envVar: "XIAOMI_TOKEN_PLAN_CN_API_KEY",
  },
  {
    id: "xiaomi-token-plan-ams",
    label: "Xiaomi MiMo Token Plan (Amsterdam)",
    envVar: "XIAOMI_TOKEN_PLAN_AMS_API_KEY",
  },
  {
    id: "xiaomi-token-plan-sgp",
    label: "Xiaomi MiMo Token Plan (Singapore)",
    envVar: "XIAOMI_TOKEN_PLAN_SGP_API_KEY",
  },
];

/** The provider's native API-key env var, or undefined if we don't know one. */
export function providerEnvVar(providerId: string): string | undefined {
  return PI_PROVIDER_CATALOG.find((p) => p.id === providerId)?.envVar;
}

/**
 * The provider picker's options: the static catalogue UNIONED with every
 * provider `pi --list-models` actually reported.
 *
 * The union matters in both directions:
 *   - catalogue-only (no key yet)  → still offered, so a fresh install can pick
 *     a provider and key it. This is the fresh-install fix.
 *   - live-only (not in catalogue) → still offered, so a provider Pi added after
 *     this catalogue was written (or a custom/base-url one) is never hidden just
 *     because we're out of date. Labelled by its bare id.
 *
 * Ordering is deliberate: providers Pi already has models for come FIRST (the
 * operator is most likely picking one of those, and on a configured box that
 * keeps the familiar short list at the top), then the rest of the catalogue
 * alphabetically by label. Pure + total, so the picker itself stays thin glue.
 */
export function providerChoices(models: readonly PiModel[]): PiProvider[] {
  const live = new Set(models.map((m) => m.provider));
  const known = new Map(PI_PROVIDER_CATALOG.map((p) => [p.id, p.label]));
  const ids = new Set<string>([...known.keys(), ...live]);
  const byLabel = (a: PiProvider, b: PiProvider) => a.label.localeCompare(b.label);
  const all = [...ids].map((id) => ({
    id,
    label: known.get(id) ?? id,
    hasModels: live.has(id),
  }));
  return [
    ...all.filter((p) => p.hasModels).sort(byLabel),
    ...all.filter((p) => !p.hasModels).sort(byLabel),
  ];
}

/**
 * The string `pi --model` expects. Pi accepts either the bare model name (it
 * resolves the provider) or a `provider/model` pair. We hand back the bare
 * name as printed, which is what the subagent example passes through verbatim
 * and what users see in the picker.
 */
export function modelId(m: PiModel): string {
  return m.model;
}

/**
 * Look up a model by the id the wizard stored (bare model name). Returns
 * undefined if the model is no longer offered (e.g. provider key removed).
 */
export function findModel(models: readonly PiModel[], id: string): PiModel | undefined {
  return models.find((m) => m.model === id);
}

/**
 * THE key routing decision: does the chosen primary model accept images?
 *
 * When true, the wizard SKIPS asking for an image model and the extension
 * will NOT register `look_at_image` — the primary can look at images itself,
 * so a separate vision delegate is dead weight. When the primary is unknown
 * (not in the parsed list), we conservatively return false so the image model
 * is still offered (better to over-provision a delegate than to silently lose
 * vision).
 */
export function primaryIsMultimodal(
  models: readonly PiModel[],
  primaryId: string,
): boolean {
  const m = findModel(models, primaryId);
  return m?.supportsImages ?? false;
}
