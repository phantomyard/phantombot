/**
 * Provenance of the vault secrets THIS process injected into `process.env`.
 *
 * Extracted from `vault.ts` so it can be imported by `config.ts` (#514).
 * `vault.ts` imports `loadConfig`, so a `config.ts -> vault.ts` edge would
 * close an import cycle; this module deliberately imports NOTHING, which lets
 * both sides read the same registry without one.
 *
 * The registry answers one question, asked wherever code resolves a secret for
 * a persona that may not be the one loaded at startup: did this value come
 * from a vault, and if so, WHOSE? An ambient key (shell export, systemd
 * `Environment=`) is host-wide and safe to fall back to. A vault-injected key
 * belongs to exactly one persona and must never stand in for another's.
 *
 * `vault.ts` owns the writes (`noteVaultInjection` / `forgetVaultInjection` /
 * `noteVaultLoadedPersonaDir`); everyone else only reads.
 */

/**
 * Env keys THIS process injected from a vault. Mirrors envBootstrap's
 * `_moduleTracked`: it lets a later reload for a DIFFERENT persona reconcile —
 * updating a key to the new persona's value, or removing it if the new persona
 * doesn't have it — without ever touching a key that was already in the
 * environment at boot.
 */
const _vaultTracked = new Set<string>();

/** The persona dir whose vault we last successfully injected. */
let _vaultLoadedPersonaDir: string | undefined;

/**
 * Record which persona's vault was last injected into `process.env`; pass
 * `undefined` when a failed open has just stripped the injected keys.
 */
export function noteVaultLoadedPersonaDir(
  personaDirPath: string | undefined,
): void {
  _vaultLoadedPersonaDir = personaDirPath;
}

/**
 * The live tracking set. `loadVaultIntoEnv` mutates it in place as it
 * reconciles, and takes it as a defaulted parameter so a test can substitute
 * an isolated set without touching the process-wide registry.
 */
export function vaultTrackedKeys(): Set<string> {
  return _vaultTracked;
}

/**
 * True when `name` in `process.env` was injected there from a VAULT by this
 * process (rather than inherited from the shell / a systemd `Environment=`).
 */
export function isVaultInjectedEnvKey(
  name: string,
  tracked: Set<string> = _vaultTracked,
): boolean {
  return tracked.has(name);
}

/**
 * True when `personaDirPath` is the persona whose vault this process last
 * injected into `process.env`.
 *
 * Lets a resolver tell the two cases a vault-injected key can be in apart. If
 * the key belongs to a DIFFERENT persona it must never stand in; if it belongs
 * to THIS persona it is that persona's own secret, still in the environment
 * because `loadVaultIntoEnv` deliberately leaves injected keys in place when
 * the same persona's vault fails to open transiently.
 */
export function isVaultLoadedPersonaDir(personaDirPath: string): boolean {
  return (
    _vaultLoadedPersonaDir !== undefined &&
    personaDirPath === _vaultLoadedPersonaDir
  );
}

/** For tests: reset the module-scope vault env tracking. */
export function _resetVaultTrackingForTesting(): void {
  _vaultTracked.clear();
  _vaultLoadedPersonaDir = undefined;
}
