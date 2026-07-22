/**
 * Tests for Windows Task Scheduler XML generation + install/uninstall logic.
 * Uses a fake SchtasksRunner that records every invocation, so we don't need
 * actual schtasks.exe on the test host (and so these tests pass on Linux CI).
 * The XML is generated as a plain string regardless of platform, so all of
 * these run everywhere.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { rmrf } from "./fixtures/rmrf.ts";

import {
  buildLauncherArguments,
  defaultTaskSchedulerServiceControl,
  ensureTasksCurrent,
  generateHeartbeatTaskXml,
  generateNightlyTaskXml,
  generatePhantombotTaskXml,
  generateTickTaskXml,
  daemonKillOrder,
  descendantsOf,
  installPhantombotTasks,
  isDaemonCommandLine,
  killDaemonProcesses,
  launcherVbsPath,
  LAUNCHER_VBS,
  ProcessEnumerationError,
  type ProcessManager,
  type RunningProcess,
  type WaitDeps,
  waitForProcessesGone,
  type SchtasksResult,
  type SchtasksRunner,
  taskLogPaths,
  uninstallPhantombotTasks,
  HEARTBEAT_TASK,
  NIGHTLY_TASK,
  PHANTOMBOT_TASK,
  TICK_TASK,
} from "../src/lib/taskScheduler.ts";

const SID = "S-1-5-21-1111111111-2222222222-3333333333-1001";
const BIN = "C:\\Users\\andrew\\AppData\\Local\\phantombot\\bin\\phantombot.exe";

class FakeSchtasks implements SchtasksRunner {
  calls: string[][] = [];
  responses: SchtasksResult[] = [];
  async run(args: readonly string[]): Promise<SchtasksResult> {
    this.calls.push([...args]);
    return this.responses.shift() ?? { exitCode: 0, stdout: "", stderr: "" };
  }
}

class CaptureStream {
  chunks: string[] = [];
  write(s: string | Uint8Array): boolean {
    this.chunks.push(typeof s === "string" ? s : new TextDecoder().decode(s));
    return true;
  }
  get text(): string {
    return this.chunks.join("");
  }
}

let workdir: string;

beforeEach(async () => {
  workdir = await mkdtemp(join(tmpdir(), "phantombot-schtasks-"));
});

afterEach(async () => {
  await rmrf(workdir);
});

describe("taskLogPaths", () => {
  test("honours XDG_DATA_HOME so the log hint matches where tasks write", () => {
    const prev = process.env.XDG_DATA_HOME;
    try {
      process.env.XDG_DATA_HOME = join("/tmp", "xdg-data-override");
      const { out, err } = taskLogPaths("phantombot");
      // Both the scheduler action and platform.ts logsCommand() resolve
      // through this function, so an override must flow into both.
      expect(out).toBe(
        join("/tmp", "xdg-data-override", "phantombot", "logs", "phantombot.out.log"),
      );
      expect(err).toBe(
        join("/tmp", "xdg-data-override", "phantombot", "logs", "phantombot.err.log"),
      );
    } finally {
      if (prev === undefined) delete process.env.XDG_DATA_HOME;
      else process.env.XDG_DATA_HOME = prev;
    }
  });
});

describe("buildLauncherArguments", () => {
  test("passes launcher, binary, subcommand and both logs as quoted tokens", () => {
    const args = buildLauncherArguments(
      BIN,
      ["run"],
      "C:\\logs\\phantombot.out.log",
      "C:\\logs\\phantombot.err.log",
    );
    // //B (batch mode) suppresses any runtime script-error dialog. Each value
    // is its own quoted token so a spaced path survives arg parsing, and the
    // binary path stays visible (drift detection reads it back).
    expect(args).toBe(
      `//B "${launcherVbsPath()}" "${BIN}" "run" "C:\\logs\\phantombot.out.log" "C:\\logs\\phantombot.err.log"`,
    );
  });
});

describe("LAUNCHER_VBS", () => {
  test("runs the child hidden and waits, rebuilding the cmd redirection", () => {
    // windowStyle 0 (hidden) + waitOnReturn True - no console flash, but Task
    // Scheduler still sees the always-on task as Running for IgnoreNew.
    expect(LAUNCHER_VBS).toContain("sh.Run cmd, 0, True");
    // Rebuilds `cmd /c ""<exe>" <args> 1>>"<out>" 2>>"<err>""` from the tokens.
    expect(LAUNCHER_VBS).toContain('"cmd /c "');
    expect(LAUNCHER_VBS).toContain('" 1>>"');
    expect(LAUNCHER_VBS).toContain('" 2>>"');
    // ASCII-only (byte-identical as ANSI or UTF-8) and CRLF-terminated.
    expect(Buffer.byteLength(LAUNCHER_VBS, "utf8")).toBe(LAUNCHER_VBS.length);
    expect(LAUNCHER_VBS).toContain("\r\n");
  });
});

describe("generatePhantombotTaskXml", () => {
  const xml = generatePhantombotTaskXml(SID, BIN);

  test("is a Task Scheduler 1.2 document with the right URI", () => {
    expect(xml).toContain('<?xml version="1.0" encoding="UTF-16"?>');
    expect(xml).toContain(
      '<Task version="1.2" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">',
    );
    expect(xml).toContain(`<URI>${PHANTOMBOT_TASK}</URI>`);
  });

  test("runs as the current user by SID, only while logged in, no elevation", () => {
    expect(xml).toContain(`<UserId>${SID}</UserId>`);
    expect(xml).toContain("<LogonType>InteractiveToken</LogonType>");
    expect(xml).toContain("<RunLevel>LeastPrivilege</RunLevel>");
  });

  test("keep-alive: logon trigger + 1-minute repeat + IgnoreNew, unlimited runtime", () => {
    expect(xml).toContain("<LogonTrigger>");
    expect(xml).toContain("<Interval>PT1M</Interval>");
    expect(xml).toContain(
      "<MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>",
    );
    expect(xml).toContain("<ExecutionTimeLimit>PT0S</ExecutionTimeLimit>");
    expect(xml).toContain("<RestartOnFailure>");
  });

  test("action runs the hidden launcher via wscript.exe (no console flash)", () => {
    // wscript.exe (no console) runs the launcher, which spawns cmd hidden, so
    // the task never pops a visible window; cmd.exe is no longer the Command.
    expect(xml).toContain("<Command>wscript.exe</Command>");
    expect(xml).not.toContain("<Command>cmd.exe</Command>");
    // wscript runs in batch mode so a script error never pops its own dialog.
    expect(xml).toContain("//B");
    // The launcher path and the binary path are both quoted args…
    expect(xml).toContain(`"${launcherVbsPath()}"`);
    expect(xml).toContain(`"${BIN}"`);
    // …and the per-task log paths are handed to the launcher.
    expect(xml).toContain("phantombot.out.log");
    expect(xml).toContain("phantombot.err.log");
    // The redirection operators now live in the .vbs, never in the task XML.
    expect(xml).not.toContain("1>>");
    expect(xml).not.toContain("1&gt;&gt;");
  });
});

describe("companion task schedules", () => {
  test("heartbeat repeats every 30 minutes", () => {
    const xml = generateHeartbeatTaskXml(SID, BIN);
    expect(xml).toContain(`<URI>${HEARTBEAT_TASK}</URI>`);
    expect(xml).toContain("<Interval>PT30M</Interval>");
    expect(xml).toContain("heartbeat.out.log");
    expect(xml).not.toContain("<RestartOnFailure>");
  });

  test("nightly fires daily at 02:00 (calendar trigger)", () => {
    const xml = generateNightlyTaskXml(SID, BIN);
    expect(xml).toContain(`<URI>${NIGHTLY_TASK}</URI>`);
    expect(xml).toContain("<CalendarTrigger>");
    expect(xml).toContain("<ScheduleByDay>");
    expect(xml).toContain("<DaysInterval>1</DaysInterval>");
    expect(xml).toContain("2020-01-01T02:00:00");
  });

  test("tick repeats every minute", () => {
    const xml = generateTickTaskXml(SID, BIN);
    expect(xml).toContain(`<URI>${TICK_TASK}</URI>`);
    expect(xml).toContain("<Interval>PT1M</Interval>");
    expect(xml).toContain("tick.out.log");
  });
});

describe("XML escaping", () => {
  test("ampersands and angle brackets in the bin path become entities", () => {
    const xml = generatePhantombotTaskXml(SID, "C:\\odd&path\\<bot>.exe");
    expect(xml).toContain("C:\\odd&amp;path\\&lt;bot&gt;.exe");
  });
});

describe("installPhantombotTasks", () => {
  test("imports all four tasks with /F, in main→companions order", async () => {
    const out = new CaptureStream();
    const err = new CaptureStream();
    const st = new FakeSchtasks();
    const result = await installPhantombotTasks({
      binPath: BIN,
      sid: SID,
      xmlDir: workdir,
      schtasks: st,
      out,
      err,
    });
    expect(result.installed).toBe(true);

    const seq = st.calls.map((c) => c.join(" "));
    expect(seq).toEqual([
      `/Create /TN ${PHANTOMBOT_TASK} /XML ${join(workdir, "phantombot-task-phantombot.xml")} /F`,
      `/Create /TN ${HEARTBEAT_TASK} /XML ${join(workdir, "phantombot-task-heartbeat.xml")} /F`,
      `/Create /TN ${NIGHTLY_TASK} /XML ${join(workdir, "phantombot-task-nightly.xml")} /F`,
      `/Create /TN ${TICK_TASK} /XML ${join(workdir, "phantombot-task-tick.xml")} /F`,
    ]);
    expect(out.text).toContain("registered");
  });

  test("writes the shared hidden launcher so wscript.exe has a script to run", async () => {
    const { existsSync, readFileSync } = await import("node:fs");
    await installPhantombotTasks({
      binPath: BIN,
      sid: SID,
      xmlDir: workdir,
      schtasks: new FakeSchtasks(),
      out: new CaptureStream(),
      err: new CaptureStream(),
    });
    expect(existsSync(launcherVbsPath())).toBe(true);
    expect(readFileSync(launcherVbsPath(), "utf8")).toBe(LAUNCHER_VBS);
  });

  test("transient XML import files are cleaned up after import", async () => {
    const { existsSync } = await import("node:fs");
    const out = new CaptureStream();
    const err = new CaptureStream();
    const st = new FakeSchtasks();
    await installPhantombotTasks({
      binPath: BIN,
      sid: SID,
      xmlDir: workdir,
      schtasks: st,
      out,
      err,
    });
    expect(existsSync(join(workdir, "phantombot-task-phantombot.xml"))).toBe(
      false,
    );
    expect(existsSync(join(workdir, "phantombot-task-tick.xml"))).toBe(false);
  });

  test("XML is written as UTF-16LE with a BOM (schtasks import requirement)", async () => {
    const { readFileSync } = await import("node:fs");
    // The runner sees the file at import time — exactly when schtasks.exe
    // would — before install cleans up the transient. Capture its first bytes.
    let firstBytes: Buffer | undefined;
    const st: SchtasksRunner = {
      async run(args: readonly string[]): Promise<SchtasksResult> {
        const i = args.indexOf("/XML");
        if (i >= 0 && firstBytes === undefined) {
          firstBytes = readFileSync(args[i + 1]!);
        }
        return { exitCode: 0, stdout: "", stderr: "" };
      },
    };
    await installPhantombotTasks({
      binPath: BIN,
      sid: SID,
      xmlDir: workdir,
      schtasks: st,
      out: new CaptureStream(),
      err: new CaptureStream(),
    });
    expect(firstBytes?.[0]).toBe(0xff);
    expect(firstBytes?.[1]).toBe(0xfe);
  });

  test("fails install (and reports) when a /Create returns non-zero", async () => {
    const out = new CaptureStream();
    const err = new CaptureStream();
    const st = new FakeSchtasks();
    st.responses = [{ exitCode: 1, stdout: "", stderr: "Access is denied" }];
    const result = await installPhantombotTasks({
      binPath: BIN,
      sid: SID,
      xmlDir: workdir,
      schtasks: st,
      out,
      err,
    });
    expect(result.installed).toBe(false);
    expect(err.text).toContain("schtasks /Create");
    expect(err.text).toContain("Access is denied");
    // Bailed after the first failure — no companion imports attempted.
    expect(st.calls.length).toBe(1);
  });
});

describe("uninstallPhantombotTasks", () => {
  test("deletes each task with /F in reverse (companions→main) order", async () => {
    const out = new CaptureStream();
    const err = new CaptureStream();
    const st = new FakeSchtasks();
    const result = await uninstallPhantombotTasks({ schtasks: st, out, err });
    expect(result.removed).toBe(true);
    expect(st.calls.map((c) => c.join(" "))).toEqual([
      `/Delete /TN ${TICK_TASK} /F`,
      `/Delete /TN ${NIGHTLY_TASK} /F`,
      `/Delete /TN ${HEARTBEAT_TASK} /F`,
      `/Delete /TN ${PHANTOMBOT_TASK} /F`,
    ]);
    expect(out.text).toContain("removed scheduled task");
  });

  test("removes the shared launcher script when the tasks are torn down", async () => {
    const { existsSync } = await import("node:fs");
    // Put the launcher in place first (install writes it), then uninstall.
    await installPhantombotTasks({
      binPath: BIN,
      sid: SID,
      xmlDir: workdir,
      schtasks: new FakeSchtasks(),
      out: new CaptureStream(),
      err: new CaptureStream(),
    });
    expect(existsSync(launcherVbsPath())).toBe(true);
    await uninstallPhantombotTasks({
      schtasks: new FakeSchtasks(),
      out: new CaptureStream(),
      err: new CaptureStream(),
    });
    expect(existsSync(launcherVbsPath())).toBe(false);
  });

  test("a missing task (non-zero delete) is logged, not fatal", async () => {
    const out = new CaptureStream();
    const err = new CaptureStream();
    const st = new FakeSchtasks();
    st.responses = [
      { exitCode: 1, stdout: "", stderr: "cannot find the file specified" },
      { exitCode: 1, stdout: "", stderr: "cannot find the file specified" },
      { exitCode: 1, stdout: "", stderr: "cannot find the file specified" },
      { exitCode: 1, stdout: "", stderr: "cannot find the file specified" },
    ];
    const result = await uninstallPhantombotTasks({ schtasks: st, out, err });
    expect(result.removed).toBe(true);
    expect(out.text).toContain("returned 1 (continuing)");
  });
});

describe("ensureTasksCurrent (heartbeat self-heal)", () => {
  const OLD_BIN =
    "C:\\Users\\andrew\\AppData\\Local\\phantombot\\old\\phantombot.exe";

  /** The registered XML each task's `/Query /XML` should return, keyed by name. */
  function registeredXml(bin: string): Record<string, string> {
    return {
      [PHANTOMBOT_TASK]: generatePhantombotTaskXml(SID, bin),
      [HEARTBEAT_TASK]: generateHeartbeatTaskXml(SID, bin),
      [NIGHTLY_TASK]: generateNightlyTaskXml(SID, bin),
      [TICK_TASK]: generateTickTaskXml(SID, bin),
    };
  }

  /**
   * A schtasks fake whose `/Query /XML` answers come from a per-task map
   * (undefined => task not installed, exit 1) and whose `/Create` always
   * succeeds. Records every call so tests can assert which tasks were
   * re-imported.
   */
  class HealFake implements SchtasksRunner {
    calls: string[][] = [];
    constructor(private queryXml: Record<string, string | undefined>) {}
    async run(args: readonly string[]): Promise<SchtasksResult> {
      this.calls.push([...args]);
      if (args[0] === "/Query") {
        const tn = args[args.indexOf("/TN") + 1]!;
        const xml = this.queryXml[tn];
        if (xml === undefined) {
          return { exitCode: 1, stdout: "", stderr: "cannot find" };
        }
        return { exitCode: 0, stdout: xml, stderr: "" };
      }
      return { exitCode: 0, stdout: "", stderr: "" };
    }
    created(): string[] {
      return this.calls
        .filter((c) => c[0] === "/Create")
        .map((c) => c[c.indexOf("/TN") + 1]!);
    }
  }

  test("healthy box: every task already points at the binary → no re-import", async () => {
    const st = new HealFake(registeredXml(BIN));
    const r = await ensureTasksCurrent({
      binPath: BIN,
      sid: SID,
      xmlDir: workdir,
      schtasks: st,
    });
    expect(r.rewrote).toEqual([]);
    expect(st.created()).toEqual([]);
    // All four per-user tasks are checked for drift.
    expect(st.calls.every((c) => c[0] === "/Query")).toBe(true);
    expect(st.calls.length).toBe(4);
  });

  test("moved binary: all tasks drifted → all re-registered", async () => {
    const st = new HealFake(registeredXml(OLD_BIN));
    const r = await ensureTasksCurrent({
      binPath: BIN,
      sid: SID,
      xmlDir: workdir,
      schtasks: st,
    });
    expect(r.rewrote).toEqual([
      PHANTOMBOT_TASK,
      HEARTBEAT_TASK,
      NIGHTLY_TASK,
      TICK_TASK,
    ]);
    expect(st.created()).toEqual([
      PHANTOMBOT_TASK,
      HEARTBEAT_TASK,
      NIGHTLY_TASK,
      TICK_TASK,
    ]);
  });

  test("a single missing task is re-registered; the current ones are left alone", async () => {
    const xml = registeredXml(BIN);
    xml[TICK_TASK] = undefined as unknown as string; // tick was deleted
    const st = new HealFake(xml);
    const r = await ensureTasksCurrent({
      binPath: BIN,
      sid: SID,
      xmlDir: workdir,
      schtasks: st,
    });
    expect(r.rewrote).toEqual([TICK_TASK]);
    expect(st.created()).toEqual([TICK_TASK]);
  });

  test("path casing differences alone are not treated as drift", async () => {
    // schtasks may echo the command line back with different casing; a mere
    // case difference must not trigger a needless re-import.
    const st = new HealFake(registeredXml(BIN.toUpperCase()));
    const r = await ensureTasksCurrent({
      binPath: BIN.toLowerCase(),
      sid: SID,
      xmlDir: workdir,
      schtasks: st,
    });
    expect(r.rewrote).toEqual([]);
    expect(st.created()).toEqual([]);
  });
});

