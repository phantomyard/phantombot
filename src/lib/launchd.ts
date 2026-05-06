/**
 * launchd unit (plist) generation and install/uninstall logic for
 * phantombot on macOS.
 *
 * Mirrors the shape of `systemd.ts` so the per-platform router in
 * `platform.ts` can dispatch to either backend with the same surface
 * area. The `LaunchctlRunner` indirection keeps this testable: tests
 * inject a fake runner instead of actually invoking `launchctl`.
 *
 * Path layout (per-user LaunchAgents — equivalent of systemd --user):
 *
 *   ~/Library/LaunchAgents/dev.phantombot.phantombot.plist
 *   ~/Library/LaunchAgents/dev.phantombot.heartbeat.plist
 *   ~/Library/LaunchAgents/dev.phantombot.nightly.plist
 *   ~/Library/LaunchAgents/dev.phantombot.tick.plist
 *
 * Logs go to ~/Library/Logs/phantombot/<unit>.{out,err}.log (no journald
 * on Mac, and `log show` is a poor fit for free-form bot output).
 *
 * Note on env files: launchd's `EnvironmentVariables` plist key only
 * accepts inline static values — it has no equivalent of systemd's
 * `EnvironmentFile=`. Phantombot self-loads `~/.env` and
 * `~/.config/phantombot/.env` at startup (see src/index.ts), so the
 * agent finds credentials in process.env on both platforms without
 * needing per-plist env entries here.
 */

import { existsSync } from "node:fs";
import { mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import type { WriteSink } from "./io.ts";

export const PHANTOMBOT_PLIST_LABEL = "dev.phantombot.phantombot";
export const HEARTBEAT_PLIST_LABEL = "dev.phantombot.heartbeat";
export const NIGHTLY_PLIST_LABEL = "dev.phantombot.nightly";
export const TICK_PLIST_LABEL = "dev.phantombot.tick";

function launchAgentsDir(): string {
  return join(homedir(), "Library", "LaunchAgents");
}

function logsDir(): string {
  return join(homedir(), "Library", "Logs", "phantombot");
}

export function defaultPlistPath(): string {
  return join(launchAgentsDir(), `${PHANTOMBOT_PLIST_LABEL}.plist`);
}

export function heartbeatPlistPath(): string {
  return join(launchAgentsDir(), `${HEARTBEAT_PLIST_LABEL}.plist`);
}

export function nightlyPlistPath(): string {
  return join(launchAgentsDir(), `${NIGHTLY_PLIST_LABEL}.plist`);
}

export function tickPlistPath(): string {
  return join(launchAgentsDir(), `${TICK_PLIST_LABEL}.plist`);
}

/**
 * XML-escape a value for inclusion in a plist string. Plists are XML, so
 * `&`, `<`, `>` need entities — the rest survive intact.
 */
function xmlEscape(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

const PLIST_HEADER =
  '<?xml version="1.0" encoding="UTF-8"?>\n' +
  '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" ' +
  '"http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n' +
  '<plist version="1.0">\n';
const PLIST_FOOTER = "</plist>\n";

interface BasePlistOptions {
  label: string;
  binPath: string;
  args: readonly string[];
  /** When true, KeepAlive=true + RunAtLoad=true (long-running daemon). */
  keepAlive?: boolean;
  /** Seconds between firings (StartInterval). Mutually exclusive with calendar. */
  startIntervalSec?: number;
  /** Calendar firing (e.g. {Hour: 2, Minute: 0}). */
  startCalendar?: { Hour?: number; Minute?: number; Weekday?: number };
  /** When true, sets RunAtLoad=true so the unit fires once on load (and again per StartInterval). */
  runAtLoad?: boolean;
}

function generatePlist(opts: BasePlistOptions): string {
  const argv = [opts.binPath, ...opts.args];
  const argvXml = argv
    .map((a) => `    <string>${xmlEscape(a)}</string>`)
    .join("\n");

  const lines: string[] = [];
  lines.push(PLIST_HEADER + "<dict>");
  lines.push(`  <key>Label</key>`);
  lines.push(`  <string>${xmlEscape(opts.label)}</string>`);
  lines.push(`  <key>ProgramArguments</key>`);
  lines.push(`  <array>`);
  lines.push(argvXml);
  lines.push(`  </array>`);

  if (opts.runAtLoad ?? opts.keepAlive) {
    lines.push(`  <key>RunAtLoad</key>`);
    lines.push(`  <true/>`);
  }
  if (opts.keepAlive) {
    // Restart on crash. The dict form lets us be more precise (don't restart
    // on clean exit), but the boolean form is simpler and matches the
    // systemd Restart=on-failure semantics closely enough.
    lines.push(`  <key>KeepAlive</key>`);
    lines.push(`  <true/>`);
    lines.push(`  <key>ThrottleInterval</key>`);
    lines.push(`  <integer>5</integer>`);
  }
  if (opts.startIntervalSec !== undefined) {
    lines.push(`  <key>StartInterval</key>`);
    lines.push(`  <integer>${opts.startIntervalSec}</integer>`);
  }
  if (opts.startCalendar) {
    lines.push(`  <key>StartCalendarInterval</key>`);
    lines.push(`  <dict>`);
    for (const [k, v] of Object.entries(opts.startCalendar)) {
      lines.push(`    <key>${xmlEscape(k)}</key>`);
      lines.push(`    <integer>${v}</integer>`);
    }
    lines.push(`  </dict>`);
  }

  // PATH: include ~/.pi/agent/bin and ~/.local/bin so the harness's Bash
  // tool finds `phantombot` and `pi` when the agent invokes them. Mac
  // default PATH is narrow (/usr/bin:/bin:/usr/sbin:/sbin), so we have to
  // be explicit. $HOME interpolation isn't supported in plist values, so
  // we resolve it eagerly at install time using homedir().
  const home = homedir();
  const pathValue = `${home}/.pi/agent/bin:${home}/.local/bin:/opt/homebrew/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin`;
  lines.push(`  <key>EnvironmentVariables</key>`);
  lines.push(`  <dict>`);
  lines.push(`    <key>PATH</key>`);
  lines.push(`    <string>${xmlEscape(pathValue)}</string>`);
  lines.push(`  </dict>`);

  // Logs: ~/Library/Logs/phantombot/<label>.{out,err}.log. Created on demand
  // by launchd; we just point at them.
  const logBase = join(logsDir(), opts.label);
  lines.push(`  <key>StandardOutPath</key>`);
  lines.push(`  <string>${xmlEscape(logBase + ".out.log")}</string>`);
  lines.push(`  <key>StandardErrorPath</key>`);
  lines.push(`  <string>${xmlEscape(logBase + ".err.log")}</string>`);

  // Working dir: the user's home, mirroring how systemd starts a user unit
  // with HOME-cwd. Some phantombot subcommands resolve relative paths
  // against cwd, so this matters.
  lines.push(`  <key>WorkingDirectory</key>`);
  lines.push(`  <string>${xmlEscape(home)}</string>`);

  lines.push(`</dict>`);
  lines.push(PLIST_FOOTER);
  return lines.join("\n") + "\n";
}

function quoteArg(s: string): string {
  if (/^[A-Za-z0-9_/.\-]+$/.test(s)) return s;
  return `"${s.replace(/(["\\$`])/g, "\\$1")}"`;
}
// Re-export so tests can verify the encoded ExecStart equivalent if needed.
export { quoteArg as _quoteArg };

