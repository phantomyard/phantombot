/**
 * `phantombot install` — write the host-appropriate service-manager
 * units for `phantombot run` and start them.
 *
 *   - Linux   → systemd --user units in ~/.config/systemd/user/
 *   - macOS   → launchd plists in ~/Library/LaunchAgents/
 *   - Windows → Task Scheduler logon tasks under \Phantombot\
 *
 * Requires the compiled binary (process.execPath ends in 'phantombot' or
 * the user passes --bin). Running from `bun src/index.ts` won't work
 * because the resulting unit would point at the bun runtime + a script
 * path that's only valid in the dev directory.
 */

import { defineCommand } from "citty";
import { basename, dirname } from "node:path";
import * as p from "@clack/prompts";

import { installCompletions } from "../lib/completionInstall.ts";

import {
  BunLaunchctlRunner,
  defaultPlistPath,
  guiDomain,
  heartbeatPlistPath as launchdHeartbeatPath,
  installPhantombotPlists,
  type LaunchctlRunner,
  nightlyPlistPath as launchdNightlyPath,
  tickPlistPath as launchdTickPath,
} from "../lib/launchd.ts";
import { currentPlatform } from "../lib/platform.ts";
import {
  BunSystemctlRunner,
  buildSystemctlEnv,
  defaultUnitPath,
  ensureUserSystemdEnv,
  installPhantombotUnit,
  type SystemctlRunner,
  type UserSystemdEnv,
} from "../lib/systemd.ts";
import {
  BunSchtasksRunner,
  currentPersonaName,
  installPhantombotTasks,
  readTaskLogon,
  type SchtasksRunner,
  type TaskLogon,
  type TaskLogonMode,
} from "../lib/taskScheduler.ts";
import { openPersonaVault, vaultPath } from "../lib/vault.ts";
import { resolveVaultPersonaDir } from "./vault.ts";
import {
  loadConfig,
  personaDir,
  servedPersonasOf,
} from "../config.ts";
import { existsSync } from "node:fs";
import type { WriteSink } from "../lib/io.ts";

/** Vault key under which the Windows account password is stored so a later
 * reinstall / boot-schema migration can reuse it without re-prompting — the
 * same "press Enter to reuse the saved value" UX the harness uses for API
 * tokens. Per-persona, encrypted at rest with the persona's derived key. */
export const WINDOWS_PASSWORD_VAULT_KEY = "WINDOWS_PASSWORD";

/**
 * Trailing "here's how to manage it" block shown after a successful install,
 * identical on every OS. Advertises the clean `phantombot <verb>` subcommands
 * rather than the raw systemctl/launchctl/schtasks incantations — the CLI wraps
 * those per-platform, so the user never has to see or type them.
 */
export function manageHints(): string {
  return (
    `\nmanage phantombot:\n` +
    `  phantombot start      start the service\n` +
    `  phantombot stop       stop the service\n` +
    `  phantombot restart    restart the service\n` +
    `  phantombot logs       tail the service logs\n` +
    `  phantombot uninstall  remove the service\n`
  );
}

