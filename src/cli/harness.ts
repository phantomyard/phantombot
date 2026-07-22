/**
 * `phantombot harness` — interactive TUI to set the harness chain
 * (primary → fallback). Detects which binaries are on PATH and warns
 * about the ones that aren't.
 */

import { defineCommand } from "citty";
import * as p from "@clack/prompts";

import { type Config, loadConfig } from "../config.ts";
import {
  getIn,
  readConfigToml,
  setIn,
  type TomlObject,
  updateConfigToml,
} from "../lib/configWriter.ts";
import {
  harnessBin,
  resolveHarnessBinary,
  whichBinary,
} from "../lib/harnessAvailability.ts";
import {
  defaultServiceControl,
  restartCommand,
  type ServiceControl,
} from "../lib/platform.ts";
import {
  listPiModels,
  modelId,
  type PiModel,
  primaryIsMultimodal,
  providerChoices,
  providerEnvVar,
} from "../lib/piModels.ts";
import {
  computeRoutingClears,
  computeRoutingWrites,
  ENV_PI_API_KEY,
  resolvePiApiKeyWrite,
  resolveRouting,
  resolveRoutingProvider,
  type RoutingChoices,
} from "../lib/piRouting.ts";
import { updateEnvFile } from "../lib/envFile.ts";
import { userEnvPath } from "./env.ts";
import { saveHarnessBins } from "../state.ts";

export { whichBinary } from "../lib/harnessAvailability.ts";

export type HarnessId = "claude" | "pi" | "gemini" | "codex";
// Pi is listed FIRST so it is the default primary in the wizard (both the
// pre-selected option and the SUPPORTED_HARNESSES[0] fallback). Pi is
// phantombot's reference harness — capability routing, the coding-brain swap,
// and the vision delegate are all Pi features — so a fresh install should land
// on Pi unless the operator deliberately picks another.
export const SUPPORTED_HARNESSES: ReadonlyArray<HarnessId> = [
  "pi",
  "claude",
  "gemini",
  "codex",
];

/**
 * The official Pi installer invocation — user-space, no sudo. Returned as an
 * argv array (not a shell string) so callers spawn it explicitly; it is pure
 * and unit-tested so the wizard's shell-out stays a thin wrapper.
 *
 * Platform-aware (issue #269): POSIX runs Pi's shell installer
 * (pi.dev/install.sh) via `sh`, but on Windows there is no `sh` and that path
 * either fails outright or, if Git Bash is present, installs a POSIX layout the
 * Windows runtime can't launch. Windows instead runs Pi's PowerShell installer
 * (pi.dev/install.ps1) through `powershell`. The `platform` arg defaults to the
 * host but is injectable so both branches stay unit-tested on a single OS.
 */
export function piInstallCommand(
  platform: NodeJS.Platform = process.platform,
): string[] {
  if (platform === "win32") {
    return [
      "powershell",
      "-NoProfile",
      "-ExecutionPolicy",
      "Bypass",
      "-Command",
      "irm https://pi.dev/install.ps1 | iex",
    ];
  }
  return ["sh", "-c", "curl -fsSL https://pi.dev/install.sh | sh"];
}

export async function detectAvailability(
  config: Config,
): Promise<Record<HarnessId, string | undefined>> {
  return {
    claude: await whichBinary(config.harnesses.claude.bin),
    pi: await whichBinary(config.harnesses.pi.bin),
    gemini: await whichBinary(config.harnesses.gemini.bin),
    codex: await whichBinary(config.harnesses.codex?.bin ?? "codex"),
  };
}

export async function applyHarnessChain(
  configPath: string,
  chain: readonly HarnessId[],
): Promise<void> {
  await updateConfigToml(configPath, (toml) => {
    setIn(toml, ["harnesses", "chain"], [...chain]);
  });
}

/**
 * Persist the capability-routing choices: write the `[harnesses.pi.routing]`
 * sub-table to config.toml AND the PHANTOMBOT_*_MODEL env vars to ~/.env. The
 * image model is whatever the wizard collected (it pre-selects the primary as
 * the default image model when the primary is vision-capable). Returns the
 * computed writes so callers/tests can assert.
 *
 * `envPath` is injectable for tests (defaults to ~/.env via userEnvPath()).
 */
