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
import { harnessBin, whichBinary } from "../lib/harnessAvailability.ts";
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
} from "../lib/piModels.ts";
import {
  computeRoutingWrites,
  resolveRouting,
  type RoutingChoices,
} from "../lib/piRouting.ts";
import { updateEnvFile } from "../lib/envFile.ts";
import { userEnvPath } from "./env.ts";
import { saveHarnessBins } from "../state.ts";

export { whichBinary } from "../lib/harnessAvailability.ts";

export type HarnessId = "claude" | "pi" | "gemini" | "codex";
export const SUPPORTED_HARNESSES: ReadonlyArray<HarnessId> = [
  "claude",
  "pi",
  "gemini",
  "codex",
];

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
 * multimodal auto-skip is applied inside `computeRoutingWrites`, so by the time
 * we get here the image model is already dropped when the primary is
 * multimodal. Returns the computed writes so callers/tests can assert.
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
    // Mirror the env "" = unset semantics into TOML: drop the key when there's
    // no image/coding model so a multimodal switch clears a stale entry.
    setRoutingKey(toml, "image_model", writes.toml.image_model);
    setRoutingKey(toml, "coding_model", writes.toml.coding_model);
    // coding_progress: write only when on; otherwise delete so disabling it (or
    // dropping the coding model) clears a stale flag rather than leaving it.
    setRoutingKey(toml, "coding_progress", writes.toml.coding_progress);
  });
  await updateEnvFile(envPath, writes.env);
  return writes;
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
    initialValue:
      (config.harnesses.chain[0] as HarnessId) ?? SUPPORTED_HARNESSES[0],
  });
  if (p.isCancel(primary)) {
    p.cancel("cancelled");
    return 1;
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

  const chain: HarnessId[] = [primary as HarnessId];
  if (fallbackPick !== "none") chain.push(fallbackPick as HarnessId);

  await applyHarnessChain(config.configPath, chain);
  p.note(
    `harness chain: ${chain.join(" → ")}\nsaved to ${config.configPath}`,
    "Saved",
  );

  // Capability routing is Pi-specific (it's driven by a Pi extension), so only
  // offer the wizard step when pi is somewhere in the chain. Failover (the
  // chain above) is untouched by any of this.
  if (chain.includes("pi")) {
    const cancelled = await runRoutingWizard(config, availability.pi);
    if (cancelled) {
      p.cancel("cancelled");
      return 1;
    }
  }

  await maybePromptRestart(svc);

  p.outro("done");
  return 0;
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
): Promise<boolean> {
  const toml = await readConfigToml(config.configPath);
  const current = resolveRouting(
    getIn(toml, ["harnesses", "pi", "routing"]) as
      | Record<string, unknown>
      | undefined,
  );

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

  // Custom routing: query pi for the live model list so the picker only shows
  // models that are actually available. Falls back to free-text if pi can't be
  // queried (not installed, or output unparseable).
  const models = piBin ? await listPiModels(piBin) : [];
  if (models.length === 0) {
    p.note(
      "Couldn't read `pi --list-models` — entering model ids by hand.\n" +
        "Use the bare name as printed by `pi --list-models` (e.g. gpt-5.2).",
      "Routing",
    );
  }

  const primaryModel = await pickModel(
    "Primary model (orchestrator)",
    models,
    current.primaryModel,
  );
  if (primaryModel === CANCELLED) return true;

  const multimodal = primaryIsMultimodal(models, primaryModel);

  // THE auto-skip: a multimodal primary needs no image delegate, so we don't
  // even ask. The extension keys off the (now-unset) PHANTOMBOT_IMAGE_MODEL.
  let imageModel: string | undefined;
  if (multimodal) {
    p.note(
      `${primaryModel} accepts image input — skipping the image model.\n` +
        "The look_at_image tool won't be registered; the primary sees images itself.",
      "Multimodal primary",
    );
  } else {
    const picked = await pickModel(
      "Image model (vision delegate for look_at_image)",
      models.filter((m) => m.supportsImages),
      current.imageModel,
    );
    if (picked === CANCELLED) return true;
    imageModel = picked;
  }

  const codingModel = await pickModel(
    "Coding model (delegate for the coder tool)",
    models,
    current.codingModel,
  );
  if (codingModel === CANCELLED) return true;

  // Progress streaming is a coder-only behavior, so only ask when a coding
  // model is actually set. ON by default now: stream unless the operator opts
  // out (and unless an existing config explicitly turned it off).
  let codingProgress = true;
  if (codingModel.trim()) {
    const ans = await p.confirm({
      message: "Stream coder progress to the chat while it works?",
      initialValue: current.codingProgress !== false,
    });
    if (p.isCancel(ans)) return true;
    codingProgress = ans;
  }

  const choices: RoutingChoices = {
    primaryModel,
    imageModel,
    codingModel,
    codingProgress,
    primaryMultimodal: multimodal,
  };
  const writes = await applyRouting(config.configPath, choices);
  p.note(
    [
      `primary: ${writes.toml.primary_model}`,
      `image:   ${writes.toml.image_model ?? "(none — primary is multimodal)"}`,
      `coding:  ${writes.toml.coding_model ?? "(none)"}`,
      `progress: ${writes.toml.coding_progress ? "on (streams to chat)" : "off"}`,
      "",
      `saved to ${config.configPath} and ${userEnvPath()}`,
    ].join("\n"),
    "Capability routing",
  );
  return false;
}

const CANCELLED = Symbol("cancelled");

/**
 * Single model picker. Shows a select of available models when we have the
 * list, otherwise a free-text prompt. Returns the chosen bare model id, or the
 * CANCELLED sentinel if the user aborted.
 */
async function pickModel(
  message: string,
  models: readonly PiModel[],
  initial: string | undefined,
): Promise<string | typeof CANCELLED> {
  if (models.length === 0) {
    const r = await p.text({
      message,
      placeholder: "e.g. gpt-5.2",
      initialValue: initial ?? "",
    });
    if (p.isCancel(r)) return CANCELLED;
    return r.trim();
  }
  const r = await p.select<string>({
    message,
    options: models.map((m) => ({
      value: modelId(m),
      label: `${m.provider}/${m.model}`,
      hint: m.supportsImages ? "vision" : undefined,
    })),
    initialValue:
      initial && models.some((m) => modelId(m) === initial)
        ? initial
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
      `skipped — restart later with: ${restartCommand()}`,
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
