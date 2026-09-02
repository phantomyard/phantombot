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
 *   1. Primary brain — Pi / Codex / Claude, with a plain-words description.
 *   2. Fallback brain — optional, `(none)` allowed.
 *   3. If Pi was picked, HOW Pi's models are configured:
 *        · "Configure Provider and Model Swap Settings" (the default) —
 *          provider → API key → primary / vision / coder model slots, each a
 *          searchable windowed list (`SearchListScreen`).
 *        · "Use Host Configuration" — clear phantombot's routing and let Pi
 *          decide from its own local config.
 *
 * Codex and Claude are CHAIN-ONLY choices: agents inherit the host's harness
 * configuration for them (auth, models, everything the host install owns), so
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
  primaryIsMultimodal,
  providerChoices,
  providerEnvVar,
} from "../lib/piModels.ts";
import { resolvePiApiKeyWrite, type RoutingChoices } from "../lib/piRouting.ts";
import { probeProviderKey, type KeyProbeResult } from "../lib/providerKeyProbe.ts";
import type { PiAuthWriteResult } from "../lib/piAuthStore.ts";

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
  /** A progress fact, shown in the notice bar. Never a question. */
  note(title: string, body: string): void;
}

export interface BrainDeps {
  persona?: string;
  /** The chain this persona effectively runs with now. */
  chain: readonly string[];
  /** pi/codex/claude → resolved binary path, or undefined when not on PATH. */
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
  /** Resolved pi binary, when present. Absent ⇒ free-text model entry. */
  piBin?: string;
  /** The install command, handed over as text — the TUI never runs installers. */
  installCommand: string;
  /** `pi --list-models`, injectable for tests. */
  listModels(extraEnv?: Record<string, string>): Promise<PiModel[]>;
  /**
   * Cheap provider-side key check, run the moment a key is entered — before
   * the model slots, so a bad key never costs the user a full re-pick.
   * Injectable for tests; defaults to the real HTTP probe.
   */
  probeProviderKey?(providerId: string, key: string): Promise<KeyProbeResult>;
  setSecret(
    value: string,
    instanceId?: string,
  ): Promise<{ ok: boolean; persona?: string; error?: string }>;
  unsetSecret(instanceId?: string): Promise<unknown>;
  writeAuth(provider: string, value: string): Promise<PiAuthWriteResult>;
  applyChain(chain: readonly string[]): Promise<void>;
  applyRouting(choices: RoutingChoices, instanceId?: string): Promise<unknown>;
  clearRouting(opts?: { tombstone?: boolean }, instanceId?: string): Promise<void>;
}

const NONE = "";

const HARNESS_LABELS: Record<string, string> = {
  pi: "Pi",
  codex: "Codex",
  claude: "Claude",
};

function mergeModels(existing: readonly PiModel[], fresh: readonly PiModel[]): PiModel[] {
  const seen = new Set<string>();
  const res: PiModel[] = [];
  for (const m of [...fresh, ...existing]) {
    const key = `${m.provider}/${m.model}`;
    if (!seen.has(key)) {
      seen.add(key);
      res.push(m);
    }
  }
  return res;
}

/**
 * Per-harness hints. Codex/Claude state the inheritance up front — an operator
 * picking Codex must learn HERE that there is nothing to configure, not
 * discover it from an empty wizard.
 */
function harnessHint(id: string, deps: BrainDeps): string {
  if (id === "pi") return "provider + model routing configured in this app";
  const label = HARNESS_LABELS[id] ?? id;
  const found = deps.availability[id] ? "" : " (not on PATH — will fail)";
  return `uses this host's ${label} configuration — nothing to set up${found}`;
}

const PRIMARY_DESCRIPTION =
  "The primary brain answers every turn first — it is the model the phantom thinks with. The fallback, asked next, only steps in when the primary fails.";

const FALLBACK_DESCRIPTION =
  "Used when the primary errors, hangs, or returns an empty reply. Leave it as (none) if you don't want a safety net — everything still works, there is just nothing to fall back to.";

const PI_MODE_DESCRIPTION =
  "Configure here picks the provider and which model handles primary, vision and coding turns — recommended. Use Host Configuration hands model choice back to Pi itself (whatever you set up by running `pi` on this host).";

/**
 * Run the flow. Returns the line to show in the notice bar — every exit,
 * including a cancel, names what happened to the config.
 */