export async function applyRouting(
  configPath: string,
  choices: RoutingChoices,
  envPath: string = userEnvPath(),
): Promise<ReturnType<typeof computeRoutingWrites>> {
  const writes = computeRoutingWrites(choices);
  await updateConfigToml(configPath, (toml) => {
    setIn(toml, ["harnesses", "pi", "routing", "primary_model"], writes.toml.primary_model);
    // Provider: drop the key when none was chosen so a switch back to Pi's
    // default clears a stale provider (mirrors the env "" = unset semantics).
    setRoutingKey(toml, "provider", writes.toml.provider);
    // Mirror the env "" = unset semantics into TOML: drop the key when there's
    // no image/coding model so a multimodal switch clears a stale entry.
    setRoutingKey(toml, "image_model", writes.toml.image_model);
    setRoutingKey(toml, "coding_model", writes.toml.coding_model);
  });
  await updateEnvFile(envPath, writes.env);
  return writes;
}

/**
 * Erase every routing value the wizard owns, from BOTH stores — the
 * "Use Pi's own config" path. See `computeRoutingClears` for why this must
 * actively clear rather than merely skip writing (the old "later" branch was a
 * no-op that silently kept stale routing alive forever).
 *
 * The empty `[harnesses.pi.routing]` table is left behind rather than deleted:
 * `resolveRouting` maps an empty table to all-undefined, which is exactly the
 * "no overrides" state we want, and keeping the table avoids churning the TOML
 * shape. `envPath` is injectable for tests, matching applyRouting.
 */
export async function clearPiRouting(
  configPath: string,
  envPath: string = userEnvPath(),
): Promise<ReturnType<typeof computeRoutingClears>> {
  const clears = computeRoutingClears();
  await updateConfigToml(configPath, (toml) => {
    const routing = getIn(toml, ["harnesses", "pi", "routing"]) as
      | Record<string, unknown>
      | undefined;
    if (!routing) return;
    for (const key of clears.tomlKeys) delete routing[key];
  });
  await updateEnvFile(envPath, clears.env);
  return clears;
}

function setRoutingKey(
  toml: TomlObject,
  key: string,
  value: string | boolean | undefined,
): void {
  const routing = getIn(toml, ["harnesses", "pi", "routing"]) as
    | Record<string, unknown>
    | undefined;
  if (value === undefined) {
    if (routing && key in routing) delete routing[key];
    return;
  }
  setIn(toml, ["harnesses", "pi", "routing", key], value);
}

interface RunInput {
  config?: Config;
  serviceControl?: ServiceControl;
  /**
   * Optional pre-computed availability map. If provided, skips the PATH
   * sweep — useful when the caller (e.g. `init`) has already detected
   * availability and we don't want to re-walk PATH for every harness.
   */
  availability?: Record<HarnessId, string | undefined>;
}

