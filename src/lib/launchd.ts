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
 *   ~/Library/LaunchAgents/dev.phantombot.heartbeat.<persona>.plist  (one per served persona, #491)
 *   ~/Library/LaunchAgents/dev.phantombot.tick.plist
 *
 * The pre-#491 single `dev.phantombot.heartbeat.plist` is the LEGACY
 * heartbeat: installs/heals that know the served-persona roster replace it
 * with per-persona plists (mirroring systemd's `phantombot-heartbeat@`
 * template instances), retiring the legacy plist only after the default
 * persona's replacement is verifiably loaded.
 *
 * Logs go to ~/Library/Logs/phantombot/<unit>.{out,err}.log (no journald
 * on Mac, and `log show` is a poor fit for free-form bot output). launchd
 * appends to them forever with no size cap, so the heartbeat rotates them
 * itself — see src/lib/logRotate.ts.
 *
 * Note on credentials: launchd's `EnvironmentVariables` plist key only
 * accepts inline static values, and since #452 no platform sources a
 * plaintext env file anyway — phantombot decrypts the active persona's
 * vault at startup (see src/index.ts), so the agent finds credentials in
 * process.env on every platform without per-plist env entries here.
 */

import { existsSync, readdirSync } from "node:fs";
import { mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { isPhantombotBinary } from "./binaryIdentity.ts";
import type { WriteSink } from "./io.ts";

export const PHANTOMBOT_PLIST_LABEL = "dev.phantombot.phantombot";
/**
 * LEGACY single-persona heartbeat label (pre-#491). Served-persona rigs use
 * one `dev.phantombot.heartbeat.<persona>` plist per persona instead; this
 * label survives so installs/heals/uninstalls can boot out and delete what
 * an older install left behind.
 */
export const HEARTBEAT_PLIST_LABEL = "dev.phantombot.heartbeat";

/** Per-persona heartbeat label (#491): `dev.phantombot.heartbeat.<persona>`. */
export function heartbeatPlistLabelFor(persona: string): string {
  return `${HEARTBEAT_PLIST_LABEL}.${persona}`;
}
/**
 * RETIRED label. The nightly no longer runs on a clock (startup + the
 * heartbeat's day-rollover check trigger it now — see nightlyTrigger.ts), so
 * this plist is never generated. The label survives only so an upgrade can
 * bootout and delete what an older install left in the gui domain.
 */
export const NIGHTLY_PLIST_LABEL = "dev.phantombot.nightly";
export const TICK_PLIST_LABEL = "dev.phantombot.tick";

function launchAgentsDir(): string {
  return join(homedir(), "Library", "LaunchAgents");
}

/**
 * Directory launchd writes every unit's stdout/stderr into. Exported so the
 * log-rotation pass (#428) can cap the files launchd itself never rotates.
 */
export function launchdLogsDir(): string {
  return join(homedir(), "Library", "Logs", "phantombot");
}

function logsDir(): string {
  return launchdLogsDir();
}

export function defaultPlistPath(): string {
  return join(launchAgentsDir(), `${PHANTOMBOT_PLIST_LABEL}.plist`);
}

/**
 * Absolute paths of the main agent's stdout/stderr logs on macOS
 * (~/Library/Logs/phantombot/<label>.{out,err}.log). Mirrors the paths
 * baked into the plist's StandardOutPath/StandardErrorPath, so `phantombot
 * logs` tails the same files launchd writes.
 */
export function launchdLogPaths(): { out: string; err: string } {
  const base = join(logsDir(), PHANTOMBOT_PLIST_LABEL);
  return { out: `${base}.out.log`, err: `${base}.err.log` };
}

/** Path of the LEGACY single-persona heartbeat plist (kept for cleanup). */
export function heartbeatPlistPath(): string {
  return join(launchAgentsDir(), `${HEARTBEAT_PLIST_LABEL}.plist`);
}

/** Path of a per-persona heartbeat plist (#491). */
export function heartbeatPlistPathFor(persona: string, dir?: string): string {
  return join(
    dir ?? launchAgentsDir(),
    `${heartbeatPlistLabelFor(persona)}.plist`,
  );
}

/**
 * Persona names with an on-disk per-persona heartbeat plist, discovered by
 * listing the LaunchAgents dir — the launchd analogue of systemd's
 * `list-unit-files phantombot-heartbeat@*.timer`. File-based (not
 * `launchctl list`) so it also finds plists that failed to bootstrap.
 */
export function listHeartbeatInstancePlists(dir?: string): string[] {
  const d = dir ?? launchAgentsDir();
  if (!existsSync(d)) return [];
  const personas: string[] = [];
  for (const name of readdirSync(d)) {
    const m = /^dev\.phantombot\.heartbeat\.(.+)\.plist$/.exec(name);
    if (m && m[1]!.length > 0) personas.push(m[1]!);
  }
  return personas.sort();
}

/** Path of the retired nightly plist (kept for cleanup only). */
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

/**
 * Generate a heartbeat plist — fires every 30 minutes. With `persona` the
 * plist is per-persona (#491): own label, `heartbeat --persona <name>` args.
 * Without it the LEGACY single-persona plist is generated (kept so pre-init
 * installs with no roster still get a heartbeat, and so tests/cleanup can
 * reproduce the old unit).
 */
export function generateHeartbeatPlist(binPath: string, persona?: string): string {
  return generatePlist({
    label: persona ? heartbeatPlistLabelFor(persona) : HEARTBEAT_PLIST_LABEL,
    binPath,
    args: persona ? ["heartbeat", "--persona", persona] : ["heartbeat"],
    startIntervalSec: 30 * 60,
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
  /**
   * Personas to install per-persona heartbeat plists for (#491) — default
   * persona FIRST, same contract as systemd's `installPhantombotUnit`.
   * When omitted (no config on a pre-init box), the LEGACY single-persona
   * heartbeat plist is installed instead; the first heartbeat heal replaces
   * it once a config exists.
   */
  personas?: readonly string[];
  /** Path overrides — tests use these to keep writes inside a tmpdir. */
  plistPath?: string;
  heartbeatPlistPath?: string;
  nightlyPlistPath?: string;
  tickPlistPath?: string;
  /** Override the LaunchAgents dir for per-persona plists (tests). */
  agentsDir?: string;
  /** Override gui domain (e.g. gui/501). Defaults to gui/<current uid>. */
  domain?: string;
  launchctl: LaunchctlRunner;
  out: WriteSink;
  err: WriteSink;
}

/**
 * Write the three plists, then bootstrap each into the user's gui domain.
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
  ];
  // One heartbeat plist per served persona (#491) when the roster is known;
  // the legacy single-persona plist when it isn't (pre-init box).
  if (opts.personas === undefined) {
    plists.push({
      path: hbPath,
      label: HEARTBEAT_PLIST_LABEL,
      body: generateHeartbeatPlist(opts.binPath),
    });
  } else {
    for (const persona of opts.personas) {
      plists.push({
        path: heartbeatPlistPathFor(persona, opts.agentsDir),
        label: heartbeatPlistLabelFor(persona),
        body: generateHeartbeatPlist(opts.binPath, persona),
      });
    }
  }
  plists.push({
    path: tkPath,
    label: TICK_PLIST_LABEL,
    body: generateTickPlist(opts.binPath),
  });

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
  // Track whether the default persona's heartbeat plist loaded — the
  // legacy single-persona plist is only retired once its replacement is
  // verifiably in the domain (same migration rule as the systemd heal).
  const defaultLabel =
    opts.personas !== undefined && opts.personas.length > 0
      ? heartbeatPlistLabelFor(opts.personas[0]!)
      : undefined;
  let defaultInstanceReady = opts.personas === undefined;
  for (const p of plists) {
    const r = await opts.launchctl.run(["bootstrap", domain, p.path]);
    if (r.exitCode !== 0) {
      opts.err.write(
        `launchctl bootstrap ${domain} ${p.path} failed (${r.exitCode}): ${r.stderr.trim() || r.stdout.trim()}\n`,
      );
      return { installed: false };
    }
    if (defaultLabel !== undefined && p.label === defaultLabel) {
      defaultInstanceReady = true;
    }
  }

  // Migration: boot out + delete the legacy single-persona heartbeat plist
  // once the default persona's per-persona replacement is loaded. Only
  // after a CONFIRMED unload — a transient bootout failure must keep the
  // plist on disk so a later heal/install can retry the unload.
  if (
    opts.personas !== undefined &&
    defaultInstanceReady &&
    existsSync(hbPath) &&
    (await confirmedUnload(opts.launchctl, domain, HEARTBEAT_PLIST_LABEL))
  ) {
    await unlink(hbPath);
    opts.out.write(`removed retired plist: ${hbPath}\n`);
  }

  // Upgrade cleanup: an install from before the nightly timer was retired
  // still has the 02:00 agent loaded. Bootout + delete it so it can't fire a
  // duplicate sweep. Guarded on the plist existing, so a fresh Mac issues no
  // extra launchctl call at all. Confirmed-unload for the same reason.
  if (
    existsSync(ngPath) &&
    (await confirmedUnload(opts.launchctl, domain, NIGHTLY_PLIST_LABEL))
  ) {
    await unlink(ngPath);
    opts.out.write(`removed retired plist: ${ngPath}\n`);
  }
  opts.out.write(
    `bootstrapped ${PHANTOMBOT_PLIST_LABEL} + ${opts.personas?.length ?? 1} heartbeat plist(s) + tick into ${domain}\n`,
  );
  return { installed: true };
}

export interface UninstallLaunchdOptions {
  /** Path overrides — tests use these to keep writes inside a tmpdir. */
  plistPath?: string;
  heartbeatPlistPath?: string;
  nightlyPlistPath?: string;
  tickPlistPath?: string;
  /** Override the LaunchAgents dir for per-persona plist discovery (tests). */
  agentsDir?: string;
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

  // Every per-persona heartbeat plist on disk (#491), then the retired
  // labels, then the main agent. Discovery defaults to the resolved
  // heartbeat plist's own directory so test path overrides stay hermetic.
  const agentsDir = opts.agentsDir ?? dirname(hbPath);
  const instancePersonas = listHeartbeatInstancePlists(agentsDir);
  const labels = [
    TICK_PLIST_LABEL,
    NIGHTLY_PLIST_LABEL,
    ...instancePersonas.map(heartbeatPlistLabelFor),
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
  for (const persona of instancePersonas) {
    const p = heartbeatPlistPathFor(persona, agentsDir);
    if (existsSync(p)) {
      await unlink(p);
      opts.out.write(`removed ${p}\n`);
    }
  }

  return { removed: true };
}

export interface EnsureLaunchdHeartbeatOptions {
  binPath: string;
  /** Served personas — default FIRST (servedPersonasOf contract). */
  personas: readonly string[];
  domain: string;
  launchctl: LaunchctlRunner;
  /** Override the LaunchAgents dir (tests). */
  agentsDir?: string;
  /** Override the legacy heartbeat plist path (tests). */
  legacyHeartbeatPath?: string;
}

export interface EnsureLaunchdHeartbeatResult {
  /** Plist files (re)written because content drifted. */
  rewrote: string[];
  backups: string[];
  /** Labels (re)bootstrapped into the gui domain this pass. */
  bootstrapped: string[];
  /** Per-persona labels removed because their persona is no longer served. */
  removed: string[];
  /** Per-persona labels whose reload was skipped: a stale job stayed
   *  loaded because bootout failed. The on-disk body still matches the
   *  loaded job, so the next heal retries instead of mistaking the old
   *  job for a healthy reload. */
  reloadFailed: string[];
  /** Per-persona labels whose plist was left in place because bootout
   *  failed and launchd still has the job loaded. */
  removeFailed: string[];
  /** True when the legacy single-persona heartbeat plist was retired. */
  retiredLegacy: boolean;
}

/**
 * Boot a label out of the domain and confirm the unload before any caller
 * removes the backing plist. Returns true only when the job is verifiably
 * NOT loaded afterwards — bootout succeeded, or a `print` probe confirms
 * the job is absent. Deleting a plist without this check turns a
 * transient bootout failure into an unrecoverable state: launchd keeps
 * the job registered but the file a later heal needs to find and retry
 * the unload is gone (#494 review).
 */
async function confirmedUnload(
  launchctl: LaunchctlRunner,
  domain: string,
  label: string,
): Promise<boolean> {
  const out = await launchctl.run(["bootout", `${domain}/${label}`]);
  if (out.exitCode === 0) return true;
  const probe = await launchctl.run(["print", `${domain}/${label}`]);
  return probe.exitCode !== 0;
}

/**
 * Reconcile per-persona heartbeat plists with the served-persona roster
 * (#491) — the launchd analogue of the systemd heal's instance
 * reconciliation. Idempotent; called by `phantombot install`, the persona
 * lifecycle sync, and the heartbeat's own periodic heal.
 *
 * Per persona: write the plist if missing/stale (backing up the old body),
 * then bootout+bootstrap when it was rewritten or isn't loaded. Personas
 * with a plist on disk that are no longer served get booted out and
 * deleted. The legacy single-persona plist is retired only AFTER the
 * default persona's plist is verifiably loaded — a failed bootstrap keeps
 * the legacy heartbeat rather than leaving the host with none.
 */
export async function ensureLaunchdHeartbeatInstances(
  opts: EnsureLaunchdHeartbeatOptions,
): Promise<EnsureLaunchdHeartbeatResult> {
  const dir = opts.agentsDir ?? launchAgentsDir();
  const legacyPath = opts.legacyHeartbeatPath ?? heartbeatPlistPath();
  const result: EnsureLaunchdHeartbeatResult = {
    rewrote: [],
    backups: [],
    bootstrapped: [],
    removed: [],
    reloadFailed: [],
    removeFailed: [],
    retiredLegacy: false,
  };
  await mkdir(dir, { recursive: true });
  await mkdir(logsDir(), { recursive: true });

  let defaultReady = false;
  for (let i = 0; i < opts.personas.length; i++) {
    const persona = opts.personas[i]!;
    const label = heartbeatPlistLabelFor(persona);
    const path = heartbeatPlistPathFor(persona, dir);
    const expected = generateHeartbeatPlist(opts.binPath, persona);
    let current: string | undefined;
    if (existsSync(path)) {
      current = await readFile(path, "utf8");
    }
    const dirty = current !== expected;
    const loaded = await opts.launchctl.run([
      "print",
      `${opts.domain}/${label}`,
    ]);
    const wasLoaded = loaded.exitCode === 0;
    if (wasLoaded && !dirty) {
      if (i === 0) defaultReady = true;
      continue;
    }
    // Missing, stale, or not loaded: reload from disk. When a stale job
    // is still loaded, bootout must succeed BEFORE the plist is
    // rewritten — a failed bootout would otherwise leave the on-disk
    // body matching `expected` while launchd keeps running the old job,
    // and the next heal would mistake that stale job for a healthy
    // reload (#494 review). Leaving the old body in place keeps disk and
    // launchd consistent, so the next heal retries the reload.
    if (wasLoaded && dirty) {
      const out = await opts.launchctl.run([
        "bootout",
        `${opts.domain}/${label}`,
      ]);
      if (out.exitCode !== 0) {
        result.reloadFailed.push(label);
        continue;
      }
    }
    if (dirty) {
      if (current !== undefined) {
        const bak = `${path}.bak`;
        await writeFile(bak, current, "utf8");
        result.backups.push(bak);
      }
      await writeFile(path, expected, "utf8");
      result.rewrote.push(label);
    }
    const r = await opts.launchctl.run(["bootstrap", opts.domain, path]);
    if (r.exitCode === 0) {
      result.bootstrapped.push(label);
      if (i === 0) defaultReady = true;
    }
  }

  // Retire plists whose persona is no longer served. The plist file is
  // the only handle a later heal has to find/retry the unload, so it is
  // deleted only after the job is verifiably gone from the domain.
  const served = new Set(opts.personas);
  for (const persona of listHeartbeatInstancePlists(dir)) {
    if (served.has(persona)) continue;
    const label = heartbeatPlistLabelFor(persona);
    const p = heartbeatPlistPathFor(persona, dir);
    if (await confirmedUnload(opts.launchctl, opts.domain, label)) {
      if (existsSync(p)) await unlink(p);
      result.removed.push(label);
    } else {
      result.removeFailed.push(label);
    }
  }

  // Retire the legacy single-persona heartbeat only once its replacement
  // (the default persona's plist) is loaded and the legacy job itself is
  // verifiably unloaded — same retry-handle rule as above.
  if (
    defaultReady &&
    existsSync(legacyPath) &&
    (await confirmedUnload(opts.launchctl, opts.domain, HEARTBEAT_PLIST_LABEL))
  ) {
    await unlink(legacyPath);
    result.retiredLegacy = true;
  }
  return result;
}

/**
 * Persona-lifecycle caller of the #491 reconciliation — the launchd half
 * of the heartbeat-instance sync seam (mirrors systemd's
 * `defaultSyncHeartbeatInstances`). Invoked after `autostart_personas`
 * changes so a newly-served persona's first maintenance pass is at most 30
 * minutes away instead of waiting for the next heal.
 *
 * Returns null when instance management isn't possible here (not a real
 * installed binary — arming launchd agents from a dev `bun` run or a test
 * would touch the developer's actual host), so callers stay silent on dev
 * boxes. The periodic heartbeat heal reconciles the same state.
 */
export async function defaultSyncLaunchdHeartbeatInstances(
  personas: readonly string[],
): Promise<{ armed: string[]; disabled: string[] } | null> {
  if (process.platform !== "darwin") return null;
  if (!isPhantombotBinary()) return null;
  let domain: string;
  try {
    domain = guiDomain();
  } catch {
    return null;
  }
  const r = await ensureLaunchdHeartbeatInstances({
    binPath: process.execPath,
    personas,
    domain,
    launchctl: new BunLaunchctlRunner(),
  });
  return { armed: r.bootstrapped, disabled: r.removed };
}

export interface LaunchdServiceControl {
  isActive(): Promise<boolean>;
  start(): Promise<{ ok: boolean; stderr?: string }>;
  stop(): Promise<{ ok: boolean; stderr?: string }>;
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
    async start() {
      let domain: string;
      try {
        domain = guiDomain();
      } catch (e) {
        return { ok: false, stderr: (e as Error).message };
      }
      const target = `${domain}/${PHANTOMBOT_PLIST_LABEL}`;
      // Our main agent is KeepAlive=true, so `stop()` fully unloads it with
      // `bootout` (a mere SIGTERM would be relaunched). `start` is therefore
      // the inverse: if the agent is already loaded, `kickstart` (re)starts it;
      // if it was booted out, `bootstrap` reloads it from the plist. Splitting
      // on load state sidesteps bootstrap's EBUSY-when-already-loaded error.
      const loaded = await runner.run(["print", target]);
      if (loaded.exitCode === 0) {
        const r = await runner.run(["kickstart", target]);
        return r.exitCode === 0
          ? { ok: true }
          : { ok: false, stderr: r.stderr.trim() || `exit ${r.exitCode}` };
      }
      const plistPath = defaultPlistPath();
      if (!existsSync(plistPath)) {
        return {
          ok: false,
          stderr: `no LaunchAgent installed at ${plistPath} — run 'phantombot install' first`,
        };
      }
      const r = await runner.run(["bootstrap", domain, plistPath]);
      return r.exitCode === 0
        ? { ok: true }
        : { ok: false, stderr: r.stderr.trim() || `exit ${r.exitCode}` };
    },
    async stop() {
      let domain: string;
      try {
        domain = guiDomain();
      } catch (e) {
        return { ok: false, stderr: (e as Error).message };
      }
      const target = `${domain}/${PHANTOMBOT_PLIST_LABEL}`;
      // KeepAlive=true means a plain `kill` would be relaunched immediately.
      // `bootout` unloads the agent from the domain so it stays stopped until
      // the next `start()`.
      const r = await runner.run(["bootout", target]);
      if (r.exitCode === 0) return { ok: true };
      // bootout on a not-loaded agent exits non-zero; treat "already gone" as
      // success rather than surfacing a spurious error.
      const stillLoaded = await runner.run(["print", target]);
      if (stillLoaded.exitCode !== 0) return { ok: true };
      return { ok: false, stderr: r.stderr.trim() || `exit ${r.exitCode}` };
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
      if (!isPhantombotBinary(binPath)) return { rerendered: false };
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
