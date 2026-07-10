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
import { log } from "./logger.ts";

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

/** A running Windows process, as reported by the process lister. */
export interface RunningProcess {
  pid: number;
  commandLine: string;
  /** Image name, e.g. "phantombot.exe". Empty when the lister can't see it. */
  name?: string;
  /** Parent PID as reported by the OS. May point at a long-dead process. */
  parentPid?: number;
  /** Process creation time (ms since epoch), used to reject recycled parents. */
  createdMs?: number;
}

/**
 * Enumerate + terminate Windows processes. Abstracted behind an interface so
 * `stop()`/`restart()` are unit-testable with a fake — the real backend shells
 * out to PowerShell (CIM) and taskkill.
 */
export interface ProcessManager {
  /**
   * EVERY running process, with parentage. We can't filter to phantombot.exe:
   * the orphans we must reap are the daemon's harness children (claude.exe,
   * node.exe, cmd.exe, …), which carry unrelated image names.
   */
  listAll(): Promise<RunningProcess[]>;
  /** Force-terminate a single process by PID (best-effort; never throws). */
  kill(pid: number): Promise<void>;
}

/**
 * Is this command line the always-on daemon (`phantombot run`)?
 *
 * `schtasks /End` is unreliable at killing phantombot's detached daemon — the
 * scheduler loses track of the real PID, so `/End` no-ops and the process
 * survives a "stop"/"restart". To finish the job we enumerate phantombot.exe
 * processes and kill the daemon directly — but we must NEVER kill the CLI
 * invoker that's running `stop`/`restart` (itself a phantombot.exe). The daemon
 * is uniquely identified by its first argument being exactly `run`; the CLI
 * invoker's first arg is `stop`/`restart`, so it's naturally excluded (belt +
 * braces: callers also skip their own PID).
 */