export async function runHarness(input: RunInput = {}): Promise<number> {
  const config = input.config ?? (await loadConfig());
  const availability = input.availability ?? (await detectAvailability(config));
  await saveHarnessBins(availability);
  const svc = input.serviceControl ?? defaultServiceControl();

  p.intro("Configure the harness chain");

  p.note(
    SUPPORTED_HARNESSES.map(
      (id) => `  ${availability[id] ? "[ok]  " : "[NOT FOUND]"} ${id}: ${availability[id] ?? harnessBin(config, id)}`,
    ).join("\n"),
    "Detected harnesses",
  );

  const hasAnyHarness = Object.values(availability).some((path) => path !== undefined);
  if (!hasAnyHarness) {
    p.note(
      "No supported harness (claude, pi, gemini, codex) was found on your PATH.\n" +
      "You will need to install at least one of them before the agent can think.\n" +
      "We will continue the setup anyway so your configuration is ready.",
      "Warning: No Harness Found",
    );
  }

  const primary = await p.select<HarnessId>({
    message: "Primary harness",
    options: SUPPORTED_HARNESSES.map((id) => ({
      value: id,
      label: id,
      hint: availability[id] ? availability[id] : "not on PATH (will fail)",
    })),
    // Pi is the default (SUPPORTED_HARNESSES[0]); an existing config wins.
    initialValue:
      (config.harnesses.chain[0] as HarnessId) ?? SUPPORTED_HARNESSES[0],
  });
  if (p.isCancel(primary)) {
    p.cancel("cancelled");
    return 1;
  }

  // If Pi is the primary, configure it right here — offer to install when it's
  // missing (the install can put it on PATH, so the fallback picker below then
  // shows it as available), then run the now/later → API key → routing flow.
  if (primary === "pi") {
    const cancelled = await configurePi(config, availability, "primary");
    if (cancelled) {
      p.cancel("cancelled");
      return 1;
    }
  }

  const fallbackOptions: Array<{
    value: HarnessId | "none";
    label: string;
    hint?: string;
  }> = [
    { value: "none", label: "(none)", hint: "no fallback if primary fails" },
    ...SUPPORTED_HARNESSES.filter((id) => id !== primary).map((id) => ({
      value: id,
      label: id,
      hint: availability[id] ?? "not on PATH",
    })),
  ];

  const fallbackPick = await p.select<HarnessId | "none">({
    message: "Fallback harness",
    options: fallbackOptions,
    initialValue: (config.harnesses.chain[1] as HarnessId | undefined) ?? "none",
  });
  if (p.isCancel(fallbackPick)) {
    p.cancel("cancelled");
    return 1;
  }

  // Pi as the FALLBACK gets the exact same treatment as when it's primary —
  // install offer, now/later, its own API key, and a full routing pass — so the
  // fallback can point at a different provider/model entirely, not just reuse
  // the primary's. (When Pi is the primary it was already handled above; it can
  // only appear once in the chain, so this never double-runs.)
  if (fallbackPick === "pi") {
    const cancelled = await configurePi(config, availability, "fallback");
    if (cancelled) {
      p.cancel("cancelled");
      return 1;
    }
  }

  const chain: HarnessId[] = [primary as HarnessId];
  if (fallbackPick !== "none") chain.push(fallbackPick as HarnessId);

  await applyHarnessChain(config.configPath, chain);
  p.note(
    `harness chain: ${chain.join(" → ")}\nsaved to ${config.configPath}`,
    "Saved",
  );

  await maybePromptRestart(svc);

  p.outro("done");
  return 0;
}

/**
 * Run the official Pi installer (user-space, no sudo). stdout/stdin inherit so
 * the operator goes through Pi's own onboarding live; stderr is captured for the
 * failure note. Injectable for tests via the `runner` param. Returns whether it
 * exited cleanly.
 */
export type InstallRunner = (cmd: string[]) => Promise<{
  exitCode: number;
  stderr: string;
}>;

const defaultInstallRunner: InstallRunner = async (cmd) => {
  const [bin, ...rest] = cmd;
  const proc = Bun.spawn([bin!, ...rest], {
    stdin: "inherit",
    stdout: "inherit",
    stderr: "pipe",
  });
  const stderr = await new Response(proc.stderr).text();
  const exitCode = await proc.exited;
  return { exitCode, stderr };
};

async function installPi(
  runner: InstallRunner = defaultInstallRunner,
): Promise<boolean> {
  const r = await runner(piInstallCommand());
  if (r.exitCode === 0) return true;
  p.note(
    `pi install exited ${r.exitCode}.\n${(r.stderr || "(no stderr)").trim()}`,
    "Install failed",
  );
  return false;
}

/**
 * Configure Pi when it's chosen as a harness (primary OR fallback). Steps:
 *   1. If Pi isn't on PATH, offer to run the official installer, then redetect
 *      (and update the shared `availability` map so the caller's later prompts
 *      see the freshly-installed binary).
 *   2. Ask WHO owns the model config — the real choice behind the old
 *      "now / later" wording, which described *when* you'd configure rather than
 *      *what* would drive Pi:
 *        · "Use Pi's own config" ⇒ delegate to Pi's local settings (what the
 *          user set by running `pi` and logging into a provider). CLEARS both of
 *          phantombot's routing stores, then stops — see clearPiRouting for why
 *          skipping the write isn't enough.
 *        · "Configure models" ⇒ continue to 3.
 *   3. Pick the provider (from Pi's full static catalogue, NOT just what's
 *      already keyed), collect that provider's API key (stored in ~/.env as
 *      PHANTOMBOT_PI_API_KEY, threaded per-turn onto `--api-key`; NOT written
 *      into Pi's own store), refresh the model catalogue with it, then run the
 *      routing wizard for primary / image / coding (no "use defaults?" detour).
 *
 * `availability` is mutated in place when an install succeeds. Returns `true`
 * only when the operator cancelled outright (Esc), so the caller can abort.
 */