export interface RunInstallInput {
  binPath?: string;
  /** systemd unit path (Linux) — defaults to ~/.config/systemd/user/phantombot.service. */
  unitPath?: string;
  /** launchd plist path (macOS) — defaults to ~/Library/LaunchAgents/dev.phantombot.phantombot.plist. */
  plistPath?: string;
  /**
   * Optional path overrides for the heartbeat/nightly/tick companion
   * units — pass-through to the platform-specific install helpers.
   * Tests use these to keep all unit writes inside a tmpdir; production
   * leaves them undefined and the helper picks the per-user XDG / Library
   * locations.
   */
  heartbeatServicePath?: string;
  heartbeatTimerPath?: string;
  /** Test overrides for the retired pre-#486 heartbeat units (Linux). */
  legacyHeartbeatServicePath?: string;
  legacyHeartbeatTimerPath?: string;
  nightlyServicePath?: string;
  nightlyTimerPath?: string;
  tickServicePath?: string;
  tickTimerPath?: string;
  /**
   * Personas to arm heartbeat instances for (Linux, #486). Production
   * leaves this undefined and install derives it from the loaded config;
   * tests pass it explicitly to stay hermetic.
   */
  personas?: readonly string[];
  heartbeatPlistPath?: string;
  nightlyPlistPath?: string;
  tickPlistPath?: string;
  out?: WriteSink;
  err?: WriteSink;
  /** Override systemctl runner for testing. */
  systemctl?: SystemctlRunner;
  /** Override launchctl runner for testing. */
  launchctl?: LaunchctlRunner;
  /** Override schtasks runner for testing (Windows). */
  schtasks?: SchtasksRunner;
  /** Override the current-user SID for testing (Windows). */
  sid?: string;
  /** Override the persona the Windows tasks supervise (testing). */
  persona?: string;
  /**
   * Windows logon-mode prompt seams (testing). When absent, the real
   * @clack/prompts flow runs — but only on a TTY; a non-interactive install
   * (scripted, CI, SSH without -t) silently takes the interactive-token
   * default.
   */
  promptRunLoggedOff?: () => Promise<boolean | null>;
  promptPassword?: () => Promise<string | null>;
  /** `COMPUTER\user` resolution seam (testing). Defaults to `whoami`. */
  whoami?: () => Promise<string>;
  /**
   * Scripted-mode flags (Windows): skip the TUI prompt entirely. With
   * `--run-logged-off`, the password comes from --windows-password or the
   * PHANTOMBOT_WINDOWS_PASSWORD env var; without either (and no TTY to ask),
   * install fails with a clear message rather than hanging.
   */
  runLoggedOff?: boolean;
  windowsPassword?: string;
  /** Directory for transient Task Scheduler XML import files (Windows tests). */
  xmlDir?: string;
  /**
   * Read the previously-saved Windows password from the vault (enables the
   * "press Enter to reuse" flow). Test seam; the real impl opens the persona
   * vault. Returns null when none is saved.
   */
  readVaultWindowsPassword?: () => Promise<string | null>;
  /**
   * Persist a validated Windows password to the vault after a successful
   * install so future reinstalls / boot-schema migrations can reuse it. Test
   * seam; the real impl writes the persona vault.
   */
  saveVaultWindowsPassword?: (password: string) => Promise<void>;
  /**
   * Validate that `username`+`password` actually authenticate BEFORE committing
   * to password/boot mode. A blank or wrong password would otherwise register a
   * boot task that fails every reboot; instead install falls back to
   * interactive (login) mode. Test seam; the real impl runs a PowerShell
   * ValidateCredentials probe. When absent, validation is skipped (assumed
   * valid) — validation is a Windows-runtime concern.
   */
  validateWindowsCredential?: (
    username: string,
    password: string,
  ) => Promise<boolean>;
  /**
   * The persona's persisted install-time logon mode, used to default the
   * run-logged-off prompt to the previous choice (first-time installs default
   * to interactive/login). Test seam; defaults to reading the logon marker.
   */
  readPersistedLogonMode?: () => Promise<TaskLogonMode>;
  /** Override systemd-env detection for testing. */
  ensureSystemdEnv?: () => UserSystemdEnv;
  /**
   * Override the platform check for testing. Defaults to currentPlatform()
   * which reads process.platform.
   */
  platform?: "linux" | "darwin" | "windows" | "unsupported";
  /** Override gui domain (e.g. "gui/501") on darwin. Defaults to gui/<current uid>. */
  domain?: string;
}

export async function runInstall(input: RunInstallInput = {}): Promise<number> {
  const out = input.out ?? process.stdout;
  const err = input.err ?? process.stderr;

  const binPath = input.binPath ?? process.execPath;
  // The compiled binary is `phantombot` on POSIX and `phantombot.exe` on
  // Windows — accept either. Running from `bun src/index.ts` (basename `bun`)
  // is rejected because the resulting unit would point at the bun runtime.
  // Split on both separators so the check is correct regardless of which
  // platform's path we're handed (matters for cross-platform unit tests).
  const rawName = binPath.split(/[/\\]/).pop() ?? binPath;
  const binName = rawName.replace(/\.exe$/i, "");
  if (binName !== "phantombot") {
    err.write(
      `phantombot install needs the compiled binary, not '${basename(binPath)}'. ` +
        `Build it with \`bun run build\`, then run install via \`./dist/phantombot install\`.\n`,
    );
    return 2;
  }

  const platform = input.platform ?? currentPlatform();
  switch (platform) {
    case "linux":
      return runInstallLinux(input, binPath, out, err);
    case "darwin":
      return runInstallDarwin(input, binPath, out, err);
    case "windows":
      return runInstallWindows(input, binPath, out, err);
    default:
      err.write(
        `phantombot install supports linux, darwin and windows only; this host reports platform=${process.platform}\n`,
      );
      return 2;
  }
}