describe("isDaemonCommandLine", () => {
  test("matches the always-on daemon (`... run`)", () => {
    expect(isDaemonCommandLine(`"${BIN}" run`)).toBe(true);
    expect(isDaemonCommandLine(`${BIN} run`)).toBe(true);
    // Case-insensitive, tolerant of trailing redirection text.
    expect(isDaemonCommandLine(`"${BIN}" RUN 1>>log 2>>err`)).toBe(true);
  });

  test("does NOT match the CLI invoker (stop/restart/other)", () => {
    expect(isDaemonCommandLine(`"${BIN}" restart`)).toBe(false);
    expect(isDaemonCommandLine(`"${BIN}" stop`)).toBe(false);
    expect(isDaemonCommandLine(`"${BIN}" runner`)).toBe(false); // not a bare `run`
    expect(isDaemonCommandLine(`"${BIN}"`)).toBe(false); // no args
    expect(isDaemonCommandLine("")).toBe(false);
  });
});

/** Shorthand for a phantombot.exe process row. */
function pb(
  pid: number,
  args: string,
  parentPid?: number,
  createdMs?: number,
): RunningProcess {
  return {
    pid,
    commandLine: `"${BIN}" ${args}`,
    name: "phantombot.exe",
    parentPid,
    createdMs,
  };
}

