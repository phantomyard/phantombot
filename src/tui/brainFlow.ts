/**
 * The Brain (harness chain) configuration, as a sequence of SCREEN questions.
 *
 * The old flow replayed the CLI `runHarness` question sequence verbatim —
 * the wording, defaults and structure were the CLI's, not what a TUI user
 * needs. This module owns the asking (like `channelsFlow.ts`); the WRITES go
 * through the same config-writing functions the CLI uses, injected as deps, so
 * the TUI and the CLI cannot write different shapes of the same files.
 *
 * The flow:
 *   1. Primary brain — detected LIVE each time the menu opens:
 *        · "Native — Configure Provider and Model Swap Settings" is always
 *          offered: the pi engine built into this binary, configured here
 *          (provider → API key → primary / vision / coder model slots, each a
 *          searchable windowed list, `SearchListScreen`).
 *        · Claude, Codex and "Pi — Use Host Configuration" appear ONLY when
 *          their binary is installed. A missing harness is not a choice.
 *   2. Fallback brain — optional, `(none)` allowed; native may back itself up.
 *
 * Codex, Claude and host Pi are CHAIN-ONLY choices: agents inherit the host's
 * harness configuration for them (auth, models, everything the host install owns), so
 * this flow never collects a token or a model for either — it writes their
 * chain entry and nothing else. The per-option hints say exactly that, because
 * "nothing to set up here" is the answer, not an omission.
 *
 * Every question is injected rather than imported, so the flow is testable
 * without a terminal — and cancelling is a real answer at every step:
 * `undefined` from any question leaves the config untouched.
 */

import type { PiModel } from "../lib/piModels.ts";
import {
  mergeModels,
  modelsForProvider,
  primaryIsMultimodal,
  providerChoices,
  providerEnvVar,
} from "../lib/piModels.ts";
import { resolvePiApiKeyWrite, type RoutingChoices } from "../lib/piRouting.ts";
import { probeProviderKey, type KeyProbeResult } from "../lib/providerKeyProbe.ts";
import { fetchProviderModels } from "../lib/providerModelCatalog.ts";
import type { PiAuthWriteResult } from "../lib/piAuthStore.ts";
import type { BrainTestRequest, BrainTestResult } from "./screens/BrainTest.tsx";

export type { BrainTestRequest, BrainTestResult };

export interface BrainQuestions {
  choose(input: {
    title: string;
    description?: string;
    options: readonly { value: string; label: string; hint?: string }[];
    initial?: string;
  }): Promise<string | undefined>;
  /** A searchable, windowed list — for the long provider/model catalogues. */
  search(input: {
    title: string;
    /** Names the slot being asked — "Selecting the PRIMARY model". */
    banner?: string;
    description?: string;
    options: readonly { value: string; label: string; hint?: string }[];
    initial?: string;
  }): Promise<string | undefined>;
  value(input: {
    title: string;
    hint?: string;
    masked?: boolean;
    allowEmpty?: boolean;
  }): Promise<string | undefined>;
  /** Live model test screen with checklist status and apply/retry confirmation. */
  testBrain?(input: BrainTestRequest): Promise<BrainTestResult>;
  /** A progress fact, shown in the notice bar. Never a question. */
  note(title: string, body: string): void;
}

