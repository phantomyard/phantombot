/**
 * Capability-routing config for the Pi harness.
 *
 * This is DISTINCT from the primary→fallback harness chain (that's failover —
 * try the next harness when one dies). Capability routing is WITHIN a single
 * Pi turn: a strong-but-narrow PRIMARY model delegates specialist subtasks to
 * an IMAGE model (vision Q&A) and a CODING model (PR/MR-scoped jobs), via the
 * `look_at_image` and `coder` tools registered by the bundled Pi extension
 * (see pi-extension/capability-routing/).
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
 *   PHANTOMBOT_IMAGE_MODEL     — the vision delegate. SET ONLY when the primary
 *                                is NOT multimodal. When the primary already
 *                                accepts image input, this is intentionally
 *                                left UNSET so the extension does not register
 *                                `look_at_image` (the primary looks itself).
 *   PHANTOMBOT_CODING_MODEL    — the coding delegate spawned by `coder`.
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
 * The resolved routing config. All three are optional: undefined means "no
 * override — let Pi / the extension fall back to its default behavior". An
 * absent imageModel specifically means the `look_at_image` tool will not be
 * registered (either because the primary is multimodal, or because routing is
 * off entirely).
 */
export interface PiRoutingConfig {
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
  primaryModel: string;
  /** May be set even for a multimodal primary; auto-skip discards it. */
  imageModel?: string;
  codingModel?: string;
  /**
   * Whether the chosen primary accepts image input. When true, the image
   * model is DROPPED regardless of what `imageModel` holds — the central
   * "skip image model when multimodal" rule, applied in exactly one place.
   */
  primaryMultimodal: boolean;
}

/** The concrete writes the wizard should persist. */
export interface RoutingWrites {
  /** Values to set in config.toml's [harnesses.pi.routing]. */
  toml: { primary_model: string; image_model?: string; coding_model?: string };
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
  const coding = clean(choices.codingModel);
  // Auto-skip: a multimodal primary never gets an image delegate.
  const image = choices.primaryMultimodal ? undefined : clean(choices.imageModel);

  const toml: RoutingWrites["toml"] = { primary_model: primary };
  if (image) toml.image_model = image;
  if (coding) toml.coding_model = coding;

  // "" clears the key (updateEnvFile delete semantics). We always write all
  // three keys so switching from a non-multimodal to a multimodal primary
  // actively removes a stale PHANTOMBOT_IMAGE_MODEL rather than leaving it.
  const env: Record<string, string> = {
    [ENV_PRIMARY_MODEL]: primary,
    [ENV_IMAGE_MODEL]: image ?? "",
    [ENV_CODING_MODEL]: coding ?? "",
  };

  return { toml, env };
}
