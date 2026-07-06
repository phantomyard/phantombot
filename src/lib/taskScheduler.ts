/**
 * Windows Task Scheduler backend — the `systemctl --user` / launchd analogue
 * for phantombot on Windows.
 *
 * Mirrors the shape of `systemd.ts` and `launchd.ts` so the per-platform
 * router in `platform.ts` can dispatch to it with the same surface area. A
 * `SchtasksRunner` indirection keeps this testable: tests inject a fake
 * runner instead of actually invoking `schtasks.exe`.
 *
 * Design constraints (from issue #201):
 *   - NO admin. Registering a task in the CURRENT user's own tree via
 *     `schtasks /Create` needs no elevation, unlike a true Windows Service
 *     (SCM registration, which is what WinSW does). The trade-off is that a
 *     user-scoped scheduled task with an InteractiveToken principal only runs
 *     while that user is logged in — exactly the macOS/launchd model Andrew
 *     accepted. Someone wanting true headless-without-login should install a
 *     real service (e.g. WinSW); the README documents that.
 *   - Runs as the current user, only when logged in:
 *       <LogonType>InteractiveToken</LogonType> + <UserId> = current SID.
 *     InteractiveToken means Task Scheduler needs no stored password.
 *   - Grant/identify the principal by SID, never by name — a workgroup box has
 *     %USERDOMAIN%=WORKGROUP which does not resolve (same lesson as the Phase 2
 *     identity.json ACL). `currentUserSid()` is reused from filePermissions.ts.
 *
 * Task layout (all under a \Phantombot\ folder so they group in taskschd.msc):
 *
 *   \Phantombot\phantombot   — always-on `phantombot run`   (keep-alive)
 *   \Phantombot\heartbeat    — `phantombot heartbeat`       (every 30 min)
 *   \Phantombot\nightly      — `phantombot nightly`         (daily 02:00)
 *   \Phantombot\tick         — `phantombot tick`            (every 60 s)
 *
 * Keep-alive without a supervisor: Task Scheduler has no true "restart on
 * clean exit" like launchd's KeepAlive. We emulate it for the always-on task
 * with a belt-and-braces pair: a LogonTrigger (start at logon) PLUS a
 * TimeTrigger repeating every minute, combined with
 * MultipleInstancesPolicy=IgnoreNew. If the agent is already running the
 * minute-tick is ignored; if it died, the next tick restarts it. This gives
 * effectively-infinite restart while logged in, admin-free.
 *
 * Logging (WinSW-inspired, minus the SCM): Task Scheduler does not capture a
 * process's stdout/stderr, so the action is run through `cmd /c` with the
 * streams redirected (append) to per-task .out.log / .err.log under the
 * phantombot data dir's logs\ folder - the same out/err split launchd writes
 * to ~/Library/Logs. Log ROTATION is not yet handled here (documented
 * limitation; WinSW is the upgrade path for rotation + richer supervision).
 *
 * No console flash: a task whose Command is cmd.exe pops a visible console
 * window every time it fires - intolerable for the tick task that runs every
 * 60 s. So the action instead invokes `wscript.exe <launcher.vbs>`, a tiny
 * generated VBScript that re-launches the real `cmd /c ... >> log` line HIDDEN
 * (WshShell.Run windowStyle 0). wscript.exe has no console of its own and the
 * child cmd runs hidden, so nothing flashes. The launcher WAITS on the child
 * (waitOnReturn = true) so Task Scheduler still sees the always-on task as
 * Running - preserving the MultipleInstancesPolicy=IgnoreNew keep-alive. The
 * binary path is still passed as a real task argument (not buried inside the
 * .vbs), so the drift self-heal in `ensureTasksCurrent` can still detect a
 * moved binary by inspecting the registered task XML.
 */

