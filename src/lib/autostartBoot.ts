/**
 * Boot-start setup for the TUI's Autostart selector — the "survives logged-off"
 * half of autostart. Login-level autostart is the historical behaviour (user
 * units / LaunchAgents / logon tasks, no credentials needed); Boot needs
 * platform privileges, so it lives behind this module with every subprocess
 * and secret read injected for tests.
 *
 *   - Linux   → enable-only linger doctrine (Andrew/Robbie, 2026-08-31):
 *               Boot = linger ON (a one-way prerequisite — enabled if
 *               missing, NEVER disabled by phantombot) + the daemon unit
 *               enabled (`systemctl --user enable phantombot.service` — no
 *               sudo). Login = unit disabled + a marked, idempotent start
 *               line in ~/.profile. Off = unit disabled + line removed.
 *               The unit, not linger, is what phantombot stops booting.
 *               Runs as the USER, never root; sudo only ever touches
 *               enable-linger.
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
 * Where boot-level state lives per platform (test seams override):
 *   - Linux   → the daemon unit's enabled state (`systemctl --user
 *               is-enabled phantombot.service`). Linger is deliberately NOT
 *               read for display: it is a host prerequisite (also set by
 *               `phantombot init`, possibly carrying other services), not
 *               an autostart feature, and under the enable-only doctrine it
 *               is never torn down — so it cannot be boot state we own.
 *   - macOS   → /Library/LaunchDaemons/dev.phantombot.*.plist
 *               (host-level; our tooling doesn't create these YET, but the
 *               probe detects a daemon set up by any earlier install path)
 *   - Windows → per-persona logon marker (windows-logon-<persona>.json):
 *               mode "password" IS boot level — the task runs logged-off.
 */
export interface BootStatePaths {
  lingerDir?: string;
  daemonDir?: string;
  /** Test seam — override the Linux unit-enabled probe. */
  /** Test seam — override the platform branch (default: real host). */
  platform?: "linux" | "darwin" | "windows" | "unsupported";
  /** Test seam — override the Windows logon-marker reader. */
  logonReader?: (persona: string) => Promise<{ mode: string }>;
}

/**
 * Read-only boot-state probe — does the platform ACTUALLY start this
 * persona (or, on Linux/macOS, the host) without a login? No sudo, no
 * elevation anywhere; on Linux it runs `systemctl --user is-enabled`, on
 * macOS it is a pure fs check, on Windows it reads the persona's persisted
 * logon marker. This is what lets the Autostart selector DISPLAY a
 * pre-existing boot setup (an enabled daemon unit, a password-mode task
 * from `phantombot install`) as Boot instead of silently mislabelling it
 * Login.
 *
 * ENABLE-ONLY NOTE: on Linux there is NOTHING to probe. The daemon unit is
 * enabled unconditionally by the installer (phantombot install), so an
 * enabled unit is the always-run default state, not a Boot choice — deriving
 * display or teardown ownership from `is-enabled` mislabels every standard
 * install as Boot and arms teardown against state phantombot did not choose
 * (review blocker, 2026-08-31). On Linux, boot is RECORD-expressed only: a
 * `boot` record is written when Boot is selected and is the sole source for
 * display and for teardown. Linger is likewise display-invisible (one-way
 * prerequisite, never boot state we own).
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
      // Records-only: an enabled unit is the installer's unconditional
      // default, so no live probe can discriminate a Boot choice. Unrecorded
      // personas display Login; only a recorded mode=boot shows Boot.
      return false;
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

/** The daemon unit the enable-only doctrine toggles. */
export const SYSTEMD_UNIT = "phantombot.service";

/**
 * Is linger ON for this user? Read-only fs check — linger is a one-way
 * prerequisite under the enable-only doctrine: phantombot enables it when
 * a Boot start needs it and NEVER disables it (it is host state that may
 * carry other systemd --user services).
 */
export async function probeLingerLinux(
  user?: string,
  lingerDir?: string,
): Promise<boolean> {
  const { existsSync } = await import("node:fs");
  const name = user ?? (await import("node:os")).userInfo().username;
  return existsSync(joinPath(lingerDir ?? "/var/lib/systemd/linger", name));
}

/**
 * Is the daemon unit currently enabled? Read-only probe (exit 0 = enabled).
 */
export async function probeDaemonUnitEnabled(
  runner: SpawnRunner,
): Promise<boolean> {
  const r = await runner.run(["systemctl", "--user", "is-enabled", SYSTEMD_UNIT]);
  return r.exit === 0;
}

/**
 * Enable the daemon unit — THE boot start on Linux. No sudo, no linger
 * touch: with linger on (a prerequisite this module enables when missing)
 * the user manager starts the unit at boot.
 */
export async function enableDaemonUnit(
  runner: SpawnRunner,
): Promise<BootSetupOutcome> {
  const r = await runner.run(["systemctl", "--user", "enable", SYSTEMD_UNIT]);
  if (r.exit === 0) return { status: "ok" };
  return {
    status: "failed",
    error: (r.stderr || r.stdout).trim() || `systemctl --user enable exited ${r.exit}`,
  };
}

/**
 * Disable the daemon unit — the Boot teardown under the enable-only
 * doctrine: phantombot stops booting by disabling ITS OWN unit, never by
 * touching host linger. No sudo. Does not stop a running daemon (that is
 * the daemon lifecycle, not autostart).
 */
export async function disableDaemonUnit(
  runner: SpawnRunner,
): Promise<BootSetupOutcome> {
  const r = await runner.run(["systemctl", "--user", "disable", SYSTEMD_UNIT]);
  if (r.exit === 0) return { status: "ok" };
  return {
    status: "failed",
    error: (r.stderr || r.stdout).trim() || `systemctl --user disable exited ${r.exit}`,
  };
}