export interface LaunchdUnitParams {
  binPath: string;
  args: readonly string[];
}

/** Generate the always-on phantombot agent plist (Label dev.phantombot.phantombot). */
export function generatePhantombotPlist(params: LaunchdUnitParams): string {
  return generatePlist({
    label: PHANTOMBOT_PLIST_LABEL,
    binPath: params.binPath,
    args: params.args,
    keepAlive: true,
    runAtLoad: true,
  });
}

/** Generate the heartbeat plist — fires every 30 minutes. */
export function generateHeartbeatPlist(binPath: string): string {
  return generatePlist({
    label: HEARTBEAT_PLIST_LABEL,
    binPath,
    args: ["heartbeat"],
    startIntervalSec: 30 * 60,
  });
}

/** Generate the nightly plist — fires daily at 02:00. */
export function generateNightlyPlist(binPath: string): string {
  return generatePlist({
    label: NIGHTLY_PLIST_LABEL,
    binPath,
    args: ["nightly"],
    startCalendar: { Hour: 2, Minute: 0 },
  });
}

/**
 * Generate the tick plist — fires every 60 seconds.
 *
 * launchd's minimum reliable StartInterval is roughly 10s; 60s matches
 * the systemd timer cadence exactly so cron-style schedules behave the
 * same on both platforms.
 */
export function generateTickPlist(binPath: string): string {
  return generatePlist({
    label: TICK_PLIST_LABEL,
    binPath,
    args: ["tick"],
    startIntervalSec: 60,
  });
}

export interface LaunchctlResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export interface LaunchctlRunner {
  run(args: readonly string[]): Promise<LaunchctlResult>;
}

export class BunLaunchctlRunner implements LaunchctlRunner {
  async run(args: readonly string[]): Promise<LaunchctlResult> {
    const proc = Bun.spawn(["launchctl", ...args], {
      env: { ...process.env },
      stdout: "pipe",
      stderr: "pipe",
    });
    const stdout = await new Response(proc.stdout).text();
    const stderr = await new Response(proc.stderr).text();
    const exitCode = await proc.exited;
    return { exitCode, stdout, stderr };
  }
}

