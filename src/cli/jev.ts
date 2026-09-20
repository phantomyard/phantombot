/**
 * `phantombot jev` — configure the optional TypeSafe Jev backend (issue
 * #597) for the threat judge and/or the brain-swap router.
 *
 * The walkthrough itself lives in `src/tui/jevFlow.ts` (provider picker,
 * frictionless reuse of an existing OpenRouter key, consumer and mode
 * pickers) and is asked on TUI screens — standalone here, or from the
 * PersonaDetail Jev row. This module owns the WRITE path
 * (`applyJevConfig`) so the two surfaces can never drift, plus the
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
  type JevSettings,
  loadConfigForPersona,
  personaDir,
  resolvePersona,
} from "../config.ts";
import {
  JEV_DEFAULT_KEY_ENV,
  JEV_DEFAULT_MODEL,
  JEV_OPENROUTER_BASE_URL,
  JEV_TYPESAFE_BASE_URL,
  jevDecide,
  type JevFetch,
} from "../lib/jev.ts";
import { setIn, updateConfigToml } from "../lib/configWriter.ts";
import { personaConfigPath } from "../lib/personaConfig.ts";
import {
  setPersonaSecret,
  type SetPersonaSecretResult,
} from "../lib/vaultSecrets.ts";
import { defaultServiceControl, type ServiceControl } from "../lib/platform.ts";
import { maybePromptRestart } from "./harness.ts";

/** One consumer's wizard outcome. Timeouts/thresholds keep their defaults. */
export interface JevConsumerUpdate {
  enabled: boolean;
  mode: "shadow" | "active";
}

export interface JevConfigUpdate {
  provider: "typesafe" | "openrouter";
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
  judge: JevConsumerUpdate;
  router: JevConsumerUpdate;
}