/** Shorthand for a non-phantombot child process (harness, shell, …). */
function child(
  pid: number,
  name: string,
  parentPid: number,
  createdMs?: number,
): RunningProcess {
  return { pid, commandLine: name, name, parentPid, createdMs };
}

/**
 * A ProcessManager fake: canned process list + records killed PIDs. Killed
 * processes actually disappear from `listAll()` so `waitForProcessesGone`
 * terminates — unless the PID is in `unkillable`, which simulates a wedged
 * process for the timeout path.
 */
class FakeProcessManager implements ProcessManager {
  killed: number[] = [];
  listCalls = 0;
  /** Number of leading listAll() calls that throw, simulating a CIM hiccup. */
  failListsFor = 0;
  /** When true, every listAll() throws. */
  alwaysFailList = false;
  constructor(
    private procs: RunningProcess[],
    private unkillable: number[] = [],
  ) {}
  async listAll(): Promise<RunningProcess[]> {
    this.listCalls++;
    if (this.alwaysFailList || this.failListsFor > 0) {
      this.failListsFor--;
      throw new ProcessEnumerationError("powershell produced no output");
    }
    return this.procs;
  }
  async kill(pid: number): Promise<void> {
    this.killed.push(pid);
    if (this.unkillable.includes(pid)) return;
    this.procs = this.procs.filter((p) => p.pid !== pid);
  }
}

