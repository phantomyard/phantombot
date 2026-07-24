/**
 * /model slash command — parsing, write planning, and persistence (issue #313).
 *
 * The channel dispatcher (channels/commands.ts) owns Telegram-shaped concerns
 * (usage text, replies, restart); this module owns everything unit-testable:
 *   - parseModelRequest: arg string → structured request
 *   - applyModelRequest: persist a set/clear to BOTH stores (config.toml +
 *     ~/.env) and sync the in-memory Config, mirroring the /chattiness and
 *     wizard write patterns
 *   - formatModelShow: the bare-`/model` reply body per harness
 *
 * WHY BOTH STORES: model config resolves env-over-TOML at startup
 * (config.ts), so writing only config.toml would be silently ignored on any
 * install where the wizard previously wrote PHANTOMBOT_*_MODEL into ~/.env.
 * Writing only env would leave `phantombot doctor` and the TOML reading
 * stale. Both must move together, exactly like applyRouting does for the
 * onboarding wizard.
 *
 * A restart is always required after a successful write — every harness
 * bakes its model config at construction (buildHarnessChain), so the
 * dispatcher fires selfRestart via afterSend, same dance as /restart.
 */

import type { Config } from "../config.ts";
import { getIn, setIn, updateConfigToml } from "./configWriter.ts";
import { defaultEnvFilePath, updateEnvFile } from "./envFile.ts";
import {
  ENV_CODING_MODEL,
  ENV_IMAGE_MODEL,
  ENV_PRIMARY_MODEL,
  type PiRoutingConfig,
} from "./piRouting.ts";
import type { HarnessModelInfo } from "../harnesses/types.ts";

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

export type ModelRole = "primary" | "coding" | "image";

export type ModelRequest =
  | { kind: "show" }
  | { kind: "list"; filter?: string }
  | { kind: "set"; role: ModelRole; slug: string }
  | { kind: "clear" }
  | { kind: "usage" };

/**
 * Parse the text after `/model` into a structured request.
 *
 *   ""                  → show
 *   "list [filter]"     → list
 *   "clear"             → clear (gemini/codex only)
 *   "primary <slug>"    → set primary (explicit alias of the bare form)
 *   "coding <slug>"     → set coding (pi only)
 *   "image <slug>"      → set image (pi only)
 *   "<slug>"            → set primary
 *   anything else       → usage
 *
 * Roles and "list"/"clear" are case-insensitive; the slug is preserved
 * verbatim because model ids are case-sensitive on some providers.
 */
export function parseModelRequest(arg: string): ModelRequest {
  const tokens = arg.split(/\s+/).filter((t) => t.length > 0);
  if (tokens.length === 0) return { kind: "show" };

  const head = tokens[0]!.toLowerCase();
  if (head === "list") {
    const filter = tokens.slice(1).join(" ").trim();
    return { kind: "list", filter: filter.length > 0 ? filter : undefined };
  }
  if (head === "clear") {
    return tokens.length === 1 ? { kind: "clear" } : { kind: "usage" };
  }
  if (head === "primary" || head === "coding" || head === "image") {
    if (tokens.length === 2) {
      return { kind: "set", role: head, slug: tokens[1]! };
    }
    return { kind: "usage" };
  }
  if (tokens.length === 1) return { kind: "set", role: "primary", slug: tokens[0]! };
  return { kind: "usage" };
}

// ---------------------------------------------------------------------------
// Show formatting
// ---------------------------------------------------------------------------

/** Bare-`/model` reply body: what the primary harness is currently running. */
export function formatModelShow(
  harnessId: string,
  info: HarnessModelInfo | undefined,
): string {
  if (!info) {
    return `${harnessId}: model info unavailable (harness doesn't report it)`;
  }
  switch (harnessId) {
    case "pi": {
      const lines = [`pi primary: ${info.model}`];
      if (info.provider) lines.push(`provider:   ${info.provider}`);
      lines.push(`coding:     ${info.codingModel ?? "(same as primary)"}`);
      lines.push(`image:      ${info.imageModel ?? "(none)"}`);
      return lines.join("\n");
    }
    case "claude":
      return (
        `claude model: ${info.model}` +
        (info.fallbackModel ? `\nfallback:     ${info.fallbackModel}` : "")
      );
    default:
      return `${harnessId} model: ${info.model}`;
  }
}

// ---------------------------------------------------------------------------
// Writes
// ---------------------------------------------------------------------------

/**
 * Claude models are set by alias, validated against a small allowlist to
 * catch typos — a bad --model value fails every turn at runtime, which is a
 * much worse place to discover "opys". Keep in sync with the aliases the
 * claude CLI accepts.
 */
export const CLAUDE_MODEL_ALIASES = ["opus", "sonnet", "haiku"] as const;

export type ModelApplyResult =
  | { ok: true; summary: string }
  | { ok: false; error: string };

const PI_ROLE_WRITES: Record<
  ModelRole,
  { tomlKey: string; envVar: string; routingField: keyof PiRoutingConfig }
> = {
  primary: { tomlKey: "primary_model", envVar: ENV_PRIMARY_MODEL, routingField: "primaryModel" },
  coding: { tomlKey: "coding_model", envVar: ENV_CODING_MODEL, routingField: "codingModel" },
  image: { tomlKey: "image_model", envVar: ENV_IMAGE_MODEL, routingField: "imageModel" },
};