async function configurePi(
  config: Config,
  availability: Record<HarnessId, string | undefined>,
  role: "primary" | "fallback",
): Promise<boolean> {
  if (!availability.pi) {
    const doInstall = await p.confirm({
      message: `Pi isn't installed. Install it now (official installer, user-space)?`,
      initialValue: true,
    });
    if (p.isCancel(doInstall)) return true;
    if (doInstall) {
      const ok = await installPi();
      if (ok) {
        // Redetect against the broad search path (Pi may land in ~/.local/bin or
        // ~/.pi/agent/bin, not the current process PATH).
        const resolved = await resolveHarnessBinary("pi");
        availability.pi = resolved.path;
        await saveHarnessBins(availability);
        p.note(
          availability.pi
            ? `pi installed: ${availability.pi}`
            : "pi installed, but not yet detected on the search path — you can still configure routing by hand below.",
          "Install",
        );
      }
    }
  }

  const mode = await p.select<"configure" | "local">({
    message: `Pi (${role}): how should models be configured?`,
    options: [
      {
        value: "configure",
        label: "Configure models",
        hint: "pick provider + API key, then primary / vision / coding models",
      },
      {
        value: "local",
        label: "Use Pi's own config",
        hint: "delegate to Pi's local settings (from `pi` login) — clears any routing here",
      },
    ],
    initialValue: "configure",
  });
  if (p.isCancel(mode)) return true;
  if (mode === "local") {
    // ACTIVELY clear both stores — see clearPiRouting/computeRoutingClears. The
    // old "later" branch returned without clearing, so any previously-configured
    // routing kept being threaded onto every turn and this option did nothing.
    await clearPiRouting(config.configPath);
    p.note(
      [
        "Pi will use its own local config (~/.pi/agent/settings.json) — the",
        "provider + model you set by running `pi` and logging in.",
        "",
        `cleared phantombot's Pi routing from ${config.configPath}`,
        `and ${userEnvPath()} (provider, primary/image/coding model, API key),`,
        "so no --model/--provider/--api-key is passed and Pi decides for itself.",
        "",
        "Re-run `phantombot harness` and pick 'Configure models' to override.",
      ].join("\n"),
      "Pi: using Pi's own config",
    );
    return false;
  }

  // CONFIGURE: provider FIRST. Pi's `--provider` defaults to google, so a key is
  // meaningless until we know which provider it's FOR — and the provider also
  // scopes the key prompt label and the model pickers. Query the model catalog
  // once here: it yields the models the routing wizard will filter (and marks
  // which providers are already keyed), so we don't shell out twice.
  let models = availability.pi ? await listPiModels(availability.pi) : [];
  const currentRouting = resolveRouting(
    getIn(await readConfigToml(config.configPath), [
      "harnesses",
      "pi",
      "routing",
    ]) as Record<string, unknown> | undefined,
  );
  const provider = await pickProvider(models, currentRouting.provider);
  if (provider === CANCELLED) return true;

  // Collect the API key, LABELLED by the chosen provider so it's unambiguous
  // what to paste ("openrouter API key:" vs a bare "Pi API key:"). Blank =
  // leave whatever's already in ~/.env (or nothing) — we never force a key,
  // because the local-store fallback covers the absent case.
  const keyLabel = provider ? `${provider} API key` : "Pi API key";
  const apiKey = await p.password({
    message: `${keyLabel} (passed per-turn; blank to keep current / use Pi's own)`,
  });
  if (p.isCancel(apiKey)) return true;
  // Blank means "keep current" ONLY when the provider is unchanged. The api-key
  // is provider-scoped (threaded onto `--api-key` alongside `--provider`), so a
  // blank key after a provider switch/clear must DROP the stale key — otherwise
  // the old provider's key is fired at the new `--provider` and auth fails. The
  // decision is a pure, tested function; here we just enact it.
  const keyWrite = resolvePiApiKeyWrite(apiKey, provider, currentRouting.provider);
  if (keyWrite.action === "set") {
    await updateEnvFile(userEnvPath(), { [ENV_PI_API_KEY]: keyWrite.value });
    p.note(`saved ${ENV_PI_API_KEY} to ${userEnvPath()}`, "Pi API key");
    // Refresh the catalog with the key we just took. On a fresh install the
    // first listing was EMPTY (Pi had no key, so `--list-models` printed "No
    // models available"), which is what forced the model pickers into free-text.
    // Now that we hold a key we can populate them — but only by injecting the
    // provider's NATIVE env var: `--list-models` ignores `--api-key` and reads
    // auth from its own store / native vars only (see PiProvider.envVar). No
    // known var (or still empty ⇒ bad key, provider outage) leaves `models` as
    // it was, and the pickers degrade to free-text rather than dead-ending.
    const envVar = provider ? providerEnvVar(provider) : undefined;
    if (availability.pi && envVar) {
      const refreshed = await listPiModels(availability.pi, undefined, {
        [envVar]: keyWrite.value,
      });
      if (refreshed.length > 0) models = refreshed;
    }
  } else if (keyWrite.action === "clear") {
    await updateEnvFile(userEnvPath(), { [ENV_PI_API_KEY]: "" });
    p.note(
      `provider changed and no new key entered — cleared the stale ${ENV_PI_API_KEY} ` +
        `so Pi falls back to its own local store`,
      "Pi API key",
    );
  }

  // Straight into custom routing — Pi is already the chosen harness, so we don't
  // re-ask "use defaults?"; we go collect primary / image / coding models, all
  // filtered to the chosen provider. Reuse the catalog we already fetched.
  // Pass the picker's answer through VERBATIM — including "" for "(none)". The
  // "" is the explicit "clear the provider" sentinel; collapsing it to undefined
  // here (the old `provider || undefined`) made runRoutingWizard fall back to the
  // existing provider, so "(none)" could never clear a previously-set one.
  return runRoutingWizard(config, availability.pi, {
    forceCustom: true,
    provider,
    models,
  });
}

