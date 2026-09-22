/**
 * `phantombot decision-model` — configure the optional decision model
 * (issue #597; TypeSafe Jev today) for the threat judge and/or the
 * brain-swap router.
 *
 * The CANONICAL command is `src/cli/decision-model.ts`; this module owns
 * everything behind it AND the deprecated `phantombot jev` alias (the
 * `env` → `vault` pattern: the alias prints a one-line notice to stderr and
 * forwards to the same `runDecisionModel`), so existing scripts and muscle memory
 * keep working while the interface standardizes on the general concept the
 * TUI already uses (the "Decision model" row).
 *
 * The walkthrough itself lives in `src/tui/decisionModelFlow.ts` (provider picker,
 * frictionless reuse of an existing OpenRouter key, consumer picker) and is
 * asked on TUI screens — standalone here, or from the
 * PersonaDetail Jev row. This module owns the WRITE path
 * (`applyDecisionModelConfig`) so the two surfaces can never drift, plus the
 * supporting pieces both sides share: the live key probe, the reusable-key
 * discovery, and the idempotence check.
 *
 * Credentials go to the VAULT, never config.toml. The `[jev]` block records
 * everything EXCEPT the key: provider, endpoint, and key_env (the vault/env
 * NAME the key is read from), so "use the OpenRouter key I already have"
 * stores nothing new — the block just points at the existing name.
 */

import { existsSync } from "node:fs";
import * as p from "@clack/prompts";
import { defineCommand } from "citty";

import {
  type Config,
  type DecisionModelSettings,
  loadConfigForPersona,
  personaDir,
  resolvePersona,
} from "../config.ts";
import {
  DECISION_MODEL_DEFAULT_KEY_ENV,
  DECISION_MODEL_DEFAULT_MODEL,
  DECISION_MODEL_OPENROUTER_BASE_URL,
  DECISION_MODEL_TYPESAFE_BASE_URL,
  decisionModelDecide,
  type DecisionModelFetch,
} from "../lib/decisionModel.ts";
import { setIn, updateConfigToml } from "../lib/configWriter.ts";
import { personaConfigPath } from "../lib/personaConfig.ts";
import {
  getPersonaSecret,
  setPersonaSecret,
  type SetPersonaSecretResult,
} from "../lib/vaultSecrets.ts";
import { defaultServiceControl, type ServiceControl } from "../lib/platform.ts";
import { maybePromptRestart } from "./harness.ts";

/** One consumer's wizard outcome. Timeouts/thresholds keep their defaults. */
export interface DecisionModelConsumerUpdate {
  enabled: boolean;
}

export interface DecisionModelConfigUpdate {
  provider: "typesafe" | "openrouter";
  /**
   * An unknown vendor name carried over verbatim from the existing block
   * (`DecisionModelSettings.statedProvider`) by the wizard's keep paths. It
   * is what gets written to `provider`; the transport above still drives
   * the defaults. Undefined whenever the operator picked a transport.
   */
  statedProvider?: string;
  model?: string;
  baseUrl?: string;
  /**
   * The vault/env NAME the key is read from. A reused OpenRouter key keeps
   * its existing name (nothing new is stored); a newly typed key is stored
   * under PHANTOMBOT_JEV_API_KEY.
   */
  keyEnv: string;
  /** A NEW key to store in the vault. Undefined = reuse keyEnv as-is. */
  apiKey?: string;
  judge: DecisionModelConsumerUpdate;
  router: DecisionModelConsumerUpdate;
}

export interface ApplyDecisionModelConfigInput {
  config: Config;
  persona: string;
  update: DecisionModelConfigUpdate;
  /** Test seam for forcing vault failures without touching a real vault. */
  writeSecret?: (
    config: Config,
    name: string,
    value: string,
    persona?: string,
  ) => Promise<SetPersonaSecretResult>;
}

function deleteIn(root: Record<string, unknown>, path: readonly string[]): void {
  let current: Record<string, unknown> = root;
  for (const key of path.slice(0, -1)) {
    const next = current[key];
    if (!next || typeof next !== "object" || Array.isArray(next)) return;
    current = next as Record<string, unknown>;
  }
  delete current[path[path.length - 1]!];
}

/**
 * Persist a Jev configuration: the key (when a new one was typed) into the
 * persona's vault, everything else into `[jev]` in the persona's
 * config.toml. Merge semantics throughout: fields the update omits
 * (judge.timeout_ms, judge.threshold, judge.fail_closed, router.timeout_ms)
 * keep whatever is already in the file — a wizard re-run never silently
 * resets an operator's tuning, and `api_key` is scrubbed if it ever appears
 * (secrets never live in the plaintext file).
 */