/** Wait deps that never actually sleep, for deterministic tests. */
const fastWait: WaitDeps = {
  sleep: async () => {},
  timeoutMs: 50,
  intervalMs: 1,
};

describe("descendantsOf", () => {
  test("walks the tree breadth-first", () => {
    const procs = [
      pb(100, "run"),
      child(200, "cmd.exe", 100),
      child(300, "claude.exe", 200),
      child(400, "node.exe", 300),
      child(500, "unrelated.exe", 1),
    ];
    expect(descendantsOf(procs, 100)).toEqual([200, 300, 400]);
    expect(descendantsOf(procs, 500)).toEqual([]);
  });

  test("rejects a recycled parent PID: a child cannot predate its parent", () => {
    // PID 100 died; a NEW process was handed PID 100 at t=5000. The old
    // process's children (created t=1000) still name 100 as their parent, but
    // they are not descendants of the new occupant and must not be killed.
    const procs = [
      pb(100, "run", undefined, 5000),
      child(200, "innocent.exe", 100, 1000),
    ];
    expect(descendantsOf(procs, 100)).toEqual([]);
  });

  test("follows the edge when either timestamp is missing", () => {
    const procs = [pb(100, "run"), child(200, "cmd.exe", 100)];
    expect(descendantsOf(procs, 100)).toEqual([200]);
  });

  test("survives a parentage cycle without looping forever", () => {
    const procs = [
      { pid: 1, commandLine: "a", name: "a", parentPid: 2 },
      { pid: 2, commandLine: "b", name: "b", parentPid: 1 },
    ];
    expect(descendantsOf(procs, 1)).toEqual([2]);
  });
});

