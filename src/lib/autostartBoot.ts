/**
 * Boot-start setup for the TUI's Autostart selector — the "survives logged-off"
 * half of autostart. Login-level autostart is the historical behaviour (user
 * units / LaunchAgents / logon tasks, no credentials needed); Boot needs
 * platform privileges, so it lives behind this module with every subprocess
 * and secret read injected for tests.
 *
 *   - Linux   → `sudo loginctl enable-linger <user>` — the user manager
 *               (systemd --user) then starts at boot and brings the units up.
 *               Runs as the USER, never root; sudo only touches linger.
 *   - Windows → re-register the persona's task set in password mode via the
 *               same `installPhantombotTasks` machinery `phantombot install`
 *               uses, with the credential validated first.
 *
 * macOS is deliberately NOT here yet: a boot start there means a root-owned
 * LaunchDaemon set (label collisions with the gui agent, duplicate instances,
 * root-owned file writes) — real installer territory. The TUI offers Boot only
 * where it is actually implemented, so the menu never lies.
 *
 * Credential doctrine:
 *   - Linux: the sudo password is used IN MEMORY for the single
 *     `enable-linger` call and NEVER persisted. Vault rows are exported into
 *     every agent turn's environment at daemon start (loadVaultIntoEnv has no
 *     allow-list, and filterAuthEnv only strips ANTHROPIC- and CLAUDE_CODE-
 *     prefixed keys),
 *     so a stored SUDO_PASSWORD would put a root-escalating credential within
 *     reach of anything an agent shells out to. Nothing on Linux re-reads it —
 *     linger is one-shot persistent state.
 *   - Windows: the account password IS stored (WINDOWS_PASSWORD, default
 *     persona's vault) — task re-registration genuinely re-reads it, and
 *     cli/install.ts already stores it under the same key. If Default moves,
 *     the new default's vault has no credential → the TUI re-prompts;
 *     nothing is silently reused across a default move.
 */

/** How a platform operation turned out. */
export type BootSetupOutcome =
  | { status: "ok" }
  /** The credential was explicitly rejected — the caller must re-prompt. */
  | { status: "invalid-credential"; error: string }
  | { status: "failed"; error: string };

export interface SpawnResult {
  exit: number;
  stdout: string;
  stderr: string;
}

export interface SpawnRunner {
  run(argv: string[], opts?: { input?: string }): Promise<SpawnResult>;
}

const SUDO = "sudo";

/**
 * Probe whether sudo NEEDS NO PASSWORD right now (`sudo -n true`). Many
 * Linux/Mac setups are (NOPASSWD wheel, CI images); when it is, Boot skips
 * the password prompt entirely. `sudo -n` fails fast with exit ≠ 0 when a
 * password would be required.
 *
 * Caveat: this CANNOT distinguish a true NOPASSWD rule from a cached sudo
 * timestamp (15 min by default) — a user who ran sudo shortly before gets
 * the prompt-free branch either way. Callers must not present the result as
 * a claim about the host's sudoers policy.
 */
export async function probeSudoPasswordless(
  runner: SpawnRunner,
): Promise<boolean> {
  const r = await runner.run([SUDO, "-n", "true"]);
  return r.exit === 0;
}

/**
 * Linux boot start via passwordless sudo — no credential involved. Fails
 * closed: any non-zero exit is "failed" (a passwordless probe that passed
 * but a real command that failed means something else is wrong, not the
 * credential).
 */
export async function enableBootLinuxPasswordless(
  user: string,
  runner: SpawnRunner,
): Promise<BootSetupOutcome> {
  const r = await runner.run(
    [SUDO, "-n", "loginctl", "enable-linger", user],
  );
  if (r.exit === 0) return { status: "ok" };
  return {
    status: "failed",
    error: (r.stderr || r.stdout).trim() || `loginctl enable-linger exited ${r.exit}`,
  };
}

/** Validate a sudo password WITHOUT caching a timestamp (-k) — probe only. */
export async function validateSudoPassword(
  password: string,
  runner: SpawnRunner,
): Promise<BootSetupOutcome> {
  const r = await runner.run([SUDO, "-S", "-k", "-v"], { input: `${password}\n` });
  if (r.exit === 0) return { status: "ok" };
  const err = (r.stderr || r.stdout).trim();
  return {
    status: err.toLowerCase().includes("incorrect password") || err.includes("no password was provided")
      ? "invalid-credential"
      : "failed",
    error: err || `sudo exited ${r.exit}`,
  };
}