/**
 * Resolve the gui domain target for the current user. launchd's modern
 * (10.10+) command surface is domain-scoped: `gui/<uid>` is the user's
 * graphical session, the closest analogue to systemd --user.
 *
 * Tests inject the uid; production reads process.getuid() directly.
 */
export function guiDomain(uid?: number): string {
  const u = uid ?? process.getuid?.();
  if (u === undefined) {
    throw new Error("cannot determine current uid for launchd gui domain");
  }
  return `gui/${u}`;
}

export interface InstallLaunchdOptions {
  binPath: string;
  /** Path overrides — tests use these to keep writes inside a tmpdir. */
  plistPath?: string;
  heartbeatPlistPath?: string;
  nightlyPlistPath?: string;
  tickPlistPath?: string;
  /** Override gui domain (e.g. gui/501). Defaults to gui/<current uid>. */
  domain?: string;
  launchctl: LaunchctlRunner;
  out: WriteSink;
  err: WriteSink;
}

/**
 * Write the four plists, then bootstrap each into the user's gui domain.
 *
 * `bootstrap` is the modern install verb (replaces `load`). It both loads
 * the unit and starts it (for KeepAlive=true) or schedules it (for
 * StartInterval/StartCalendarInterval). If a unit with the same Label is
 * already loaded, bootstrap fails with EBUSY — we bootout first to make
 * the operation idempotent for upgrade scenarios.
 */
export async function installPhantombotPlists(
  opts: InstallLaunchdOptions,
): Promise<{ installed: boolean }> {
  const domain = opts.domain ?? guiDomain();
  const mainPath = opts.plistPath ?? defaultPlistPath();
  const hbPath = opts.heartbeatPlistPath ?? heartbeatPlistPath();
  const ngPath = opts.nightlyPlistPath ?? nightlyPlistPath();
  const tkPath = opts.tickPlistPath ?? tickPlistPath();

  const plists: Array<{ path: string; label: string; body: string }> = [
    {
      path: mainPath,
      label: PHANTOMBOT_PLIST_LABEL,
      body: generatePhantombotPlist({ binPath: opts.binPath, args: ["run"] }),
    },
    {
      path: hbPath,
      label: HEARTBEAT_PLIST_LABEL,
      body: generateHeartbeatPlist(opts.binPath),
    },
    {
      path: ngPath,
      label: NIGHTLY_PLIST_LABEL,
      body: generateNightlyPlist(opts.binPath),
    },
    {
      path: tkPath,
      label: TICK_PLIST_LABEL,
      body: generateTickPlist(opts.binPath),
    },
  ];

  // Make sure the logs dir exists — launchd will refuse to start the
  // service if StandardOutPath/StandardErrorPath point at a non-existent
  // directory, and silently truncating the error to journald isn't an
  // option here.
  await mkdir(logsDir(), { recursive: true });

  for (const p of plists) {
    await mkdir(dirname(p.path), { recursive: true });
    await writeFile(p.path, p.body, "utf8");
    opts.out.write(`wrote plist: ${p.path}\n`);
  }

  // Idempotent install: bootout any pre-existing target (best-effort,
  // don't fail if it isn't loaded), then bootstrap fresh.
  for (const p of plists) {
    await opts.launchctl.run(["bootout", `${domain}/${p.label}`]);
  }
  for (const p of plists) {
    const r = await opts.launchctl.run(["bootstrap", domain, p.path]);
    if (r.exitCode !== 0) {
      opts.err.write(
        `launchctl bootstrap ${domain} ${p.path} failed (${r.exitCode}): ${r.stderr.trim() || r.stdout.trim()}\n`,
      );
      return { installed: false };
    }
  }
  opts.out.write(
    `bootstrapped ${PHANTOMBOT_PLIST_LABEL} + heartbeat + nightly + tick into ${domain}\n`,
  );
  return { installed: true };
}

export interface UninstallLaunchdOptions {
  /** Path overrides — tests use these to keep writes inside a tmpdir. */
  plistPath?: string;
  heartbeatPlistPath?: string;
  nightlyPlistPath?: string;
  tickPlistPath?: string;
  domain?: string;
  launchctl: LaunchctlRunner;
  out: WriteSink;
  err: WriteSink;
}