export interface BrainDeps {
  persona?: string;
  /** The chain this persona effectively runs with now. */
  chain: readonly string[];
  /** native/pi-host/codex/claude → resolved binary path, or undefined when not installed. */
  availability: Record<string, string | undefined>;
  /** The EFFECTIVE Pi routing now (provider + the three model slots). */
  routing: {
    provider?: string;
    primaryModel?: string;
    imageModel?: string;
    codingModel?: string;
  };
  /** The stored Pi API key, when one is readable — drives the "keep it" hint. */
  storedKey?: string;
  /** Existing values for named Pi slots (used only for a Pi -> Pi chain). */
  piInstances?: Partial<Record<"primary" | "fallback", {
    routing: BrainDeps["routing"];
    storedKey?: string;
  }>>;
  /** Where the writes land — shown back so the user knows which file moved. */
  targetPath: string;
  /** Persona scope (vs the global fallback file) — decides the tombstone. */
  personaScope: boolean;
  /** The embedded engine's `pi --list-models`, injectable for tests. */
  listModels(extraEnv?: Record<string, string>): Promise<PiModel[]>;
  /**
   * Cheap provider-side key check, run the moment a key is entered — before
   * the model slots, so a bad key never costs the user a full re-pick.
   * Injectable for tests; defaults to the real HTTP probe.
   */
  probeProviderKey?(providerId: string, key: string): Promise<KeyProbeResult>;
  /**
   * The provider's OWN model list, asked over HTTP. The fallback for when
   * `pi --list-models` knows nothing about the chosen provider — without it the
   * model pickers collapse to free text and the operator has to type a model id
   * from memory. Injectable for tests; defaults to the real fetch.
   */
  fetchProviderModels?(providerId: string, key: string): Promise<PiModel[]>;
  setSecret(
    value: string,
    instanceId?: string,
  ): Promise<{ ok: boolean; persona?: string; error?: string }>;
  unsetSecret(instanceId?: string): Promise<unknown>;
  writeAuth(provider: string, value: string): Promise<PiAuthWriteResult>;
  applyChain(chain: readonly string[]): Promise<void>;
  applyRouting(choices: RoutingChoices, instanceId?: string): Promise<unknown>;
}

const NONE = "";

export const HARNESS_LABELS: Record<string, string> = {
  native: "Native — Configure Provider and Model Swap Settings",
  "pi-host": "Pi — Use Host Configuration",
  codex: "Codex",
  claude: "Claude",
};

/** Menu order. Native first: it is built in, the one brain every host can run. */
const BRAIN_ORDER = ["native", "pi-host", "codex", "claude"] as const;

/**
 * The brains this host can run right now: native always, the host harnesses
 * only when their binary resolved in this (live) detection.
 */
export function offeredBrains(
  availability: Record<string, string | undefined>,
): string[] {
  return BRAIN_ORDER.filter((id) => id === "native" || !!availability[id]);
}

/** Stored chain id → menu entry (the named native instances pick "native"). */
export function brainMenuId(id: string | undefined): string | undefined {
  if (id === "pi-primary" || id === "pi-fallback") return "native";
  return id;
}

/**
 * Per-harness hints. Host harnesses state the inheritance up front — an
 * operator picking Codex must learn HERE that there is nothing to configure,
 * not discover it from an empty wizard.
 */
function harnessHint(id: string): string {
  if (id === "native") {
    return "built-in pi engine — pick provider, API key and the primary / vision / coder models here (recommended)";
  }
  const label = id === "pi-host" ? "pi" : (HARNESS_LABELS[id] ?? id);
  return `uses this host's ${label} configuration — nothing to set up here`;
}

const PRIMARY_DESCRIPTION =
  "The primary brain answers every turn first — it is the model the phantom thinks with. The fallback, asked next, only steps in when the primary fails.";

const FALLBACK_DESCRIPTION =
  "Used when the primary errors, hangs, or returns an empty reply. Leave it as (none) if you don't want a safety net — everything still works, there is just nothing to fall back to.";

/**
 * Run the flow. Returns the line to show in the notice bar — every exit,
 * including a cancel, names what happened to the config.
 */
export async function configureBrain(
  q: BrainQuestions,
  deps: BrainDeps,
): Promise<string> {
  const offered = offeredBrains(deps.availability);
  const initialOf = (id: string | undefined): string | undefined => {
    const mapped = brainMenuId(id);
    return mapped !== undefined && offered.includes(mapped) ? mapped : undefined;
  };

  const primary = await q.choose({
    title: "Primary brain",
    description: PRIMARY_DESCRIPTION,
    options: offered.map((id) => ({
      value: id,
      label: HARNESS_LABELS[id] ?? id,
      hint: harnessHint(id),
    })),
    initial: initialOf(deps.chain[0]) ?? "native",
  });
  if (primary === undefined) return "brain unchanged";

  const fallback = await q.choose({
    title: "Fallback brain (optional)",
    description: FALLBACK_DESCRIPTION,
    options: [
      { value: NONE, label: "(none)", hint: "no fallback if the primary fails" },
      ...offered
        .filter((id) => id !== primary || id === "native")
        .map((id) => ({
          value: id,
          label: HARNESS_LABELS[id] ?? id,
          hint: harnessHint(id),
        })),
    ],
    initial: initialOf(deps.chain[1]) ?? NONE,
  });
  if (fallback === undefined) return "brain unchanged";

  const bothNative = primary === "native" && fallback === "native";
  if (primary === "native") {
    const cancelled = await configureNative(
      q,
      deps,
      "primary",
      bothNative ? "pi-primary" : undefined,
    );
    if (cancelled) return "brain unchanged";
  }
  if (fallback === "native") {
    const cancelled = await configureNative(
      q,
      deps,
      "fallback",
      bothNative ? "pi-fallback" : undefined,
    );
    if (cancelled) return "brain unchanged";
  }

  const chain = bothNative
    ? ["pi-primary", "pi-fallback"]
    : [primary, ...(fallback !== NONE ? [fallback] : [])];
  await deps.applyChain(chain);
  const where = `saved to ${deps.targetPath}`;
  q.note(
    "Brain saved",
    `chain${deps.persona ? ` for '${deps.persona}'` : ""}: ${chain.join(" → ")}\n${where}`,
  );
  return `brain saved: ${chain.join(" → ")}`;
}

