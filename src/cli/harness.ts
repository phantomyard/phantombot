/**
 * `phantombot harness` — interactive TUI to set the harness chain
 * (primary → fallback). Detects which binaries are on PATH and warns
 * about the ones that aren't.
 */

import { defineCommand } from "citty";
import * as p from "@clack/prompts";
import { clackPrompts, type HarnessPrompts } from "./harnessPrompts.ts";

import { type Config, loadConfig } from "../config.ts";
import {
  getIn,
  readConfigToml,
  setIn,
  type TomlObject,
  updateConfigToml,
} from "../lib/configWriter.ts";
import { type PersonaWriteScope } from "../lib/personaConfig.ts";
import {
  harnessBin,
  resolveHarnessAvailability,
} from "../lib/harnessAvailability.ts";
import {
  defaultServiceControl,
  restartCommand,
  type ServiceControl,
} from "../lib/platform.ts";
import {
  listPiModels,
  modelId,
  modelsForProvider,
  type PiModel,
  primaryIsMultimodal,
  providerChoices,
  providerEnvVar,
} from "../lib/piModels.ts";
import {
  computeRoutingClears,
  ROUTING_LOCAL_CONFIG_KEY,
  computeRoutingWrites,
  ENV_PI_API_KEY,
  resolvePiApiKeyWrite,
  resolveRoutingProvider,
  type RoutingChoices,
} from "../lib/piRouting.ts";
import { setPersonaSecret, unsetPersonaSecret } from "../lib/vaultSecrets.ts";
import { writePiApiKey } from "../lib/piAuthStore.ts";
import { saveHarnessBins } from "../state.ts";
import { EMBEDDED_PI_VERSION, embeddedPiCommand } from "../lib/embeddedPi.ts";
import { harnessChainIds, piInstanceSecretName } from "../harnesses/buildChain.ts";

export { whichBinary } from "../lib/harnessAvailability.ts";
// The harness write resolver lives in lib/ so non-TUI writers (/model) share
// exactly one definition with the wizard; re-exported here for callers and
// tests that have always found it on this module.
export {
  resolveHarnessWriteTarget,
  suffixEnvKeys,
  type HarnessWriteTarget,
} from "../lib/harnessWriteTarget.ts";
import {
  resolveHarnessWriteTarget,
  type HarnessWriteTarget,
} from "../lib/harnessWriteTarget.ts";

export type HarnessId = "native" | "claude" | "codex" | "pi-host";
// native is listed FIRST so it is the default primary: it is the pi engine
// compiled into this binary, so it is the one brain every host can run — it
// only needs a provider key. The host harnesses follow and are OFFERED only
// when installed (offeredHarnesses). Nothing is ever installed from here.
export const SUPPORTED_HARNESSES: ReadonlyArray<HarnessId> = [
  "native",
  "claude",
  "codex",
  "pi-host",
];

/** Native is always offered (built in); host harnesses only when detected. */
export function offeredHarnesses(
  availability: Record<HarnessId, string | undefined>,
): HarnessId[] {
  return SUPPORTED_HARNESSES.filter((id) => id === "native" || !!availability[id]);
}

/**
 * Map a stored chain id to the menu entry it came from, or undefined when that
 * entry is not offered on this host. The named instances a native → native
 * chain writes (`pi-primary` / `pi-fallback`) pick "native".
 */
export function pickableId(
  id: string | undefined,
  offered: readonly HarnessId[],
): HarnessId | undefined {
  if (id === undefined) return undefined;
  const mapped = id === "pi-primary" || id === "pi-fallback" ? "native" : id;
  return (offered as readonly string[]).includes(mapped)
    ? (mapped as HarnessId)
    : undefined;
}

/**
 * The `state.json harness_bins` shape for a detection result. native is never
 * persisted — its "binary" is this executable, which moves on every update —
 * and pi-host persists under the `pi` key that loadConfig reads.
 */
export function availabilityStateBins(
  availability: Record<HarnessId, string | undefined>,
): Record<string, string | undefined> {
  return {
    claude: availability.claude,
    codex: availability.codex,
    pi: availability["pi-host"],
  };
}