/** The marked login-start block we own inside the hook file. */
export const LOGIN_HOOK_MARKER = "# phantombot login-start (managed — do not edit)";
/**
 * The login hook phantombot manages. ~/.profile is sourced by login bash
 * shells (console and most SSH logins); GUI-session coverage varies by
 * distro, which is an accepted v1 caveat — the unit-level Boot path is the
 * primary doctrine and Login via hook is the fallback.
 */
export const LOGIN_HOOK_PATH = ".profile";

/**
 * Resolve the login hook path. Returns null when HOME is unset — a relative
 * `.profile` written into the process cwd would be a silent mis-write, so we
 * fail instead.
 */
function loginHookPath(home?: string): string | null {
  const dir = home ?? ("HOME" in process.env ? process.env.HOME! : "");
  if (!dir) return null;
  return joinPath(dir, LOGIN_HOOK_PATH);
}

/** Does the hook file currently carry our marked start line? */
export async function probeLoginHook(home?: string): Promise<boolean> {
  const { readFileSync, existsSync } = await import("node:fs");
  const p = loginHookPath(home);
  if (!p || !existsSync(p)) return false;
  try {
    return readFileSync(p, "utf8").includes(LOGIN_HOOK_MARKER);
  } catch {
    return false;
  }
}

/**
 * Add or remove OUR marked login-start block in the hook file — idempotent,
 * and it only ever touches lines between our marker comments; anything the
 * user (or another tool) wrote is untouched. `present=false` removes the
 * block; a file left empty by that is left as an empty file, not deleted.
 */
export async function writeLoginHook(
  present: boolean,
  home?: string,
): Promise<BootSetupOutcome> {
  const { readFileSync, writeFileSync, existsSync, statSync } = await import("node:fs");
  const p = loginHookPath(home);
  if (!p) {
    return { status: "failed", error: "HOME is not set — cannot locate the login hook file" };
  }
  const block = present
    ? `${LOGIN_HOOK_MARKER}\nsystemctl --user start ${SYSTEMD_UNIT} >/dev/null 2>&1 || true\n# <<< phantombot login-start <<<\n`
    : null;
  let body = "";
  let mode: number | undefined;
  if (existsSync(p)) {
    try {
      body = readFileSync(p, "utf8");
      // Preserve the file's permissions — writeFileSync would otherwise apply
      // the umask default and silently widen a restrictive .profile.
      mode = statSync(p).mode & 0o777;
    } catch (e) {
      return { status: "failed", error: `reading ${LOGIN_HOOK_PATH}: ${(e as Error).message}` };
    }
  }
  // Strip any existing block (marker line, start line, closing marker) so a
  // re-write never duplicates. Only OUR marker-delimited lines are removed.
  const lines = body.split("\n");
  const kept: string[] = [];
  let inBlock = false;
  for (const line of lines) {
    if (line === LOGIN_HOOK_MARKER) {
      inBlock = true;
      continue;
    }
    if (inBlock) {
      if (line === "# <<< phantombot login-start <<<") inBlock = false;
      continue;
    }
    kept.push(line);
  }
  // FAIL CLOSED: a marker with no closing marker means the file was
  // hand-edited or truncated mid-block. Skipping to EOF would discard every
  // user line after the marker, so we refuse to write and report it.
  if (inBlock) {
    return {
      status: "failed",
      error: `${LOGIN_HOOK_PATH} has an unterminated phantombot block (missing "${"# <<< phantombot login-start <<<"}") — fix or remove it by hand; nothing was changed`,
    };
  }
  while (kept.length > 0 && kept[kept.length - 1] === "") kept.pop();
  const next = block ? [...kept, block].join("\n") : kept.length > 0 ? `${kept.join("\n")}\n` : "";
  try {
    writeFileSync(p, next, mode !== undefined ? { mode } : undefined);
    return { status: "ok" };
  } catch (e) {
    return { status: "failed", error: `writing ${LOGIN_HOOK_PATH}: ${(e as Error).message}` };
  }
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
 * After a Boot persona leaves (Off/Login), does any REMAINING persona still
 * need the boot-level host start (the enabled daemon unit on Linux, the
 * LaunchDaemon on macOS)? Records-only by design: the enable-only doctrine
 * WRITES a `boot` record whenever Boot is selected, so a boot persona always
 * has a record; reading live unit state here would be circular (the unit is
 * still enabled because the OUTGOING persona enabled it). Windows tasks are
 * per-persona and torn down individually, so the caller only consults this
 * for Linux/macOS.
 */
export function bootHookStillNeeded(
  list: string[],
  recorded: Record<string, "login" | "boot"> | undefined,
): boolean {
  return list.some((p) => recorded?.[p] === "boot");
}

/**
 * After the change, do any remaining on-list personas need the LOGIN-level
 * start (the marked ~/.profile line on Linux)? Under the enable-only
 * doctrine every on-list persona that is not boot is login: when this is
 * true the hook line stays/lands, when false it is removed.
 */
export function loginHookNeeded(
  list: string[],
  recorded: Record<string, "login" | "boot"> | undefined,
): boolean {
  return list.some((p) => (recorded?.[p] ?? "login") === "login");
}

/**
 * Linux: enable linger for `user` — a ONE-WAY prerequisite for boot starts
 * under the enable-only doctrine: phantombot enables it when a Boot start
 * needs it and NEVER disables it (it is host state that may carry other
 * systemd --user services). Runs as the user, never root — sudo is only the
 * privilege bridge for `loginctl enable-linger`, the exact scope Andrew set
 * ("it should boot as the user, never as root").
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