/**
 * Served personas to arm per-persona maintenance units for (#486/#491),
 * resolved the same way on every platform. A config that can't be loaded
 * yet (pre-init box) must not fail the install — return undefined so the
 * backend installs its single-persona fallback; the startup doctor / first
 * heartbeat heal provisions per-persona units once a config exists.
 * Personas with no directory on disk (stale autostart entries) are
 * skipped: their units would only fail.
 */
async function resolveInstallPersonas(
  input: RunInstallInput,
): Promise<readonly string[] | undefined> {
  if (input.personas !== undefined) return input.personas;
  try {
    const config = await loadConfig();
    return servedPersonasOf(config).filter((name) =>
      existsSync(personaDir(config, name)),
    );
  } catch {
    return undefined;
  }
}

async function runInstallLinux(
  input: RunInstallInput,
  binPath: string,
  out: WriteSink,
  err: WriteSink,
): Promise<number> {
  const sysEnv = input.ensureSystemdEnv
    ? input.ensureSystemdEnv()
    : ensureUserSystemdEnv();
  if (!sysEnv.ready) {
    err.write(`no user-level systemd bus available: ${sysEnv.reason}\n`);
    return 2;
  }
  if (sysEnv.autoSet) {
    out.write(
      `auto-detected XDG_RUNTIME_DIR=${sysEnv.runtimeDir} (linger is enabled)\n`,
    );
  }

  const unitPath = input.unitPath ?? defaultUnitPath();
  const systemctl =
    input.systemctl ?? new BunSystemctlRunner(buildSystemctlEnv(sysEnv));

  const personas = await resolveInstallPersonas(input);

  const result = await installPhantombotUnit({
    binPath,
    unitPath,
    personas,
    heartbeatServicePath: input.heartbeatServicePath,
    heartbeatTimerPath: input.heartbeatTimerPath,
    legacyHeartbeatServicePath: input.legacyHeartbeatServicePath,
    legacyHeartbeatTimerPath: input.legacyHeartbeatTimerPath,
    nightlyServicePath: input.nightlyServicePath,
    nightlyTimerPath: input.nightlyTimerPath,
    tickServicePath: input.tickServicePath,
    tickTimerPath: input.tickTimerPath,
    systemctl,
    out,
    err,
  });
  if (!result.installed) return 1;

  out.write(manageHints());
  return 0;
}

async function runInstallDarwin(
  input: RunInstallInput,
  binPath: string,
  out: WriteSink,
  err: WriteSink,
): Promise<number> {
  const launchctl = input.launchctl ?? new BunLaunchctlRunner();
  let domain: string;
  try {
    domain = input.domain ?? guiDomain();
  } catch (e) {
    err.write(`cannot determine launchd gui domain: ${(e as Error).message}\n`);
    return 2;
  }

  const hbPath = input.heartbeatPlistPath ?? launchdHeartbeatPath();
  const result = await installPhantombotPlists({
    binPath,
    personas: await resolveInstallPersonas(input),
    plistPath: input.plistPath ?? defaultPlistPath(),
    heartbeatPlistPath: hbPath,
    nightlyPlistPath: input.nightlyPlistPath ?? launchdNightlyPath(),
    tickPlistPath: input.tickPlistPath ?? launchdTickPath(),
    // Per-persona plists live beside the legacy heartbeat plist — in
    // production that IS the LaunchAgents dir; in tests it keeps writes
    // inside the tmpdir.
    agentsDir: dirname(hbPath),
    domain,
    launchctl,
    out,
    err,
  });
  if (!result.installed) return 1;

  out.write(manageHints());
  return 0;
}

