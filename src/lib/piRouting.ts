/**
 * Capability-routing config for the Pi harness.
 *
 * This is DISTINCT from the primary→fallback harness chain (that's failover —
 * try the next harness when one dies). Capability routing is WITHIN a single
 * Pi turn: a strong-but-narrow PRIMARY model delegates a vision subtask to an
 * IMAGE model via the `look_at_image` tool registered by the bundled Pi
 * extension (see pi-extension/capability-routing/). The CODING model is read
 * here too, but it drives the per-turn coding-brain swap in harnesses/pi.ts —
 * not a delegation tool.
 *
 * ───────────────────────────────────────────────────────────────────────────
 * THE ENV-VAR CONTRACT
 * ───────────────────────────────────────────────────────────────────────────
 * The wizard (`phantombot harness`) persists the operator's choices in TWO
 * places, and the Pi extension reads ONLY the env vars at load time:
 *
 *   PHANTOMBOT_PRIMARY_MODEL   — the primary/orchestrator model id (bare name
 *                                as printed by `pi --list-models`, e.g.
 *                                "gpt-5.2" or "~anthropic/claude-opus-latest").
 *                                Empty / unset = "use Pi's configured default"
 *                                (no override; the extension routes nothing).
 *   PHANTOMBOT_IMAGE_MODEL     — the vision delegate. ALWAYS set when routing is
 *                                configured: an explicit pick, or — when the
 *                                primary is itself multimodal and no pick was
 *                                made — the PRIMARY model id. We keep it set even
 *                                for a vision primary so a text-only coding
 *                                delegate (after a coding-brain swap) still has a
 *                                `look_at_image` tool; the tool's description
 *                                tells vision-capable models not to use it.
 *   PHANTOMBOT_CODING_MODEL    — the coding model swapped in for a coding turn
 *                                by the per-turn coding-brain swap (harnesses/pi.ts).
 *
 * The same values are mirrored into config.toml under
 * `[harnesses.pi.routing]` (primary_model / image_model / coding_model) so the
 * choice survives a fresh shell and is visible to `phantombot doctor`. config
 * loading (config.ts) and the env file (~/.env, written via the same path as
 * `phantombot env set`) keep the env vars and TOML in sync; env wins, matching
 * every other setting in phantombot.
 *
 * Why env vars at all (vs. the extension reading config.toml)? The extension
 * runs INSIDE the `pi` subprocess that phantombot spawns. phantombot already
 * exports its environment to that child (see harnesses/pi.ts → withPersonaEnv),
 * so env vars are the zero-coupling channel: the extension needs no knowledge
 * of phantombot's config path or TOML schema.
 */

export const ENV_PRIMARY_MODEL = "PHANTOMBOT_PRIMARY_MODEL";
export const ENV_IMAGE_MODEL = "PHANTOMBOT_IMAGE_MODEL";
export const ENV_CODING_MODEL = "PHANTOMBOT_CODING_MODEL";
/**
 * The Pi PROVIDER (e.g. "openrouter", "openai", "xai", "deepseek"), threaded
 * per-turn onto `pi --provider <name>` alongside the model and api-key. This is
 * the lynchpin that makes a per-turn api-key correct: `pi --provider` DEFAULTS
 * TO GOOGLE, so an OpenRouter key handed to Pi without `--provider openrouter`
 * is fired at the wrong endpoint and auth fails. The provider also SCOPES the
 * wizard: the operator picks it first, the key prompt is labelled by it, and the
 * model pickers only show that provider's models — so the single per-turn
 * `--provider` is always right no matter which model (primary OR the swapped-in
 * coding model) is active that turn. Not a secret, so it lives in BOTH config.toml
 * (`[harnesses.pi.routing].provider`) and ~/.env, exactly like the model ids.
 * Empty / unset ⇒ omit `--provider` (Pi falls back to its own default, google).
 */
