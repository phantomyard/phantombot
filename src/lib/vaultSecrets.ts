/**
 * Write a secret collected by an interactive wizard into a persona's encrypted
 * vault.
 *
 * Before #452 the wizards (`phantombot voice`, `phantombot harness`, the
 * OpenClaw importer) persisted the keys they collected to a plaintext `.env`
 * file. Nothing reads those files at runtime any more, so a wizard that still
 * wrote one would silently collect a key and drop it on the floor. This is the
 * single replacement path: the ACTIVE persona's vault, which
 * `loadVaultIntoEnv()` injects into `process.env` at startup and
 * `reloadVaultForPersona()` refreshes before every harness spawn.
 *
 * Per-persona by construction: voice, routing and API keys are persona-scoped
 * settings, so the secret lands beside the config.toml that references it
 * rather than in one host-wide file every persona shared.
 *
 * Never throws — a wizard must not die between "operator pasted a key" and
 * "config written". Callers report `ok: false` in their own UI idiom.
 */

import { type Config, personaDir } from "../config.ts";
import { log } from "./logger.ts";
import { existsSync } from "node:fs";

import {
  isVaultInjectedEnvKey,
  isVaultLoadedPersonaDir,
  openPersonaVault,
  vaultPath,
} from "./vault.ts";

export interface SetPersonaSecretResult {
  ok: boolean;
  /** Persona whose vault was written (resolved, never blank on ok). */
  persona?: string;
  error?: string;
}

/**
 * Store `name`=`value` in `persona`'s vault (default persona when omitted) and
 * verify it by reading it back through the decrypt path — the same validation
 * gate the plaintext migration uses, so a wizard never reports success for a
 * key that did not survive the round trip.
 *
 * Also mirrors the value into `process.env` so the CURRENT process (a wizard
 * that goes on to call `pi --list-models`, say) sees it without a restart.
 */
export async function setPersonaSecret(
  config: Config,
  name: string,
  value: string,
  persona?: string,
): Promise<SetPersonaSecretResult> {
  const target = persona || config.defaultPersona;
  try {
    const vault = await openPersonaVault(personaDir(config, target));
    try {
      vault.set(name, value);
      if (vault.get(name) !== value) {
        // Name only — never the value.
        log.warn("vault: read-back mismatch on wizard write", { name });
        return { ok: false, persona: target, error: "read-back mismatch" };
      }
    } finally {
      vault.close();
    }
  } catch (e) {
    log.warn("vault: wizard write failed", {
      name,
      error: (e as Error).message,
    });
    return { ok: false, persona: target, error: (e as Error).message };
  }
  process.env[name] = value;
  return { ok: true, persona: target };
}

/**
 * Remove `name` from `persona`'s vault (and from the current `process.env`) —
 * the counterpart to `setPersonaSecret` for a wizard that clears a credential
 * (e.g. switching Pi provider without supplying a new key). Absent name is a
 * no-op success. Never throws.
 */
export async function unsetPersonaSecret(
  config: Config,
  name: string,
  persona?: string,
): Promise<SetPersonaSecretResult> {
  const target = persona || config.defaultPersona;
  try {
    const vault = await openPersonaVault(personaDir(config, target));
    try {
      vault.unset(name);
    } finally {
      vault.close();
    }
  } catch (e) {
    log.warn("vault: wizard unset failed", {
      name,
      error: (e as Error).message,
    });
    return { ok: false, persona: target, error: (e as Error).message };
  }
  delete process.env[name];
  return { ok: true, persona: target };
}