describe("daemonKillOrder", () => {
  test("kills the daemon AND its orphan-prone harness tree, daemon first", () => {
    const procs = [
      pb(100, "run"),
      child(200, "cmd.exe", 100),
      child(300, "claude.exe", 200),
      pb(999, "restart"), // CLI invoker, unrelated parent
    ];
    expect(daemonKillOrder(procs, 999)).toEqual([100, 200, 300]);
  });

  test("skips self, non-daemon phantombot.exe, and non-phantombot images", () => {
    const procs = [
      pb(100, "run"), // daemon → kill
      pb(200, "restart"), // CLI invoker → skip
      pb(300, "run"), // second daemon → kill
      pb(999, "run"), // self → skip even though daemon
      child(400, "claude.exe", 1), // unrelated tree → skip
    ];
    expect(daemonKillOrder(procs, 999)).toEqual([100, 300]);
  });

  test("never kills the CLI invoker even when it is a DESCENDANT of the daemon", () => {
    // The regression that rules out `taskkill /T`: the agent's Bash tool runs
    // `phantombot restart`, so the invoker hangs off the daemon it must kill.
    // The daemon still dies; we and our own children survive to call /Run.
    const procs = [
      pb(100, "run"), // the daemon → must die
      child(200, "claude.exe", 100), // harness → must die
      child(300, "cmd.exe", 200), // harness's shell → must die
      pb(999, "restart", 300), // ← us, a descendant of the daemon
      child(1000, "powershell.exe", 999), // ← spawned by us (the process lister)
    ];
    const order = daemonKillOrder(procs, 999);
    expect(order).toContain(100);
    expect(order).not.toContain(999);
    expect(order).not.toContain(1000);
    expect(order[0]).toBe(100); // daemon first: it can't spawn a fresh harness
  });

  test("no daemons → empty kill set", () => {
    expect(daemonKillOrder([pb(1, "restart")], 999)).toEqual([]);
  });
});