async function runInstallWindows(
  input: RunInstallInput,
  binPath: string,
  out: WriteSink,
  err: WriteSink,
): Promise<number> {
  const schtasks = input.schtasks ?? new BunSchtasksRunner();
  const persona = input.persona ?? (await currentPersonaName());

  // Ask whether the daemon should also run when NOBODY is logged on
  // (headless VM, Windows-update reboots). That requires Task Scheduler to
  // store the Windows password with the task. The prompt DEFAULT reflects the
  // persona's previously-chosen mode (first-time installs default to the safer
  // interactive/login mode). Prompts only run on a real TTY; an unattended
  // reinstall honours the persisted choice (this is the boot-schema migration
  // path). A blank or wrong password never registers a boot task — install
  // falls back to interactive/login mode instead.
  const logon = await resolveWindowsLogon(input, persona, out, err);
  if (!logon) return 2; // user cancelled the prompt

  const result = await installPhantombotTasks({
    binPath,
    persona,
    sid: input.sid,
    xmlDir: input.xmlDir,
    logon,
    schtasks,
    out,
    err,
  });
  if (!result.installed) return 1;

  // Persist the validated password to the vault so a later reinstall or
  // boot-schema migration can reuse it without prompting (Enter-to-reuse).
  if (logon.mode === "password" && logon.password) {
    const save =
      input.saveVaultWindowsPassword ??
      ((pw: string) => defaultSaveVaultWindowsPassword(persona, pw));
    try {
      await save(logon.password);
      out.write(`saved ${WINDOWS_PASSWORD_VAULT_KEY} to the vault (press Enter to reuse it next install)\n`);
    } catch (e) {
      err.write(
        `warning: could not save the Windows password to the vault: ${(e as Error).message}\n`,
      );
    }
  }

  out.write(
    logon.mode === "password"
      ? `\nThese tasks run as ${logon.username} whether or not anyone is logged on (starts at boot). ` +
          `A login-fallback task also starts the agent at logon, so a later password change can't lock the agent out.\n` +
          manageHints()
      : `\nThese tasks run for the current Windows user while logged in.\n` +
          manageHints(),
  );
  return 0;
}

type WindowsLogonChoice = TaskLogon & { password?: string };

/**
 * The install-time "run when logged off?" flow. Returns the chosen logon
 * config, or null when the user cancels. Key behaviours:
 *
 *  - The run-logged-off prompt DEFAULTS to the persona's previously-chosen
 *    mode; a first-time install defaults to interactive/login.
 *  - When run-logged-off is chosen, the password can be typed OR reused from
 *    the vault by pressing Enter (the harness API-token UX).
 *  - The credential is VALIDATED before committing; a blank or wrong password
 *    falls back to interactive/login mode with a loud message, rather than
 *    registering a boot task that fails every reboot.
 *  - An unattended invocation (no TTY, no flag) honours the persisted mode —
 *    the path a boot-schema migration re-runs install through.
 */
