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

/**
 * Where boot-level state lives per platform (test seams override the dirs):
 *   - Linux   → /var/lib/systemd/linger/<user>   (host-level; one flag)
 *   - macOS   → /Library/LaunchDaemons/dev.phantombot.*.plist
 *               (host-level; our tooling doesn't create these YET, but the
 *               probe detects a daemon set up by any earlier install path)
 *   - Windows → per-persona logon marker (windows-logon-<persona>.json):
 *               mode "password" IS boot level — the task runs logged-off.
 */
export interface BootStatePaths {
  lingerDir?: string;
  daemonDir?: string;
  /**
   * Linux only — does phantombot OWN the linger flag (the `[boot_hooks]`
   * marker written when the TUI ran enable-linger)? Linger is also a plain
   * `phantombot init` prerequisite and can be set by an admin; an unowned
   * flag is a host prerequisite, NOT a boot-autostart feature, so it must
   * not display as Boot (that would arm a teardown the ownership check
   * would only refuse). `false`/absent → linger present still means not
   * boot. Callers read the marker from the same host config as the
   * teardown, so display and teardown share one source of truth.
   */
  lingerOwned?: boolean;
  /** Test seam — override the platform branch (default: real host). */
  platform?: "linux" | "darwin" | "windows" | "unsupported";
  /** Test seam — override the Windows logon-marker reader. */
  logonReader?: (persona: string) => Promise<{ mode: string }>;
}

/**
 * Read-only boot-state probe — does the platform ACTUALLY start this
 * persona (or, on Linux/macOS, the host) without a login? No sudo, no
 * elevation, no subprocess on Linux/macOS (pure fs checks); on Windows it
 * reads the persona's persisted logon marker. This is what lets the
 * Autostart selector DISPLAY a pre-existing boot setup (linger enabled by
 * `phantombot init`, a password-mode task from `phantombot install`) as
 * Boot instead of silently mislabelling it Login.
 *
 * LINUX CAVEAT: linger is a phantombot PREREQUISITE (`phantombot init`
 * enables it so the user-systemd bus is reachable) and is per-USER host
 * state with no provenance — other systemd --user services may depend on
 * it. So on Linux the probe only reports Boot when phantombot owns the
 * flag (`lingerOwned`, from the `[boot_hooks]` marker): an inherited flag
 * is never mislabelled into arming a teardown.
 */
export async function probeBootState(
  persona: string,
  opts?: BootStatePaths,
): Promise<boolean> {
  const { existsSync, readdirSync } = await import("node:fs");
  const { currentPlatform } = await import("./platform.ts");
  const platform = opts?.platform ?? currentPlatform();
  try {
    if (platform === "linux") {
      if (opts?.lingerOwned !== true) return false; // not ours → not a boot-autostart feature
      const user = (await import("node:os")).userInfo().username;
      return existsSync(
        joinPath(opts?.lingerDir ?? "/var/lib/systemd/linger", user),
      );
    }
    if (platform === "darwin") {
      const dir = opts?.daemonDir ?? "/Library/LaunchDaemons";
      if (!existsSync(dir)) return false;
      return readdirSync(dir).some((f) => f.startsWith("dev.phantombot.") && f.endsWith(".plist"));
    }
    if (platform === "windows") {
      // The per-persona marker is the same source the heartbeat self-heal
      // reads — mode "password" means the task set runs logged-off (boot).
      const logon = opts?.logonReader
        ? await opts.logonReader(persona)
        : await (async () => {
            const { readTaskLogon } = await import("./taskScheduler.ts");
            return readTaskLogon(persona);
          })();
      return logon.mode === "password";
    }
    return false;
  } catch {
    return false; // unreadable state is not boot state — fail closed to Login
  }
}

function joinPath(dir: string, name: string): string {
  return dir.endsWith("/") || dir.endsWith("\\")
    ? `${dir}${name}`
    : `${dir}/${name}`;
}

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
 * The real subprocess runner (Bun.spawn) as a SpawnRunner. Lives here so
 * every sudo/task touchpoint in the TUI shares one implementation and the
 * tests inject a fake instead.
 */
