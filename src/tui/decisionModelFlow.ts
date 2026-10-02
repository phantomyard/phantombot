/**
 * The Decision Model row, as a sequence of SCREEN questions (issue #597).
 *
 * `phantombot decision-model` asks these through the standalone flow; the
 * PersonaDetail Jev row asks them in-app. The WRITE path stays the CLI's
 * (`applyDecisionModelConfig`), so the two surfaces cannot drift — the same rule the
 * memory and voice flows follow.
 *
 * The flow's headline property is FRICTIONLESS SETUP when an OpenRouter or TypeSafe key
 * already exists (the principal's rule, 2026-09-20): provider choice first;
 * a reusable key from the CURRENT persona's vault is offered as the DEFAULT with no token prompt at all; a
 * token is only ever asked for when there is nothing to reuse. Choosing a
 * reusable key stores nothing new — the `[jev]` block just points key_env at
 * the existing vault name.
 *
 * Idempotent: re-running the flow and keeping every offered default writes
 * nothing (the caller checks `decisionModelUpdateEquals`). Esc at any step cancels the
 * whole flow — `undefined` anywhere means nothing is written.
 *
 * Two rules keep a PROVIDER SWITCH from reaching into the previous
 * provider's state (PR #605 review). The existing credential NAME and the
 * existing MODEL are carried over only while the flow stays on the same
 * actual provider (`sameProvider`): a custom vendor's `ACME_API_KEY` must
 * not become the vault slot a freshly typed TypeSafe token is stored into
 * (that overwrites the Acme secret under the guise of a switch), and its
 * `acme/decision-v2` must not be what a Direct-TypeSafe pick validates and
 * persists. A switch always lands on the default name and the default
 * model. And a custom vendor is only ever validated at an endpoint the
 * operator STATED — a block with no `base_url` is asked for one here, never
 * probed at a transport's default.
 */

import type { DecisionModelConfigUpdate, ReusableDecisionModelKey } from "../cli/jev.ts";
import type { DecisionModelSettings } from "../config.ts";
import {
  DECISION_MODEL_DEFAULT_KEY_ENV,
  DECISION_MODEL_DEFAULT_MODEL,
  DECISION_MODEL_OPENROUTER_BASE_URL,
  DECISION_MODEL_TYPESAFE_BASE_URL,
  fetchDecisionModels,
} from "../lib/decisionModel.ts";
import type { BrainTestRequest, BrainTestResult } from "./screens/BrainTest.tsx";

export interface DecisionModelQuestions {
  choose(input: {
    title: string;
    description?: string;
    initial?: string;
    options: readonly { value: string; label: string; hint?: string }[];
  }): Promise<string | undefined>;
  search?(input: {
    title: string;
    banner?: string;
    description?: string;
    initial?: string;
    options: readonly { value: string; label: string; hint?: string }[];
  }): Promise<string | undefined>;
  value(input: {
    title: string;
    hint?: string;
    masked?: boolean;
    initial?: string;
    allowEmpty?: boolean;
  }): Promise<string | undefined>;
  testBrain?(input: BrainTestRequest): Promise<BrainTestResult>;
  note?(title: string, body: string): void;
}

export interface DecisionModelFlowDeps {
  /** The host's current [jev] block, so defaults prefill from reality. */
  existing: DecisionModelSettings | undefined;
  /** Credentials the path can reuse, pre-discovered by the caller for this persona. */
  reusableKeys: ReusableDecisionModelKey[];
  /** Optional secret reader for resolving vault keys not present in process.env. */
  getSecret?(keyEnv: string): Promise<string | undefined>;
  /** Optional model fetcher, defaulting to fetchDecisionModels. */
  fetchModels?(
    provider: string,
    apiKey: string,
    baseUrl?: string,
  ): Promise<string[]>;
  /** One live forced-tool decision — a key that fails never reaches the config. */
  validate(settings: {
    baseUrl: string;
    apiKey: string;
    model?: string;
  }): Promise<{ ok: boolean; error?: string }>;
}

export type DecisionModelFlowResult =
  | { rejected: string }
  | { update: DecisionModelConfigUpdate; summary: string };