/**
 * Configure the native harness for the slot it occupies (`primary` or
 * `fallback` — the provider screen names which). Returns `true` when the
 * operator cancelled, so the caller can abort the whole flow untouched.
 *
 * There is no "configure vs host configuration" question: native is
 * phantombot-configured by definition, and the host's own pi is the separate
 * "Pi — Use Host Configuration" brain.
 *
 * Idempotency contract: a key is written ONLY when the operator types one.
 * Submitting the key box empty keeps what is stored (when the provider is
 * unchanged — `resolvePiApiKeyWrite` decides), so re-running the flow and
 * changing nothing rewrites no secret.
 */
export async function configureNative(
  q: BrainQuestions,
  deps: BrainDeps,
  role: "primary" | "fallback",
  instanceId?: string,
): Promise<boolean> {
  const current = instanceId
    ? (deps.piInstances?.[role] ?? { routing: {}, storedKey: undefined })
    : { routing: deps.routing, storedKey: deps.storedKey };

  // The catalogue is fetched once and reused by every slot's list. With no
  // catalogue (no key yet) the lists degrade to free-text rows.
  let models = await deps.listModels();
  if (current.storedKey && current.routing.provider) {
    if (models.filter((m) => m.provider === current.routing.provider).length === 0) {
      const envVar = providerEnvVar(current.routing.provider);
      if (envVar) {
        const refreshed = await deps.listModels({ [envVar]: current.storedKey });
        if (refreshed.length > 0) models = mergeModels(models, refreshed);
      }
    }
  }

  const provider = await q.search({
    title: `Provider for the ${role} brain`,
    description:
      "Scopes the API key and every model list. Type to search — the catalogue is long.",
    options: [
      { value: NONE, label: "(none)", hint: "Pi's default provider (google)" },
      ...providerChoices(models).map((p) => ({
        value: p.id,
        label: p.label,
        hint: p.hasModels
          ? `${p.id} — key already configured`
          : p.label.toLowerCase() !== p.id.toLowerCase()
            ? p.id
            : undefined,
      })),
    ],
    initial:
      current.routing.provider !== undefined &&
      providerChoices(models).some((p) => p.id === current.routing.provider)
        ? current.routing.provider
        : NONE,
  });
  if (provider === undefined) return true;

  const keyLabel = provider ? `${provider} API key` : "Pi API key";
  let key = await q.value({
    title: keyLabel,
    hint: current.storedKey
      ? "a key is already stored — press Enter to keep it"
      : "paste the key; stored in the phantom's vault, never displayed. Empty = keep whatever is stored",
    masked: true,
    allowEmpty: true,
  });
  if (key === undefined) return true;

  // Validate BEFORE anything is written: a rejected key must not cost the
  // user their provider pick or the model slots that follow. "keep" (blank
  // entry) is checked too — a stored key going stale is exactly the failure
  // this exists to catch. Only an explicit provider rejection (401/403)
  // blocks; unverifiable keys warn and continue, and the end-of-flow live
  // test still guards them.
  const probe = deps.probeProviderKey ?? probeProviderKey;
  for (;;) {
    const keyWrite = resolvePiApiKeyWrite(
      key,
      provider || undefined,
      current.routing.provider,
    );
    const candidate =
      keyWrite.action === "set"
        ? keyWrite.value
        : keyWrite.action === "keep"
          ? current.storedKey
          : undefined;
    if (!candidate) break;
    const result = await probe(provider || "google", candidate);
    if (result.status === "invalid") {
      q.note(
        keyLabel,
        `REJECTED by the provider: ${result.detail}\nNothing was saved. Enter the key again, or press esc to go back.`,
      );
      key = await q.value({
        title: keyLabel,
        hint: "the previous key was rejected — paste a valid one (esc goes back)",
        masked: true,
        allowEmpty: true,
      });
      if (key === undefined) return true;
      continue;
    }
    if (result.status === "unverified") {
      q.note(
        keyLabel,
        `couldn't verify against the provider (${result.detail}) — continuing; the live test at the end still catches a bad key`,
      );
    }
    break;
  }

  const keyWrite = resolvePiApiKeyWrite(
    key,
    provider || undefined,
    current.routing.provider,
  );
  if (keyWrite.action === "set") {
    const stored = await deps.setSecret(keyWrite.value, instanceId);
    if (!stored.ok) {
      q.note(
        "Pi API key",
        `could not save ${keyLabel} to the ${stored.persona ?? "persona"} vault: ${stored.error}\nPi will fall back to its own local store until this is fixed.`,
      );
    } else {
      q.note("Pi API key", `saved to the ${stored.persona ?? "persona"} vault`);
    }
    // Key Pi's OWN auth store too, so `pi --list-models` sees the provider —
    // the same #312 merge-write the CLI does. Failure degrades to an
    // env-injected refresh, never a dead end.
    let refreshed: PiModel[] = [];
    if (provider) {
      const authWrite = await deps.writeAuth(provider, keyWrite.value);
      if (authWrite.ok && !authWrite.skipped) {
        q.note("Pi API key", `also keyed Pi's own store (${authWrite.path})`);
      } else if (!authWrite.ok) {
        q.note(
          "Pi API key",
          `couldn't write Pi's auth store: ${authWrite.reason} — falling back to an env-injected model refresh`,
        );
      }
      if (authWrite.ok) refreshed = await deps.listModels();
    }
    if (refreshed.length === 0 && provider) {
      const envVar = providerEnvVar(provider);
      if (envVar) refreshed = await deps.listModels({ [envVar]: keyWrite.value });
    }
    if (refreshed.length > 0) models = mergeModels(models, refreshed);
  } else if (keyWrite.action === "keep") {
    const effectiveKey = current.storedKey;
    if (provider && effectiveKey) {
      const authWrite = await deps.writeAuth(provider, effectiveKey);
      let refreshed: PiModel[] = [];
      if (authWrite.ok) refreshed = await deps.listModels();
      if (refreshed.length === 0 && models.filter((m) => m.provider === provider).length === 0) {
        const envVar = providerEnvVar(provider);
        if (envVar) refreshed = await deps.listModels({ [envVar]: effectiveKey });
      }
      if (refreshed.length > 0) models = mergeModels(models, refreshed);
    }
  } else if (keyWrite.action === "clear") {
    // Provider switched and nothing typed: the old key points at the wrong
    // provider now. Clear it rather than fire it at the new `--provider`.
    await deps.unsetSecret(instanceId);
    q.note(
      "Pi API key",
      "provider changed and no new key entered — cleared the stale key so Pi falls back to its own local store",
    );
  }

  // LAST RESORT before the pickers: if Pi still lists nothing for this
  // provider, ask the provider itself. `pi --list-models` only enumerates
  // providers Pi has already keyed, and a key written seconds ago may not be
  // visible to it yet — which is exactly how the picker used to end up with a
  // lone "(none)" row and a demand that the user type a model id from memory.
  let scoped = modelsForProvider(provider || undefined, models);
  if (scoped.length === 0 && provider) {
    const fetchModels = deps.fetchProviderModels ?? fetchProviderModels;
    const effectiveKey =
      keyWrite.action === "set" ? keyWrite.value : (current.storedKey ?? "");
    const live = await fetchModels(provider, effectiveKey);
    if (live.length > 0) {
      models = mergeModels(models, live);
      scoped = modelsForProvider(provider, models);
      q.note(
        "Model catalogue",
        `Pi listed no models for ${provider}; fetched ${live.length} from the provider's own API.`,
      );
    }
  }

  // Slot 1 — PRIMARY. "(none)" leaves Pi on its own default model.
  const primaryModel = await pickModelSlot(q, {
    slot: "primary",
    what: "the model that answers every turn",
    models: scoped,
    initial: current.routing.primaryModel,
    allowNone: true,
  });
  if (primaryModel === CANCELLED) return true;

  // Slot 2 — VISION. When the primary sees images itself there is nothing to
  // pick: the primary IS the vision model (the "always have an image model"
  // rule — a text-only coding delegate still has a look_at_image to call).
  // When it can't, the list narrows to vision-capable models. Capability comes
  // from Pi's `images` column; a model with no capability data counts as
  // not-capable, so vision is still asked rather than guessed.
  const multimodal = primaryIsMultimodal(scoped, primaryModel);
  let imageModel: string | undefined;
  if (multimodal) {
    imageModel = primaryModel;
    q.note(
      "Vision model",
      "the primary model sees images itself — no separate vision model needed",
    );
  } else {
    const visionPick = await pickModelSlot(q, {
      slot: "vision",
      what: "the delegate that looks at images when the primary can't",
      models: scoped.filter((m) => m.supportsImages),
      initial: current.routing.imageModel,
      allowNone: true,
    });
    if (visionPick === CANCELLED) return true;
    imageModel = visionPick || undefined;
  }

  // Slot 3 — CODER. Defaults to the primary: an explicit pick is optional,
  // a coding-brain swap is not mandatory.
  const codingPick = await pickModelSlot(q, {
    slot: "coder",
    what: "swapped in for coding turns (defaults to the primary model)",
    models: scoped,
    initial: (current.routing.codingModel ?? primaryModel) || undefined,
    allowNone: true,
  });
  if (codingPick === CANCELLED) return true;

  await deps.applyRouting({
    provider: provider || undefined,
    primaryModel,
    imageModel,
    codingModel: codingPick || undefined,
  }, instanceId);
  q.note(
    "Model routing saved",
    [
      `provider: ${provider || "(none — Pi's default)"}`,
      `primary: ${primaryModel}`,
      `vision:  ${imageModel ?? "(none — primary is multimodal)"}`,
      `coder:   ${codingPick || "(none)"}`,
      "",
      `saved to ${deps.targetPath}`,
    ].join("\n"),
  );
  return false;
}