/**
 * Persist a set/clear to config.toml + the env file, and sync the in-memory
 * Config + process.env so the running process agrees with disk until the
 * restart lands. `envPath` is injectable for tests.
 *
 * Returns a refusal (ok: false) for requests the harness can't honor:
 * coding/image roles on non-Pi harnesses, clear on pi/claude (both need a
 * model to function — use set instead), and non-allowlisted Claude aliases.
 */
export async function applyModelRequest(
  req: ModelRequest & { kind: "set" | "clear" },
  harnessId: string,
  config: Config,
  envPath: string = defaultEnvFilePath(),
): Promise<ModelApplyResult> {
  switch (harnessId) {
    case "pi":
      return applyPi(req, config, envPath);
    case "claude":
      return applyClaude(req, config, envPath);
    case "gemini":
      return applySimple(req, config, envPath, "gemini", "PHANTOMBOT_GEMINI_MODEL");
    case "codex":
      return applySimple(req, config, envPath, "codex", "PHANTOMBOT_CODEX_MODEL");
    default:
      return {
        ok: false,
        error: `/model isn't supported for the '${harnessId}' harness`,
      };
  }
}

async function applyPi(
  req: ModelRequest & { kind: "set" | "clear" },
  config: Config,
  envPath: string,
): Promise<ModelApplyResult> {
  if (req.kind === "clear") {
    return {
      ok: false,
      error:
        "pi has no default to clear to — routing needs an explicit primary. " +
        "use /model <slug> to switch, or `phantombot harness` to re-run the routing wizard",
    };
  }
  const { tomlKey, envVar, routingField } = PI_ROLE_WRITES[req.role];
  await updateConfigToml(config.configPath, (toml) => {
    setIn(toml, ["harnesses", "pi", "routing", tomlKey], req.slug);
  });
  await updateEnvFile(envPath, { [envVar]: req.slug });
  // In-memory sync — config.ts resolved env-over-TOML at startup, so both
  // the live Config and the live env must agree with what we just wrote.
  const routing = (config.harnesses.pi.routing ??= {});
  routing[routingField] = req.slug;
  process.env[envVar] = req.slug;
  return { ok: true, summary: `pi ${req.role} model → ${req.slug}` };
}

async function applyClaude(
  req: ModelRequest & { kind: "set" | "clear" },
  config: Config,
  envPath: string,
): Promise<ModelApplyResult> {
  if (req.kind === "clear") {
    return {
      ok: false,
      error:
        "claude has no default to clear to — use /model <alias> (opus, sonnet, haiku)",
    };
  }
  if (req.role !== "primary") {
    return {
      ok: false,
      error: "claude runs a single model — /model <alias> is the only write",
    };
  }
  const alias = req.slug.toLowerCase();
  if (!(CLAUDE_MODEL_ALIASES as readonly string[]).includes(alias)) {
    return {
      ok: false,
      error:
        `unknown claude alias '${req.slug}' — expected one of: ` +
        CLAUDE_MODEL_ALIASES.join(", "),
    };
  }
  await updateConfigToml(config.configPath, (toml) => {
    setIn(toml, ["harnesses", "claude", "model"], alias);
  });
  await updateEnvFile(envPath, { PHANTOMBOT_CLAUDE_MODEL: alias });
  config.harnesses.claude.model = alias;
  process.env.PHANTOMBOT_CLAUDE_MODEL = alias;
  return { ok: true, summary: `claude model → ${alias}` };
}

/**
 * gemini + codex share their shape: a single `model` string where "" means
 * "let the CLI pick its default". Set pins it; clear reverts to the default
 * by DELETING the TOML key and unsetting the env var ("" is the env-file
 * unset sentinel), so the config genuinely returns to its unpinned state
 * rather than carrying an empty-string override forever.
 */
async function applySimple(
  req: ModelRequest & { kind: "set" | "clear" },
  config: Config,
  envPath: string,
  id: "gemini" | "codex",
  envVar: string,
): Promise<ModelApplyResult> {
  if (req.kind === "set" && req.role !== "primary") {
    return {
      ok: false,
      error: `${id} runs a single model — /model <model-id> is the only write`,
    };
  }

  if (req.kind === "clear") {
    await updateConfigToml(config.configPath, (toml) => {
      const harness = getIn(toml, ["harnesses", id]) as
        | Record<string, unknown>
        | undefined;
      if (harness) delete harness.model;
    });
    await updateEnvFile(envPath, { [envVar]: "" });
    if (id === "gemini") config.harnesses.gemini.model = "";
    else if (config.harnesses.codex) config.harnesses.codex.model = "";
    delete process.env[envVar];
    return { ok: true, summary: `${id} model → (default)` };
  }

  await updateConfigToml(config.configPath, (toml) => {
    setIn(toml, ["harnesses", id, "model"], req.slug);
  });
  await updateEnvFile(envPath, { [envVar]: req.slug });
  if (id === "gemini") config.harnesses.gemini.model = req.slug;
  else if (config.harnesses.codex) config.harnesses.codex.model = req.slug;
  process.env[envVar] = req.slug;
  return { ok: true, summary: `${id} model → ${req.slug}` };
}
