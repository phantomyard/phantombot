/**
 * The Jev row, as a sequence of SCREEN questions (issue #597).
 *
 * `phantombot jev` asks these through the standalone flow; the PersonaDetail
 * Jev row asks them in-app. The WRITE path stays the CLI's
 * (`applyJevConfig`), so the two surfaces cannot drift — the same rule the
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
 * nothing (the caller checks `jevUpdateEquals`). Esc at any step cancels the
 * whole flow — `undefined` anywhere means nothing is written.
 */

import type { JevConfigUpdate, ReusableJevKey } from "../cli/jev.ts";
import type { JevSettings } from "../config.ts";
import {
  JEV_DEFAULT_KEY_ENV,
  JEV_DEFAULT_MODEL,
  JEV_OPENROUTER_BASE_URL,
  JEV_TYPESAFE_BASE_URL,
} from "../lib/jev.ts";
import type { MemoryQuestions } from "./memoryFlow.ts";

/** Same question shape as the memory flow — choose screens and value boxes. */
export type JevQuestions = MemoryQuestions;

export interface JevFlowDeps {
  /** The host's current [jev] block, so defaults prefill from reality. */
  existing: JevSettings | undefined;
  /** Credentials the OpenRouter path can reuse, pre-discovered by the caller. */
  reusableKeys: ReusableJevKey[];
  /** One live forced-tool decision — a key that fails never reaches the config. */
  validate(settings: {
    baseUrl: string;
    apiKey: string;
    model?: string;
  }): Promise<{ ok: boolean; error?: string }>;
}

export type JevFlowResult =
  | { rejected: string }
  | { update: JevConfigUpdate; summary: string };

export async function configureJev(
  persona: string,
  q: JevQuestions,
  deps: JevFlowDeps,
): Promise<JevFlowResult | undefined> {
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
      "an optional typed-decision model (today: TypeSafe's Jev) for the threat judge and the primary/coder router — cheap, fast, independent of the harness chain",
    options: [
      {
        value: "openrouter",
        label: "OpenRouter",
        hint:
          existing?.provider === "openrouter"
            ? "current · reuses an existing OpenRouter key"
            : "reuses an existing OpenRouter key",
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
    ],
    initial: existing?.provider ?? "openrouter",
  });
  if (!provider) return undefined;

  if (provider === "off") {
    const keepProvider = existing?.provider ?? "openrouter";
    return {
      update: {
        provider: keepProvider,
        model: existing?.model,
        baseUrl: existing?.baseUrl,
        keyEnv: existing?.keyEnv ?? JEV_DEFAULT_KEY_ENV,
        judge: { enabled: false, mode: existing?.judge.mode ?? "shadow" },
        router: { enabled: false, mode: existing?.router.mode ?? "shadow" },
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

  if (provider === "openrouter") {
    baseUrl = existing?.provider === "openrouter"
      ? existing.baseUrl
      : JEV_OPENROUTER_BASE_URL;
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
          hint: `stored in the vault as ${JEV_DEFAULT_KEY_ENV}`,
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
      keyEnv = JEV_DEFAULT_KEY_ENV;
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
      : JEV_TYPESAFE_BASE_URL;
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
      keyEnv = existing?.keyEnv ?? JEV_DEFAULT_KEY_ENV;
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
    title: `What should Jev do for ${persona}?`,
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

  // 4. MODE — shadow is the shipped default for a reason: it gathers
  //    divergence evidence on real traffic before Jev may decide anything.
  let mode: "shadow" | "active" = "shadow";
  if (consumers !== "neither") {
    const picked = await q.choose({
      title: "Shadow mode first?",
      description:
        "shadow: Jev decides alongside the existing method and only logs divergences · active: Jev decides, the existing method is the fallback",
      options: [
        {
          value: "shadow",
          label: "Shadow — log-only, gather evidence (recommended)",
          hint:
            existing && !existing.judge.enabled
              ? undefined
              : existing?.judge.mode === "shadow"
                ? "current"
                : undefined,
        },
        {
          value: "active",
          label: "Active — Jev decides",
          hint:
            existing?.judge.mode === "active" || existing?.router.mode === "active"
              ? "current"
              : undefined,
        },
      ],
      initial:
        existing?.judge.mode === "active" || existing?.router.mode === "active"
          ? "active"
          : "shadow",
    });
    if (!picked) return undefined;
    mode = picked as "shadow" | "active";
  }

  // 5. VALIDATE — even a reused key: a revoked credential must fail here,
  //    not at the first held message.
  const v = await deps.validate({
    baseUrl,
    apiKey: resolvedKey!,
    model: existing?.model ?? JEV_DEFAULT_MODEL,
  });
  if (!v.ok) return { rejected: v.error ?? "key validation failed" };

  const judgeOn = consumers === "both" || consumers === "judge";
  const routerOn = consumers === "both" || consumers === "router";
  return {
    update: {
      provider: provider as "typesafe" | "openrouter",
      model: existing?.model,
      baseUrl,
      keyEnv,
      ...(apiKey !== undefined ? { apiKey } : {}),
      judge: { enabled: judgeOn, mode },
      router: { enabled: routerOn, mode },
    },
    summary:
      `${provider} · judge ${judgeOn ? mode : "off"} · router ${routerOn ? mode : "off"}` +
      (apiKey !== undefined ? ` · key stored as ${keyEnv}` : ` · reusing ${keyEnv}`),
  };
}

function currentConsumers(
  existing: JevSettings | undefined,
): "both" | "judge" | "router" | "neither" | undefined {
  if (!existing) return undefined;
  const j = existing.judge.enabled;
  const r = existing.router.enabled;
  if (j && r) return "both";
  if (j) return "judge";
  if (r) return "router";
  return "neither";
}