/** The "Detected harnesses" note body. */
export function formatDetectedHarnesses(
  config: Config,
  availability: Record<HarnessId, string | undefined>,
): string {
  return SUPPORTED_HARNESSES.map((id) =>
    id === "native"
      ? `  [built in]  native: pi ${EMBEDDED_PI_VERSION} engine inside phantombot`
      : `  ${availability[id] ? "[ok]       " : "[not found]"} ${id}: ${availability[id] ?? harnessBin(config, id)}`,
  ).join("\n");
}

export const NO_HOST_HARNESS_NOTE =
  "No host harness (claude, codex, pi) was found on your PATH — that's fine.\n" +
  "The built-in native harness needs nothing installed; it only needs a provider API key.";

/**
 * What the wizard and `init` show as "installed".
 *
 * Delegates to `resolveHarnessAvailability` (issue #450) instead of calling
 * `whichBinary()` on the configured bin. The bare `which` skipped BOTH safety
 * nets `doctor`/`run` have had since #150: the `harnessSearchPath()` sweep
 * (`%APPDATA%\npm`, `~/.bun/bin`, nvm/fnm node dirs — where the harness CLIs
 * actually land on Windows) and the absolute-bin -> bare-name retry. The result
 * was a box where `phantombot doctor` resolved claude fine and `phantombot
 * harness` reported NOT FOUND on the same config. The wizard must never be a
 * weaker detector than the daemon it is configuring.
 */
export async function detectAvailability(
  config: Config,
  pathEnv = process.env.PATH ?? "",
): Promise<Record<HarnessId, string | undefined>> {
  const ids: HarnessId[] = [...SUPPORTED_HARNESSES];
  const entries = await Promise.all(
    ids.map(
      async (id) =>
        [id, (await resolveHarnessAvailability(config, id, pathEnv))?.resolved] as const,
    ),
  );
  return Object.fromEntries(entries) as Record<HarnessId, string | undefined>;
}

export async function applyHarnessChain(
  configPath: string,
  chain: readonly string[],
  persona?: string,
  scope: PersonaWriteScope = "global",
): Promise<void> {
  // Same rule as the Telegram writer (phantombot#439): in "persona" scope
  // `configPath` IS that persona's own config.toml, where its chain is the
  // plain `[harnesses].chain` — and where the reader looks first. Writing the
  // legacy `[harnesses.personas.<name>]` table into a persona file would be
  // read as "this persona's override for a persona of the same name", which
  // `loadConfig` deliberately drops.
  await updateConfigToml(configPath, (toml) => {
    setIn(
      toml,
      persona && scope === "global"
        ? ["harnesses", "personas", persona, "chain"]
        : ["harnesses", "chain"],
      [...chain],
    );
  });
}

/**
 * Persist the capability-routing choices: write the `[harnesses.pi.routing]`
 * sub-table to config.toml. The image model is whatever the wizard collected
 * (it pre-selects the primary as the default image model when the primary is
 * vision-capable). Returns the computed writes so callers/tests can assert.
 *
 * Since #452 config.toml is the ONLY store for these non-secret settings; the
 * old `PHANTOMBOT_*_MODEL` mirror into `~/.env` is gone, because nothing reads
 * that file at runtime and a mirror nothing reads is just a second source of
 * truth to drift. `computeRoutingWrites().env` is still returned so callers can
 * see the effective values (the pi harness projects them per-turn).
 */
