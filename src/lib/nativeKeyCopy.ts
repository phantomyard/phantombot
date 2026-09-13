/**
 * Native-harness API-key resolution and one-time COPY from the legacy host
 * auth store into the persona vault.
 *
 * The defect this closes (2026-09-13, Atlas): #549's upgrade mapped legacy
 * `pi` slots to native WITHOUT first copying their API key anywhere. Native
 * kept working only through the key living in the user's own
 * `~/.pi/agent/auth.json` — so the day the user uninstalled pi and deleted
 * `~/.pi`, both native harnesses died with pi's cryptic "No API key found",
 * while doctor kept reporting "ok". That dependency is now forbidden twice
 * over:
 *
 *   1. RUNTIME — native never reads the host auth store (see
 *      lib/nativeAgentDir.ts; the embedded engine gets its own agent dir).
 *      The key travels per-turn from the vault via `--api-key`.
 *   2. MIGRATION — before anything depends on native, the key is COPIED into
 *      the persona vault from the legacy sources, and only sources. This
 *      module owns that copy: startup (run.ts) and `phantombot doctor` both
 *      call it, idempotently, for every native slot in every served chain.
 *
 * Copy order per missing slot (first win):
 *   a. the vault row already holds the secret            → stored (no write)
 *   b. the host's legacy `~/.pi/agent/auth.json` holds an
 *      api_key for the slot's provider                    → copy (the ONE
 *      sanctioned read of that file; it is the key's
 *      only pre-native home)
 *   c. the vault's OPENROUTER_API_KEY row, when the slot's
 *      provider is openrouter (a pre-native host often
 *      keyed that row for other tooling)                  → copy
 *   d. a SIBLING native slot of the same persona whose
 *      provider matches and whose key resolves            → copy (a
 *      native→native chain shares one provider key)
 *
 * A slot that resolves from none of these is REPORTED, never invented: doctor
 * turns it into a FAIL naming the secret, `doctor --fix` asks the operator
 * once, and a native turn fails with an error that names the exact fix.
 */

import { existsSync, readFileSync } from "node:fs";
import { personaDir, type Config } from "../config.ts";
import { nativeApiKeyNameFor } from "../harnesses/buildChain.ts";
import { identityFromNsec } from "./nostrIdentity.ts";
import { readPersonaIdentityNsec } from "./personaIdentity.ts";
import { piAuthJsonPath } from "./piAuthStore.ts";
import { openPersonaVault, openVaultWithSecret, vaultPath } from "./vault.ts";

export interface NativeSlotKey {
  /** Chain id (native, pi-primary, pi-fallback, ...). */
  id: string;
  /** The vault secret the embedded engine reads this slot's key from. */
  secretName: string;
  /** The configured provider (undefined = no routing). */
  provider?: string;
}

/** Where a slot's key came from — or that it is missing. */
export type NativeKeySource =
  | "stored"
  | "auth-store"
  | "openrouter-row"
  | "sibling"
  | "missing";

export interface NativeKeyStatus {
  id: string;
  secretName: string;
  provider?: string;
  source: NativeKeySource;
}

export interface NativeKeyCopyResult {
  slots: NativeKeyStatus[];
  /** Slots this call WROTE a new vault row for. */
  copied: { id: string; secretName: string; from: NativeKeySource }[];
  /** Slots with no resolvable key after the copy pass. */
  stillMissing: NativeKeyStatus[];
}

/** Vault seam — the copy pass reads and writes the persona's encrypted vault. */
export interface NativeKeyVault {
  get(name: string): string | undefined;
  set(name: string, value: string): void;
  /** Optional close for openers that hold a real connection. */
  close?(): void;
}