export interface ApplyJevConfigInput {
  config: Config;
  persona: string;
  update: JevConfigUpdate;
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
export async function applyJevConfig(
  input: ApplyJevConfigInput,
): Promise<void> {
  const { config, persona, update } = input;
  const configPath = personaConfigPath(config.personasDir, persona);
  const writeSecret = input.writeSecret ?? setPersonaSecret;
  let secretResult: SetPersonaSecretResult | undefined;

  if (update.apiKey !== undefined) {
    secretResult = await writeSecret(
      config,
      update.keyEnv,
      update.apiKey,
      persona,
    );
  }

  await updateConfigToml(configPath, (toml) => {
    setIn(toml, ["jev", "provider"], update.provider);
    setIn(toml, ["jev", "model"], update.model ?? JEV_DEFAULT_MODEL);
    setIn(
      toml,
      ["jev", "base_url"],
      update.baseUrl ??
        (update.provider === "openrouter"
          ? JEV_OPENROUTER_BASE_URL
          : JEV_TYPESAFE_BASE_URL),
    );
    setIn(toml, ["jev", "key_env"], update.keyEnv);
    setIn(toml, ["jev", "judge", "enabled"], update.judge.enabled);
    setIn(toml, ["jev", "judge", "mode"], update.judge.mode);
    setIn(toml, ["jev", "router", "enabled"], update.router.enabled);
    setIn(toml, ["jev", "router", "mode"], update.router.mode);
    // A key in the plaintext file is never right, whatever it came from.
    deleteIn(toml, ["jev", "api_key"]);
  });

  if (secretResult && !secretResult.ok) {
    throw new Error(
      `jev: could not store ${update.keyEnv} in the ${secretResult.persona ?? persona} vault: ` +
        (secretResult.error ?? "unknown error"),
    );
  }
}

/**
 * True when the update would write what is already on disk — the flow's
 * idempotence check. Re-running the wizard and keeping every offered default
 * (including "use the existing key") must write nothing.
 */
export function jevUpdateEquals(
  existing: JevSettings | undefined,
  update: JevConfigUpdate,
): boolean {
  if (!existing) return false;
  const expectBaseUrl =
    update.baseUrl ??
    (update.provider === "openrouter"
      ? JEV_OPENROUTER_BASE_URL
      : JEV_TYPESAFE_BASE_URL);
  // A re-used key means "no credential change"; a NEW typed key always
  // counts as a change worth writing.
  if (update.apiKey !== undefined) return false;
  return (
    existing.provider === update.provider &&
    existing.model === (update.model ?? JEV_DEFAULT_MODEL) &&
    existing.baseUrl === expectBaseUrl &&
    existing.keyEnv === update.keyEnv &&
    existing.judge.enabled === update.judge.enabled &&
    existing.judge.mode === update.judge.mode &&
    existing.router.enabled === update.router.enabled &&
    existing.router.mode === update.router.mode
  );
}

/** A credential the Jev wizard can offer to reuse, with a human label. */
export interface ReusableJevKey {
  env: string;
  label: string;
}

/**
 * Discover credentials an OpenRouter-backed Jev setup can reuse with ZERO
 * new secrets (the frictionless rule, principal 2026-09-20): the Jev key
 * itself if one is already stored, the embeddings OpenAI-compatible key when
 * its endpoint IS OpenRouter, and a generic OPENROUTER_API_KEY export.
 * Discovery reads process.env — the loaded persona's vault is already
 * injected there at startup, and the wizard paths reload it before calling.
 */
export function findReusableJevKeys(config: Config): ReusableJevKey[] {
  const out: ReusableJevKey[] = [];
  const seen = new Set<string>();
  const add = (env: string, label: string) => {
    if (seen.has(env) || !process.env[env]?.trim()) return;
    seen.add(env);
    out.push({ env, label });
  };
  add(JEV_DEFAULT_KEY_ENV, "the Jev key already in the vault");
  const embeddingsUrl = config.embeddings.openaiCompatible?.baseUrl ?? "";
  if (/openrouter\.ai/i.test(embeddingsUrl)) {
    add(
      "PHANTOMBOT_OPENAI_COMPATIBLE_API_KEY",
      "the OpenRouter key already used for embeddings",
    );
  }
  add("OPENROUTER_API_KEY", "the OpenRouter key in the environment");
  return out;
}

/**
 * Live key probe: one trivial forced-tool decision against the configured
 * endpoint. A key that does not work is caught at configure time, not at
 * the first held message — the same gate the embedding and voice wizards
 * apply. Also used by the /status probe.
 */
export async function validateJevKey(settings: {
  baseUrl: string;
  apiKey: string;
  model?: string;
  fetchImpl?: JevFetch;
}): Promise<{ ok: boolean; error?: string }> {
  const r = await jevDecide({
    baseUrl: settings.baseUrl,
    apiKey: settings.apiKey,
    model: settings.model ?? JEV_DEFAULT_MODEL,
    prompt: "Validation ping. Reply by calling the ping function.",
    tool: "ping",
    description: "Answer a validation ping.",
    parameters: {
      type: "object",
      properties: { pong: { type: "string", enum: ["ok"] } },
      required: ["pong"],
      additionalProperties: false,
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
}

export async function runJev(input: RunInput = {}): Promise<number> {
  const err = process.stderr;
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
    reusableKeys: findReusableJevKeys(config),
    validate: (settings: { baseUrl: string; apiKey: string; model?: string }) =>
      validateJevKey(settings),
  };

  const finish = async (
    chosen:
      | { rejected: string }
      | { update: JevConfigUpdate; summary: string }
      | undefined,
  ): Promise<string> => {
    if (!chosen) return "jev unchanged";
    if ("rejected" in chosen)
      return `jev unchanged — rejected: ${chosen.rejected}`;
    if (jevUpdateEquals(config.jev, chosen.update))
      return "jev unchanged — already set";
    await applyJevConfig({ config, persona, update: chosen.update });
    return `jev saved: ${chosen.summary}`;
  };

  if (process.stdin.isTTY) {
    const { runStandaloneFlow } = await import("../tui/standalone.tsx");
    const { configureJev } = await import("../tui/jevFlow.ts");
    const svc = input.serviceControl ?? defaultServiceControl();
    return await runStandaloneFlow(async (q) => {
      const chosen = await configureJev(
        persona,
        { choose: (opts) => q.choose(opts), value: (opts) => q.value(opts) },
        deps,
      );
      const message = await finish(chosen);
      if (message.startsWith("jev saved")) {
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
    }, ["phantombot", persona, "jev"]);
  }

  // Non-TTY fallback: the same flow asked through clack.
  const { configureJev } = await import("../tui/jevFlow.ts");
  p.intro("Configure the Jev screener");
  const chosen = await configureJev(
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
      "Configure the optional TypeSafe Jev screener (threat judge and/or brain-swap router). Validates the key before saving.",
  },
  args: {
    persona: {
      type: "string",
      required: false,
      description:
        "Persona to configure Jev for. Default: PHANTOMBOT_PERSONA env, then the host's default persona.",
    },
  },
  async run({ args }) {
    process.exitCode = await runJev({
      persona: args.persona as string | undefined,
    });
  },
});