export async function applyDecisionModelConfig(
  input: ApplyDecisionModelConfigInput,
): Promise<void> {
  const { config, persona, update } = input;
  const configPath = personaConfigPath(config.personasDir, persona);
  const writeSecret = input.writeSecret ?? setPersonaSecret;

  // Vault FIRST, and abort before touching config.toml when it fails —
  // writing an enabled [jev] block whose key never landed would leave Jev
  // configured with a missing or stale credential while the operator was
  // told the save failed.
  if (update.apiKey !== undefined) {
    const secretResult: SetPersonaSecretResult = await writeSecret(
      config,
      update.keyEnv,
      update.apiKey,
      persona,
    );
    if (!secretResult.ok) {
      throw new Error(
        `jev: could not store ${update.keyEnv} in the ${secretResult.persona ?? persona} vault: ` +
          (secretResult.error ?? "unknown error"),
      );
    }
  }

  await updateConfigToml(configPath, (toml) => {
    setIn(toml, ["jev", "provider"], update.statedProvider ?? update.provider);
    setIn(toml, ["jev", "model"], update.model ?? DECISION_MODEL_DEFAULT_MODEL);
    setIn(
      toml,
      ["jev", "base_url"],
      update.baseUrl ??
        (update.provider === "openrouter"
          ? DECISION_MODEL_OPENROUTER_BASE_URL
          : DECISION_MODEL_TYPESAFE_BASE_URL),
    );
    setIn(toml, ["jev", "key_env"], update.keyEnv);
    setIn(toml, ["jev", "judge", "enabled"], update.judge.enabled);
    setIn(toml, ["jev", "router", "enabled"], update.router.enabled);
    // `mode` was a pre-merge draft key (shadow/active). An enabled consumer
    // now always decides, so a stale copy left in the file would read as a
    // live setting that nothing honours — scrub it on every write.
    deleteIn(toml, ["jev", "judge", "mode"]);
    deleteIn(toml, ["jev", "router", "mode"]);
    // A key in the plaintext file is never right, whatever it came from.
    deleteIn(toml, ["jev", "api_key"]);
  });
}

/**
 * True when the update would write what is already on disk — the flow's
 * idempotence check. Re-running the wizard and keeping every offered default
 * (including "use the existing key") must write nothing.
 */
export function decisionModelUpdateEquals(
  existing: DecisionModelSettings | undefined,
  update: DecisionModelConfigUpdate,
): boolean {
  if (!existing) return false;
  const expectBaseUrl =
    update.baseUrl ??
    (update.provider === "openrouter"
      ? DECISION_MODEL_OPENROUTER_BASE_URL
      : DECISION_MODEL_TYPESAFE_BASE_URL);
  // A re-used key means "no credential change"; a NEW typed key always
  // counts as a change worth writing.
  if (update.apiKey !== undefined) return false;
  return (
    (existing.statedProvider ?? existing.provider) ===
      (update.statedProvider ?? update.provider) &&
    existing.model === (update.model ?? DECISION_MODEL_DEFAULT_MODEL) &&
    existing.baseUrl === expectBaseUrl &&
    existing.keyEnv === update.keyEnv &&
    existing.judge.enabled === update.judge.enabled &&
    existing.router.enabled === update.router.enabled
  );
}

/** A credential the Jev wizard can offer to reuse, with a human label. */
export interface ReusableDecisionModelKey {
  env: string;
  label: string;
}

/**
 * Discover credentials an OpenRouter-backed Jev setup can reuse with ZERO
 * new secrets (the frictionless rule, principal 2026-09-20): the Jev key
 * itself if one is already stored, the embeddings OpenAI-compatible key when
 * its endpoint IS OpenRouter, and a generic OPENROUTER_API_KEY export.
 *
 * Discovery is PERSONA-SCOPED (getPersonaSecret): the target persona's own
 * vault is read first, and process.env is only consulted through the
 * ambient-env guard — on a multi-persona daemon the injected environment
 * belongs to whichever vault was loaded at startup, so reading it raw could
 * offer (and validate) the DEFAULT persona's key and then write key_env
 * into a target vault that does not contain it. Never throws — an
 * unopenable vault degrades to the guarded ambient fallback.
 */
export async function findReusableDecisionModelKeys(
  config: Config,
  persona?: string,
): Promise<ReusableDecisionModelKey[]> {
  const out: ReusableDecisionModelKey[] = [];
  const seen = new Set<string>();
  const add = async (env: string, label: string) => {
    if (seen.has(env)) return;
    const value = await getPersonaSecret(config, env, persona);
    if (!value?.trim()) return;
    seen.add(env);
    out.push({ env, label });
  };
  await add(DECISION_MODEL_DEFAULT_KEY_ENV, "the decision-model key already in the vault");
  const embeddingsUrl = config.embeddings.openaiCompatible?.baseUrl ?? "";
  if (/openrouter\.ai/i.test(embeddingsUrl)) {
    await add(
      "PHANTOMBOT_OPENAI_COMPATIBLE_API_KEY",
      "the OpenRouter key already used for embeddings",
    );
  }
  await add(
    "OPENROUTER_API_KEY",
    "an OpenRouter key already stored for this persona",
  );
  return out;
}