async function resolveWindowsLogon(
  input: RunInstallInput,
  persona: string,
  out: WriteSink,
  err: WriteSink,
): Promise<WindowsLogonChoice | null> {
  const readVault =
    input.readVaultWindowsPassword ??
    (() => defaultReadVaultWindowsPassword(persona));
  const validate =
    input.validateWindowsCredential ?? defaultValidateWindowsCredential;

  // Validate the credential, then either commit to password mode or fall back
  // to interactive/login with a loud message. A validation ERROR (the probe
  // couldn't run) is not proof the password is wrong, so it proceeds as
  // requested with a warning; only an explicit "invalid" downgrades.
  const commitPassword = async (
    username: string,
    password: string,
  ): Promise<WindowsLogonChoice> => {
    if (!password) {
      out.write(
        "no Windows password provided — installing interactive/login mode instead (runs while you are logged in)\n",
      );
      return { mode: "interactive" };
    }
    let valid: boolean;
    try {
      valid = await validate(username, password);
    } catch (e) {
      out.write(
        `warning: could not verify the Windows password (${(e as Error).message}); proceeding with run-logged-off as requested\n`,
      );
      return { mode: "password", username, password };
    }
    if (!valid) {
      out.write(
        `the Windows password for ${username} did not validate — installing interactive/login mode instead ` +
          `(the agent will start when you log in, not at boot). Re-run \`phantombot install\` with the correct password to enable boot start.\n`,
      );
      return { mode: "interactive" };
    }
    return { mode: "password", username, password };
  };

  // Scripted mode: flags/env/vault decide, no prompts. Explicit false is the
  // same interactive-token install as answering "no".
  if (input.runLoggedOff !== undefined) {
    if (!input.runLoggedOff) return { mode: "interactive" };
    const username = await (input.whoami ?? defaultWhoami)();
    const password =
      input.windowsPassword ??
      process.env.PHANTOMBOT_WINDOWS_PASSWORD ??
      (await readVault()) ??
      undefined;
    if (!password) {
      err.write(
        "--run-logged-off needs the Windows password via --windows-password, PHANTOMBOT_WINDOWS_PASSWORD, or a saved vault value\n",
      );
      return null;
    }
    return await commitPassword(username, password);
  }

  const persistedMode = await (
    input.readPersistedLogonMode ??
    (async () => (await readTaskLogon(persona)).mode)
  )();
  const defaultLoggedOff = persistedMode === "password";

  const interactive = Boolean(process.stdin.isTTY && process.stdout.isTTY);
  const askLoggedOff =
    input.promptRunLoggedOff ??
    (interactive
      ? async () => {
          const answer = await p.confirm({
            message:
              "Run phantombot when you are logged off? (survives reboots without login; requires your Windows password)",
            initialValue: defaultLoggedOff,
          });
          if (p.isCancel(answer)) return null;
          return answer;
        }
      : undefined);

  // Unattended (no TTY, no prompt seam): honour the persisted choice. This is
  // the boot-schema migration / silent-reinstall path — it must not silently
  // downgrade a password-mode box to interactive.
  if (!askLoggedOff) {
    if (!defaultLoggedOff) return { mode: "interactive" };
    const username = await (input.whoami ?? defaultWhoami)();
    const password = (await readVault()) ?? undefined;
    if (!password) {
      out.write(
        "run-logged-off was previously configured but no saved password is available; installing interactive/login mode instead\n",
      );
      return { mode: "interactive" };
    }
    return await commitPassword(username, password);
  }

  const wantsLoggedOff = await askLoggedOff();
  if (wantsLoggedOff === null) {
    err.write("install cancelled\n");
    return null;
  }
  if (!wantsLoggedOff) return { mode: "interactive" };

  const username = await (input.whoami ?? defaultWhoami)();
  const saved = (await readVault()) ?? undefined;
  const askPassword =
    input.promptPassword ??
    (async () => {
      const answer = await p.password({
        message: saved
          ? `Windows password for ${username} (press Enter to reuse the saved password):`
          : `Windows password for ${username} (stored encrypted with the scheduled task):`,
        validate: (v) =>
          !v && !saved ? "password may not be empty" : undefined,
      });
      if (p.isCancel(answer)) return null;
      return answer;
    });
  const typed = await askPassword();
  if (typed === null) {
    err.write("install cancelled\n");
    return null;
  }
  // Empty input + a saved value → reuse the saved password (Enter-to-reuse).
  const password = typed === "" && saved ? saved : typed;
  return await commitPassword(username, password);
}

/** Read the saved Windows password from the persona vault, or null. Never
 * creates a vault: if none exists yet there's nothing to reuse. Exported so
 * the boot-schema migration path (run.ts) can reuse the same reader. */
export async function defaultReadVaultWindowsPassword(
  persona: string,
): Promise<string | null> {
  try {
    const dir = await resolveVaultPersonaDir(persona);
    if (!existsSync(vaultPath(dir))) return null;
    const vault = await openPersonaVault(dir);
    try {
      return vault.get(WINDOWS_PASSWORD_VAULT_KEY) ?? null;
    } finally {
      vault.close();
    }
  } catch {
    return null;
  }
}

/** Persist the Windows password into the persona vault (encrypted at rest). */
async function defaultSaveVaultWindowsPassword(
  persona: string,
  password: string,
): Promise<void> {
  const dir = await resolveVaultPersonaDir(persona);
  const vault = await openPersonaVault(dir);
  try {
    vault.set(WINDOWS_PASSWORD_VAULT_KEY, password);
  } finally {
    vault.close();
  }
}