/**
 * Capability-routing wizard step (interactive). Returns `true` if the user
 * cancelled (so the caller can abort the whole command), `false` otherwise —
 * including the "keep configured defaults" path, which is a successful no-op.
 *
 * The TUI itself is verified manually (matching this file's other prompts and
 * the create-persona convention). The branching/auto-skip LOGIC lives in pure,
 * unit-tested functions: `computeRoutingWrites` (multimodal auto-skip) and
 * `primaryIsMultimodal` (capability detection). This keeps the untested
 * surface to thin @clack glue.
 *
 * `piBin` is the resolved pi path from availability (or undefined if pi isn't
 * installed); we still let the operator configure routing in that case via
 * free-text entry so a config can be staged ahead of installing pi.
 */
async function runRoutingWizard(
  config: Config,
  piBin: string | undefined,
  opts: {
    forceCustom?: boolean;
    /**
     * Provider chosen by configurePi; scopes the model pickers + is persisted.
     * `""` means the operator explicitly chose "(none)" (clear the provider);
     * `undefined` means the step was skipped, so keep the current provider.
     */
    provider?: string;
    /** Pre-fetched `pi --list-models` catalog (avoids a second shell-out). */
    models?: readonly PiModel[];
  } = {},
): Promise<boolean> {
  const toml = await readConfigToml(config.configPath);
  const current = resolveRouting(
    getIn(toml, ["harnesses", "pi", "routing"]) as
      | Record<string, unknown>
      | undefined,
  );

  // `forceCustom` (the "configure now" path) goes straight into per-capability
  // model selection — Pi is already the chosen harness, so the "use defaults?"
  // detour would be redundant. Otherwise we offer it as before.
  if (!opts.forceCustom) {
    const useDefaults = await p.confirm({
      message: "Model: use configured defaults?",
      // Default = no override when nothing is configured yet, otherwise keep the
      // existing routing. Either way the safe answer leaves things as they are.
      initialValue: current.primaryModel === undefined,
    });
    if (p.isCancel(useDefaults)) return true;
    if (useDefaults) {
      p.note(
        current.primaryModel
          ? `keeping: primary=${current.primaryModel}` +
              (current.imageModel ? ` image=${current.imageModel}` : "") +
              (current.codingModel ? ` coding=${current.codingModel}` : "")
          : "no per-capability routing — Pi uses its configured default model",
        "Routing",
      );
      return false;
    }
  }

  // Custom routing: use the catalog configurePi already fetched, else query pi
  // now so the picker only shows models that are actually available. Falls back
  // to free-text if pi can't be queried (not installed, or output unparseable).
  const allModels = opts.models ?? (piBin ? await listPiModels(piBin) : []);
  if (allModels.length === 0) {
    p.note(
      "Couldn't read `pi --list-models` — entering model ids by hand.\n" +
        "Use the bare name as printed by `pi --list-models` (e.g. gpt-5.2).",
      "Routing",
    );
  }
  // Scope every model picker to the chosen provider: a single per-turn
  // `--provider` is only correct if primary + image + coding all come from that
  // one provider. With no provider (or no catalog) we show everything.
  // "" (explicit "(none)") clears; undefined (step skipped) keeps current.
  const provider = resolveRoutingProvider(opts.provider, current.provider);
  const models = provider
    ? allModels.filter((m) => m.provider === provider)
    : allModels;

  // Primary is OPTIONAL: "(none)" leaves Pi on its own default model (the
  // "default install" path) with no override.
  const primaryModel = await pickModel(
    "Primary model (orchestrator) — (none) keeps Pi's default",
    models,
    current.primaryModel,
    { allowNone: true },
  );
  if (primaryModel === CANCELLED) return true;

  const multimodal = primaryIsMultimodal(models, primaryModel);

  // Image model is ALWAYS offered now (no auto-skip). When the primary is itself
  // vision-capable we pre-select the primary as the default image model — that's
  // the "always have an image model" rule: a text-only coding model swapped in
  // for a code turn always has a look_at_image delegate to call. It's still
  // OPTIONAL: "(none)" omits it (a vision primary just sees images itself). When
  // multimodal, offer the full model list (so the primary is selectable);
  // otherwise restrict to vision-capable models.
  const imageInitial =
    current.imageModel ?? (multimodal && primaryModel ? primaryModel : undefined);
  const imageModelPick = await pickModel(
    "Image model (vision delegate for look_at_image)",
    multimodal ? models : models.filter((m) => m.supportsImages),
    imageInitial,
    { allowNone: true },
  );
  if (imageModelPick === CANCELLED) return true;
  const imageModel = imageModelPick || undefined;

  // Coding model is OPTIONAL: "(none)" means no coding-brain swap.
  const codingModel = await pickModel(
    "Coding model (coding-brain swap)",
    models,
    current.codingModel,
    { allowNone: true },
  );
  if (codingModel === CANCELLED) return true;

  const choices: RoutingChoices = {
    provider,
    primaryModel,
    imageModel,
    codingModel,
  };
  const writes = await applyRouting(config.configPath, choices);
  p.note(
    [
      `provider: ${writes.toml.provider ?? "(none — Pi's default)"}`,
      `primary: ${writes.toml.primary_model}`,
      `image:   ${writes.toml.image_model ?? "(none — primary is multimodal)"}`,
      `coding:  ${writes.toml.coding_model ?? "(none)"}`,
      "",
      `saved to ${config.configPath} and ${userEnvPath()}`,
    ].join("\n"),
    "Capability routing",
  );
  return false;
}