/**
 * Live key probe: one trivial choice decision against the configured
 * endpoint. A key that does not work is caught at configure time, not at
 * the first held message — the same gate the embedding and voice wizards
 * apply. Also used by the /status probe.
 */
export async function validateDecisionModelKey(settings: {
  baseUrl: string;
  apiKey: string;
  model?: string;
  fetchImpl?: DecisionModelFetch;
}): Promise<{ ok: boolean; error?: string }> {
  const r = await decisionModelDecide({
    baseUrl: settings.baseUrl,
    apiKey: settings.apiKey,
    model: settings.model ?? DECISION_MODEL_DEFAULT_MODEL,
    instructions: "Answer the validation ping.",
    state: "Validation ping.",
    questions: {
      pong: {
        type: "choice",
        instructions: "Reply to the ping.",
        criteria: { ok: "The ping was received" },
      },
    },
    timeoutMs: 5000,
    fetchImpl: settings.fetchImpl,
  });
  return r.ok ? { ok: true } : { ok: false, error: r.error };
}

interface RunInput {
  persona?: string;
  config?: Config;
  serviceControl?: ServiceControl;
  /** True when invoked through the deprecated `phantombot jev` alias. */
  deprecated?: boolean;
}

export async function runDecisionModel(input: RunInput = {}): Promise<number> {
  const err = process.stderr;
  if (input.deprecated) {
    err.write(
      "note: `phantombot jev` is deprecated — use `phantombot decision-model`. Forwarding to the same flow.\n",
    );
  }
  const { config, persona } = input.config
    ? {
        config: input.config,
        persona: resolvePersona(input.persona, input.config),
      }
    : await loadConfigForPersona(input.persona);

  const dir = personaDir(config, persona);
  if (!existsSync(dir)) {
    err.write(`no persona '${persona}' at ${dir}\n`);
    return 2;
  }

  const deps = {
    existing: config.jev,
    reusableKeys: await findReusableDecisionModelKeys(config, persona),
    validate: (settings: { baseUrl: string; apiKey: string; model?: string }) =>
      validateDecisionModelKey(settings),
  };

  const finish = async (
    chosen:
      | { rejected: string }
      | { update: DecisionModelConfigUpdate; summary: string }
      | undefined,
  ): Promise<string> => {
    if (!chosen) return "decision model unchanged";
    if ("rejected" in chosen)
      return `decision model unchanged — rejected: ${chosen.rejected}`;
    if (decisionModelUpdateEquals(config.jev, chosen.update))
      return "decision model unchanged — already set";
    await applyDecisionModelConfig({ config, persona, update: chosen.update });
    return `decision model saved: ${chosen.summary}`;
  };

  if (process.stdin.isTTY) {
    const { runStandaloneFlow } = await import("../tui/standalone.tsx");
    const { configureDecisionModel } = await import("../tui/decisionModelFlow.ts");
    const svc = input.serviceControl ?? defaultServiceControl();
    return await runStandaloneFlow(async (q) => {
      const chosen = await configureDecisionModel(
        persona,
        { choose: (opts) => q.choose(opts), value: (opts) => q.value(opts) },
        deps,
      );
      const message = await finish(chosen);
      if (message.startsWith("decision model saved")) {
        await maybePromptRestart(
          svc,
          async (msg) =>
            await q.confirm({
              title: msg,
              consequence: {
                summary: "restarts daemon",
                detail: "",
                longRunning: false,
                restarts: true,
              },
            }),
          {
            note: (body: string, title?: string) => q.note(title ?? "", body),
          } as never,
        );
      }
      return message;
    }, ["phantombot", persona, "decision-model"]);
  }

  // Non-TTY fallback: the same flow asked through clack.
  const { configureDecisionModel } = await import("../tui/decisionModelFlow.ts");
  p.intro("Configure the decision model");
  const chosen = await configureDecisionModel(
    persona,
    {
      choose: async (opts) => {
        const r = await p.select({
          message: opts.title,
          options: opts.options.map((o) => ({
            value: o.value,
            label: o.label,
            hint: o.hint,
          })),
          initialValue: opts.initial,
        });
        return p.isCancel(r) ? undefined : (r as string);
      },
      value: async (opts) => {
        const r = await p.text({
          message: opts.title,
          placeholder: opts.hint,
          initialValue: opts.initial,
        });
        return p.isCancel(r) ? undefined : String(r);
      },
    },
    deps,
  );
  const message = await finish(chosen);
  p.outro(message);
  return 0;
}

export default defineCommand({
  meta: {
    name: "jev",
    description:
      "DEPRECATED alias for `phantombot decision-model`. Forwards to the same decision-model walkthrough (TypeSafe Jev today).",
  },
  args: {
    persona: {
      type: "string",
      required: false,
      description:
        "Persona to configure the decision model for. Default: PHANTOMBOT_PERSONA env, then the host's default persona.",
    },
  },
  async run({ args }) {
    process.exitCode = await runDecisionModel({
      persona: args.persona as string | undefined,
      deprecated: true,
    });
  },
});