describe("waitForProcessesGone", () => {
  test("reports gone once the PIDs disappear", async () => {
    const pm = new FakeProcessManager([pb(100, "run")]);
    await pm.kill(100);
    expect(await waitForProcessesGone(pm, [100], fastWait)).toEqual({
      gone: true,
    });
  });

  test("times out when a PID never exits (bounded, does not hang)", async () => {
    const pm = new FakeProcessManager([pb(100, "run")], [100]);
    await pm.kill(100);
    const out = await waitForProcessesGone(pm, [100], fastWait);
    expect(out.gone).toBe(false);
    expect(out).toMatchObject({ reason: "timeout" });
  });

  test("empty pid list short-circuits without listing", async () => {
    const pm = new FakeProcessManager([]);
    expect(await waitForProcessesGone(pm, [], fastWait)).toEqual({ gone: true });
    expect(pm.listCalls).toBe(0);
  });

  // The regression Kai flagged: enumeration failure used to surface as [],
  // which read as "every victim exited" and green-lit `schtasks /Run`.
  test("a persistent enumeration failure never reports gone", async () => {
    const pm = new FakeProcessManager([pb(100, "run")], [100]);
    pm.alwaysFailList = true;
    const out = await waitForProcessesGone(pm, [100], fastWait);
    expect(out.gone).toBe(false);
    expect(out).toMatchObject({ reason: "enumeration-failed" });
  });

  test("a transient enumeration failure recovers and still confirms exit", async () => {
    const pm = new FakeProcessManager([pb(100, "run")]);
    await pm.kill(100); // actually gone…
    pm.failListsFor = 2; // …but the first two polls can't see that
    expect(await waitForProcessesGone(pm, [100], fastWait)).toEqual({
      gone: true,
    });
    expect(pm.listCalls).toBeGreaterThan(2);
  });
});