const CANCELLED = Symbol("cancelled");

/**
 * Provider picker. The provider is asked BEFORE the API key (Pi's `--provider`
 * defaults to google, so the key is meaningless without it) and BEFORE the model
 * pickers (it scopes them). "(none)" leaves Pi on its own default provider.
 * Returns the chosen provider id ("" = none), or CANCELLED on abort.
 *
 * Options come from `providerChoices`: Pi's STATIC provider catalogue unioned
 * with whatever `pi --list-models` reported. It used to derive the list from
 * `--list-models` ALONE, which meant a fresh install — where Pi holds no key and
 * lists nothing — got an empty picker and fell through to free-text. That's
 * backwards: the operator is in this wizard precisely to add their first key, so
 * the full catalogue must be offered regardless of what's already keyed. The
 * free-text fallback now only triggers in the true degenerate case (no catalogue
 * at all), which shouldn't happen since the catalogue is a constant.
 */
async function pickProvider(
  models: readonly PiModel[],
  initial: string | undefined,
): Promise<string | typeof CANCELLED> {
  const providers = providerChoices(models);
  if (providers.length === 0) {
    const r = await p.text({
      message: "Pi provider (e.g. openrouter, openai) — blank = Pi's default",
      placeholder: "openrouter",
      initialValue: initial ?? "",
    });
    if (p.isCancel(r)) return CANCELLED;
    return r.trim();
  }
  const NONE = "";
  const options = [
    { value: NONE, label: "(none)", hint: "Pi's default provider (google)" },
    ...providers.map((pr) => ({
      value: pr.id,
      label: pr.label,
      // Surface which providers Pi can already serve models for, so a keyed box
      // still reads at a glance now that the list is the full catalogue.
      hint: pr.hasModels ? `${pr.id} — key already configured` : pr.id,
    })),
  ];
  const known = initial !== undefined && providers.some((pr) => pr.id === initial);
  const r = await p.select<string>({
    message: "Provider (scopes the API key + model list)",
    options,
    initialValue: known ? initial : NONE,
  });
  if (p.isCancel(r)) return CANCELLED;
  return r;
}