export async function uninstallPhantombotPlists(
  opts: UninstallLaunchdOptions,
): Promise<{ removed: boolean }> {
  const domain = opts.domain ?? guiDomain();
  const mainPath = opts.plistPath ?? defaultPlistPath();
  const hbPath = opts.heartbeatPlistPath ?? heartbeatPlistPath();
  const ngPath = opts.nightlyPlistPath ?? nightlyPlistPath();
  const tkPath = opts.tickPlistPath ?? tickPlistPath();

  const labels = [
    TICK_PLIST_LABEL,
    NIGHTLY_PLIST_LABEL,
    HEARTBEAT_PLIST_LABEL,
    PHANTOMBOT_PLIST_LABEL,
  ];
  // bootout each label (best-effort). A missing target returns non-zero
  // — that's fine, we just want it gone from the domain.
  for (const label of labels) {
    const r = await opts.launchctl.run(["bootout", `${domain}/${label}`]);
    if (r.exitCode !== 0) {
      opts.out.write(
        `launchctl bootout ${domain}/${label} returned ${r.exitCode} (continuing)\n`,
      );
    }
  }

  // Main plist gets a "(no plist at …)" log if absent so the user can tell
  // whether they ever installed; companion plists are silent if absent.
  if (existsSync(mainPath)) {
    await unlink(mainPath);
    opts.out.write(`removed ${mainPath}\n`);
  } else {
    opts.out.write(`(no plist at ${mainPath})\n`);
  }
  for (const p of [hbPath, ngPath, tkPath]) {
    if (existsSync(p)) {
      await unlink(p);
      opts.out.write(`removed ${p}\n`);
    }
  }

  return { removed: true };
}

export interface LaunchdServiceControl {
  isActive(): Promise<boolean>;
  restart(): Promise<{ ok: boolean; stderr?: string }>;
  rerenderUnitIfStale(): Promise<{ rerendered: boolean; backupPath?: string }>;
}

/**
 * Compare the on-disk plist at plistPath against the canonical template
 * for binPath. If absent or different, write the canonical template and
 * `launchctl bootout` + `launchctl bootstrap` to reload. Returns whether
 * a rerender happened and, if it did, the path of any backup written.
 */
export async function ensurePlistCurrent(opts: {
  plistPath: string;
  binPath: string;
  domain: string;
  launchctl: LaunchctlRunner;
}): Promise<{ rerendered: boolean; backupPath?: string }> {
  const expected = generatePhantombotPlist({
    binPath: opts.binPath,
    args: ["run"],
  });
  let current: string | undefined;
  if (existsSync(opts.plistPath)) {
    current = await readFile(opts.plistPath, "utf8");
  }
  if (current === expected) return { rerendered: false };
  await mkdir(dirname(opts.plistPath), { recursive: true });
  let backupPath: string | undefined;
  if (current !== undefined) {
    backupPath = `${opts.plistPath}.bak`;
    await writeFile(backupPath, current, "utf8");
  }
  await writeFile(opts.plistPath, expected, "utf8");
  // Reload so launchd picks up the new plist body.
  await opts.launchctl.run([
    "bootout",
    `${opts.domain}/${PHANTOMBOT_PLIST_LABEL}`,
  ]);
  await opts.launchctl.run(["bootstrap", opts.domain, opts.plistPath]);
  return { rerendered: true, backupPath };
}

/**
 * Default LaunchdServiceControl backed by real launchctl. Returns
 * isActive=false on any error so callers can treat "service unknown" the
 * same as "not running".
 */
export function defaultLaunchdServiceControl(): LaunchdServiceControl {
  const runner = new BunLaunchctlRunner();
  return {
    async isActive() {
      // `launchctl print gui/<uid>/<label>` returns 0 if loaded.
      // `launchctl list <label>` is the legacy form — also returns 0 if
      // loaded but is deprecated. Use print which is reliable on 10.10+.
      let domain: string;
      try {
        domain = guiDomain();
      } catch {
        return false;
      }
      const r = await runner.run([
        "print",
        `${domain}/${PHANTOMBOT_PLIST_LABEL}`,
      ]);
      return r.exitCode === 0;
    },
    async restart() {
      let domain: string;
      try {
        domain = guiDomain();
      } catch (e) {
        return { ok: false, stderr: (e as Error).message };
      }
      // `kickstart -k` stops the running instance (if any) and starts a
      // fresh one — the launchd analogue of `systemctl restart`.
      const r = await runner.run([
        "kickstart",
        "-k",
        `${domain}/${PHANTOMBOT_PLIST_LABEL}`,
      ]);
      return r.exitCode === 0
        ? { ok: true }
        : { ok: false, stderr: r.stderr.trim() || `exit ${r.exitCode}` };
    },
    async rerenderUnitIfStale() {
      const binPath = process.execPath;
      if (basename(binPath) !== "phantombot") return { rerendered: false };
      const plistPath = defaultPlistPath();
      if (!existsSync(plistPath)) return { rerendered: false };
      let domain: string;
      try {
        domain = guiDomain();
      } catch {
        return { rerendered: false };
      }
      return ensurePlistCurrent({
        plistPath,
        binPath,
        domain,
        launchctl: runner,
      });
    },
  };
}