/**
 * Linux: enable linger for `user`. Runs as the user, never root — sudo is
 * only the privilege bridge for `loginctl enable-linger`, the exact scope
 * Andrew set ("it should boot as the user, never as root").
 */
export async function enableBootLinux(
  password: string,
  user: string,
  runner: SpawnRunner,
): Promise<BootSetupOutcome> {
  const v = await validateSudoPassword(password, runner);
  if (v.status !== "ok") return v;
  // The -v above validated WITHOUT caching; re-authenticate this invocation.
  const r = await runner.run(
    [SUDO, "-S", "-k", "loginctl", "enable-linger", user],
    { input: `${password}\n` },
  );
  if (r.exit === 0) return { status: "ok" };
  const err = (r.stderr || r.stdout).trim();
  return {
    status: err.toLowerCase().includes("incorrect password")
      ? "invalid-credential"
      : "failed",
    error: err || `loginctl enable-linger exited ${r.exit}`,
  };
}

/**
 * Vault key for the Windows boot credential, stored in the DEFAULT persona's
 * vault: if Default moves, the new default's vault has no record → the TUI
 * re-prompts (never silently reused across a default move). The Linux sudo
 * password has NO vault key by design — see the credential doctrine at the
 * top of this file. Must match cli/install.ts's key of the same name.
 */
export const WINDOWS_PASSWORD_VAULT_KEY = "WINDOWS_PASSWORD";

/** Read a boot credential from `persona`'s vault; null when absent/unreadable. */
export async function readBootCredential(
  personaDir: string,
  key: string,
): Promise<string | null> {
  try {
    const { openPersonaVault } = await import("./vault.ts");
    const { existsSync } = await import("node:fs");
    const { vaultPath } = await import("./vault.ts");
    if (!existsSync(vaultPath(personaDir))) return null;
    const vault = await openPersonaVault(personaDir);
    try {
      return vault.get(key) ?? null;
    } finally {
      vault.close();
    }
  } catch {
    return null;
  }
}

/**
 * Persist a boot credential into `persona`'s vault (encrypted at rest).
 * WINDOWS-ONLY: never call this with a sudo password — see the credential
 * doctrine at the top of this file.
 */
export async function saveBootCredential(
  personaDir: string,
  key: string,
  value: string,
): Promise<void> {
  const { openPersonaVault } = await import("./vault.ts");
  const vault = await openPersonaVault(personaDir);
  try {
    vault.set(key, value);
  } finally {
    vault.close();
  }
}

export interface WindowsBootParams {
  /** Override the transient XML import dir (tests keep writes in a tmpdir). */
  xmlDir?: string;
  schtasks?: unknown;
  out: { write(s: string): void };
  err: { write(s: string): void };
}

/**
 * Windows: re-register `persona`'s task set in password (boot) mode through
 * the exact machinery `phantombot install` uses — same launcher, same
 * login-fallback twin, same boot-schema marker — so the TUI and the CLI
 * cannot disagree about what "boot start" means on Windows.
 *
 * The caller has ALREADY validated the credential (install's
 * `defaultValidateWindowsCredential`), matching install's own ordering:
 * a blank or wrong password never registers a boot task.
 */
export async function enableBootWindows(
  binPath: string,
  persona: string,
  username: string,
  password: string,
  params: WindowsBootParams,
): Promise<BootSetupOutcome> {
  try {
    const { installPhantombotTasks } = await import("./taskScheduler.ts");
    const opts = {
      binPath,
      persona,
      logon: { mode: "password" as const, username, password },
      out: params.out,
      err: params.err,
      ...(params.xmlDir ? { xmlDir: params.xmlDir } : {}),
    };
    const result = await installPhantombotTasks({
      ...opts,
      // Tests inject a fake runner; production builds the real one here so
      // this module stays platform-agnostic above the process boundary.
      schtasks: (params.schtasks as never) ?? new (await import("./taskScheduler.ts")).BunSchtasksRunner(),
    });
    return result.installed
      ? { status: "ok" }
      : { status: "failed", error: "task registration did not complete" };
  } catch (e) {
    return { status: "failed", error: (e as Error).message };
  }
}