export interface CopyNativeKeysInput {
  config: Config;
  /** Persona whose chains to audit; undefined = the host's own chain. */
  persona?: string;
  /**
   * Vault access. In production: the persona's real vault (opened read-write
   * when `personaDir` is given). Tests inject a map-backed fake.
   */
  vault?: NativeKeyVault;
  /** Persona dir used to open the real vault when `vault` is not injected. */
  personaDir?: string;
  /**
   * Vault opener override (doctor uses a READ-ONLY-constructing opener: it
   * must never generate an identity for a persona that has none). Default:
   * openPersonaVault(personaDir). Return undefined when no vault can be
   * opened — the audit then reports every slot from env/auth sources only.
   */
  openVault?: () => Promise<NativeKeyVault | undefined>;
  /**
   * The legacy host auth store to copy FROM. Defaults to the real
   * `~/.pi/agent/auth.json`; tests point this at a fixture.
   */
  authPath?: string;
  /** The caller owns closing an injected vault; default false = we opened it. */
  vaultInjected?: boolean;
  /**
   * Resolve sources WITHOUT writing (doctor --no-repair's audit): copied[] is
   * still reported as the source that WOULD be used, but no vault row is set.
   */
  dryRun?: boolean;
}

/**
 * Open a persona's vault ONLY if it already exists — never provision.
 *
 * `openPersonaVault` calls `getOrCreatePersonaIdentity`, which GENERATES an
 * identity.json (and the open creates vault.sqlite) for a persona that has
 * neither. An inspection must not do that (doctor's "never provisions a
 * persona it only inspected" invariant), so read-only callers use this: no
 * identity or no vault file → undefined, and the audit reports from the
 * legacy auth store only.
 */
export async function openExistingPersonaVault(
  dir: string,
): Promise<NativeKeyVault | undefined> {
  if (!existsSync(vaultPath(dir))) return undefined;
  const nsec = readPersonaIdentityNsec(dir);
  if (!nsec) return undefined;
  return openVaultWithSecret(dir, identityFromNsec(nsec).secretKey);
}

/**
 * Every native slot the given persona (or the host chain) can run, with the
 * secret name the turn actually reads — the SAME resolution
 * `nativeApiKeyNameFor` uses, so doctor and the Vault screen can never
 * disagree with the runtime.
 */
export function nativeSlotsFor(config: Config, persona?: string): NativeSlotKey[] {
  // Same resolution harnessChainIds uses: a persona's own chain when it has
  // one, the host chain otherwise — so the audit covers exactly what turns run.
  const override = persona ? config.harnesses.personas?.[persona]?.chain : undefined;
  const ids = new Set<string>(override && override.length > 0 ? override : config.harnesses.chain);
  const out = new Map<string, NativeSlotKey>();
  for (const id of ids) {
    const secretName = nativeApiKeyNameFor(config, id);
    if (!secretName) continue;
    const instance = config.harnesses.instances?.[id];
    const routing = instance ? instance.routing : config.harnesses.pi.routing;
    out.set(secretName, {
      id,
      secretName,
      provider: routing?.provider || undefined,
    });
  }
  return [...out.values()];
}

/**
 * Read an api_key entry for `provider` out of a pi auth.json
 * (`{ "<provider>": { "type": "api_key", "key": "…" } }`). OAuth entries are
 * NOT api keys — pi cannot thread one onto `--api-key`, so they don't count.
 */
export function readAuthStoreKey(
  authPath: string,
  provider: string,
): string | undefined {
  if (!provider) return undefined;
  try {
    if (!existsSync(authPath)) return undefined;
    const parsed: unknown = JSON.parse(readFileSync(authPath, "utf8"));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return undefined;
    }
    const entry = (parsed as Record<string, unknown>)[provider];
    if (!entry || typeof entry !== "object") return undefined;
    const e = entry as Record<string, unknown>;
    if (e.type !== "api_key") return undefined;
    const key = e.key;
    return typeof key === "string" && key.trim() ? key.trim() : undefined;
  } catch {
    return undefined;
  }
}

/**
 * The full copy pass for one persona's native slots. Idempotent: a second run
 * finds every slot `stored` and copies nothing. Never throws — a vault or
 * auth-store failure degrades to `missing` (doctor reports it; a turn fails
 * with the actionable error) rather than taking down startup.
 */