export const ENV_PI_PROVIDER = "PHANTOMBOT_PI_PROVIDER";
/**
 * The Pi provider API key, threaded per-turn onto `pi --api-key <key>` exactly
 * the way the model is threaded onto `--model` — NOT persisted into Pi's own
 * auth store (~/.pi). Phantomops owns long-term key storage in production; here
 * the wizard's "configure now" path may stash one in ~/.env so a single box can
 * run standalone. The contract is a graceful three-tier fallback for auth:
 *   1. this env var present  → `--api-key` is passed (wins).
 *   2. absent                → no `--api-key`; Pi falls back to its OWN env vars
 *                              / local store settings (the "install later, no
 *                              key" path — legacy installs keep working).
 *   3. neither               → Pi errors as it normally would.
 * Empty / unset ⇒ omit the flag (tier 2). Never written by computeRoutingWrites;
 * it's collected separately by the wizard and read directly in harnesses/pi.ts.
 */
export const ENV_PI_API_KEY = "PHANTOMBOT_PI_API_KEY";

/**
 * The resolved routing config. All model fields are optional: undefined means
 * "no override — let Pi / the extension fall back to its default behavior". An
 * absent imageModel specifically means the `look_at_image` tool will not be
 * registered (either because the primary is multimodal, or because routing is
 * off entirely).
 */
export interface PiRoutingConfig {
  /**
   * Provider name for all routed models (e.g. "openrouter"). Threaded onto
   * `--provider` every turn; without it Pi defaults to google and a non-google
   * api-key fails. undefined ⇒ no `--provider` (Pi's own default).
   */
  provider?: string;
  primaryModel?: string;
  imageModel?: string;
  codingModel?: string;
}

function clean(v: string | undefined): string | undefined {
  if (v === undefined) return undefined;
  const t = v.trim();
  return t.length > 0 ? t : undefined;
}

/**
 * Decide which provider the routing wizard should persist, given the provider
 * picker's answer and the currently-configured provider.
 *
 * `picked` is exactly what `pickProvider` returned, carried verbatim:
 *   - a provider name → set it
 *   - `""` ((none))   → the operator EXPLICITLY cleared the provider, so we
 *                       return `""` (which `computeRoutingWrites`/`applyRouting`
 *                       turn into a delete of both the TOML key and the env var)
 *   - `undefined`     → the provider step was SKIPPED (e.g. the standalone
 *                       fallback path doesn't re-ask), so keep `current`
 *
 * The crucial distinction is `""` (explicit clear) vs `undefined` (skipped):
 * the old wiring collapsed the picker's `""` to `undefined` before this point,
 * so choosing "(none)" could never clear an existing provider — it always fell
 * back to `current`.
 */
export function resolveRoutingProvider(
  picked: string | undefined,
  current: string | undefined,
): string | undefined {
  return picked ?? current;
}

/**
 * Decide what the harness wizard should do with PHANTOMBOT_PI_API_KEY after the
 * key prompt, given the key the operator typed and whether the provider
 * changed.
 *
 * The key prompt treats blank as "keep whatever's already in ~/.env" — but that
 * is ONLY safe when the provider is unchanged. The api-key is provider-scoped:
 * it's threaded per-turn onto `pi --api-key` ALONGSIDE `pi --provider`, and Pi's
 * `--provider` defaults to google, so a key from the OLD provider fired at a NEW
 * `--provider` (or at no provider) auth-fails. So if the operator switched
 * providers (or cleared the provider to "(none)") and left the key blank, the
 * stale key MUST be cleared — Pi then falls back to its own local store, the
 * documented "no per-turn key" path. A blank key with an UNCHANGED provider is
 * the genuine "keep current" case and is preserved untouched (so re-running the
 * wizard without retyping the key on an already-configured box is a no-op).
 *
 *   - non-blank key            → set it (a freshly entered key always wins)
 *   - blank + provider changed → clear the stale key
 *   - blank + provider same    → keep the current key
 *
 * Pure and exported so the decision is unit-tested without driving the TUI.
 */
export type PiApiKeyWrite =
  | { action: "set"; value: string }
  | { action: "clear" }
  | { action: "keep" };

export function resolvePiApiKeyWrite(
  enteredKey: string,
  newProvider: string | undefined,
  currentProvider: string | undefined,
): PiApiKeyWrite {
  const entered = enteredKey.trim();
  if (entered) return { action: "set", value: entered };
  const providerChanged = clean(newProvider) !== clean(currentProvider);
  return providerChanged ? { action: "clear" } : { action: "keep" };
}