export function bunSpawnRunner(): SpawnRunner {
  return {
    run: (argv, opts) =>
      new Promise((resolve) => {
        const child = Bun.spawn(argv, {
          stdin: opts?.input !== undefined ? "pipe" : "ignore",
          stdout: "pipe",
          stderr: "pipe",
        });
        if (opts?.input !== undefined && child.stdin) {
          child.stdin.write(opts.input);
          child.stdin.end();
        }
        void Promise.all([
          new Response(child.stdout).text(),
          new Response(child.stderr).text(),
          child.exited,
        ]).then(([stdout, stderr, exit]) => resolve({ exit, stdout, stderr }));
      }),
  };
}

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
 * Linux: disable linger (the Boot teardown). Passwordless path — same
 * fail-closed doctrine as enable: any non-zero exit is "failed".
 */
export async function disableBootLinuxPasswordless(
  user: string,
  runner: SpawnRunner,
): Promise<BootSetupOutcome> {
  const r = await runner.run([SUDO, "-n", "loginctl", "disable-linger", user]);
  if (r.exit === 0) return { status: "ok" };
  return {
    status: "failed",
    error: (r.stderr || r.stdout).trim() || `loginctl disable-linger exited ${r.exit}`,
  };
}

/**
 * Linux: disable linger with a validated password. Validates FIRST (-k, no
 * timestamp cached) so a wrong password never half-applies a teardown.
 */
export async function disableBootLinux(
  password: string,
  user: string,
  runner: SpawnRunner,
): Promise<BootSetupOutcome> {
  const v = await validateSudoPassword(password, runner);
  if (v.status !== "ok") return v;
  const r = await runner.run(
    [SUDO, "-S", "-k", "loginctl", "disable-linger", user],
    { input: `${password}\n` },
  );
  if (r.exit === 0) return { status: "ok" };
  const err = (r.stderr || r.stdout).trim();
  return {
    status: err.toLowerCase().includes("incorrect password")
      ? "invalid-credential"
      : "failed",
    error: err || `loginctl disable-linger exited ${r.exit}`,
  };
}

/** Our daemon plists in /Library/LaunchDaemons (macOS boot state). */
async function macDaemonPlists(daemonDir?: string): Promise<string[]> {
  const { existsSync, readdirSync } = await import("node:fs");
  const dir = daemonDir ?? "/Library/LaunchDaemons";
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.startsWith("dev.phantombot.") && f.endsWith(".plist"))
    .map((f) => joinPath(dir, f));
}

/**
 * macOS: bootout + remove our /Library/LaunchDaemons plists. Passwordless
 * path. Only touches plists whose name starts with our label prefix — a
 * foreign daemon is never unloaded.
 */
export async function teardownBootMacPasswordless(
  runner: SpawnRunner,
  opts?: BootStatePaths,
): Promise<BootSetupOutcome> {
  const plists = await macDaemonPlists(opts?.daemonDir);
  if (plists.length === 0) return { status: "ok" }; // nothing of ours to tear down
  for (const plist of plists) {
    const b = await runner.run([SUDO, "-n", "launchctl", "bootout", "system", plist]);
    const bErr = (b.stderr || b.stdout).trim();
    // Only the "not loaded" failure is tolerable — the daemon is already
    // down, which is the state teardown is driving toward. Any other
    // bootout failure (job busy, wrong domain) must ABORT before the rm:
    // removing the plist of a still-loaded daemon leaves it running and
    // unmanageable until reboot, and invisible to a later probe.
    if (b.exit !== 0 && !/not loaded|no such process/i.test(bErr)) {
      return {
        status: "failed",
        error: bErr || `bootout ${plist} exited ${b.exit} — plist left in place`,
      };
    }
    const r = await runner.run([SUDO, "-n", "rm", "-f", plist]);
    if (r.exit !== 0) {
      return {
        status: "failed",
        error: (r.stderr || r.stdout).trim() || `removing ${plist} exited ${r.exit}`,
      };
    }
  }
  return { status: "ok" };
}

/**
 * macOS: teardown with a validated password — validate first (-k), then run
 * the bootout+remove sequence with -S -k per command.
 */