export async function copyNativeKeys(
  input: CopyNativeKeysInput,
): Promise<NativeKeyCopyResult> {
  const slots = nativeSlotsFor(input.config, input.persona);
  const authPath = input.authPath ?? piAuthJsonPath();

  let openedByUs: NativeKeyVault | undefined;
  let vault = input.vault;
  if (!vault && input.personaDir) {
    try {
      if (input.openVault) {
        const opened = await input.openVault();
        if (opened) {
          vault = opened;
          openedByUs = opened;
        }
      } else {
        openedByUs = await openPersonaVault(input.personaDir);
        vault = openedByUs;
      }
    } catch {
      vault = undefined; // no vault / unreadable → nothing stored, nothing copied
    }
  }

  const copied: NativeKeyCopyResult["copied"] = [];
  const statuses: NativeKeyStatus[] = [];
  // The key each resolved slot holds — written OR, under dryRun, would-be.
  // Sibling lookup reads this, never the vault: a dry run writes nothing, so
  // re-reading the vault would report a slot --fix WOULD fill as missing.
  const values = new Map<string, string>();
  const resolve = (status: NativeKeyStatus, from: NativeKeySource, key: string): void => {
    if (!input.dryRun) vault!.set(status.secretName, key);
    values.set(status.secretName, key);
    status.source = from;
    copied.push({ id: status.id, secretName: status.secretName, from });
  };
  try {
    // First sweep: what already resolves (stored rows, incl. sibling keys).
    for (const slot of slots) {
      const stored = vault?.get(slot.secretName)?.trim();
      if (stored) values.set(slot.secretName, stored);
      statuses.push({
        ...slot,
        source: stored ? "stored" : "missing",
      });
    }

    // Second sweep: fill the gaps from the sanctioned sources. A dry run with
    // no openable vault still reports what the auth store would supply.
    for (const status of statuses) {
      if (status.source !== "missing") continue;
      const provider = status.provider;
      if (!provider || (!vault && !input.dryRun)) continue;

      // (b) legacy host auth store — the key's only pre-native home.
      const authKey = readAuthStoreKey(authPath, provider);
      if (authKey) {
        resolve(status, "auth-store", authKey);
        continue;
      }

      // (c) an OPENROUTER_API_KEY vault row for an openrouter slot.
      if (provider === "openrouter") {
        const row = vault?.get("OPENROUTER_API_KEY")?.trim();
        if (row) {
          resolve(status, "openrouter-row", row);
          continue;
        }
      }

      // (d) a sibling native slot with the same provider whose key resolves.
      const sibling = statuses.find(
        (s) =>
          s.secretName !== status.secretName &&
          s.provider === provider &&
          values.has(s.secretName),
      );
      if (sibling) resolve(status, "sibling", values.get(sibling.secretName)!);
    }
  } finally {
    if (openedByUs && !input.vaultInjected) openedByUs.close?.();
  }

  return {
    slots: statuses,
    copied,
    stillMissing: statuses.filter((s) => s.source === "missing"),
  };
}

/**
 * The startup pass: run the copy for EVERY served persona, so a host that
 * upgrades and never runs doctor still serves. A persona without a chain
 * override audits the host chain (the same resolution turns use). Best-effort
 * per persona — one unreadable persona must not stop the others. Returns one
 * entry per audited persona that HAS native slots (for logging).
 */
export async function copyNativeKeysForServedPersonas(input: {
  config: Config;
  personas: readonly string[];
  authPath?: string;
}): Promise<{ persona: string; result: NativeKeyCopyResult }[]> {
  const out: { persona: string; result: NativeKeyCopyResult }[] = [];
  for (const persona of input.personas) {
    const slots = nativeSlotsFor(input.config, persona);
    if (slots.length === 0) continue;
    const result = await copyNativeKeys({
      config: input.config,
      persona,
      personaDir: personaDir(input.config, persona),
      authPath: input.authPath,
    });
    out.push({ persona, result });
  }
  return out;
}