/**
 * The Jev row, as a sequence of SCREEN questions (issue #597).
 *
 * `phantombot decision-model` asks these through the standalone flow; the
 * PersonaDetail Jev row asks them in-app. The WRITE path stays the CLI's
 * (`applyDecisionModelConfig`), so the two surfaces cannot drift — the same rule the
 * memory and voice flows follow.
 *
 * The flow's headline property is FRICTIONLESS SETUP when an OpenRouter key
 * already exists (the principal's rule, 2026-09-20): provider choice first;
 * a reusable key is offered as the DEFAULT with no token prompt at all; a
 * token is only ever asked for when there is nothing to reuse. Choosing a
 * reusable key stores nothing new — the `[jev]` block just points key_env at
 * the existing vault name.
 *
 * Idempotent: re-running the flow and keeping every offered default writes
 * nothing (the caller checks `decisionModelUpdateEquals`). Esc at any step cancels the
 * whole flow — `undefined` anywhere means nothing is written.
 */

import type { DecisionModelConfigUpdate, ReusableDecisionModelKey } from "../cli/jev.ts";
import type { DecisionModelSettings } from "../config.ts";
import {
  DECISION_MODEL_DEFAULT_KEY_ENV,
  DECISION_MODEL_DEFAULT_MODEL,
  DECISION_MODEL_OPENROUTER_BASE_URL,
  DECISION_MODEL_TYPESAFE_BASE_URL,
} from "../lib/decisionModel.ts";
import type { MemoryQuestions } from "./memoryFlow.ts";

/** Same question shape as the memory flow — choose screens and value boxes. */
export type DecisionModelQuestions = MemoryQuestions;

export interface DecisionModelFlowDeps {
  /** The host's current [jev] block, so defaults prefill from reality. */
  existing: DecisionModelSettings | undefined;
  /** Credentials the OpenRouter path can reuse, pre-discovered by the caller. */
  reusableKeys: ReusableDecisionModelKey[];
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
      "a recommended typed-decision model (today: TypeSafe's Jev) for the threat judge and the primary/coder router — cheap, fast, independent of the harness chain",
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
              hint: `current · ${existing.baseUrl} · key ${existing.keyEnv}`,
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
    // Nothing vendor-specific to ask: keep the endpoint and the credential
    // name exactly as configured, then re-ask the consumers and re-validate.
    baseUrl = existing!.baseUrl;
    keyEnv = existing!.keyEnv;
    resolvedKey = existing!.apiKey ?? process.env[keyEnv]?.trim();
    if (!resolvedKey)
      return {
        rejected:
          `no key resolves for ${keyEnv} — store it with ` +
          `\`phantombot vault set ${keyEnv}\` and re-run`,
      };
  } else if (provider === "openrouter") {
    // A custom vendor rides the same transport but at its OWN endpoint:
    // picking OpenRouter explicitly must not inherit that URL.
    baseUrl = existing?.provider === "openrouter" && !existing.statedProvider
      ? existing.baseUrl
      : DECISION_MODEL_OPENROUTER_BASE_URL;
    const reuseOptions = deps.reusableKeys.map((k) => ({
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
      if (!resolvedKey) {
        return { rejected: `${keyEnv} is not set in the environment` };
      }
    }
  } else {
    // Direct TypeSafe.
    baseUrl = existing?.provider === "typesafe"
      ? existing.baseUrl
      : DECISION_MODEL_TYPESAFE_BASE_URL;
    const url = await q.value({
      title: "TypeSafe API base URL (the /v1 part)",
      hint: "confirm against your TypeSafe dashboard",
      initial: baseUrl,
    });
    if (url === undefined) return undefined;
    if (!url.trim()) return { rejected: "base URL is required" };
    baseUrl = url.trim().replace(/\/+$/, "");

    const existingKey =
      existing?.provider === "typesafe"
        ? process.env[existing.keyEnv]?.trim()
        : undefined;
    if (existingKey) {
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
      keyEnv = existing?.keyEnv ?? DECISION_MODEL_DEFAULT_KEY_ENV;
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

  // 3. CONSUMERS — judge and router are independent: a user may reasonably
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

  // 4. VALIDATE — even a reused key: a revoked credential must fail here,
  //    not at the first held message.
  const v = await deps.validate({
    baseUrl,
    apiKey: resolvedKey!,
    model: existing?.model ?? DECISION_MODEL_DEFAULT_MODEL,
  });
  if (!v.ok) return { rejected: v.error ?? "key validation failed" };

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
      model: existing?.model,
      baseUrl,
      keyEnv,
      ...(apiKey !== undefined ? { apiKey } : {}),
      judge: { enabled: judgeOn },
      router: { enabled: routerOn },
    },
    summary:
      `${provider === "custom" ? existing!.statedProvider : provider} · judge ${judgeOn ? "on" : "off"} · router ${routerOn ? "on" : "off"}` +
      (apiKey !== undefined ? ` · key stored as ${keyEnv}` : ` · reusing ${keyEnv}`),
  };
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