export async function teardownBootMac(
  password: string,
  runner: SpawnRunner,
  opts?: BootStatePaths,
): Promise<BootSetupOutcome> {
  const v = await validateSudoPassword(password, runner);
  if (v.status !== "ok") return v;
  const plists = await macDaemonPlists(opts?.daemonDir);
  if (plists.length === 0) return { status: "ok" };
  for (const plist of plists) {
    const b = await runner.run([SUDO, "-S", "-k", "launchctl", "bootout", "system", plist], {
      input: `${password}\n`,
    });
    const bErr = (b.stderr || b.stdout).trim();
    // Same abort-before-rm doctrine as the passwordless path — and a wrong
    // password surfaces here as invalid-credential, not "failed".
    if (b.exit !== 0 && !/not loaded|no such process/i.test(bErr)) {
      return {
        status: bErr.toLowerCase().includes("incorrect password")
          ? "invalid-credential"
          : "failed",
        error: bErr || `bootout ${plist} exited ${b.exit} — plist left in place`,
      };
    }
    const r = await runner.run([SUDO, "-S", "-k", "rm", "-f", plist], {
      input: `${password}\n`,
    });
    if (r.exit !== 0) {
      const err = (r.stderr || r.stdout).trim();
      return {
        status: err.toLowerCase().includes("incorrect password")
          ? "invalid-credential"
          : "failed",
        error: err || `removing ${plist} exited ${r.exit}`,
      };
    }
  }
  return { status: "ok" };
}

/**
 * Windows: re-register `persona`'s task set in INTERACTIVE (login) mode —
 * the downgrade half of a Boot → Login change. Reuses the exact install
 * machinery so the marker, launcher and task XML all stay consistent (the
 * heartbeat self-heal would otherwise keep healing password-mode tasks).
 * No credential needed.
 */
export async function registerLoginTasksWindows(
  binPath: string,
  persona: string,
  params: WindowsBootParams,
): Promise<BootSetupOutcome> {
  try {
    const { installPhantombotTasks, BunSchtasksRunner } = await import("./taskScheduler.ts");
    const result = await installPhantombotTasks({
      binPath,
      persona,
      logon: { mode: "interactive" as const },
      out: params.out,
      err: params.err,
      ...(params.xmlDir ? { xmlDir: params.xmlDir } : {}),
      ...(params.sid ? { sid: params.sid } : {}),
      ...(params.accountName ? { accountName: params.accountName } : {}),
      schtasks: (params.schtasks as never) ?? new BunSchtasksRunner(),
    });
    return result.installed
      ? { status: "ok" }
      : { status: "failed", error: "task registration did not complete" };
  } catch (e) {
    return { status: "failed", error: (e as Error).message };
  }
}

export interface WindowsTeardownParams {
  schtasks?: unknown;
  sid?: string;
  accountName?: string;
  out: { write(s: string): void };
  err: { write(s: string): void };
}

/**
 * Windows: delete `persona`'s task set (password-mode = boot level). Uses
 * the same ownership-checked uninstall `phantombot uninstall` uses — a task
 * owned by another Windows account is never touched.
 */
export async function teardownBootWindows(
  persona: string,
  params: WindowsTeardownParams,
): Promise<BootSetupOutcome> {
  try {
    const mod = await import("./taskScheduler.ts");
    await mod.uninstallPhantombotTasks({
      persona,
      ...(params.sid ? { sid: params.sid } : {}),
      ...(params.accountName ? { accountName: params.accountName } : {}),
      schtasks:
        (params.schtasks as never) ?? new mod.BunSchtasksRunner(),
      out: params.out,
      err: params.err,
    });
    return { status: "ok" };
  } catch (e) {
    return { status: "failed", error: (e as Error).message };
  }
}

/**
 * After a Boot persona leaves (Off/Login), does ANY remaining autostart
 * persona still need the host-level boot hook (linger / LaunchDaemon)?
 * A member needs it when its EFFECTIVE mode is boot: recorded, or — for
 * records that predate or disagree with reality (a stale `login` entry on
 * a host where the persona's plist actually exists from an earlier
 * install path) — probed. Windows tasks are per-persona and torn down
 * individually, so the caller only consults this for Linux/macOS.
 */
export async function bootHookStillNeeded(
  list: string[],
  recorded: Record<string, "login" | "boot"> | undefined,
  probe: (persona: string) => Promise<boolean>,
): Promise<boolean> {
  for (const persona of list) {
    if (recorded?.[persona] === "boot") return true;
    if (await probe(persona)) return true; // login/undefined records: trust the PROBE over the record
  }
  return false;
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
  /** Test seams — task-principal identity (Windows resolves these live). */
  sid?: string;
  accountName?: string;
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
      ...(params.sid ? { sid: params.sid } : {}),
      ...(params.accountName ? { accountName: params.accountName } : {}),
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