describe("killDaemonProcesses", () => {
  test("kills the daemon tree and waits for it to actually exit", async () => {
    const pm = new FakeProcessManager([
      pb(100, "run"),
      child(200, "claude.exe", 100),
      pb(999, "restart"),
    ]);
    const r = await killDaemonProcesses(pm, 999, fastWait);
    expect(pm.killed).toEqual([100, 200]);
    expect(r).toEqual({ killed: 2, confirmed: true });
    // Proves we polled for exit rather than returning straight after taskkill.
    expect(pm.listCalls).toBeGreaterThan(1);
  });

  test("no daemons → nothing killed, still confirmed", async () => {
    const pm = new FakeProcessManager([pb(1, "restart")]);
    expect(await killDaemonProcesses(pm, 999, fastWait)).toEqual({
      killed: 0,
      confirmed: true,
    });
    expect(pm.killed).toEqual([]);
  });

  test("enumeration failure → kills nothing and reports unconfirmed", async () => {
    const pm = new FakeProcessManager([pb(100, "run")]);
    pm.alwaysFailList = true;
    const r = await killDaemonProcesses(pm, 999, fastWait);
    expect(r.confirmed).toBe(false);
    expect(r.killed).toBe(0);
    expect(pm.killed).toEqual([]); // never blind-kill on an unknown process set
  });

  test("victim survives taskkill → reports unconfirmed", async () => {
    const pm = new FakeProcessManager([pb(100, "run")], [100]);
    const r = await killDaemonProcesses(pm, 999, fastWait);
    expect(r).toMatchObject({ killed: 1, confirmed: false });
  });
});