/**
 * Resolve routing config with phantombot's standard precedence:
 * env var > config.toml > unset. `toml` is the parsed
 * `[harnesses.pi.routing]` sub-table (may be empty / undefined).
 *
 * `env` is injectable for tests; defaults to process.env.
 */
export function resolveRouting(
  toml: Record<string, unknown> | undefined,
  env: Record<string, string | undefined> = process.env,
): PiRoutingConfig {
  const t = toml ?? {};
  const tomlStr = (key: string): string | undefined => {
    const v = t[key];
    return typeof v === "string" ? clean(v) : undefined;
  };
  return {
    provider: clean(env[ENV_PI_PROVIDER]) ?? tomlStr("provider"),
    primaryModel: clean(env[ENV_PRIMARY_MODEL]) ?? tomlStr("primary_model"),
    imageModel: clean(env[ENV_IMAGE_MODEL]) ?? tomlStr("image_model"),
    codingModel: clean(env[ENV_CODING_MODEL]) ?? tomlStr("coding_model"),
  };
}

/**
 * The operator's wizard answers, BEFORE multimodal auto-skip is applied.
 * `imageModel` here is whatever they picked; `computeRoutingWrites` drops it
 * when the primary is multimodal.
 */
export interface RoutingChoices {
  /**
   * Provider for all the models below (e.g. "openrouter"). The wizard collects
   * it first and filters every model picker to it, so one provider covers
   * primary + image + coding. undefined ⇒ no `--provider` override.
   */
  provider?: string;
  primaryModel: string;
  /** May be set even for a multimodal primary; auto-skip discards it. */
  imageModel?: string;
  codingModel?: string;
}

/** The concrete writes the wizard should persist. */
export interface RoutingWrites {
  /** Values to set in config.toml's [harnesses.pi.routing]. */
  toml: {
    provider?: string;
    primary_model: string;
    image_model?: string;
    coding_model?: string;
  };
  /**
   * Env vars to write to ~/.env. A value of "" means UNSET (delete the key) —
   * matching `phantombot env unset` / updateEnvFile's empty-string semantics,
   * so a previously-set image model is cleared when the new primary is
   * multimodal.
   */
  env: Record<string, string>;
}

/**
 * Turn the operator's choices into the exact set of TOML + env writes,
 * applying the multimodal auto-skip. This is the single source of truth for
 * the "skip image model when multimodal" behavior — the TUI just collects
 * answers and hands them here, and the tests pin this function directly.
 */
export function computeRoutingWrites(choices: RoutingChoices): RoutingWrites {
  const primary = choices.primaryModel.trim();
  const provider = clean(choices.provider);
  const coding = clean(choices.codingModel);
  // The image model is exactly what the operator selected — no auto-drop, no
  // auto-default applied here. This REPLACES the old multimodal auto-skip (which
  // dropped the image model for a vision primary). The "always have an image
  // model" behavior now lives in the wizard, which pre-selects the primary as
  // the default image model when the primary is vision-capable — so a text-only
  // coding delegate (after a coding-brain swap) always has a look_at_image to
  // call. An explicit "(none)" is honored: a vision primary that opts out simply
  // sees images itself. Optional ⇒ undefined.
  const image = clean(choices.imageModel);

  const toml: RoutingWrites["toml"] = { primary_model: primary };
  if (provider) toml.provider = provider;
  if (image) toml.image_model = image;
  if (coding) toml.coding_model = coding;

  // "" clears the key (updateEnvFile delete semantics). We always write all
  // keys so switching from a non-multimodal to a multimodal primary actively
  // removes a stale PHANTOMBOT_IMAGE_MODEL.
  const env: Record<string, string> = {
    [ENV_PI_PROVIDER]: provider ?? "",
    [ENV_PRIMARY_MODEL]: primary,
    [ENV_IMAGE_MODEL]: image ?? "",
    [ENV_CODING_MODEL]: coding ?? "",
  };

  return { toml, env };
}