export function isDaemonCommandLine(commandLine: string): boolean {
  // Strip a leading quoted ("...") or bare (\S+) executable token, then take
  // the first remaining whitespace-separated argument.
  const m = commandLine.match(/^\s*(?:"[^"]*"|\S+)\s+(.*)$/);
  const firstArg = (m?.[1] ?? "").trim().split(/\s+/)[0] ?? "";
  return firstArg.toLowerCase() === "run";
}

/**
 * Every descendant of `rootPid`, breadth-first (nearest children first).
 *
 * ── Why the creation-time guard ──
 * Windows never reparents orphans, so a dead process's PID can be recycled
 * while its children still name it as `parentPid`. Worse, a BRAND NEW,
 * unrelated process can be handed the recycled PID and inherit a pile of
 * bogus "children". Walking parentage naively would then kill innocent
 * processes.
 *
 * A genuine child is always created AFTER its parent. So we only follow an
 * edge when the child's creation time is >= the parent's. When either
 * timestamp is missing we follow the edge anyway — degrading to the previous
 * (unguarded) behaviour rather than silently under-reaping.
 *
 * Exported for testing.
 */
export function descendantsOf(
  procs: readonly RunningProcess[],
  rootPid: number,
): number[] {
  const byParent = new Map<number, RunningProcess[]>();
  for (const p of procs) {
    if (p.parentPid === undefined) continue;
    const siblings = byParent.get(p.parentPid);
    if (siblings) siblings.push(p);
    else byParent.set(p.parentPid, [p]);
  }
  const createdOf = new Map<number, number | undefined>(
    procs.map((p) => [p.pid, p.createdMs]),
  );

  const out: number[] = [];
  const seen = new Set<number>([rootPid]); // also guards parentage cycles
  let frontier = [rootPid];
  while (frontier.length > 0) {
    const next: number[] = [];
    for (const parent of frontier) {
      const parentCreated = createdOf.get(parent);
      for (const child of byParent.get(parent) ?? []) {
        if (seen.has(child.pid)) continue;
        // Reject a recycled-PID parent: a real child can't predate its parent.
        if (
          parentCreated !== undefined &&
          child.createdMs !== undefined &&
          child.createdMs < parentCreated
        ) {
          continue;
        }
        seen.add(child.pid);
        out.push(child.pid);
        next.push(child.pid);
      }
    }
    frontier = next;
  }
  return out;
}

/** Does this process look like the phantombot binary? */
function isPhantombotImage(p: RunningProcess): boolean {
  return (p.name ?? "").toLowerCase() === "phantombot.exe";
}

/**
 * The exact PIDs `stop()`/`restart()` must terminate, in kill order.
 *
 * For each stray `phantombot run` daemon we take the daemon PLUS its whole
 * descendant tree — the harness processes (claude.exe and its children) that
 * `taskkill /F /PID` leaves behind as orphans, because it terminates one
 * process and Windows has no process groups to sweep the rest.
 *
 * ── Why not just `taskkill /T` ──
 * `/T` would be simpler, but it kills the tree from the root DOWN — and the
 * CLI invoker running `restart` is frequently a DESCENDANT of the daemon
 * (the agent's own Bash tool shells out to `phantombot restart`). `/T` would
 * therefore kill the very process that still has to call `schtasks /Run`,
 * turning an instant restart into a silent 60-second wait for the keep-alive
 * trigger. So we enumerate the tree ourselves and subtract our own subtree.
 *
 * Order is root-first: the daemon dies before its children, so it can't spawn
 * a fresh harness while we're partway through reaping the old one.
 *
 * Exported for testing.
 */
export function daemonKillOrder(
  procs: readonly RunningProcess[],
  selfPid: number,
): number[] {
  // Never kill ourselves, nor anything we spawned (e.g. the powershell we
  // just used to enumerate). Our ANCESTORS are fair game — the daemon above
  // us must still die; Windows simply leaves us with a dangling parent PID.
  const protectedPids = new Set<number>([
    selfPid,
    ...descendantsOf(procs, selfPid),
  ]);

  const order: number[] = [];
  const queued = new Set<number>();
  for (const p of procs) {
    if (p.pid === selfPid) continue;
    if (!isPhantombotImage(p)) continue;
    if (!isDaemonCommandLine(p.commandLine)) continue;
    if (protectedPids.has(p.pid)) continue;
    for (const pid of [p.pid, ...descendantsOf(procs, p.pid)]) {
      if (protectedPids.has(pid) || queued.has(pid)) continue;
      queued.add(pid);
      order.push(pid);
    }
  }
  return order;
}

export class BunProcessManager implements ProcessManager {
  async listAll(): Promise<RunningProcess[]> {
    // CIM gives us the full CommandLine (tasklist does not), which we need to
    // tell the daemon (`... run`) apart from the CLI invoker (`... restart`),
    // plus ParentProcessId/CreationDate for safe tree-walking. CreationDate is
    // projected to a round-trip ISO string: piping a raw CIM DateTime through
    // ConvertTo-Json yields a shape that varies by PowerShell version.
    const script =
      "Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,Name,CommandLine," +
      "@{N='Created';E={$_.CreationDate.ToUniversalTime().ToString('o')}} | ConvertTo-Json -Compress";
    try {
      const proc = Bun.spawn(
        ["powershell", "-NoProfile", "-NonInteractive", "-Command", script],
        {
          env: { ...process.env },
          stdout: "pipe",
          stderr: "pipe",
          windowsHide: true,
        },
      );
      const stdout = await new Response(proc.stdout).text();
      await proc.exited;
      const trimmed = stdout.trim();
      if (!trimmed) return [];
      const parsed = JSON.parse(trimmed);
      const rows = Array.isArray(parsed) ? parsed : [parsed];
      return rows
        .map((r) => {
          const created = Date.parse(String(r?.Created ?? ""));
          const parent = Number(r?.ParentProcessId);
          return {
            pid: Number(r?.ProcessId),
            commandLine: String(r?.CommandLine ?? ""),
            name: String(r?.Name ?? ""),
            parentPid: Number.isFinite(parent) ? parent : undefined,
            createdMs: Number.isNaN(created) ? undefined : created,
          };
        })
        .filter((r) => Number.isFinite(r.pid) && r.pid > 0);
    } catch {
      // PowerShell missing / JSON malformed → treat as "nothing to kill".
      return [];
    }
  }

  async kill(pid: number): Promise<void> {
    try {
      // No `/T`: `daemonKillOrder` already enumerated the tree, minus our own
      // subtree. `/T` here could sweep up the CLI invoker running `restart`.
      const proc = Bun.spawn(["taskkill", "/F", "/PID", String(pid)], {
        env: { ...process.env },
        stdout: "ignore",
        stderr: "ignore",
        // Without this every reaped PID flashes a console window on the desktop.
        windowsHide: true,
      });
      await proc.exited;
    } catch {
      // Best-effort: a race where the PID already exited is fine.
    }
  }
}

/** Injectable clock/sleep so the wait loop is testable without real delays. */
export interface WaitDeps {
  sleep: (ms: number) => Promise<void>;
  timeoutMs: number;
  intervalMs: number;
}

const defaultWaitDeps: WaitDeps = {
  sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
  timeoutMs: 10_000,
  intervalMs: 100,
};

/**
 * Block until none of `pids` are running, or the timeout expires.
 *
 * `taskkill /F` returns as soon as the OS *accepts* the termination request,
 * not when the process is actually gone. `restart()` used to fire
 * `schtasks /Run` immediately afterwards, so the new daemon could start while
 * the old one still held the single-instance run-lock — the new process saw a
 * live holder, refused to start, and the restart silently no-opped. Waiting
 * for the PIDs to actually disappear closes that race.
 *
 * Returns true if everything exited, false on timeout (caller proceeds anyway —
 * a stuck PID shouldn't wedge `stop()` forever).
 */
export async function waitForProcessesGone(
  pm: ProcessManager,
  pids: readonly number[],
  deps: WaitDeps = defaultWaitDeps,
): Promise<boolean> {
  if (pids.length === 0) return true;
  const target = new Set(pids);
  const deadline = Date.now() + deps.timeoutMs;
  for (;;) {
    const alive = (await pm.listAll()).filter((p) => target.has(p.pid));
    if (alive.length === 0) return true;
    if (Date.now() >= deadline) {
      log.warn("taskScheduler: processes still alive after kill timeout", {
        pids: alive.map((p) => p.pid),
      });
      return false;
    }
    await deps.sleep(deps.intervalMs);
  }
}

/**
 * Kill every stray `phantombot run` daemon AND its orphaned descendants,
 * skipping the current process (the CLI invoker running stop/restart) and
 * anything it spawned. This is the reliable teardown `schtasks /End` fails to
 * guarantee. Blocks until the killed PIDs are actually gone, so a following
 * `schtasks /Run` can't race the old process's run-lock.
 *
 * Returns the number of processes killed.
 */
export async function killDaemonProcesses(
  pm: ProcessManager,
  selfPid: number,
  waitDeps: WaitDeps = defaultWaitDeps,
): Promise<number> {
  const procs = await pm.listAll();
  const victims = daemonKillOrder(procs, selfPid);
  for (const pid of victims) {
    await pm.kill(pid);
  }
  await waitForProcessesGone(pm, victims, waitDeps);
  return victims.length;
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
export function defaultTaskSchedulerServiceControl(
  runner: SchtasksRunner = new BunSchtasksRunner(),
  processManager: ProcessManager = new BunProcessManager(),
  selfPid: number = process.pid,
): TaskSchedulerServiceControl {
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
      // /End alone isn't enough on two counts: the 1-minute keep-alive
      // TimeTrigger would relaunch within 60s, AND /End often fails to kill
      // phantombot's detached daemon at all (the scheduler loses its PID). So:
      // disable the trigger, /End the task, then kill any surviving `phantombot
      // run` daemon directly. /Disable on an already-disabled task is harmless;
      // /End on a stopped task is harmless.
      const r = await runner.run(["/Change", "/TN", PHANTOMBOT_TASK, "/DISABLE"]);
      await runner.run(["/End", "/TN", PHANTOMBOT_TASK]);
      await killDaemonProcesses(processManager, selfPid);
      return r.exitCode === 0
        ? { ok: true }
        : { ok: false, stderr: r.stderr.trim() || `exit ${r.exitCode}` };
    },
    async restart() {
      // Kill any running instance, then start a fresh one — the schtasks
      // analogue of `systemctl restart`. Re-enable the keep-alive trigger FIRST
      // (before killing): if this CLI is itself a descendant of the daemon we're
      // about to kill, the /Run below never executes — but the re-enabled
      // 1-minute trigger relaunches the swapped binary within 60s regardless.
      // /End is best-effort; killDaemonProcesses guarantees the old process is
      // actually gone so /Run doesn't bounce off the single-instance lock.
      await runner.run(["/Change", "/TN", PHANTOMBOT_TASK, "/ENABLE"]);
      await runner.run(["/End", "/TN", PHANTOMBOT_TASK]);
      await killDaemonProcesses(processManager, selfPid);
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