/**
 * Single model picker. Shows a select of available models when we have the
 * list, otherwise a free-text prompt. Returns the chosen bare model id, or the
 * CANCELLED sentinel if the user aborted.
 */
async function pickModel(
  message: string,
  models: readonly PiModel[],
  initial: string | undefined,
  opts: { allowNone?: boolean } = {},
): Promise<string | typeof CANCELLED> {
  if (models.length === 0) {
    const r = await p.text({
      message: opts.allowNone ? `${message} (blank = none)` : message,
      placeholder: "e.g. gpt-5.2",
      initialValue: initial ?? "",
    });
    if (p.isCancel(r)) return CANCELLED;
    return r.trim();
  }
  // When optional, prepend a "(none)" sentinel (value "") so the operator can
  // omit this capability. computeRoutingWrites treats "" / undefined as unset.
  const NONE = "";
  const options = [
    ...(opts.allowNone
      ? [{ value: NONE, label: "(none)", hint: "no override" }]
      : []),
    ...models.map((m) => ({
      value: modelId(m),
      label: `${m.provider}/${m.model}`,
      hint: m.supportsImages ? "vision" : undefined,
    })),
  ];
  const known = initial && models.some((m) => modelId(m) === initial);
  const r = await p.select<string>({
    message,
    options,
    initialValue: known
      ? initial
      : opts.allowNone
        ? NONE
        : modelId(models[0]!),
  });
  if (p.isCancel(r)) return CANCELLED;
  return r;
}

/**
 * A confirm prompt: returns true to proceed, false to skip. Default
 * wraps `@clack/prompts` confirm; tests inject a stub so they can drive
 * `maybePromptRestart` end-to-end without a real TTY.
 */
export type ConfirmFn = (message: string) => Promise<boolean>;

const defaultConfirm: ConfirmFn = async (message) => {
  const r = await p.confirm({ message, initialValue: true });
  return !p.isCancel(r) && r === true;
};

/**
 * Shared post-apply hook for the config-mutating TUIs.
 *
 * Two steps. Always: re-render the on-disk service-manager unit if it's
 * stale (a pre-Phase-29 systemd unit lacks `EnvironmentFile=` and
 * silently swallows the .env secrets the TUI just wrote; the launchd
 * plist has analogous templating). Then: if phantombot is running, offer
 * to restart it inline so the change takes effect.
 *
 * `confirm` is parameterized so tests can drive the full ordering
 * (rerender → confirm → restart) without going through @clack's
 * non-TTY-friendly prompt.
 */
export async function maybePromptRestart(
  svc: ServiceControl,
  confirm: ConfirmFn = defaultConfirm,
): Promise<void> {
  await maybeUpgradeUnit(svc);
  if (!(await svc.isActive())) return;
  const proceed = await confirm(
    "phantombot is currently running. Restart to apply changes?",
  );
  if (!proceed) {
    p.note(
      `skipped — restart later with: ${await restartCommand()}`,
      "Restart",
    );
    return;
  }
  const r = await svc.restart();
  p.note(
    r.ok ? "restarted" : `restart failed: ${r.stderr ?? "unknown"}`,
    "Restart",
  );
}

/**
 * Re-render the installed service-manager unit if it's stale; print a
 * one-line notice when it happened (and surface the backup path so a
 * hand-edit is recoverable). Exposed so tests can verify the rewrite
 * path without going through the @clack confirm prompt in
 * maybePromptRestart.
 */
export async function maybeUpgradeUnit(
  svc: ServiceControl,
): Promise<{ rerendered: boolean; backupPath?: string }> {
  const r = await svc.rerenderUnitIfStale();
  if (r.rerendered) {
    const note = r.backupPath
      ? `service-manager unit upgraded to current template\nprevious contents saved to ${r.backupPath}`
      : "service-manager unit upgraded to current template";
    p.note(note, "Unit");
  }
  return r;
}

export default defineCommand({
  meta: {
    name: "harness",
    description: "Set the harness chain (primary → fallback). Detects which binaries are on PATH.",
  },
  async run() {
    const code = await runHarness();
    process.exitCode = code;
  },
});