/**
 * Validate a Windows credential via a PowerShell ValidateCredentials probe,
 * so a blank/wrong password never registers a boot task that fails on every
 * reboot. The password is passed through the environment (not the command
 * line) to keep it out of process listings. Tries the local machine account
 * store first, then the domain — returns true if either authenticates.
 */
async function defaultValidateWindowsCredential(
  username: string,
  password: string,
): Promise<boolean> {
  // Strip any DOMAIN\ or COMPUTER\ prefix — ValidateCredentials takes the bare
  // account name plus a context.
  const bare = username.includes("\\") ? username.split("\\").pop()! : username;
  // Exit codes: 0 = valid, 1 = definitively invalid (a store answered "no"),
  // 2 = couldn't verify (no store was reachable — e.g. no domain controller).
  // Only a definitive "invalid" (exit 1) downgrades the install; an
  // "unverifiable" result throws so the caller proceeds as requested rather
  // than penalising a transient infrastructure outage.
  const script = `
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.DirectoryServices.AccountManagement
$u = $env:PB_VC_USER
$p = $env:PB_VC_PASS
$definitive = $false
foreach ($ctx in @('Machine','Domain')) {
  try {
    $pc = New-Object System.DirectoryServices.AccountManagement.PrincipalContext($ctx)
    if ($pc.ValidateCredentials($u, $p)) { Write-Output 'VALID'; exit 0 }
    $definitive = $true
  } catch { }
}
if ($definitive) { Write-Output 'INVALID'; exit 1 } else { Write-Output 'UNKNOWN'; exit 2 }
`;
  const child = Bun.spawn(
    ["powershell", "-NoProfile", "-NonInteractive", "-Command", script],
    {
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
      windowsHide: true,
      env: { ...process.env, PB_VC_USER: bare, PB_VC_PASS: password },
    },
  );
  const [stdout, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    child.exited,
  ]);
  if (exitCode === 0 && stdout.includes("VALID")) return true;
  if (exitCode === 1) return false;
  // Couldn't verify (no reachable credential store, or powershell itself
  // failed) — surface as an error so commitPassword proceeds with a warning.
  throw new Error("could not verify the Windows credential (no reachable account store)");
}

/** `COMPUTER\user` (or `DOMAIN\user`) for schtasks /RU. */
async function defaultWhoami(): Promise<string> {
  const proc = Bun.spawn(["whoami"], { stdout: "pipe", stderr: "pipe" });
  const stdout = await new Response(proc.stdout).text();
  const exitCode = await proc.exited;
  const name = stdout.trim();
  if (exitCode !== 0 || !name) {
    throw new Error("could not resolve the current Windows user via whoami");
  }
  return name;
}

export default defineCommand({
  meta: {
    name: "install",
    description:
      "Install the host-appropriate service unit for `phantombot run` (systemd --user on Linux, launchd LaunchAgent on macOS, Task Scheduler logon task on Windows) and start it.",
  },
  args: {
    "run-logged-off": {
      type: "boolean",
      description:
        "Windows: run whether or not anyone is logged on (stores the Windows password with the scheduled task; pair with --windows-password or PHANTOMBOT_WINDOWS_PASSWORD). Skips the prompt.",
    },
    "interactive": {
      type: "boolean",
      description:
        "Windows: run only while the user is logged on (skips the prompt; the default).",
    },
    "windows-password": {
      type: "string",
      description:
        "Windows: account password for --run-logged-off. Prefer the PHANTOMBOT_WINDOWS_PASSWORD env var to keep it out of shell history.",
    },
  },
  async run({ args }) {
    const code = await runInstall({
      runLoggedOff: args["run-logged-off"]
        ? true
        : args["interactive"]
          ? false
          : undefined,
      windowsPassword: args["windows-password"],
    });
    // A successful install wires up shell tab-completion so it works right
    // away, with no extra step. Best-effort: a completion failure never turns
    // a successful install into a failure.
    if (code === 0) {
      try {
        await installCompletions();
      } catch (e) {
        process.stderr.write(
          `warning: could not set up shell completion: ${(e as Error).message}\n`,
        );
      }
    }
    process.exitCode = code;
  },
});
