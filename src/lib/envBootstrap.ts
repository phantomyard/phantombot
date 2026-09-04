/**
 * Per-spawn persona environment for harness subprocesses.
 *
 * Injects non-interactive environment defaults (`CI=true`,
 * `DEBIAN_FRONTEND=noninteractive`, `GIT_TERMINAL_PROMPT=0`) so tool subshells
 * (Vitest, Jest, Git, Debian/APT, etc.) run in one-shot non-interactive mode
 * rather than stalling on interactive prompts, spinners, or watch-mode listeners.
 * Defaults are applied before caller-provided environment (`base`) so explicit
 * overrides (e.g. when tools or UI libraries like Ink alter behaviour under CI)
 * remain possible.
 *
 * HISTORY — this module used to self-source `~/.env` and
 * `~/.config/phantombot/.env` into `process.env` at startup
 * (`preloadEnvFiles`) and re-source them before every harness spawn
 * (`reloadEnvFiles`). Both are GONE (issue #452): plaintext `.env` is now a
 * ONE-WAY LEGACY IMPORT — `vaultMigrate.ts` folds it into the encrypted
 * per-persona vaults once, and nothing reads the file at runtime ever again.
 * Secrets reach `process.env` only via `loadVaultIntoEnv()`; non-secret model
 * and routing settings live in `config.toml`.
 *
 * Do not reintroduce a runtime `.env` read here. A read path is what made the
 * file authoritative-in-practice while the docs called the vault canonical;
 * `tests/lib-envFile.test.ts` guards against new ones.
 */

export const NON_INTERACTIVE_ENV: Readonly<Record<string, string>> = Object.freeze({
  CI: "true",
  DEBIAN_FRONTEND: "noninteractive",
  GIT_TERMINAL_PROMPT: "0",
});

/**
 * Return a copy of `base` with phantombot's per-turn context and non-interactive
 * environment variables set so spawned harness subprocesses can self-identify,
 * safely mutate conversation-scoped runtime state, and execute child tools non-interactively.
 * Per-spawn and copy-on-write: we never mutate the caller's env (notably the global `process.env`).
 *
 * One helper, shared by all harnesses, so the var names can't drift.
 */
export function withPersonaEnv<T extends NodeJS.ProcessEnv>(
  base: T,
  persona: string | undefined,
  conversation?: string,
  turnId?: string,
): T {
  return {
    ...NON_INTERACTIVE_ENV,
    ...base,
    ...(persona ? { PHANTOMBOT_PERSONA: persona } : {}),
    ...(conversation ? { PHANTOMBOT_CONVERSATION: conversation } : {}),
    ...(turnId ? { PHANTOMBOT_TURN_ID: turnId } : {}),
  } as T;
}