import { mkdir, unlink, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { basename, join } from "node:path";

import { xdgDataHome } from "../config.ts";
import { currentUserSid } from "./filePermissions.ts";
import type { WriteSink } from "./io.ts";

export const TASK_FOLDER = "\\Phantombot";
export const PHANTOMBOT_TASK = "\\Phantombot\\phantombot";
export const HEARTBEAT_TASK = "\\Phantombot\\heartbeat";
export const NIGHTLY_TASK = "\\Phantombot\\nightly";
export const TICK_TASK = "\\Phantombot\\tick";

/** Short label used for the per-task log filenames. */
type TaskLabel = "phantombot" | "heartbeat" | "nightly" | "tick";

function logsDir(): string {
  return join(xdgDataHome(), "phantombot", "logs");
}

/** Absolute path of a task's stdout / stderr log files. */
export function taskLogPaths(label: TaskLabel): { out: string; err: string } {
  const base = join(logsDir(), label);
  return { out: `${base}.out.log`, err: `${base}.err.log` };
}

/**
 * XML-escape a value for inclusion in Task Scheduler XML element text. Task
 * XML is XML, so `&`, `<`, `>` need entities. Double quotes are legal in
 * element text and stay intact (they matter for the cmd redirection string).
 */
function xmlEscape(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

/** Directory that holds the shared hidden-launcher script (beside logs\). */
function launcherDir(): string {
  return join(xdgDataHome(), "phantombot");
}

/** Absolute path of the shared hidden-launcher VBScript. */
export function launcherVbsPath(): string {
  return join(launcherDir(), "phantombot-launch.vbs");
}

/**
 * The shared hidden-launcher script. Task Scheduler runs this via wscript.exe
 * (which has no console) instead of running cmd.exe directly, so no console
 * window flashes on screen when a task fires. It rebuilds the exact
 * `cmd /c ""<bin>" <args> 1>>"<out>" 2>>"<err>""` line - see
 * `buildLauncherArguments` for the token layout - and runs it HIDDEN
 * (WshShell.Run windowStyle 0), WAITING for it (waitOnReturn true) so the
 * always-on task still registers as Running for the IgnoreNew keep-alive.
 *
 * ASCII-only on purpose so it is byte-identical whether read as ANSI or UTF-8.
 */
export const LAUNCHER_VBS =
  "' phantombot hidden launcher - generated by taskScheduler.ts. Do not edit.\r\n" +
  "' Runs a phantombot subcommand with stdout/stderr redirected to log files,\r\n" +
  "' with no visible console window (avoids the cmd.exe pop-up on every tick).\r\n" +
  "' Args: 0=exe path  1=subcommand line  2=stdout log  3=stderr log\r\n" +
  "Option Explicit\r\n" +
  "Dim sh, a, q, cmd\r\n" +
  "Set sh = CreateObject(\"WScript.Shell\")\r\n" +
  "Set a = WScript.Arguments\r\n" +
  "q = Chr(34)\r\n" +
  "cmd = \"cmd /c \" & q & q & a(0) & q & \" \" & a(1) & _\r\n" +
  "      \" 1>>\" & q & a(2) & q & \" 2>>\" & q & a(3) & q & q\r\n" +
  "sh.Run cmd, 0, True\r\n";

/**
 * Write the shared hidden-launcher script to its stable location (idempotent;
 * overwrites so a template change lands on the next install/self-heal). The
 * parent dir doubles as the data dir whose logs\ subfolder the tasks redirect
 * into, so we ensure it exists here too.
 */
async function writeLauncherVbs(): Promise<void> {
  await mkdir(launcherDir(), { recursive: true });
  await writeFile(launcherVbsPath(), LAUNCHER_VBS, "utf8");
}

/**
 * Build the wscript.exe argument string for a task's <Exec>. Each value is a
 * single quoted token so paths with spaces survive Windows' CommandLineToArgvW
 * parsing (which the launcher reads back as WScript.Arguments 0..3):
 *   //B "<launcher.vbs>" "<binPath>" "<args joined>" "<outLog>" "<errLog>"
 * The binary path stays a visible task argument so drift detection still works.
 */
export function buildLauncherArguments(
  binPath: string,
  args: readonly string[],
  outLog: string,
  errLog: string,
): string {
  const q = (s: string) => `"${s}"`;
  return [
    // Batch mode: suppress any runtime script-error GUI dialog (wscript's
    // default), which would itself be a visible popup - the exact thing this
    // launcher exists to avoid.
    "//B",
    q(launcherVbsPath()),
    q(binPath),
    q(args.join(" ")),
    q(outLog),
    q(errLog),
  ].join(" ");
}

interface TaskXmlOptions {
  uri: string;
  description: string;
  /** Current user's SID — principal + logon-trigger UserId. */
  sid: string;
  label: TaskLabel;
  binPath: string;
  args: readonly string[];
  /** Trigger XML block (already indented). */
  triggersXml: string;
  /** ISO 8601 duration; "PT0S" = unlimited (for the always-on daemon). */
  executionTimeLimit: string;
  /** Emit a <RestartOnFailure> safety net (the always-on task only). */
  restartOnFailure?: boolean;
}

function generateTaskXml(opts: TaskXmlOptions): string {
  const { out: outLog, err: errLog } = taskLogPaths(opts.label);
  const execArgs = buildLauncherArguments(
    opts.binPath,
    opts.args,
    outLog,
    errLog,
  );
  const workingDir = homedir();

  const restart = opts.restartOnFailure
    ? "    <RestartOnFailure>\n" +
      "      <Interval>PT1M</Interval>\n" +
      "      <Count>3</Count>\n" +
      "    </RestartOnFailure>\n"
    : "";

  return (
    '<?xml version="1.0" encoding="UTF-16"?>\n' +
    '<Task version="1.2" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">\n' +
    "  <RegistrationInfo>\n" +
    `    <Description>${xmlEscape(opts.description)}</Description>\n` +
    `    <URI>${xmlEscape(opts.uri)}</URI>\n` +
    "  </RegistrationInfo>\n" +
    "  <Triggers>\n" +
    opts.triggersXml +
    "  </Triggers>\n" +
    "  <Principals>\n" +
    '    <Principal id="Author">\n' +
    `      <UserId>${xmlEscape(opts.sid)}</UserId>\n` +
    "      <LogonType>InteractiveToken</LogonType>\n" +
    "      <RunLevel>LeastPrivilege</RunLevel>\n" +
    "    </Principal>\n" +
    "  </Principals>\n" +
    "  <Settings>\n" +
    "    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>\n" +
    "    <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>\n" +
    "    <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>\n" +
    "    <AllowHardTerminate>true</AllowHardTerminate>\n" +
    "    <StartWhenAvailable>true</StartWhenAvailable>\n" +
    "    <RunOnlyIfNetworkAvailable>false</RunOnlyIfNetworkAvailable>\n" +
    "    <IdleSettings>\n" +
    "      <StopOnIdleEnd>false</StopOnIdleEnd>\n" +
    "      <RestartOnIdle>false</RestartOnIdle>\n" +
    "    </IdleSettings>\n" +
    "    <AllowStartOnDemand>true</AllowStartOnDemand>\n" +
    "    <Enabled>true</Enabled>\n" +
    "    <Hidden>false</Hidden>\n" +
    "    <RunOnlyIfIdle>false</RunOnlyIfIdle>\n" +
    "    <WakeToRun>false</WakeToRun>\n" +
    `    <ExecutionTimeLimit>${opts.executionTimeLimit}</ExecutionTimeLimit>\n` +
    "    <Priority>7</Priority>\n" +
    restart +
    "  </Settings>\n" +
    '  <Actions Context="Author">\n' +
    "    <Exec>\n" +
    "      <Command>wscript.exe</Command>\n" +
    `      <Arguments>${xmlEscape(execArgs)}</Arguments>\n` +
    `      <WorkingDirectory>${xmlEscape(workingDir)}</WorkingDirectory>\n` +
    "    </Exec>\n" +
    "  </Actions>\n" +
    "</Task>\n"
  );
}

/**
 * A fixed past StartBoundary. Task Scheduler requires every TimeTrigger /
 * CalendarTrigger to carry a StartBoundary; using a fixed past instant means
 * "active immediately" and the repetition interval takes over from there.
 */
const START_BOUNDARY = "2020-01-01T00:00:00";
const NIGHTLY_BOUNDARY = "2020-01-01T02:00:00";

function repeatingTimeTrigger(interval: string): string {
  return (
    "    <TimeTrigger>\n" +
    "      <Enabled>true</Enabled>\n" +
    `      <StartBoundary>${START_BOUNDARY}</StartBoundary>\n` +
    "      <Repetition>\n" +
    `        <Interval>${interval}</Interval>\n` +
    "        <StopAtDurationEnd>false</StopAtDurationEnd>\n" +
    "      </Repetition>\n" +
    "    </TimeTrigger>\n"
  );
}

/** Generate the always-on phantombot agent task XML (keep-alive). */
export function generatePhantombotTaskXml(sid: string, binPath: string): string {
  // LogonTrigger starts it at logon; the 1-minute TimeTrigger + IgnoreNew
  // restarts it if it ever dies. Together: keep-alive while logged in.
  const triggers =
    "    <LogonTrigger>\n" +
    "      <Enabled>true</Enabled>\n" +
    `      <UserId>${xmlEscape(sid)}</UserId>\n` +
    "    </LogonTrigger>\n" +
    repeatingTimeTrigger("PT1M");
  return generateTaskXml({
    uri: PHANTOMBOT_TASK,
    description: "phantombot always-on agent (phantombot run)",
    sid,
    label: "phantombot",
    binPath,
    args: ["run"],
    triggersXml: triggers,
    executionTimeLimit: "PT0S", // unlimited — long-running daemon
    restartOnFailure: true,
  });
}

/** Generate the heartbeat task XML — fires every 30 minutes. */
export function generateHeartbeatTaskXml(sid: string, binPath: string): string {
  return generateTaskXml({
    uri: HEARTBEAT_TASK,
    description: "phantombot heartbeat (every 30 minutes)",
    sid,
    label: "heartbeat",
    binPath,
    args: ["heartbeat"],
    triggersXml: repeatingTimeTrigger("PT30M"),
    executionTimeLimit: "PT1H",
  });
}

/** Generate the nightly task XML — fires daily at 02:00. */
export function generateNightlyTaskXml(sid: string, binPath: string): string {
  const triggers =
    "    <CalendarTrigger>\n" +
    "      <Enabled>true</Enabled>\n" +
    `      <StartBoundary>${NIGHTLY_BOUNDARY}</StartBoundary>\n` +
    "      <ScheduleByDay>\n" +
    "        <DaysInterval>1</DaysInterval>\n" +
    "      </ScheduleByDay>\n" +
    "    </CalendarTrigger>\n";
  return generateTaskXml({
    uri: NIGHTLY_TASK,
    description: "phantombot nightly (daily at 02:00)",
    sid,
    label: "nightly",
    binPath,
    args: ["nightly"],
    triggersXml: triggers,
    executionTimeLimit: "PT1H",
  });
}

/** Generate the tick task XML — fires every 60 seconds. */
export function generateTickTaskXml(sid: string, binPath: string): string {
  return generateTaskXml({
    uri: TICK_TASK,
    description: "phantombot tick (every 60 seconds)",
    sid,
    label: "tick",
    binPath,
    args: ["tick"],
    triggersXml: repeatingTimeTrigger("PT1M"),
    executionTimeLimit: "PT1H",
  });
}

export interface SchtasksResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export interface SchtasksRunner {
  run(args: readonly string[]): Promise<SchtasksResult>;
}

export class BunSchtasksRunner implements SchtasksRunner {
  async run(args: readonly string[]): Promise<SchtasksResult> {
    const proc = Bun.spawn(["schtasks", ...args], {
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
 * Write a Task Scheduler XML file. schtasks /Create /XML is picky about
 * encoding: the most broadly-compatible form is UTF-16LE with a BOM matching
 * the `encoding="UTF-16"` declaration, so we encode explicitly rather than
 * relying on writeFile's UTF-8 default.
 */
async function writeTaskXml(path: string, xml: string): Promise<void> {
  const bom = Buffer.from([0xff, 0xfe]);
  const body = Buffer.from(xml, "utf16le");
  await writeFile(path, Buffer.concat([bom, body]));
}

interface TaskSpec {
  name: string;
  label: TaskLabel;
  xml: string;
}

/**
 * Write a task's XML to a transient file, import it with
 * `schtasks /Create /XML … /F` (idempotent — /F overwrites an existing task
 * of the same name), then delete the transient file. Shared by the full
 * install and the heartbeat self-heal so both encode/quote identically.
 */
async function importTaskSpec(
  spec: TaskSpec,
  xmlDir: string,
  schtasks: SchtasksRunner,
): Promise<SchtasksResult> {
  const xmlPath = join(xmlDir, `phantombot-task-${spec.label}.xml`);
  await writeTaskXml(xmlPath, spec.xml);
  const r = await schtasks.run([
    "/Create",
    "/TN",
    spec.name,
    "/XML",
    xmlPath,
    "/F",
  ]);
  // Best-effort cleanup of the transient import file.
  await unlink(xmlPath).catch(() => {});
  return r;
}

function allTaskSpecs(sid: string, binPath: string): TaskSpec[] {
  return [
    {
      name: PHANTOMBOT_TASK,
      label: "phantombot",
      xml: generatePhantombotTaskXml(sid, binPath),
    },
    {
      name: HEARTBEAT_TASK,
      label: "heartbeat",
      xml: generateHeartbeatTaskXml(sid, binPath),
    },
    {
      name: NIGHTLY_TASK,
      label: "nightly",
      xml: generateNightlyTaskXml(sid, binPath),
    },
    { name: TICK_TASK, label: "tick", xml: generateTickTaskXml(sid, binPath) },
  ];
}

export interface InstallTaskSchedulerOptions {
  binPath: string;
  /** Override the current user's SID (tests). Production resolves it live. */
  sid?: string;
  /** Directory for the transient XML import files (tests). Defaults to %TEMP%. */
  xmlDir?: string;
  schtasks: SchtasksRunner;
  out: WriteSink;
  err: WriteSink;
}

/**
 * Register (or refresh) all four scheduled tasks. Writes each task's XML to a
 * transient file, imports it with `schtasks /Create /XML … /F` (the /F makes
 * the operation idempotent — it overwrites an existing task of the same name),
 * then deletes the transient file.
 */
export async function installPhantombotTasks(
  opts: InstallTaskSchedulerOptions,
): Promise<{ installed: boolean }> {
  const sid = opts.sid ?? currentUserSid();
  const xmlDir = opts.xmlDir ?? tmpdir();

  // Log dir must exist before the tasks first fire — cmd's `>>` redirection
  // will fail to create a file inside a missing directory. The hidden launcher
  // the tasks invoke must exist too, or wscript.exe has nothing to run.
  await mkdir(logsDir(), { recursive: true });
  await mkdir(xmlDir, { recursive: true });
  await writeLauncherVbs();

  for (const spec of allTaskSpecs(sid, opts.binPath)) {
    const r = await importTaskSpec(spec, xmlDir, opts.schtasks);
    if (r.exitCode !== 0) {
      opts.err.write(
        `schtasks /Create ${spec.name} failed (${r.exitCode}): ${r.stderr.trim() || r.stdout.trim()}\n`,
      );
      return { installed: false };
    }
    opts.out.write(`registered scheduled task: ${spec.name}\n`);
  }

  opts.out.write(
    `registered ${PHANTOMBOT_TASK} + heartbeat + nightly + tick\n`,
  );
  return { installed: true };
}

export interface UninstallTaskSchedulerOptions {
  schtasks: SchtasksRunner;
  out: WriteSink;
  err: WriteSink;
}

/**
 * Delete all four scheduled tasks (best-effort). A missing task returns
 * non-zero from schtasks — logged and skipped, never fatal. The empty
 * \Phantombot folder is harmless and left in place (schtasks has no reliable
 * folder-delete verb across Windows versions).
 */
export async function uninstallPhantombotTasks(
  opts: UninstallTaskSchedulerOptions,
): Promise<{ removed: boolean }> {
  const names = [TICK_TASK, NIGHTLY_TASK, HEARTBEAT_TASK, PHANTOMBOT_TASK];
  for (const name of names) {
    const r = await opts.schtasks.run(["/Delete", "/TN", name, "/F"]);
    if (r.exitCode !== 0) {
      opts.out.write(
        `schtasks /Delete ${name} returned ${r.exitCode} (continuing)\n`,
      );
    } else {
      opts.out.write(`removed scheduled task: ${name}\n`);
    }
  }
  // Best-effort removal of the shared launcher script (the tasks are gone, so
  // nothing references it any more). A missing file is fine.
  await unlink(launcherVbsPath()).catch(() => {});
  return { removed: true };
}

/**
 * Windows paths are case-insensitive, and `schtasks /Query /XML` may echo the
 * stored command line back with different casing than `process.execPath`
 * reports. Compare case-folded so a mere case difference isn't mistaken for
 * drift (which would trigger a needless — though harmless — re-import + log).
 */
function xmlReferencesBin(xml: string, binPath: string): boolean {
  return xml.toLowerCase().includes(binPath.toLowerCase());
}

export interface EnsureTasksCurrentOptions {
  binPath: string;
  /** Override the current user's SID (tests). Production resolves it live. */
  sid?: string;
  /** Directory for the transient XML import files (tests). Defaults to %TEMP%. */
  xmlDir?: string;
  schtasks: SchtasksRunner;
}

export interface EnsureTasksCurrentResult {
  /**
   * Task names that were (re)registered because they were missing or still
   * referenced a stale binary path. Empty = every task was already current.
   */
  rewrote: string[];
}

/**
 * Self-heal the four scheduled tasks — the Windows analogue of systemd's
 * `ensureSystemdUnitsCurrent`. For each task, query its registered XML; if the
 * task is missing, or its command line no longer points at the current binary
 * (the moved/updated-binary case), re-import it from the current template.
 *
 * Idempotent: a task that already references `binPath` is left untouched, so
 * on a healthy box this is four cheap `/Query` calls and nothing else.
 *
 * Called on the heartbeat's regular cadence (see `defaultHealTaskScheduler` in
 * cli/heartbeat.ts), so a long-running box that never restarts still re-checks
 * every 30 minutes and repairs drift in place — matching the Linux experience
 * where a moved binary would otherwise leave the tasks silently pointing at a
 * path that no longer exists.
 *
 * Pure on its inputs (caller supplies the SID, temp dir and runner), so it
 * unit-tests with a fake runner and no real schtasks.
 */
export async function ensureTasksCurrent(
  opts: EnsureTasksCurrentOptions,
): Promise<EnsureTasksCurrentResult> {
  const sid = opts.sid ?? currentUserSid();
  const xmlDir = opts.xmlDir ?? tmpdir();
  const rewrote: string[] = [];
  let ensuredDirs = false;

  for (const spec of allTaskSpecs(sid, opts.binPath)) {
    const q = await opts.schtasks.run(["/Query", "/TN", spec.name, "/XML"]);
    const current =
      q.exitCode === 0 && xmlReferencesBin(q.stdout, opts.binPath);
    if (current) continue; // registered and already points at this binary

    // Missing or drifted → re-import. Ensure the log + temp dirs and the hidden
    // launcher exist first (a fresh box healing a never-installed task needs
    // the logs dir before the task can redirect into it, and the launcher
    // before wscript.exe can run it), but only pay for it once.
    if (!ensuredDirs) {
      await mkdir(logsDir(), { recursive: true });
      await mkdir(xmlDir, { recursive: true });
      await writeLauncherVbs();
      ensuredDirs = true;
    }
    const r = await importTaskSpec(spec, xmlDir, opts.schtasks);
    if (r.exitCode === 0) rewrote.push(spec.name);
  }

  return { rewrote };
}

export interface TaskSchedulerServiceControl {
  isActive(): Promise<boolean>;
  start(): Promise<{ ok: boolean; stderr?: string }>;
  stop(): Promise<{ ok: boolean; stderr?: string }>;
  restart(): Promise<{ ok: boolean; stderr?: string }>;
  rerenderUnitIfStale(): Promise<{ rerendered: boolean; backupPath?: string }>;
}

/**
 * Default TaskSchedulerServiceControl backed by real schtasks. Returns
 * isActive=false on any error so callers can treat "task unknown" the same as
 * "not running".
 */
export function defaultTaskSchedulerServiceControl(): TaskSchedulerServiceControl {
  const runner = new BunSchtasksRunner();
  return {
    async isActive() {
      // `schtasks /Query /TN <name>` exits 0 when the task is registered —
      // the Task Scheduler analogue of a launchd unit being loaded.
      const r = await runner.run(["/Query", "/TN", PHANTOMBOT_TASK]);
      return r.exitCode === 0;
    },
    async start() {
      // The main task carries a 1-minute keep-alive TimeTrigger, which `stop()`
      // disables. Re-enable it first so the supervisor keeps the process up,
      // then kick off a run immediately rather than waiting up to 60s for the
      // next trigger. /Change /ENABLE on an already-enabled task is harmless.
      await runner.run(["/Change", "/TN", PHANTOMBOT_TASK, "/ENABLE"]);
      const r = await runner.run(["/Run", "/TN", PHANTOMBOT_TASK]);
      return r.exitCode === 0
        ? { ok: true }
        : { ok: false, stderr: r.stderr.trim() || `exit ${r.exitCode}` };
    },
    async stop() {
      // /End alone isn't enough: the 1-minute keep-alive TimeTrigger would
      // relaunch within 60s. Disable the task first so the trigger can't fire,
      // then end the running instance. /Disable on an already-disabled task is
      // harmless; /End on a stopped task is harmless.
      const r = await runner.run(["/Change", "/TN", PHANTOMBOT_TASK, "/DISABLE"]);
      await runner.run(["/End", "/TN", PHANTOMBOT_TASK]);
      return r.exitCode === 0
        ? { ok: true }
        : { ok: false, stderr: r.stderr.trim() || `exit ${r.exitCode}` };
    },
    async restart() {
      // End any running instance, then start a fresh one — the schtasks
      // analogue of `systemctl restart`. Re-enable first in case a prior
      // `stop()` disabled the keep-alive trigger; a restart should always
      // leave the service running AND supervised. /End on a stopped task is
      // harmless.
      await runner.run(["/Change", "/TN", PHANTOMBOT_TASK, "/ENABLE"]);
      await runner.run(["/End", "/TN", PHANTOMBOT_TASK]);
      const r = await runner.run(["/Run", "/TN", PHANTOMBOT_TASK]);
      return r.exitCode === 0
        ? { ok: true }
        : { ok: false, stderr: r.stderr.trim() || `exit ${r.exitCode}` };
    },
    async rerenderUnitIfStale() {
      // Auto-heal a moved binary: if any registered task no longer references
      // the current executable path, re-import them. Only meaningful when we
      // ARE the compiled binary (dev `bun src/index.ts` shouldn't rewrite
      // tasks), and only when an install already exists (don't provision tasks
      // the user never asked for — mirrors the systemd `existsSync(unitPath)`
      // guard).
      const binPath = process.execPath;
      if (!basename(binPath).startsWith("phantombot")) {
        return { rerendered: false };
      }
      const installed = await runner.run(["/Query", "/TN", PHANTOMBOT_TASK]);
      if (installed.exitCode !== 0) return { rerendered: false };
      let sid: string;
      try {
        sid = currentUserSid();
      } catch {
        return { rerendered: false };
      }
      const r = await ensureTasksCurrent({ binPath, sid, schtasks: runner });
      return { rerendered: r.rewrote.length > 0 };
    },
  };
}

/** Absolute path of the always-on task's stdout log (used for hint output). */
export function taskSchedulerLogsHint(): string {
  const { out } = taskLogPaths("phantombot");
  return out;
}