export async function configureBrain(
  q: BrainQuestions,
  deps: BrainDeps,
): Promise<string> {
  const harnessIds = ["pi", "codex", "claude"];

  const primary = await q.choose({
    title: "Primary brain",
    description: PRIMARY_DESCRIPTION,
    options: harnessIds.map((id) => ({
      value: id,
      label: HARNESS_LABELS[id] ?? id,
      hint: harnessHint(id, deps),
    })),
    initial: deps.chain[0]?.startsWith("pi-") ? "pi" : deps.chain[0],
  });
  if (primary === undefined) return "brain unchanged";

  const fallback = await q.choose({
    title: "Fallback brain (optional)",
    description: FALLBACK_DESCRIPTION,
    options: [
      { value: NONE, label: "(none)", hint: "no fallback if the primary fails" },
      ...harnessIds
        .filter((id) => id !== primary || id === "pi")
        .map((id) => ({
          value: id,
          label: HARNESS_LABELS[id] ?? id,
          hint: harnessHint(id, deps),
        })),
    ],
    initial: deps.chain[1]?.startsWith("pi-") ? "pi" : (deps.chain[1] ?? NONE),
  });
  if (fallback === undefined) return "brain unchanged";

  const bothPi = primary === "pi" && fallback === "pi";
  let primaryMode: "configure" | "host" | undefined;
  if (primary === "pi") {
    const cancelled = await configurePi(
      q,
      deps,
      "primary",
      { onMode: (m) => { primaryMode = m; } },
      bothPi ? "pi-primary" : undefined,
    );
    if (cancelled) return "brain unchanged";
  }
  if (fallback === "pi") {
    const cancelled = await configurePi(
      q,
      deps,
      "fallback",
      { allowHostConfig: primaryMode !== "host" },
      bothPi ? "pi-fallback" : undefined,
    );
    if (cancelled) return "brain unchanged";
  }

  const chain = bothPi
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

export interface ConfigurePiOptions {
  askMode?: boolean;
  allowHostConfig?: boolean;
  onMode?: (mode: "configure" | "host") => void;
}

/**
 * Configure Pi for the slot it occupies (`primary` or `fallback` — the banner
 * always names which). Returns `true` when the operator cancelled, so the
 * caller can abort the whole flow untouched.
 *
 * Idempotency contract: a key is written ONLY when the operator types one.
 * Submitting the key box empty keeps what is stored (when the provider is
 * unchanged — `resolvePiApiKeyWrite` decides), so re-running the flow and
 * changing nothing rewrites no secret.
 */
export async function configurePi(
  q: BrainQuestions,
  deps: BrainDeps,
  role: "primary" | "fallback",
  opts?: ConfigurePiOptions,
  instanceId?: string,
): Promise<boolean> {
  const current = instanceId
    ? (deps.piInstances?.[role] ?? { routing: {}, storedKey: undefined })
    : { routing: deps.routing, storedKey: deps.storedKey };
  // askMode:false — the caller already asked the configure-vs-host question
  // (brain onboarding does, to show it in flow order) and chose "configure".
  if (!deps.piBin) {
    q.note(
      "Pi not found",
      `pi isn't on this host yet. Run this in a terminal, then come back:\n\n  ${deps.installCommand}`,
    );
  }

  let mode: "configure" | "host" = "configure";
  if (opts?.askMode !== false) {
    if (opts?.allowHostConfig === false) {
      mode = "configure";
      q.note(
        "Pi: fallback models",
        "the fallback must configure its own models — two Pi instances on host config would be identical",
      );
    } else {
      const pick = await q.choose({
        title: `Pi (${role} brain) — how should its models be configured?`,
        description: PI_MODE_DESCRIPTION,
        options: [
          {
            value: "configure",
            label: "Configure Provider and Model Swap Settings",
            hint: "pick provider, API key, and the primary / vision / coder models here (recommended)",
          },
          {
            value: "host",
            label: "Use Host Configuration",
            hint: "reuse the Pi provider and model routing already configured on this host",
          },
        ],
        initial: "configure",
      });
      if (pick === undefined) return true;
      mode = pick as "configure" | "host";
    }
  }
  opts?.onMode?.(mode);

  if (mode === "host") {
    // ACTIVELY clear — see clearPiRouting. The tombstone only exists in
    // persona scope: in the global file it would be inherited by every persona
    // that has not stated its own routing.
    await deps.clearRouting({ tombstone: deps.personaScope }, instanceId);
    q.note(
      "Pi: using host configuration",
      `cleared phantombot's Pi routing from ${deps.targetPath} — Pi decides for itself, from its own local config. Re-run Brain and choose Configure to override.`,
    );
    return false;
  }

  // The catalogue is fetched once and reused by every slot's list. With no pi
  // binary the lists degrade to free-text rows inside the search screen.
  let models = deps.piBin ? await deps.listModels() : [];
  if (current.storedKey && current.routing.provider && deps.piBin) {
    if (models.filter((m) => m.provider === current.routing.provider).length === 0) {
      const envVar = providerEnvVar(current.routing.provider);
      if (envVar) {
        const refreshed = await deps.listModels({ [envVar]: current.storedKey });
        if (refreshed.length > 0) models = mergeModels(models, refreshed);
      }
    }
  }

  const provider = await q.search({
    title: "Pi provider",
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
      if (authWrite.ok && deps.piBin) refreshed = await deps.listModels();
    }
    if (refreshed.length === 0 && provider && deps.piBin) {
      const envVar = providerEnvVar(provider);
      if (envVar) refreshed = await deps.listModels({ [envVar]: keyWrite.value });
    }
    if (refreshed.length > 0) models = mergeModels(models, refreshed);
  } else if (keyWrite.action === "keep") {
    const effectiveKey = current.storedKey;
    if (provider && effectiveKey && deps.piBin) {
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

  const scoped = provider ? models.filter((m) => m.provider === provider) : models;

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
  const multimodal = primaryIsMultimodal(models, primaryModel);
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
        "No model catalogue available (pi not installed, or no key yet). Type the model id as `pi --list-models` would print it, e.g. gpt-5.2.",
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