export async function configureDecisionModel(
  persona: string,
  q: DecisionModelQuestions,
  deps: DecisionModelFlowDeps,
): Promise<DecisionModelFlowResult | undefined> {
  const existing = deps.existing;
  const anyEnabled =
    existing !== undefined &&
    (existing.judge.enabled || existing.router.enabled);

  // 1. PROVIDER FIRST (the frictionless rule): the provider decides which
  //    credential conversation follows. "Off" is always offered — disabling
  //    keeps the block so re-enabling later is one choice.
  const provider = await q.choose({
    title: `Decision model for ${persona}`,
    description:
      "A typed-decision model for the threat judge and/or the brain-swap router — cheap, fast, independent of the harness chain.",
    options: [
      {
        value: "openrouter",
        label: "OpenRouter",
        hint:
          existing?.provider === "openrouter" && !existing.statedProvider
            ? "recommended · current · reuses an existing OpenRouter key"
            : "recommended · reuses an existing OpenRouter key",
      },
      {
        value: "typesafe",
        label: "Direct (TypeSafe)",
        hint:
          existing?.provider === "typesafe"
            ? "current · a native TypeSafe API token"
            : "a native TypeSafe API token",
      },
      {
        value: "off",
        label: "Off — the harness judge and keyword router decide",
        hint: !anyEnabled ? "current" : "keeps settings for re-enabling",
      },
      // An unknown vendor name loaded from config (see
      // DecisionModelSettings.statedProvider): offered back as-is, and
      // preselected, so a re-run that keeps the defaults never rewrites it
      // to a transport's name.
      ...(existing?.statedProvider
        ? [
            {
              value: "custom",
              label: `Keep ${existing.statedProvider} (custom endpoint)`,
              hint:
                `current · ${existing.baseUrl ?? "no base_url set"} · ` +
                `key ${existing.keyEnv}`,
            },
          ]
        : []),
    ],
    initial: existing?.statedProvider
      ? "custom"
      : (existing?.provider ?? "openrouter"),
  });
  if (!provider) return undefined;

  if (provider === "off") {
    const keepProvider = existing?.provider ?? "openrouter";
    return {
      update: {
        provider: keepProvider,
        ...(existing?.statedProvider
          ? { statedProvider: existing.statedProvider }
          : {}),
        model: existing?.model,
        baseUrl: existing?.baseUrl,
        keyEnv: existing?.keyEnv ?? DECISION_MODEL_DEFAULT_KEY_ENV,
        judge: { enabled: false },
        router: { enabled: false },
      },
      summary: "off (settings kept)",
    };
  }

  // 2. CREDENTIAL. OpenRouter: reuse wins by default — a token prompt only
  //    appears when there is nothing to reuse. TypeSafe direct: keep or
  //    replace the stored token, plus the endpoint (the direct API base is
  //    the operator's to confirm).
  let keyEnv: string;
  let apiKey: string | undefined;
  let resolvedKey: string | undefined;
  let baseUrl: string;

  if (provider === "custom") {
    // Keep the credential name exactly as configured, then re-ask the
    // consumers and re-validate. The endpoint is the operator's: a block
    // that names none (loadable only with both consumers off) is asked for
    // one here — the credential is NEVER sent to a transport's default,
    // which is the guessed endpoint the config guard refuses to load.
    keyEnv = existing!.keyEnv;
    resolvedKey = existing!.apiKey ?? process.env[keyEnv]?.trim();
    if (!resolvedKey && deps.getSecret) {
      resolvedKey = (await deps.getSecret(keyEnv))?.trim();
    }
    if (!resolvedKey)
      return {
        rejected:
          `no key resolves for ${keyEnv} — store it with ` +
          `\`phantombot vault set ${keyEnv}\` and re-run`,
      };
    if (existing!.baseUrl !== undefined) {
      baseUrl = existing!.baseUrl;
    } else {
      const url = await q.value({
        title: `${existing!.statedProvider} decisions API base URL (the /v1 part)`,
        hint: `no base_url is set for ${existing!.statedProvider} — nothing is called until you name one`,
      });
      if (url === undefined) return undefined;
      if (!url.trim()) return { rejected: "base URL is required" };
      baseUrl = url.trim().replace(/\/+$/, "");
    }
  } else if (provider === "openrouter") {
    // A custom vendor rides the same transport but at its OWN endpoint:
    // picking OpenRouter explicitly must not inherit that URL.
    baseUrl = sameProvider(existing, "openrouter")
      ? (existing!.baseUrl ?? DECISION_MODEL_OPENROUTER_BASE_URL)
      : DECISION_MODEL_OPENROUTER_BASE_URL;
    const orReusable = deps.reusableKeys.filter(
      (k) => k.env !== "TYPESAFE_API_KEY",
    );
    const reuseOptions = orReusable.map((k) => ({
      value: `reuse:${k.env}`,
      label: `Use ${k.label}`,
      hint: `${k.env} · nothing new to store`,
    }));
    const action = await q.choose({
      title: `OpenRouter credential for ${persona}`,
      description:
        reuseOptions.length > 0
          ? "an existing key works as-is — no new credential needed"
          : "no reusable OpenRouter key found in the vault or environment",
      options: [
        ...reuseOptions,
        {
          value: "new",
          label: "Enter an OpenRouter API key",
          hint: `stored in the vault as ${DECISION_MODEL_DEFAULT_KEY_ENV}`,
        },
      ],
      initial:
        existing && reuseOptions.some((o) => o.value === `reuse:${existing.keyEnv}`)
          ? `reuse:${existing.keyEnv}`
          : (reuseOptions[0]?.value ?? "new"),
    });
    if (!action) return undefined;

    if (action === "new") {
      const typed = await q.value({
        title: `OpenRouter API key for ${persona}`,
        hint: "openrouter.ai/keys — checked before it is stored",
        masked: true,
      });
      if (typed === undefined) return undefined;
      if (!typed.trim()) return { rejected: "key is required" };
      apiKey = typed.trim();
      keyEnv = DECISION_MODEL_DEFAULT_KEY_ENV;
      resolvedKey = apiKey;
    } else {
      keyEnv = action.slice("reuse:".length);
      resolvedKey = process.env[keyEnv]?.trim();
      if (!resolvedKey && deps.getSecret) {
        resolvedKey = (await deps.getSecret(keyEnv))?.trim();
      }
      if (!resolvedKey) {
        return { rejected: `${keyEnv} is not set in the environment` };
      }
    }
  } else {
    // Direct TypeSafe.
    baseUrl = sameProvider(existing, "typesafe")
      ? (existing!.baseUrl ?? DECISION_MODEL_TYPESAFE_BASE_URL)
      : DECISION_MODEL_TYPESAFE_BASE_URL;
    const url = await q.value({
      title: "TypeSafe API base URL (the /v1 part)",
      hint: "confirm against your TypeSafe dashboard",
      initial: baseUrl,
    });
    if (url === undefined) return undefined;
    if (!url.trim()) return { rejected: "base URL is required" };
    baseUrl = url.trim().replace(/\/+$/, "");

    const tsReusable = deps.reusableKeys.filter(
      (k) =>
        k.env === "TYPESAFE_API_KEY" ||
        (sameProvider(existing, "typesafe") && k.env === existing?.keyEnv) ||
        (sameProvider(existing, "typesafe") && k.env === DECISION_MODEL_DEFAULT_KEY_ENV),
    );
    const existingKey = sameProvider(existing, "typesafe")
      ? process.env[existing!.keyEnv]?.trim()
      : undefined;

    if (tsReusable.length > 0) {
      const reuseOptions = tsReusable.map((k) => ({
        value: `reuse:${k.env}`,
        label: `Use ${k.label}`,
        hint: `${k.env} · nothing new to store`,
      }));
      const action = await q.choose({
        title: `TypeSafe API token for ${persona}`,
        options: [
          ...reuseOptions,
          {
            value: "new",
            label: "Enter a TypeSafe API token",
            hint: `stored in the vault as ${DECISION_MODEL_DEFAULT_KEY_ENV}`,
          },
        ],
        initial:
          existing && reuseOptions.some((o) => o.value === `reuse:${existing.keyEnv}`)
            ? `reuse:${existing.keyEnv}`
            : (reuseOptions[0]?.value ?? "new"),
      });
      if (!action) return undefined;
      if (action === "new") {
        keyEnv = sameProvider(existing, "typesafe")
          ? existing!.keyEnv
          : DECISION_MODEL_DEFAULT_KEY_ENV;
      } else {
        keyEnv = action.slice("reuse:".length);
        resolvedKey = process.env[keyEnv]?.trim();
        if (!resolvedKey && deps.getSecret) {
          resolvedKey = (await deps.getSecret(keyEnv))?.trim();
        }
      }
    } else if (existingKey) {
      const action = await q.choose({
        title: `TypeSafe API token for ${persona}`,
        options: [
          { value: "keep", label: `Keep the stored token (${existing!.keyEnv})` },
          { value: "replace", label: "Replace it" },
        ],
        initial: "keep",
      });
      if (!action) return undefined;
      if (action === "keep") {
        keyEnv = existing!.keyEnv;
        resolvedKey = existingKey;
      } else {
        keyEnv = existing!.keyEnv;
      }
    } else {
      keyEnv = sameProvider(existing, "typesafe")
        ? existing!.keyEnv
        : DECISION_MODEL_DEFAULT_KEY_ENV;
    }

    if (resolvedKey === undefined) {
      const typed = await q.value({
        title: `TypeSafe API token for ${persona}`,
        hint: "checked before it is stored",
        masked: true,
      });
      if (typed === undefined) return undefined;
      if (!typed.trim()) return { rejected: "token is required" };
      apiKey = typed.trim();
      resolvedKey = apiKey;
    }
  }

  // 3. MODEL SELECTION (in the same way Brain gives a model list)
  let model: string;
  const keepsProvider =
    provider === "custom" || sameProvider(existing, provider);
  const currentModel =
    (keepsProvider ? existing?.model : undefined) ?? DECISION_MODEL_DEFAULT_MODEL;

  const fetcher = deps.fetchModels ?? fetchDecisionModels;
  const available = await fetcher(
    provider === "custom" ? (existing?.statedProvider ?? "custom") : provider,
    resolvedKey!,
    baseUrl,
  );

  const modelOptions = [
    ...(available.length > 0 ? available : [DECISION_MODEL_DEFAULT_MODEL]),
  ].map((m) => ({
    value: m,
    label: m,
    hint:
      m === DECISION_MODEL_DEFAULT_MODEL
        ? "recommended · default"
        : m === existing?.model
          ? "current"
          : undefined,
  }));

  if (!modelOptions.some((o) => o.value === currentModel)) {
    modelOptions.unshift({
      value: currentModel,
      label: currentModel,
      hint: currentModel === existing?.model ? "current" : undefined,
    });
  }

  const providerLabel =
    provider === "custom"
      ? (existing?.statedProvider ?? "custom endpoint")
      : provider === "openrouter"
        ? "OpenRouter"
        : "TypeSafe";

  if (q.search) {
    const picked = await q.search({
      title: "Decision model",
      banner: `Selecting the decision model for ${providerLabel}`,
      description:
        "Type to search models or enter a custom model id (default: typesafe/jev-1.13)",
      options: modelOptions,
      initial: currentModel,
    });
    if (picked === undefined) return undefined;
    model = picked.trim();
  } else if (q.choose) {
    const choice = await q.choose({
      title: `Decision model for ${persona}`,
      options: [
        ...modelOptions.slice(0, 15),
        { value: "custom_input", label: "Enter custom model id..." },
      ],
      initial: currentModel,
    });
    if (!choice) return undefined;
    if (choice === "custom_input") {
      const customModel = await q.value({
        title: `Model id for ${providerLabel}`,
        hint: "e.g. typesafe/jev-1.13",
        initial: currentModel,
      });
      if (customModel === undefined) return undefined;
      if (!customModel.trim()) return { rejected: "model id is required" };
      model = customModel.trim();
    } else {
      model = choice;
    }
  } else {
    model = currentModel;
  }

  // 4. CONSUMERS — judge and router are independent: a user may reasonably
  //    want the cheap router without moving their security control.
  const consumers = await q.choose({
    title: `What should the decision model do for ${persona}?`,
    description:
      "the judge screens untrusted input (a security control); the router makes the primary/coder brain-swap choice (routing quality)",
    options: [
      {
        value: "both",
        label: "Both — judge and router",
        hint: currentConsumers(existing) === "both" ? "current" : undefined,
      },
      {
        value: "judge",
        label: "Threat judge only",
        hint: currentConsumers(existing) === "judge" ? "current" : undefined,
      },
      {
        value: "router",
        label: "Brain-swap router only",
        hint: currentConsumers(existing) === "router" ? "current" : undefined,
      },
      {
        value: "neither",
        label: "Neither — store the credential, stay disabled",
        hint: currentConsumers(existing) === "neither" ? "current" : undefined,
      },
    ],
    initial: currentConsumers(existing) ?? "both",
  });
  if (!consumers) return undefined;

  // 5. TEST & APPLY (like in Brain) — live decision probe confirms credentials
  //    and routing before anything is applied.
  while (true) {
    const testPick = await q.choose({
      title: `Ready to test ${providerLabel} (${model})?`,
      description:
        "A quick live decision probe confirms credentials and model routing before anything runs against real traffic.",
      options: [
        {
          value: "test",
          label: "Test now (recommended)",
          hint: "sends one test decision; applies when successful",
        },
        {
          value: "skip",
          label: "Apply without testing",
          hint: "saves the configuration immediately",
        },
      ],
      initial: "test",
    });
    if (testPick === undefined) return undefined;
    if (testPick === "skip") break;

    if (q.testBrain) {
      const testResult = await q.testBrain({
        persona,
        harness: `Decision Model (${model})`,
        frameTitle: ["decision-model", persona, "test"],
        description:
          "Sending a test decision to verify model responses and credentials.",
        probe: async () => {
          const v = await deps.validate({
            baseUrl,
            apiKey: resolvedKey!,
            model,
          });
          return {
            ok: v.ok,
            detail: v.ok
              ? `Decision model responded successfully (pong: ok, model: ${model})`
              : (v.error ?? "Validation failed"),
          };
        },
      });

      if (testResult.ok) {
        if (testResult.apply) {
          break; // Confirmed apply
        } else {
          return undefined; // Discard on request
        }
      } else {
        if (testResult.retry) {
          continue; // Retry
        }
        return { rejected: `test failed: ${testResult.detail}` };
      }
    } else {
      // Non-interactive fallback: run validate directly
      const v = await deps.validate({
        baseUrl,
        apiKey: resolvedKey!,
        model,
      });
      if (!v.ok) return { rejected: v.error ?? "key validation failed" };
      break;
    }
  }

  const judgeOn = consumers === "both" || consumers === "judge";
  const routerOn = consumers === "both" || consumers === "router";
  return {
    update: {
      provider:
        provider === "custom"
          ? existing!.provider
          : (provider as "typesafe" | "openrouter"),
      ...(provider === "custom" && existing?.statedProvider
        ? { statedProvider: existing.statedProvider }
        : {}),
      model,
      baseUrl,
      keyEnv,
      ...(apiKey !== undefined ? { apiKey } : {}),
      judge: { enabled: judgeOn },
      router: { enabled: routerOn },
    },
    summary:
      `${provider === "custom" ? existing!.statedProvider : provider} (${model}) · judge ${judgeOn ? "on" : "off"} · router ${routerOn ? "on" : "off"}` +
      (apiKey !== undefined ? ` · key stored as ${keyEnv}` : ` · reusing ${keyEnv}`),
  };
}

/**
 * True when `existing` is the SAME actual provider as `provider` — a custom
 * vendor rides the openrouter transport but is not OpenRouter, so its
 * credential name, model and endpoint must not carry into an OpenRouter
 * pick (nor into a TypeSafe one).
 */
function sameProvider(
  existing: DecisionModelSettings | undefined,
  provider: string,
): boolean {
  return (
    existing !== undefined &&
    existing.provider === provider &&
    existing.statedProvider === undefined
  );
}

function currentConsumers(
  existing: DecisionModelSettings | undefined,
): "both" | "judge" | "router" | "neither" | undefined {
  if (!existing) return undefined;
  const j = existing.judge.enabled;
  const r = existing.router.enabled;
  if (j && r) return "both";
  if (j) return "judge";
  if (r) return "router";
  return "neither";
}