export async function applyRouting(
  configPath: string,
  choices: RoutingChoices,
  instanceId?: string,
): Promise<ReturnType<typeof computeRoutingWrites>> {
  const writes = computeRoutingWrites(choices);
  await updateConfigToml(configPath, (toml) => {
    const base = instanceId
      ? ["harnesses", "instances", instanceId, "routing"]
      : ["harnesses", "pi", "routing"];
    if (instanceId) setIn(toml, ["harnesses", "instances", instanceId, "type"], "native");
    setIn(toml, [...base, "primary_model"], writes.toml.primary_model);
    // Provider: drop the key when none was chosen so a switch back to Pi's
    // default clears a stale provider (mirrors the env "" = unset semantics).
    setRoutingKey(toml, "provider", writes.toml.provider, base);
    // Mirror the env "" = unset semantics into TOML: drop the key when there's
    // no image/coding model so a multimodal switch clears a stale entry.
    setRoutingKey(toml, "image_model", writes.toml.image_model, base);
    setRoutingKey(toml, "coding_model", writes.toml.coding_model, base);
    // Configuring models REVOKES a previous "use Pi's own config" opt-out in
    // the same write. Left behind, the tombstone would win over the models the
    // operator just picked (resolveRouting short-circuits on it) and the wizard
    // would report success while changing nothing.
    setRoutingKey(toml, ROUTING_LOCAL_CONFIG_KEY, undefined, base);
  });
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
 * shape.
 */
export async function clearPiRouting(
  configPath: string,
  opts: { tombstone?: boolean } = {},
  instanceId?: string,
): Promise<ReturnType<typeof computeRoutingClears>> {
  const clears = computeRoutingClears();
  await updateConfigToml(configPath, (toml) => {
    const base = instanceId
      ? ["harnesses", "instances", instanceId, "routing"]
      : ["harnesses", "pi", "routing"];
    if (instanceId) setIn(toml, ["harnesses", "instances", instanceId, "type"], "native");
    if (opts.tombstone) {
      // PERSONA scope: deleting the keys is not clearing them. A key this
      // persona no longer states falls back to the host's
      // `[harnesses.pi.routing]` under the per-key merge, and to the host's
      // unsuffixed ambient env — so a deleted persona routing silently becomes
      // the HOST routing. State the opt-out explicitly instead
      // (ROUTING_LOCAL_CONFIG_KEY), which resolveRouting honours over both.
      setIn(toml, [...base, ROUTING_LOCAL_CONFIG_KEY], true);
    }
    const routing = getIn(toml, base) as
      | Record<string, unknown>
      | undefined;
    if (!routing) return;
    for (const key of clears.tomlKeys) delete routing[key];
  });
  return clears;
}

/**
 * The routing sub-table for a harness slot, exactly as it sits in config.toml.
 *
 * Snapshot/restore exists because the brain wizard writes routing DURING the
 * interview (each model slot is persisted as it is answered) but only asks
 * "apply?" AFTER the test. Without a rollback, declining to apply — or a
 * failed test — left the new provider/models committed while the wizard
 * reported the brain unchanged (PR #539 review). The whole table is captured
 * verbatim rather than key-by-key so the "use Pi's own config" tombstone
 * round-trips too.
 */
export async function snapshotPiRouting(
  configPath: string,
  instanceId?: string,
): Promise<Record<string, unknown> | undefined> {
  const toml = await readConfigToml(configPath);
  const base = instanceId
    ? ["harnesses", "instances", instanceId, "routing"]
    : ["harnesses", "pi", "routing"];
  const routing = getIn(toml, base);
  if (!routing || typeof routing !== "object" || Array.isArray(routing)) {
    return undefined;
  }
  return { ...(routing as Record<string, unknown>) };
}

/**
 * Put a `snapshotPiRouting` result back. `undefined` means "there was no
 * routing table here" — the key is deleted, not emptied, because an empty
 * table is itself a meaningful state (all overrides explicitly cleared).
 */
export async function restorePiRouting(
  configPath: string,
  snapshot: Record<string, unknown> | undefined,
  instanceId?: string,
): Promise<void> {
  const base = instanceId
    ? ["harnesses", "instances", instanceId, "routing"]
    : ["harnesses", "pi", "routing"];
  await updateConfigToml(configPath, (toml) => {
    if (snapshot === undefined) {
      const parent = getIn(toml, base.slice(0, -1));
      if (parent && typeof parent === "object" && !Array.isArray(parent)) {
        delete (parent as TomlObject)[base[base.length - 1]!];
      }
      return;
    }
    setIn(toml, base, { ...snapshot });
  });
}

function setRoutingKey(
  toml: TomlObject,
  key: string,
  value: string | boolean | undefined,
  base: string[] = ["harnesses", "pi", "routing"],
): void {
  const routing = getIn(toml, base) as
    | Record<string, unknown>
    | undefined;
  if (value === undefined) {
    if (routing && key in routing) delete routing[key];
    return;
  }
  setIn(toml, [...base, key], value);
}

export interface RunHarnessCheckInput {
  config?: Config;
  prompts?: HarnessPrompts;
  dryRun?: boolean;
  availability?: Record<HarnessId, string | undefined>;
  pathEnv?: string;
}

/**
 * Harness detection probe used during installation. Shows what is installed —
 * and installs nothing. The native harness is built in, so a host with no
 * harness CLI at all still has a brain; the old "Install Pi now?" offer is gone.
 */
export async function runHarnessCheck(
  input: RunHarnessCheckInput = {},
): Promise<number> {
  const config = input.config ?? (await loadConfig());
  const availability =
    input.availability ?? (await detectAvailability(config, input.pathEnv));
  await saveHarnessBins(availabilityStateBins(availability));
  const hasHostHarness = offeredHarnesses(availability).length > 1;
  const summary = formatDetectedHarnesses(config, availability);

  if (input.prompts || !process.stdin.isTTY) {
    const q = input.prompts ?? clackPrompts;
    q.note(summary, "Detected harnesses");
    if (!hasHostHarness) q.note(NO_HOST_HARNESS_NOTE, "Native harness");
    const proceed = await (q.confirm ?? p.confirm)({
      message: "Continue to phantombot TUI?",
      initialValue: true,
    });
    return proceed === true ? 0 : 1;
  }

  const { runStandaloneFlow } = await import("../tui/standalone.tsx");
  return await runStandaloneFlow(async (q) => {
    const proceed = await q.choose({
      title: "Continue to phantombot TUI?",
      description: hasHostHarness ? summary : `${summary}\n\n${NO_HOST_HARNESS_NOTE}`,
      options: [
        { value: "yes", label: "Yes, continue into phantombot TUI" },
        { value: "no", label: "No, exit back to terminal" },
      ],
    });
    return proceed === "yes" ? 0 : 1;
  }, ["phantombot", "harness-check"]);
}

export interface RunInput {
  /** Write a persona override. Omit to configure the global fallback chain. */
  persona?: string;
  config?: Config;
  serviceControl?: ServiceControl;
  /**
   * Optional pre-computed availability map. If provided, skips the PATH
   * sweep — useful when the caller (e.g. `init`) has already detected
   * availability and we don't want to re-walk PATH for every harness.
   */
  availability?: Record<HarnessId, string | undefined>;
  /**
   * Who asks the questions. Default: @clack, i.e. the CLI as it always was.
   * The TUI passes an implementation backed by its own screens so the whole
   * flow runs inside the app — same writes, same order, no terminal hand-over.
   */
  prompts?: HarnessPrompts;
  /**
   * TEST SEAM: the argv that lists the native engine's models. Production
   * always uses embeddedPiCommand(); tests point it at a missing binary so the
   * wizard never spawns a real engine.
   */
  piCommand?: readonly string[];
}

export async function runHarness(input: RunInput = {}): Promise<number> {
  const persona = input.persona?.trim() || undefined;
  const config = input.config ?? (await loadConfig(persona));

  if (!input.prompts && process.stdin.isTTY) {
    const { runStandaloneFlow } = await import("../tui/standalone.tsx");
    const { createBrainOnboardingDeps, runBrainOnboarding } = await import(
      "../tui/brainOnboarding.ts"
    );
    const { loadState } = await import("../state.ts");
    const targetPersona =
      persona ??
      (await loadState()).default_persona ??
      config.defaultPersona ??
      "phantom";

    return await runStandaloneFlow(async (standaloneQ) => {
      const deps = await createBrainOnboardingDeps(targetPersona, {
        setNotice: (msg) => standaloneQ.note("", msg),
        askConfirmValue: (req) => standaloneQ.confirm(req),
      });
      const result = await runBrainOnboarding(standaloneQ, deps);
      return result.notice;
    }, ["phantombot", targetPersona, "brain"]);
  }

  // Injected asking (see harnessPrompts.ts): the CLI passes nothing and gets
  // @clack; the TUI passes screens and the SAME flow runs inside the app.
  const q = input.prompts ?? clackPrompts;
  const currentChain = harnessChainIds(config, persona);
  // Write where the read path looks: the persona's own file once it exists,
  // the global file (legacy shape) until then.
  const target = await resolveHarnessWriteTarget(config, persona);
  const availability = input.availability ?? (await detectAvailability(config));
  await saveHarnessBins(availabilityStateBins(availability));
  const svc = input.serviceControl ?? defaultServiceControl();

  q.intro("Configure the harness chain");

  q.note(formatDetectedHarnesses(config, availability), "Detected harnesses");
  // Detected live: a host harness that is not installed is not offered at all.
  const offered = offeredHarnesses(availability);
  if (offered.length === 1) q.note(NO_HOST_HARNESS_NOTE, "Native harness");

  const hints: Record<HarnessId, string> = {
    native: "built in — configure provider and model swap settings here",
    claude: "uses this host's claude configuration",
    codex: "uses this host's codex configuration",
    "pi-host": "uses this host's own pi configuration",
  };

  const primary = await q.select<HarnessId>({
    message: "Primary harness",
    options: offered.map((id) => ({ value: id, label: id, hint: hints[id] })),
    // native is the default; an existing (still-offered) choice wins.
    initialValue: pickableId(currentChain[0], offered) ?? offered[0]!,
  });
  if (primary === undefined) {
    q.cancel("cancelled");
    return 1;
  }

  const fallbackOptions: Array<{
    value: HarnessId | "none";
    label: string;
    hint?: string;
  }> = [
    { value: "none", label: "(none)", hint: "no fallback if primary fails" },
    // native may back itself up: each occurrence is an independent instance.
    ...offered.filter((id) => id !== primary || id === "native").map((id) => ({
      value: id,
      label: id,
      hint: hints[id],
    })),
  ];

  const fallbackPick = await q.select<HarnessId | "none">({
    message: "Fallback harness",
    options: fallbackOptions,
    initialValue: pickableId(currentChain[1], offered) ?? "none",
  });
  if (fallbackPick === undefined) {
    q.cancel("cancelled");
    return 1;
  }

  const bothNative = primary === "native" && fallbackPick === "native";
  if (primary === "native") {
    const cancelled = await configureNative(
      config, "primary", target, q,
      bothNative ? "pi-primary" : undefined,
      input.piCommand,
    );
    if (cancelled) {
      q.cancel("cancelled");
      return 1;
    }
  }

  if (fallbackPick === "native") {
    const cancelled = await configureNative(
      config, "fallback", target, q,
      bothNative ? "pi-fallback" : undefined,
      input.piCommand,
    );
    if (cancelled) {
      q.cancel("cancelled");
      return 1;
    }
  }

  const chain: string[] = bothNative ? ["pi-primary", "pi-fallback"] : [primary];
  if (!bothNative && fallbackPick !== "none") chain.push(fallbackPick);

  await applyHarnessChain(target.path, chain, persona, target.scope);
  q.note(
    `harness chain${persona ? ` for '${persona}'` : ""}: ${chain.join(" → ")}\nsaved to ${target.path}`,
    "Saved",
  );

  await maybePromptRestart(
    svc,
    async (message) => (await q.confirm({ message, initialValue: true })) === true,
    q,
  );

  q.outro("done");
  return 0;
}

/**
 * Configure the native harness for the slot it occupies (primary OR fallback):
 * provider → API key (persona vault, plus pi's own auth store so the model
 * listing sees it, #312) → primary / image / coding models.
 *
 * There is no "whose config?" question and no install step any more. native
 * is phantombot-configured by definition and runs the engine built into this
 * binary; the host's own pi is the separate `pi-host` harness, configured by
 * its owner exactly like claude and codex.
 *
 * Returns `true` only when the operator cancelled outright (Esc).
 */
async function configureNative(
  config: Config,
  role: "primary" | "fallback",
  target: HarnessWriteTarget,
  q: HarnessPrompts = clackPrompts,
  instanceId?: string,
  piCommand: readonly string[] = embeddedPiCommand(),
): Promise<boolean> {
  q.note(`configuring the ${role} brain: provider, API key and models`, "Native harness");

  // CONFIGURE: provider FIRST. Pi's `--provider` defaults to google, so a key is
  // meaningless until we know which provider it's FOR — and the provider also
  // scopes the key prompt label and the model pickers. Query the model catalog
  // once here: it yields the models the routing wizard will filter (and marks
  // which providers are already keyed), so we don't shell out twice.
  let models = await listPiModels(piCommand);
  // Read the EFFECTIVE routing for the persona being configured, not the raw
  // global file: with a persona layer the file on disk is only half the answer
  // (its own config.toml wins per key), and pre-selecting the host's models for
  // a persona that overrode them is how an operator silently resets them.
  const currentRouting = instanceId
    ? (config.harnesses.instances?.[instanceId]?.routing ?? {})
    : (config.harnesses.pi.routing ?? {});
  const provider = await pickProvider(models, currentRouting.provider, q);
  if (provider === CANCELLED) return true;

  // Collect the API key, LABELLED by the chosen provider so it's unambiguous
  // what to paste ("openrouter API key:" vs a bare "Pi API key:"). Blank =
  // leave whatever's already in ~/.env (or nothing) — we never force a key,
  // because the local-store fallback covers the absent case.
  const keyLabel = provider ? `${provider} API key` : "Pi API key";
  const apiKey = await q.password({
    message: `${keyLabel} (passed per-turn; blank to keep current / use Pi's own)`,
  });
  if (apiKey === undefined) return true;
  // Blank means "keep current" ONLY when the provider is unchanged. The api-key
  // is provider-scoped (threaded onto `--api-key` alongside `--provider`), so a
  // blank key after a provider switch/clear must DROP the stale key — otherwise
  // the old provider's key is fired at the new `--provider` and auth fails. The
  // decision is a pure, tested function; here we just enact it.
  const keyWrite = resolvePiApiKeyWrite(apiKey, provider, currentRouting.provider);
  const apiKeyName = instanceId ? piInstanceSecretName(instanceId) : ENV_PI_API_KEY;
  if (keyWrite.action === "set") {
    const stored = await setPersonaSecret(
      config,
      apiKeyName,
      keyWrite.value,
      target.persona,
    );
    if (!stored.ok) {
      q.note(
        `could not save ${apiKeyName} to the ${stored.persona} vault: ${stored.error}\n` +
          "Pi will fall back to its own local store until this is fixed.",
        "Pi API key",
      );
    } else {
      q.note(`saved ${apiKeyName} to the ${stored.persona} vault`, "Pi API key");
    }
    // Refresh the catalog with the key we just took. On a fresh install the
    // first listing was EMPTY (Pi had no key, so `--list-models` printed "No
    // models available"), which is what forced the model pickers into free-text.
    //
    // PRIMARY path (#312): merge-write the key into Pi's OWN auth store
    // (~/.pi/agent/auth.json). `--list-models` reads auth from that file and
    // the native env vars only — once the key is in the store a plain listing
    // is populated, no env tricks needed. This is what keying Pi interactively
    // does, and it fixed the macOS fresh-onboarding repro where the
    // env-injected child never saw the var.
    //
    // FALLBACK: if the write is skipped (an oauth login already keys this
    // provider — the listing is populated anyway) or fails (unparseable
    // user-owned file we refuse to clobber), keep the pre-#312 behavior:
    // inject the provider's NATIVE env var into the `--list-models` child (see
    // PiProvider.envVar). No known var (or still empty ⇒ bad key, provider
    // outage) leaves `models` as it was, and the pickers degrade to free-text
    // rather than dead-ending.
    let refreshed: PiModel[] = [];
    if (provider) {
      const authWrite = await writePiApiKey(provider, keyWrite.value);
      if (authWrite.ok && !authWrite.skipped) {
        q.note(
          `also keyed Pi's own store (${authWrite.path}) so \`pi --list-models\` works`,
          "Pi API key",
        );
      } else if (!authWrite.ok) {
        q.note(
          `couldn't write Pi's auth store: ${authWrite.reason}\n` +
            `falling back to an env-injected model refresh`,
          "Pi API key",
        );
      }
      // Plain listing first whenever the store keys this provider — either we
      // just wrote the key, or an oauth login already did (skipped ⇒ the
      // provider is keyed, so a plain listing is populated).
      if (authWrite.ok) {
        refreshed = await listPiModels(piCommand);
      }
    }
    if (refreshed.length === 0) {
      const envVar = provider ? providerEnvVar(provider) : undefined;
      if (envVar) {
        refreshed = await listPiModels(piCommand, undefined, {
          [envVar]: keyWrite.value,
        });
      }
    }
    if (refreshed.length > 0) models = refreshed;
  } else if (keyWrite.action === "clear") {
    await unsetPersonaSecret(
      config,
      apiKeyName,
      target.persona,
    );
    q.note(
      `provider changed and no new key entered — cleared the stale ${apiKeyName} ` +
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
  return runRoutingWizard(config, piCommand, q, {
    forceCustom: true,
    provider,
    models,
    target,
    instanceId,
    apiKey: keyWrite.action === "set" ? keyWrite.value : apiKey,
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
  piCommand: readonly string[] | undefined,
  q: HarnessPrompts = clackPrompts,
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
    /**
     * Where to persist (phantombot#441). Defaults to the global file + the
     * unsuffixed env vars, which is exactly the default persona's target, so
     * callers that configure the host itself need not pass one.
     */
    target?: HarnessWriteTarget;
    /** Named Pi instance when the chain contains Pi twice. */
    instanceId?: string;
    /**
     * The key just entered, used ONLY to ask the provider for its model list
     * when Pi's catalogue has nothing for it. Never persisted from here.
     */
    apiKey?: string;
  } = {},
): Promise<boolean> {
  const target: HarnessWriteTarget = opts.target ??
    { path: config.configPath, scope: "global" };
  const current = opts.instanceId
    ? (config.harnesses.instances?.[opts.instanceId]?.routing ?? {})
    : (config.harnesses.pi.routing ?? {});

  // `forceCustom` (the "configure now" path) goes straight into per-capability
  // model selection — Pi is already the chosen harness, so the "use defaults?"
  // detour would be redundant. Otherwise we offer it as before.
  if (!opts.forceCustom) {
    const useDefaults = await q.confirm({
      message: "Model: use configured defaults?",
      // Default = no override when nothing is configured yet, otherwise keep the
      // existing routing. Either way the safe answer leaves things as they are.
      initialValue: current.primaryModel === undefined,
    });
    if (useDefaults === undefined) return true;
    if (useDefaults) {
      q.note(
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
  const allModels = opts.models ?? (piCommand ? await listPiModels(piCommand) : []);
  if (allModels.length === 0) {
    q.note(
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
  let models = modelsForProvider(provider, allModels);
  // Same last resort as the TUI flow: when Pi lists nothing for this provider,
  // ask the provider's own models endpoint rather than making the user type a
  // model id from memory. Empty result ⇒ free-text, exactly as before.
  if (models.length === 0 && provider) {
    const { fetchProviderModels } = await import("../lib/providerModelCatalog.ts");
    const live = await fetchProviderModels(provider, opts.apiKey ?? "");
    if (live.length > 0) {
      models = live;
      q.note(
        `Pi listed no models for ${provider} — fetched ${live.length} from the provider's own API.`,
        "Routing",
      );
    }
  }

  // Primary is OPTIONAL: "(none)" leaves Pi on its own default model (the
  // "default install" path) with no override.
  const primaryModel = await pickModel(
    "Primary model (orchestrator) — (none) keeps Pi's default",
    models,
    current.primaryModel,
    { allowNone: true },
    q,
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
    q,
  );
  if (imageModelPick === CANCELLED) return true;
  const imageModel = imageModelPick || undefined;

  // Coding model is OPTIONAL: "(none)" means no coding-brain swap.
  const codingModel = await pickModel(
    "Coding model (coding-brain swap)",
    models,
    current.codingModel,
    { allowNone: true },
    q,
  );
  if (codingModel === CANCELLED) return true;

  const choices: RoutingChoices = {
    provider,
    primaryModel,
    imageModel,
    codingModel,
  };
  const writes = await applyRouting(target.path, choices, opts.instanceId);
  q.note(
    [
      `provider: ${writes.toml.provider ?? "(none — Pi's default)"}`,
      `primary: ${writes.toml.primary_model}`,
      `image:   ${writes.toml.image_model ?? "(none — primary is multimodal)"}`,
      `coding:  ${writes.toml.coding_model ?? "(none)"}`,
      "",
      `saved to ${target.path}`,
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
  q: HarnessPrompts = clackPrompts,
): Promise<string | typeof CANCELLED> {
  const providers = providerChoices(models);
  if (providers.length === 0) {
    const r = await q.text({
      message: "Pi provider (e.g. openrouter, openai) — blank = Pi's default",
      placeholder: "openrouter",
      initialValue: initial ?? "",
    });
    if (r === undefined) return CANCELLED;
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
  const r = await q.select<string>({
    message: "Provider (scopes the API key + model list)",
    options,
    initialValue: known ? initial : NONE,
  });
  if (r === undefined) return CANCELLED;
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
  q: HarnessPrompts = clackPrompts,
): Promise<string | typeof CANCELLED> {
  if (models.length === 0) {
    const r = await q.text({
      message: opts.allowNone ? `${message} (blank = none)` : message,
      placeholder: "e.g. gpt-5.2",
      initialValue: initial ?? "",
    });
    if (r === undefined) return CANCELLED;
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
  const r = await q.select<string>({
    message,
    options,
    initialValue: known
      ? initial
      : opts.allowNone
        ? NONE
        : modelId(models[0]!),
  });
  if (r === undefined) return CANCELLED;
  return r;
}

/**
 * A confirm prompt: returns true to proceed, false to skip. Default
 * wraps `@clack/prompts` confirm; tests inject a stub so they can drive
 * `maybePromptRestart` end-to-end without a real TTY.
 */
export type ConfirmFn = (message: string) => Promise<boolean>;

export const defaultConfirm: ConfirmFn = async (message) => {
  const r = await p.confirm({ message, initialValue: true });
  return !p.isCancel(r) && r === true;
};

/**
 * Shared post-apply hook for the config-mutating TUIs.
 *
 * Two steps. Always: re-render the on-disk service-manager unit if it's
 * stale (an old unit can carry retired directives — e.g. the pre-#452
 * `EnvironmentFile=` lines — or miss current ones, so a restart alone need
 * not give the service the environment this build expects; the launchd plist
 * has analogous templating). Then: if phantombot is running, offer to restart
 * it inline so the change takes effect.
 *
 * `confirm` is parameterized so tests can drive the full ordering
 * (rerender → confirm → restart) without going through @clack's
 * non-TTY-friendly prompt.
 */
export async function maybePromptRestart(
  svc: ServiceControl,
  confirm: ConfirmFn = defaultConfirm,
  q: HarnessPrompts = clackPrompts,
): Promise<void> {
  await maybeUpgradeUnit(svc, q);
  if (!(await svc.isActive())) return;
  const proceed = await confirm(
    "phantombot is currently running. Restart to apply changes?",
  );
  if (!proceed) {
    q.note(
      `skipped — restart later with: ${await restartCommand()}`,
      "Restart",
    );
    return;
  }
  const r = await svc.restart();
  q.note(
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
  q: HarnessPrompts = clackPrompts,
): Promise<{ rerendered: boolean; backupPath?: string }> {
  const r = await svc.rerenderUnitIfStale();
  if (r.rerendered) {
    const note = r.backupPath
      ? `service-manager unit upgraded to current template\nprevious contents saved to ${r.backupPath}`
      : "service-manager unit upgraded to current template";
    q.note(note, "Unit");
  }
  return r;
}

export default defineCommand({
  meta: {
    name: "harness",
    description: "Set the harness chain (primary → fallback). Detects which binaries are on PATH.",
  },
  args: {
    persona: {
      type: "string",
      description: "Set the chain for one persona. Omit for the global chain.",
    },
    check: {
      type: "boolean",
      description:
        "Detect installed harnesses (used during install). Installs nothing — the native harness is built in.",
    },
    dryrun: {
      type: "boolean",
      alias: "dry-run",
      description: "Skip side effects.",
    },
  },
  async run({ args }) {
    if (args.check) {
      const code = await runHarnessCheck({ dryRun: args.dryrun });
      process.exitCode = code;
      return;
    }
    const code = await runHarness({
      persona: args.persona ? String(args.persona) : undefined,
    });
    process.exitCode = code;
  },
});