/**
 * Read `name` from `persona`'s vault, falling back to `process.env`.
 *
 * The counterpart to `setPersonaSecret` for code that runs OUTSIDE a harness
 * spawn. `reloadVaultForPersona()` reconciles `process.env` before a spawn, so
 * a harness subprocess always sees the right persona's secrets — but the
 * daemon's own audio path (STT/TTS) runs in-process, in a listener that may be
 * one of SEVERAL personas served concurrently by one daemon. Reading
 * `process.env` there yields whichever persona `loadVaultIntoEnv` happened to
 * inject at startup: the default one. Before #452 that was harmless, because
 * the key lived in a single central plaintext file every persona shared; now
 * it lives in each persona's own vault, so a secondary persona would silently
 * find no key and go mute.
 *
 * Deliberately does NOT mutate `process.env`: two persona listeners can be
 * mid-turn at the same time, and writing a resolved key into the shared
 * environment is exactly how one persona's credential ends up on the other's
 * request. The value is returned to the caller and goes no further.
 *
 * The `process.env` fallback keeps pre-vault hosts working: a key exported by
 * the shell or set by a systemd `Environment=` is host-wide, so it is still
 * honoured when the persona's vault has no row of its own. A key this process
 * injected FROM a vault is not: it belongs to exactly one persona, and letting
 * it stand in here would put the startup persona's credential on a secondary
 * persona's request — nondeterministically, since `reloadVaultForPersona()`
 * rewrites those names before every harness spawn. A key injected from THIS
 * persona's own vault is fine, though: see `ambientEnvKeyAllowed`. Same guard
 * tick's `--secret` resolution applies. Never throws — an unopenable vault
 * degrades to the ambient fallback.
 */
export async function getPersonaSecret(
  config: Config,
  name: string,
  persona?: string,
): Promise<string | undefined> {
  const fromVault = await getPersonaSecretStrict(config, name, persona);
  if (fromVault !== undefined) return fromVault;
  if (!ambientEnvKeyAllowed(config, name, persona)) return undefined;
  return process.env[name];
}

/**
 * May `process.env[name]` stand in for `persona`'s missing vault row?
 *
 * Yes when the key was never injected from a vault by this process — it is a
 * host-wide value (shell export, systemd `Environment=`) and pre-vault hosts
 * depend on it. Yes, too, when it WAS injected but from this very persona's
 * vault: that is the persona's own secret, left in the environment because
 * `loadVaultIntoEnv` treats a same-persona open failure as a transient blip
 * rather than a reason to strip. No only for the case the guard exists for —
 * a key injected from a DIFFERENT persona's vault, which would put one
 * persona's credential on another's request, nondeterministically, since
 * `reloadVaultForPersona()` rewrites those names before every harness spawn.
 *
 * Shared by every resolver that reads a secret for a persona which may not be
 * the loaded one (`getPersonaSecret`, tick's `--secret`), so the two cannot
 * drift apart.
 */
export function ambientEnvKeyAllowed(
  config: Config,
  name: string,
  persona?: string,
): boolean {
  if (!isVaultInjectedEnvKey(name)) return true;
  const target = persona || config.personaLayer || config.defaultPersona;
  return isVaultLoadedPersonaDir(personaDir(config, target));
}

/**
 * Read `name` from `persona`'s vault and NOTHING ELSE — undefined when that
 * persona has no such row.
 *
 * The no-fallback half of `getPersonaSecret`, for callers that must not let
 * the ambient environment stand in. `phantombot tick` is the motivating case:
 * one process runs tasks for every persona, so a `process.env` hit there is
 * as likely to be a DIFFERENT persona's vault value (injected at startup) as
 * a host-wide export, and handing it to this task would be a cross-persona
 * credential leak. Callers that want the ambient fallback opt into it
 * explicitly. Never throws.
 */
export async function getPersonaSecretStrict(
  config: Config,
  name: string,
  persona?: string,
): Promise<string | undefined> {
  const target = persona || config.personaLayer || config.defaultPersona;
  const dir = personaDir(config, target);
  // Open-existing-only. This is a pure READ, and both openPersonaVault ->
  // getOrCreatePersonaIdentity and the vault opener create on demand — so
  // asking about a persona that has never been provisioned (a typo'd name, the
  // built-in default on a fresh box) would MINT an identity.json + vault, and
  // an nsec, that nobody asked for. Same rule as readAllVaultValues (#262):
  // no vault file means "no value", never "make one".
  if (!existsSync(vaultPath(dir))) return undefined;
  try {
    const vault = await openPersonaVault(dir);
    try {
      const value = vault.get(name);
      if (value !== undefined && value !== "") return value;
    } finally {
      vault.close();
    }
  } catch (e) {
    log.warn("vault: read failed", {
      name,
      persona: target,
      error: (e as Error).message,
    });
  }
  return undefined;
}