describe("service control stop/restart kill the stray daemon", () => {
  test("stop(): disable + end + kill daemon (not the CLI invoker)", async () => {
    const st = new FakeSchtasks();
    const pm = new FakeProcessManager([pb(100, "run"), pb(555, "stop")]);
    const svc = defaultTaskSchedulerServiceControl(st, pm, 555, fastWait);
    const r = await svc.stop();
    expect(r.ok).toBe(true);
    const verbs = st.calls.map((c) => c[0]);
    expect(verbs).toContain("/Change"); // /DISABLE
    expect(verbs).toContain("/End");
    expect(pm.killed).toEqual([100]); // daemon killed, CLI (555) spared
  });

  test("restart(): enable + end + kill daemon + run", async () => {
    const st = new FakeSchtasks();
    const pm = new FakeProcessManager([pb(100, "run")]);
    const svc = defaultTaskSchedulerServiceControl(st, pm, 555, fastWait);
    const r = await svc.restart();
    expect(r.ok).toBe(true);
    const verbs = st.calls.map((c) => c[0]);
    expect(verbs).toEqual(["/Change", "/End", "/Run"]);
    expect(pm.killed).toEqual([100]);
  });

  test("restart(): /Run fires only AFTER the old daemon is gone", async () => {
    // The run-lock race: `schtasks /Run` used to fire while the old process
    // still held the single-instance lock, so the new daemon refused to start.
    const st = new FakeSchtasks();
    const pm = new FakeProcessManager([pb(100, "run")]);
    const svc = defaultTaskSchedulerServiceControl(st, pm, 555, fastWait);
    await svc.restart();
    const runIdx = st.calls.findIndex((c) => c[0] === "/Run");
    expect(runIdx).toBeGreaterThanOrEqual(0);
    // By the time /Run was issued, PID 100 no longer appears in listAll().
    expect((await pm.listAll()).map((p) => p.pid)).not.toContain(100);
  });

  test("restart(): enumeration failure must NOT fire /Run", async () => {
    // Fail closed. A transient CIM failure once read as "everything exited",
    // so /Run raced the still-held run-lock and silently no-opped while we
    // reported success. The keep-alive trigger is the recovery path instead.
    const st = new FakeSchtasks();
    const pm = new FakeProcessManager([pb(100, "run")]);
    pm.alwaysFailList = true;
    const svc = defaultTaskSchedulerServiceControl(st, pm, 555, fastWait);
    const r = await svc.restart();
    expect(r.ok).toBe(false);
    expect(st.calls.map((c) => c[0])).not.toContain("/Run");
    // The keep-alive trigger must still have been re-enabled, or nothing
    // would ever relaunch the daemon.
    expect(st.calls.map((c) => c[0])).toContain("/Change");
    expect(r.stderr ?? "").toContain("keep-alive");
  });

  test("restart(): an unkillable daemon must NOT fire /Run", async () => {
    const st = new FakeSchtasks();
    const pm = new FakeProcessManager([pb(100, "run")], [100]);
    const svc = defaultTaskSchedulerServiceControl(st, pm, 555, fastWait);
    const r = await svc.restart();
    expect(r.ok).toBe(false);
    expect(st.calls.map((c) => c[0])).not.toContain("/Run");
  });

  test("stop(): enumeration failure reports failure, not a clean stop", async () => {
    const st = new FakeSchtasks();
    const pm = new FakeProcessManager([pb(100, "run")]);
    pm.alwaysFailList = true;
    const svc = defaultTaskSchedulerServiceControl(st, pm, 555, fastWait);
    const r = await svc.stop();
    expect(r.ok).toBe(false);
    expect(r.stderr ?? "").toContain("could not confirm");
  });
});
