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
import {
  MAX_NATIVE_KEY_ATTEMPTS,
  resolvePiApiKeyWrite,
  type RoutingChoices,
} from "../lib/piRouting.ts";
import {
  CUSTOM_PROVIDERS,
  customProviderAllowsKeyless,
  customProviderSpec,
  normalizeBaseUrl,
  resolveCustomProviderBaseUrl,
  storedBaseUrlForProvider,
} from "../lib/piCustomProvider.ts";
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
    /**
     * `[harnesses.pi.routing].base_url` — the endpoint a bring-your-own-endpoint
     * provider lives at (issue #694). Only meaningful while `provider` is the
     * one it was stored for.
     */
    baseUrl?: string;
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
   * Injectable for tests; defaults to the real HTTP probe. `baseUrl` matters
   * only for the bring-your-own-endpoint providers (issue #694): their `/models`
   * lives wherever the operator said it does.
   */
  probeProviderKey?(
    providerId: string,
    key: string,
    opts?: { baseUrl?: string },
  ): Promise<KeyProbeResult>;
  /**
   * The provider's OWN model list, asked over HTTP. The fallback for when
   * `pi --list-models` knows nothing about the chosen provider — without it the
   * model pickers collapse to free text and the operator has to type a model id
   * from memory. Injectable for tests; defaults to the real fetch.
   */
  fetchProviderModels?(
    providerId: string,
    key: string,
    opts?: { baseUrl?: string },
  ): Promise<PiModel[]>;
  /**
   * Register a bring-your-own-endpoint provider in the native engine's
   * `models.json` (issue #694). Pi knows `openai-compatible` / `phantomops` ONLY
   * through that entry, so the flow cannot configure them without this — the
   * CLI wizard has always done it, and the interactive flow must too, or the
   * provider it just saved is unusable on the next turn (review, Kai).
   * `models` are UNIONED with whatever the entry already lists.
   */
  writeProviderEntry?(
    providerId: string,
    entry: { baseUrl: string; models?: readonly string[]; keyAvailable?: boolean },
  ): Promise<{ ok: true; path: string; changed: boolean } | { ok: false; error: string }>;
  /**
   * Drop a custom provider's entry — the "operator switched away" path. A
   * leftover entry keeps the provider (and its stale models) selectable.
   */
  clearProviderEntry?(
    providerId: string,
  ): Promise<{ ok: true; path?: string; changed?: boolean } | { ok: false; error: string }>;
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
  // One callable for the provider's own /models, whichever way it arrives: the
  // injected test double, or the real fetch (whose 3rd arg is the fetch impl,
  // not the endpoint opts).
  const fetchModels: NonNullable<BrainDeps["fetchProviderModels"]> =
    deps.fetchProviderModels ??
    ((id, key, opts) => fetchProviderModels(id, key, fetch, opts));

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

  // BRING-YOUR-OWN-ENDPOINT providers (issue #694). Pi only knows
  // `openai-compatible` / `phantomops` through a `models.json` entry that names
  // their endpoint, so the endpoint comes BEFORE the key (there is nothing to
  // probe without it) and before the model slots (nothing to list).
  const custom = customProviderSpec(provider || undefined);
  if (custom && !deps.writeProviderEntry) {
    q.note(
      "Custom provider",
      `this flow cannot register ${custom.label}: no models.json writer is wired up. Nothing was changed.`,
    );
    return true;
  }
  // The STORED endpoint belongs to the stored provider. Reusing it across a
  // provider switch is how selecting PhantomOps after a self-hosted box ended up
  // announcing (and then persisting) the OLD inference URL — sending the new
  // personal token there (review, Kai).
  const storedBaseUrl = storedBaseUrlForProvider(
    provider || undefined,
    current.routing.provider,
    current.routing.baseUrl,
  );
  let baseUrl: string | undefined;
  if (custom?.needsBaseUrl) {
    const asked = await askBaseUrl(q, custom.id, storedBaseUrl);
    if (asked === undefined) return true;
    baseUrl = asked;
  } else if (custom) {
    baseUrl = resolveCustomProviderBaseUrl(custom.id, storedBaseUrl);
    q.note(
      custom.label,
      `${custom.label} runs on ${baseUrl ?? "(no endpoint!)"} — the personal token is the only credential it needs.`,
    );
  }

  const keyLabel = custom ? custom.keyLabel : provider ? `${provider} API key` : "Pi API key";
  // A self-hosted OpenAI-compatible server may be unauthenticated; PhantomOps
  // (and every catalogue provider) cannot run without its credential. ONE
  // definition, shared with the harness's pre-spawn guard.
  const keyless = customProviderAllowsKeyless(provider || undefined);
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
    // A keyless endpoint is still CHECKABLE — an empty Authorization is exactly
    // the configuration a self-hosted server gets — so probe it rather than
    // skipping the step that catches a wrong URL.
    const probeKeyless = !candidate && keyless;
    if (!candidate && !probeKeyless) break;
    const result = await probe(provider || "google", candidate ?? "", { baseUrl });
    if (result.status === "invalid") {
      if (probeKeyless) {
        // The endpoint answered, but not as an anonymous server: it wants a
        // credential. Ask for one instead of saving a brain whose every turn
        // will 401.
        q.note(
          keyLabel,
          `the endpoint at ${baseUrl} rejected an unauthenticated request (${result.detail}). Paste its API key (esc goes back).`,
        );
        key = await q.value({
          title: keyLabel,
          hint: "this endpoint requires a key — paste it, or esc to go back",
          masked: true,
          allowEmpty: true,
        });
        if (key === undefined) return true;
        continue;
      }
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

  // GATE (2026-09-13 Atlas): a native slot with NO resolvable key cannot run —
  // the embedded engine never reads the host ~/.pi and its own store is empty.
  // So "no key" is refused here instead of being saved as a broken brain: the
  // loop re-asks until a key resolves (typed now, or already stored) or the
  // operator aborts. resolvePiApiKeyWrite's "clear" only survives when NO
  // provider is configured (nothing to authenticate against). The re-ask is
  // BOUNDED: a prompt source that keeps answering blank (a script, a broken
  // input) must abort cleanly, never spin forever.
  for (let attempt = 1; ; attempt++) {
    const gateWrite = resolvePiApiKeyWrite(
      key,
      provider || undefined,
      current.routing.provider,
    );
    const gateCandidate =
      gateWrite.action === "set"
        ? gateWrite.value
        : gateWrite.action === "keep"
          ? current.storedKey
          : undefined;
    if (!provider || gateCandidate || keyless) break;
    if (attempt > MAX_NATIVE_KEY_ATTEMPTS) {
      q.note(
        "API key required",
        `no ${keyLabel} after ${MAX_NATIVE_KEY_ATTEMPTS} attempts — nothing was changed. Re-run Configure → Brain with the key to hand.`,
      );
      return true;
    }
    q.note(
      "API key required",
      `the ${role} brain cannot run without a key: native never reads the host's own pi configuration. Paste the ${keyLabel} (esc aborts without changing anything).`,
    );
    key = await q.value({
      title: keyLabel,
      hint: "paste the key to continue (esc aborts the whole flow)",
      masked: true,
      allowEmpty: false,
    });
    if (key === undefined) return true;
  }

  const keyWrite = resolvePiApiKeyWrite(
    key,
    provider || undefined,
    current.routing.provider,
  );
  if (keyWrite.action === "set") {
    const stored = await deps.setSecret(keyWrite.value, instanceId);
    if (!stored.ok) {
      // A failed save means NO key exists after this flow — refuse rather than
      // save a brain that cannot authenticate. Abort with the reason; the
      // stored key (if any) is untouched.
      q.note(
        "API key required",
        `could not save ${keyLabel} to the ${stored.persona ?? "persona"} vault: ${stored.error}\nNothing was changed — re-run Configure → Brain to retry.`,
      );
      return true;
    }
    q.note("Pi API key", `saved to the ${stored.persona ?? "persona"} vault`);
    // Key the NATIVE engine's own auth store too (the isolated agent dir the
    // deps wire up — never the host's ~/.pi), so `--list-models` sees the
    // provider. Failure degrades to an env-injected refresh, never a dead end.
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

  // REGISTER the endpoint before the pickers (issue #694). Pi knows this
  // provider only through `models.json`, so the entry has to exist before
  // `--list-models` (and the pickers) can see it — the CLI wizard has always
  // done this write and the interactive flow inherited neither the write nor the
  // endpoint prompt, which left Configure → Brain unable to configure the
  // feature at all (review, Kai). The seeded list comes from the provider's own
  // /models and is UNIONED with whatever the entry already holds.
  const effectiveKey =
    keyWrite.action === "set"
      ? keyWrite.value
      : keyWrite.action === "keep"
        ? current.storedKey
        : undefined;
  if (custom && baseUrl) {
    let seeded: PiModel[] = [];
    if (provider) {
      seeded = await fetchModels(provider, effectiveKey ?? "", { baseUrl });
    }
    const write = await deps.writeProviderEntry!(custom.id, {
      baseUrl,
      models: seeded.map((m) => m.model),
      keyAvailable: Boolean(effectiveKey),
    });
    if (!write.ok) {
      // Without the entry the provider does not exist for pi, so saving a brain
      // on it would be saving a brain that cannot run. Refuse, loudly.
      q.note(
        "Custom provider",
        `couldn't write the provider entry (${write.error}) — nothing was changed. Fix the agent directory and retry.`,
      );
      return true;
    }
    if (write.changed) q.note("Custom provider", `registered ${provider} at ${baseUrl} (${write.path})`);
    if (seeded.length > 0) models = mergeModels(models, seeded);
    // A fresh listing now sees the provider, so the pickers fill from it.
    if (provider) {
      const refreshed = await deps.listModels();
      if (refreshed.length > 0) models = mergeModels(models, refreshed);
    }
  } else if (deps.clearProviderEntry) {
    // Switching to a normal provider must DROP the endpoint entries: a leftover
    // one keeps the provider (and its stale models) selectable in
    // `pi --list-models`, i.e. a brain the operator thinks they moved away from.
    for (const spec of CUSTOM_PROVIDERS) {
      const cleared = await deps.clearProviderEntry(spec.id);
      if (!cleared.ok) q.note("Custom provider", cleared.error);
    }
  }

  // LAST RESORT before the pickers: if Pi still lists nothing for this
  // provider, ask the provider itself. `pi --list-models` only enumerates
  // providers Pi has already keyed, and a key written seconds ago may not be
  // visible to it yet — which is exactly how the picker used to end up with a
  // lone "(none)" row and a demand that the user type a model id from memory.
  let scoped = modelsForProvider(provider || undefined, models);
  if (scoped.length === 0 && provider) {
    const live = await fetchModels(provider, effectiveKey ?? "", { baseUrl });
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
    // Endpoint for a bring-your-own-endpoint provider; `computeRoutingWrites`
    // keeps it only for those and CLEARS it for a catalogue provider, so a
    // switch away cannot leave dead config that reads like a live setting.
    baseUrl,
    primaryModel,
    imageModel,
    codingModel: codingPick || undefined,
  }, instanceId);
  // Keep the entry in step with the PICKS: pi lists a custom provider's models
  // FROM that entry, so a model selected here and missing there is selectable in
  // the wizard and unresolvable at spawn (same rule as the CLI wizard).
  if (custom && baseUrl && provider) {
    const write = await deps.writeProviderEntry!(custom.id, {
      baseUrl,
      models: [primaryModel, imageModel, codingPick].filter(
        (m): m is string => typeof m === "string" && m !== "",
      ),
      keyAvailable: Boolean(effectiveKey),
    });
    if (!write.ok) q.note("Custom provider", write.error);
  }
  q.note(
    "Model routing saved",
    [
      `provider: ${provider || "(none — Pi's default)"}`,
      ...(baseUrl ? [`endpoint: ${baseUrl}`] : []),
      `primary: ${primaryModel}`,
      `vision:  ${imageModel ?? "(none — primary is multimodal)"}`,
      `coder:   ${codingPick || "(none)"}`,
      "",
      `saved to ${deps.targetPath}`,
    ].join("\n"),
  );
  return false;
}

/**
 * Ask for a bring-your-own-endpoint provider's base URL (issue #694).
 *
 * Asked BEFORE the key and the model slots: without an endpoint there is nothing
 * to probe the key against and nothing for `pi --list-models` to list. Validated
 * here rather than at request time — a pasted `<base>/chat/completions` or a
 * missing scheme is the common mistake, and accepting it would save a provider
 * whose every turn 404s. A blank answer keeps the stored value when there is one
 * (`initial`), so re-running the flow on a working endpoint is one Enter.
 *
 * Returns undefined on a real cancel, and after MAX_NATIVE_KEY_ATTEMPTS invalid
 * answers — a prompt source that keeps answering garbage must abort cleanly
 * rather than spin (same bound as the key prompt).
 */
async function askBaseUrl(
  q: BrainQuestions,
  providerId: string,
  current: string | undefined,
): Promise<string | undefined> {
  const spec = customProviderSpec(providerId);
  const initial = current?.trim() || spec?.defaultBaseUrl || "";
  for (let attempt = 1; ; attempt++) {
    const answer = await q.value({
      title: `${spec?.label ?? providerId} base URL`,
      hint: "the root its /chat/completions and /models live under — e.g. http://localhost:11434/v1",
      allowEmpty: true,
    });
    if (answer === undefined) return undefined;
    const norm = normalizeBaseUrl((answer ?? "").trim() || initial);
    if (norm.ok) return norm.value;
    q.note("Base URL", `${norm.error}. Nothing was saved.`);
    if (attempt >= MAX_NATIVE_KEY_ATTEMPTS) {
      q.note(
        "Base URL",
        `no usable endpoint after ${MAX_NATIVE_KEY_ATTEMPTS} attempts — nothing was changed.`,
      );
      return undefined;
    }
  }
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