const CANCELLED = Symbol("cancelled");

/**
 * One model slot as a searchable screen. The banner names the slot so a
 * three-question sequence can never blur together; empty catalogue ⇒ the
 * search screen's free-text row carries the entry by hand.
 */
async function pickModelSlot(
  q: BrainQuestions,
  opts: {
    slot: "primary" | "vision" | "coder";
    what: string;
    models: readonly PiModel[];
    initial?: string;
    allowNone?: boolean;
  },
): Promise<string | typeof CANCELLED> {
  const SLOT_LABELS = { primary: "PRIMARY", vision: "VISION", coder: "CODER" } as const;
  if (opts.models.length === 0) {
    // No catalogue: the search screen still answers — its free-text row takes
    // a bare model id typed blind, matching the CLI's free-text fallback.
    const typed = await q.search({
      title: "Pi model",
      banner: `Selecting the ${SLOT_LABELS[opts.slot]} model — ${opts.what}`,
      description:
        "No model catalogue available (no key for this provider yet). Type the model id as `pi --list-models` would print it, e.g. gpt-5.2.",
      options: opts.allowNone
        ? [{ value: NONE, label: "(none)", hint: "no override" }]
        : [],
      initial: opts.initial,
    });
    return typed === undefined ? CANCELLED : typed;
  }
  const label = (m: PiModel) => `${m.provider}/${m.model}`;
  const picked = await q.search({
    title: "Pi model",
    banner: `Selecting the ${SLOT_LABELS[opts.slot]} model — ${opts.what}`,
    options: [
      ...(opts.allowNone
        ? [{ value: NONE, label: "(none)", hint: "no override" }]
        : []),
      ...opts.models.map((m) => ({
        value: m.model,
        label: label(m),
        hint: m.supportsImages ? "vision" : undefined,
      })),
    ],
    initial: opts.initial,
  });
  return picked === undefined ? CANCELLED : picked;
}
