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
  legacyLauncherVbsPath,
  LAUNCHER_VBS,
  scheduleWindowsRelaunch,
  ProcessEnumerationError,
  type ProcessManager,
  type RunningProcess,
  type WaitDeps,
  waitForProcessesGone,
  type SchtasksResult,
  type SchtasksRunner,
  taskLogPaths,
  uninstallPhantombotTasks,
  taskNames,
  readTaskLogon,
  writeTaskLogon,
  LEGACY_TASK_NAMES,
} from "../src/lib/taskScheduler.ts";

const SID = "S-1-5-21-1111111111-2222222222-3333333333-1001";
const FOREIGN_SID = "S-1-5-21-9999999999-8888888888-7777777777-1005";
const BIN = "C:\\Users\\andrew\\AppData\\Local\\phantombot\\bin\\phantombot.exe";
const PERSONA = "megan";
const NAMES = taskNames(PERSONA);

class FakeSchtasks implements SchtasksRunner {
  calls: string[][] = [];
  responses: SchtasksResult[] = [];
  /**
   * Per-task registered XML — `/Query /XML` answers from this map (missing
   * entry → exit 1 "cannot find", like a real unregistered task), and
   * `/Delete` only succeeds for registered tasks. Seed it with
   * `principalXml(SID)` entries when a test needs tasks to exist.
   */
  registry: Record<string, string | undefined> = {};
  async run(args: readonly string[]): Promise<SchtasksResult> {
    this.calls.push([...args]);
    if (this.responses.length > 0) return this.responses.shift()!;
    if (args[0] === "/Query") {
      const tn = args[args.indexOf("/TN") + 1]!;
      const xml = this.registry[tn];
      return xml === undefined
        ? { exitCode: 1, stdout: "", stderr: "cannot find" }
        : { exitCode: 0, stdout: xml, stderr: "" };
    }
    if (args[0] === "/Delete") {
      const tn = args[args.indexOf("/TN") + 1]!;
      if (this.registry[tn] === undefined) {
        return { exitCode: 1, stdout: "", stderr: "cannot find" };
      }
      this.registry[tn] = undefined;
      return { exitCode: 0, stdout: "", stderr: "" };
    }
    return { exitCode: 0, stdout: "", stderr: "" };
  }
}

/** Minimal task XML carrying a Principal with the given SID — enough for
 * the ownership check (taskPrincipalUserId) to match on. */
function principalXml(sid: string): string {
  return (
    `<Task xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">` +
    `<Principals><Principal id="Author"><UserId>${sid}</UserId>` +
    `<LogonType>InteractiveToken</LogonType></Principal></Principals></Task>`
  );
}

/** Password-mode task XML: the Principal UserId is the `COMPUTER\\user`
 * account name (what was passed as /RU), NOT a SID. */
function passwordPrincipalXml(account: string): string {
  return (
    `<Task xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">` +
    `<Principals><Principal id="Author"><UserId>${account}</UserId>` +
    `<LogonType>Password</LogonType></Principal></Principals></Task>`
  );
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
let prevXdg: string | undefined;

beforeEach(async () => {
  workdir = await mkdtemp(join(tmpdir(), "phantombot-schtasks-"));
  // Keep marker-file and launcher writes inside the tmpdir.
  prevXdg = process.env.XDG_DATA_HOME;
  process.env.XDG_DATA_HOME = workdir;
});

afterEach(async () => {
  if (prevXdg === undefined) delete process.env.XDG_DATA_HOME;
  else process.env.XDG_DATA_HOME = prevXdg;
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
      launcherVbsPath(PERSONA),
    );
    // //B (batch mode) suppresses any runtime script-error dialog. Each value
    // is its own quoted token so a spaced path survives arg parsing, and the
    // binary path stays visible (drift detection reads it back).
    expect(args).toBe(
      `//B "${launcherVbsPath(PERSONA)}" "${BIN}" "run" "C:\\logs\\phantombot.out.log" "C:\\logs\\phantombot.err.log"`,
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
  // Generated lazily: the launcher path resolves through XDG_DATA_HOME,
  // which the outer beforeEach only points at the tmpdir per-test.
  let xml: string;
  beforeEach(() => {
    xml = generatePhantombotTaskXml(SID, BIN, PERSONA);
  });

  test("is a Task Scheduler 1.2 document with the right URI", () => {
    expect(xml).toContain('<?xml version="1.0" encoding="UTF-16"?>');
    expect(xml).toContain(
      '<Task version="1.2" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">',
    );
    expect(xml).toContain(`<URI>${NAMES.main}</URI>`);
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
    expect(xml).toContain(`"${launcherVbsPath(PERSONA)}"`);
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
    const xml = generateHeartbeatTaskXml(SID, BIN, PERSONA);
    expect(xml).toContain(`<URI>${NAMES.heartbeat}</URI>`);
    expect(xml).toContain("<Interval>PT30M</Interval>");
    expect(xml).toContain("heartbeat.out.log");
    expect(xml).not.toContain("<RestartOnFailure>");
  });

  test("nightly fires daily at 02:00 (calendar trigger)", () => {
    const xml = generateNightlyTaskXml(SID, BIN, PERSONA);
    expect(xml).toContain(`<URI>${NAMES.nightly}</URI>`);
    expect(xml).toContain("<CalendarTrigger>");
    expect(xml).toContain("<ScheduleByDay>");
    expect(xml).toContain("<DaysInterval>1</DaysInterval>");
    expect(xml).toContain("2020-01-01T02:00:00");
  });

  test("tick repeats every minute", () => {
    const xml = generateTickTaskXml(SID, BIN, PERSONA);
    expect(xml).toContain(`<URI>${NAMES.tick}</URI>`);
    expect(xml).toContain("<Interval>PT1M</Interval>");
    expect(xml).toContain("tick.out.log");
  });
});

describe("XML escaping", () => {
  test("ampersands and angle brackets in the bin path become entities", () => {
    const xml = generatePhantombotTaskXml(SID, "C:\\odd&path\\<bot>.exe", PERSONA);
    expect(xml).toContain("C:\\odd&amp;path\\&lt;bot&gt;.exe");
  });
});

describe("installPhantombotTasks", () => {
  test("imports all four tasks with /F, in main→companions order", async () => {
    const out = new CaptureStream();
    const err = new CaptureStream();
    const st = new FakeSchtasks();
    // Seed legacy pre-rename tasks owned by this account so the upgrade
    // cleanup has something to remove.
    for (const legacy of LEGACY_TASK_NAMES) st.registry[legacy] = principalXml(SID);
    const result = await installPhantombotTasks({
      binPath: BIN,
      persona: PERSONA,
      sid: SID,
      xmlDir: workdir,
      schtasks: st,
      out,
      err,
    });
    expect(result.installed).toBe(true);

    const seq = st.calls.map((c) => c.join(" "));
    expect(seq).toEqual([
      `/Query /TN ${NAMES.main} /XML`,
      `/Create /TN ${NAMES.main} /XML ${join(workdir, "phantombot-task-phantombot.xml")} /F`,
      `/Query /TN ${NAMES.heartbeat} /XML`,
      `/Create /TN ${NAMES.heartbeat} /XML ${join(workdir, "phantombot-task-heartbeat.xml")} /F`,
      `/Query /TN ${NAMES.nightly} /XML`,
      `/Create /TN ${NAMES.nightly} /XML ${join(workdir, "phantombot-task-nightly.xml")} /F`,
      `/Query /TN ${NAMES.tick} /XML`,
      `/Create /TN ${NAMES.tick} /XML ${join(workdir, "phantombot-task-tick.xml")} /F`,
      // Pre-rename legacy tasks are cleaned up so an upgrade never
      // double-supervises the daemon — each is ownership-checked via its
      // exported XML before the delete.
      `/Query /TN ${LEGACY_TASK_NAMES[0]} /XML`,
      `/Delete /TN ${LEGACY_TASK_NAMES[0]} /F`,
      `/Query /TN ${LEGACY_TASK_NAMES[1]} /XML`,
      `/Delete /TN ${LEGACY_TASK_NAMES[1]} /F`,
      `/Query /TN ${LEGACY_TASK_NAMES[2]} /XML`,
      `/Delete /TN ${LEGACY_TASK_NAMES[2]} /F`,
      `/Query /TN ${LEGACY_TASK_NAMES[3]} /XML`,
      `/Delete /TN ${LEGACY_TASK_NAMES[3]} /F`,
    ]);
    expect(out.text).toContain("registered");
  });

  test("writes the persona-scoped hidden launcher so wscript.exe has a script to run", async () => {
    const { existsSync, readFileSync } = await import("node:fs");
    await installPhantombotTasks({
      binPath: BIN,
      persona: PERSONA,
      sid: SID,
      xmlDir: workdir,
      schtasks: new FakeSchtasks(),
      out: new CaptureStream(),
      err: new CaptureStream(),
    });
    expect(existsSync(launcherVbsPath(PERSONA))).toBe(true);
    expect(readFileSync(launcherVbsPath(PERSONA), "utf8")).toBe(LAUNCHER_VBS);
  });

  test("transient XML import files are cleaned up after import", async () => {
    const { existsSync } = await import("node:fs");
    const out = new CaptureStream();
    const err = new CaptureStream();
    const st = new FakeSchtasks();
    await installPhantombotTasks({
      binPath: BIN,
      persona: PERSONA,
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
        if (args[0] === "/Create" && i >= 0 && firstBytes === undefined) {
          firstBytes = readFileSync(args[i + 1]!);
        }
        return { exitCode: 0, stdout: "", stderr: "" };
      },
    };
    await installPhantombotTasks({
      binPath: BIN,
      persona: PERSONA,
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
    const st: SchtasksRunner = {
      async run(args: readonly string[]): Promise<SchtasksResult> {
        return args[0] === "/Query"
          ? { exitCode: 1, stdout: "", stderr: "cannot find" }
          : { exitCode: 1, stdout: "", stderr: "Access is denied" };
      },
    };
    const result = await installPhantombotTasks({
      binPath: BIN,
      persona: PERSONA,
      sid: SID,
      xmlDir: workdir,
      schtasks: st,
      out,
      err,
    });
    expect(result.installed).toBe(false);
    expect(err.text).toContain("could not register scheduled task");
  });

  test("re-imports even healthy existing tasks (applies the chosen template + logon mode)", async () => {
    const xml = generatePhantombotTaskXml(SID, BIN, PERSONA);
    const created: string[] = [];
    const st: SchtasksRunner = {
      async run(args: readonly string[]): Promise<SchtasksResult> {
        if (args[0] === "/Query") return { exitCode: 0, stdout: xml, stderr: "" };
        if (args[0] === "/Create") {
          created.push(args[args.indexOf("/TN") + 1]!);
        }
        return { exitCode: 0, stdout: "", stderr: "" };
      },
    };
    const result = await installPhantombotTasks({
      binPath: BIN,
      persona: PERSONA,
      sid: SID,
      xmlDir: workdir,
      schtasks: st,
      out: new CaptureStream(),
      err: new CaptureStream(),
    });
    expect(result.installed).toBe(true);
    // Install is not the heal: a re-install must apply the current template
    // (and any fresh credential) even when the registered XML already points
    // at this binary. Drift-only preservation is ensureTasksCurrent's job.
    expect(created).toEqual([
      NAMES.main,
      NAMES.heartbeat,
      NAMES.nightly,
      NAMES.tick,
    ]);
  });
});

describe("uninstallPhantombotTasks", () => {
  test("deletes each owned task with /F in reverse (companions→main) order", async () => {
    const out = new CaptureStream();
    const err = new CaptureStream();
    const st = new FakeSchtasks();
    for (const name of [...NAMES.all, ...LEGACY_TASK_NAMES]) {
      st.registry[name] = principalXml(SID);
    }
    const result = await uninstallPhantombotTasks({ persona: PERSONA, sid: SID, schtasks: st, out, err });
    expect(result.removed).toBe(true);
    expect(st.calls.map((c) => c.join(" "))).toEqual([
      `/Query /TN ${NAMES.tick} /XML`,
      `/Delete /TN ${NAMES.tick} /F`,
      `/Query /TN ${NAMES.nightly} /XML`,
      `/Delete /TN ${NAMES.nightly} /F`,
      `/Query /TN ${NAMES.heartbeat} /XML`,
      `/Delete /TN ${NAMES.heartbeat} /F`,
      `/Query /TN ${NAMES.main} /XML`,
      `/Delete /TN ${NAMES.main} /F`,
      `/Query /TN ${LEGACY_TASK_NAMES[0]} /XML`,
      `/Delete /TN ${LEGACY_TASK_NAMES[0]} /F`,
      `/Query /TN ${LEGACY_TASK_NAMES[1]} /XML`,
      `/Delete /TN ${LEGACY_TASK_NAMES[1]} /F`,
      `/Query /TN ${LEGACY_TASK_NAMES[2]} /XML`,
      `/Delete /TN ${LEGACY_TASK_NAMES[2]} /F`,
      `/Query /TN ${LEGACY_TASK_NAMES[3]} /XML`,
      `/Delete /TN ${LEGACY_TASK_NAMES[3]} /F`,
    ]);
    expect(out.text).toContain("removed scheduled task");
  });

  test("tasks owned by ANOTHER Windows account are left untouched", async () => {
    // Task Scheduler folders are machine-global: another local user's
    // same-named tasks must survive our uninstall.
    const out = new CaptureStream();
    const st = new FakeSchtasks();
    for (const name of [...NAMES.all, ...LEGACY_TASK_NAMES]) {
      st.registry[name] = principalXml(FOREIGN_SID);
    }
    const result = await uninstallPhantombotTasks({
      persona: PERSONA,
      sid: SID,
      schtasks: st,
      out,
      err: new CaptureStream(),
    });
    expect(result.removed).toBe(true);
    expect(st.calls.filter((c) => c[0] === "/Delete")).toEqual([]);
    expect(out.text).toContain("owned by another Windows account");
    // All eight tasks are still registered.
    for (const name of [...NAMES.all, ...LEGACY_TASK_NAMES]) {
      expect(st.registry[name]).toBeDefined();
    }
  });

  test("removes THIS persona's launcher script — other personas' launchers survive", async () => {
    const { existsSync, writeFileSync } = await import("node:fs");
    // Install persona A (writes A's launcher), and fake persona B's launcher.
    await installPhantombotTasks({
      binPath: BIN,
      persona: PERSONA,
      sid: SID,
      xmlDir: workdir,
      schtasks: new FakeSchtasks(),
      out: new CaptureStream(),
      err: new CaptureStream(),
    });
    writeFileSync(launcherVbsPath("beta"), LAUNCHER_VBS, "utf8");
    expect(existsSync(launcherVbsPath(PERSONA))).toBe(true);
    await uninstallPhantombotTasks({
      persona: PERSONA,
      sid: SID,
      schtasks: new FakeSchtasks(),
      out: new CaptureStream(),
      err: new CaptureStream(),
    });
    expect(existsSync(launcherVbsPath(PERSONA))).toBe(false);
    // Persona B's tasks point at B's launcher — uninstalling A must not
    // strand them.
    expect(existsSync(launcherVbsPath("beta"))).toBe(true);
  });

  test("legacy shared launcher is removed only when no legacy task survives", async () => {
    const { existsSync, writeFileSync, mkdirSync } = await import("node:fs");
    mkdirSync(join(workdir, "phantombot"), { recursive: true });
    const legacy = legacyLauncherVbsPath();
    writeFileSync(legacy, LAUNCHER_VBS, "utf8");
    // Case 1: all legacy tasks owned by us → deleted → shared launcher goes.
    const st1 = new FakeSchtasks();
    for (const name of LEGACY_TASK_NAMES) st1.registry[name] = principalXml(SID);
    await uninstallPhantombotTasks({
      persona: PERSONA,
      sid: SID,
      schtasks: st1,
      out: new CaptureStream(),
      err: new CaptureStream(),
    });
    expect(existsSync(legacy)).toBe(false);
    // Case 2: a FOREIGN-owned legacy task survives → it still references the
    // shared launcher, so the file must stay.
    writeFileSync(legacy, LAUNCHER_VBS, "utf8");
    const st2 = new FakeSchtasks();
    st2.registry[LEGACY_TASK_NAMES[0]!] = principalXml(FOREIGN_SID);
    await uninstallPhantombotTasks({
      persona: PERSONA,
      sid: SID,
      schtasks: st2,
      out: new CaptureStream(),
      err: new CaptureStream(),
    });
    expect(existsSync(legacy)).toBe(true);
  });

  test("password-mode tasks (principal = account name, not SID) are still owned", async () => {
    // Password-mode task XML carries `<UserId>MEGAN\megan</UserId>` with
    // LogonType Password — no SID. Ownership must match the current account
    // NAME or uninstall would strand every password-mode task while still
    // deleting the persona marker.
    const out = new CaptureStream();
    const st = new FakeSchtasks();
    for (const name of NAMES.all) {
      st.registry[name] = passwordPrincipalXml("MEGAN\\megan");
    }
    const result = await uninstallPhantombotTasks({
      persona: PERSONA,
      sid: SID,
      accountName: "megan\\megan", // whoami — case differs, must still match
      schtasks: st,
      out,
      err: new CaptureStream(),
    });
    expect(result.removed).toBe(true);
    expect(st.calls.filter((c) => c[0] === "/Delete").length).toBe(4);
    for (const name of NAMES.all) expect(st.registry[name]).toBeUndefined();
  });

  test("missing tasks are skipped quietly — no deletes, not fatal", async () => {
    const out = new CaptureStream();
    const err = new CaptureStream();
    const st = new FakeSchtasks(); // empty registry: nothing registered
    const result = await uninstallPhantombotTasks({ persona: PERSONA, sid: SID, schtasks: st, out, err });
    expect(result.removed).toBe(true);
    expect(st.calls.filter((c) => c[0] === "/Delete")).toEqual([]);
    expect(st.calls.filter((c) => c[0] === "/Query").length).toBe(8);
    expect(out.text).not.toContain("removed scheduled task");
  });
});

describe("ensureTasksCurrent (heartbeat self-heal)", () => {
  const OLD_BIN =
    "C:\\Users\\andrew\\AppData\\Local\\phantombot\\old\\phantombot.exe";

  /** The registered XML each task's `/Query /XML` should return, keyed by name. */
  function registeredXml(bin: string): Record<string, string> {
    return {
      [NAMES.main]: generatePhantombotTaskXml(SID, bin, PERSONA),
      [NAMES.heartbeat]: generateHeartbeatTaskXml(SID, bin, PERSONA),
      [NAMES.nightly]: generateNightlyTaskXml(SID, bin, PERSONA),
      [NAMES.tick]: generateTickTaskXml(SID, bin, PERSONA),
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
      persona: PERSONA,
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
      persona: PERSONA,
      sid: SID,
      xmlDir: workdir,
      schtasks: st,
    });
    expect(r.rewrote).toEqual([
      NAMES.main,
      NAMES.heartbeat,
      NAMES.nightly,
      NAMES.tick,
    ]);
    expect(st.created()).toEqual([
      NAMES.main,
      NAMES.heartbeat,
      NAMES.nightly,
      NAMES.tick,
    ]);
  });

  test("a single missing task is re-registered; the current ones are left alone", async () => {
    const xml = registeredXml(BIN);
    xml[NAMES.tick] = undefined as unknown as string; // tick was deleted
    const st = new HealFake(xml);
    const r = await ensureTasksCurrent({
      binPath: BIN,
      persona: PERSONA,
      sid: SID,
      xmlDir: workdir,
      schtasks: st,
    });
    expect(r.rewrote).toEqual([NAMES.tick]);
    expect(st.created()).toEqual([NAMES.tick]);
  });

  test("path casing differences alone are not treated as drift", async () => {
    // schtasks may echo the command line back with different casing; a mere
    // case difference must not trigger a needless re-import.
    const st = new HealFake(registeredXml(BIN.toUpperCase()));
    const r = await ensureTasksCurrent({
      binPath: BIN.toLowerCase(),
      persona: PERSONA,
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
    const svc = defaultTaskSchedulerServiceControl(st, pm, 555, fastWait, PERSONA);
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
    const svc = defaultTaskSchedulerServiceControl(st, pm, 555, fastWait, PERSONA);
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
    const svc = defaultTaskSchedulerServiceControl(st, pm, 555, fastWait, PERSONA);
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
    const svc = defaultTaskSchedulerServiceControl(st, pm, 555, fastWait, PERSONA);
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
    const svc = defaultTaskSchedulerServiceControl(st, pm, 555, fastWait, PERSONA);
    const r = await svc.restart();
    expect(r.ok).toBe(false);
    expect(st.calls.map((c) => c[0])).not.toContain("/Run");
  });

  test("stop(): enumeration failure reports failure, not a clean stop", async () => {
    const st = new FakeSchtasks();
    const pm = new FakeProcessManager([pb(100, "run")]);
    pm.alwaysFailList = true;
    const svc = defaultTaskSchedulerServiceControl(st, pm, 555, fastWait, PERSONA);
    const r = await svc.stop();
    expect(r.ok).toBe(false);
    expect(r.stderr ?? "").toContain("could not confirm");
  });
});

describe("scheduleWindowsRelaunch", () => {
  test("detaches a watcher that waits on our pid, then relaunches — via one Start-Process", async () => {
    let captured: string[] | null = null;
    const r = await scheduleWindowsRelaunch({
      selfPid: 4242,
      graceSeconds: 30,
      binPath: "C:\\Users\\me\\phantombot.exe",
      spawnImpl: async (argv) => {
        captured = argv;
        return { ok: true };
      },
    });
    expect(r.ok).toBe(true);
    expect(captured).not.toBeNull();
    const argv = captured as unknown as string[];
    // Outer invocation is a hidden, detaching Start-Process of powershell.
    expect(argv[0]).toBe("powershell");
    const outer = argv[argv.length - 1] ?? "";
    expect(outer).toContain("Start-Process powershell");
    expect(outer).toContain("-WindowStyle Hidden");
    expect(outer).toContain("-EncodedCommand");

    // The encoded inner watcher must block on our pid, then launch the binary.
    const m = outer.match(/-EncodedCommand','([^']+)'/);
    expect(m).not.toBeNull();
    const inner = Buffer.from((m as RegExpMatchArray)[1] ?? "", "base64").toString(
      "utf16le",
    );
    expect(inner).toContain("Wait-Process -Id 4242 -Timeout 30");
    expect(inner).toContain("phantombot.exe");
    expect(inner).toContain("@('run')");
    expect(inner).toContain("-WindowStyle Hidden");
    expect(inner).toContain("-RedirectStandardOutput");
  });

  test("surfaces a spawn failure without throwing", async () => {
    const r = await scheduleWindowsRelaunch({
      spawnImpl: async () => ({ ok: false, stderr: "powershell exited 1" }),
    });
    expect(r.ok).toBe(false);
    expect(r.stderr).toContain("powershell exited 1");
  });
});

describe("password logon mode (run when logged off)", () => {
  const ACCOUNT = "MEGAN-PC\\megan";

  test("task XML carries LogonType Password, the account name, and a boot trigger", () => {
    const xml = generatePhantombotTaskXml(SID, BIN, PERSONA, {
      mode: "password",
      username: ACCOUNT,
    });
    expect(xml).toContain("<LogonType>Password</LogonType>");
    expect(xml).toContain(`<UserId>${ACCOUNT}</UserId>`);
    expect(xml).toContain("<BootTrigger>");
    // The credential itself never goes into the XML.
    expect(xml).not.toContain("s3cret");
  });

  test("companion tasks are password-mode too, but only the daemon gets a boot trigger", () => {
    const hb = generateHeartbeatTaskXml(SID, BIN, PERSONA, {
      mode: "password",
      username: ACCOUNT,
    });
    expect(hb).toContain("<LogonType>Password</LogonType>");
    expect(hb).not.toContain("<BootTrigger>");
  });

  test("install registers with /RU + /RP and persists the mode (without the password)", async () => {
    const st = new FakeSchtasks();
    const result = await installPhantombotTasks({
      binPath: BIN,
      persona: PERSONA,
      sid: SID,
      xmlDir: workdir,
      logon: { mode: "password", username: ACCOUNT, password: "s3cret" },
      schtasks: st,
      out: new CaptureStream(),
      err: new CaptureStream(),
    });
    expect(result.installed).toBe(true);
    const creates = st.calls.filter((c) => c[0] === "/Create");
    expect(creates.length).toBe(4);
    for (const c of creates) {
      expect(c).toContain("/RU");
      expect(c).toContain(ACCOUNT);
      expect(c).toContain("/RP");
      expect(c).toContain("s3cret");
    }
    // The marker remembers the mode + account for the heal path, but the
    // password stays with Task Scheduler — never on our disk.
    expect(await readTaskLogon(PERSONA)).toEqual({
      mode: "password",
      username: ACCOUNT,
    });
  });

  test("heal patches a drifted password-mode task's action in place (no credential needed)", async () => {
    await writeTaskLogon(PERSONA, { mode: "password", username: ACCOUNT });
    const OLD_BIN = "C:\\old\\phantombot.exe";
    const registered: Record<string, string | undefined> = {
      [NAMES.main]: generatePhantombotTaskXml(SID, OLD_BIN, PERSONA, {
        mode: "password",
        username: ACCOUNT,
      }),
      [NAMES.heartbeat]: generateHeartbeatTaskXml(SID, BIN, PERSONA, {
        mode: "password",
        username: ACCOUNT,
      }),
      [NAMES.nightly]: generateNightlyTaskXml(SID, BIN, PERSONA, {
        mode: "password",
        username: ACCOUNT,
      }),
      [NAMES.tick]: generateTickTaskXml(SID, BIN, PERSONA, {
        mode: "password",
        username: ACCOUNT,
      }),
    };
    const st: SchtasksRunner = {
      async run(args: readonly string[]): Promise<SchtasksResult> {
        if (args[0] === "/Query") {
          const xml = registered[args[args.indexOf("/TN") + 1]!];
          return xml === undefined
            ? { exitCode: 1, stdout: "", stderr: "cannot find" }
            : { exitCode: 0, stdout: xml, stderr: "" };
        }
        throw new Error("password-mode heal must NOT re-import via schtasks");
      },
    };
    const patched: Array<[string, string]> = [];
    const r = await ensureTasksCurrent({
      binPath: BIN,
      persona: PERSONA,
      sid: SID,
      xmlDir: workdir,
      schtasks: st,
      patchAction: async (name, args) => {
        patched.push([name, args]);
        return { ok: true };
      },
    });
    // Only the drifted daemon task was patched, with the new binary path in
    // the launcher arguments.
    expect(r.rewrote).toEqual([NAMES.main]);
    expect(r.failed).toEqual([]);
    expect(patched.length).toBe(1);
    expect(patched[0]![0]).toBe(NAMES.main);
    expect(patched[0]![1]).toContain(BIN);
    expect(patched[0]![1]).not.toContain(OLD_BIN);
  });

  test("heal cannot recreate a MISSING password-mode task — it says to re-install", async () => {
    await writeTaskLogon(PERSONA, { mode: "password", username: ACCOUNT });
    const st: SchtasksRunner = {
      async run(): Promise<SchtasksResult> {
        return { exitCode: 1, stdout: "", stderr: "cannot find" };
      },
    };
    const r = await ensureTasksCurrent({
      binPath: BIN,
      persona: PERSONA,
      sid: SID,
      xmlDir: workdir,
      schtasks: st,
      patchAction: async () => ({ ok: true }),
    });
    expect(r.rewrote).toEqual([]);
    expect(r.failed).toEqual([
      NAMES.main,
      NAMES.heartbeat,
      NAMES.nightly,
      NAMES.tick,
    ]);
  });

  test("legacy (pre persona-rename) tasks are removed on install", async () => {
    const st = new FakeSchtasks();
    for (const legacy of LEGACY_TASK_NAMES) st.registry[legacy] = principalXml(SID);
    await installPhantombotTasks({
      binPath: BIN,
      persona: PERSONA,
      sid: SID,
      xmlDir: workdir,
      schtasks: st,
      out: new CaptureStream(),
      err: new CaptureStream(),
    });
    const deletes = st.calls
      .filter((c) => c[0] === "/Delete")
      .map((c) => c[c.indexOf("/TN") + 1]);
    for (const legacy of LEGACY_TASK_NAMES) {
      expect(deletes).toContain(legacy);
    }
  });

  test("legacy tasks owned by ANOTHER Windows account are kept on install", async () => {
    const out = new CaptureStream();
    const st = new FakeSchtasks();
    for (const legacy of LEGACY_TASK_NAMES) st.registry[legacy] = principalXml(FOREIGN_SID);
    await installPhantombotTasks({
      binPath: BIN,
      persona: PERSONA,
      sid: SID,
      xmlDir: workdir,
      schtasks: st,
      out,
      err: new CaptureStream(),
    });
    expect(st.calls.filter((c) => c[0] === "/Delete")).toEqual([]);
    for (const legacy of LEGACY_TASK_NAMES) {
      expect(st.registry[legacy]).toBeDefined();
      expect(out.text).toContain(`left ${legacy} untouched`);
    }
  });
});

describe("per-persona logon marker", () => {
  test("two personas on one Windows account keep independent modes", async () => {
    await writeTaskLogon("alpha", { mode: "password", username: "PC\\alpha" });
    await writeTaskLogon("beta", { mode: "interactive" });
    // Persona B's install must not overwrite persona A's persisted mode —
    // A's heartbeat heals from its own marker.
    expect(await readTaskLogon("alpha")).toEqual({
      mode: "password",
      username: "PC\\alpha",
    });
    expect(await readTaskLogon("beta")).toEqual({ mode: "interactive" });
    expect(await readTaskLogon("gamma")).toEqual({ mode: "interactive" });
  });

  test("falls back to the pre-scoping shared marker, and a write PRESERVES it", async () => {
    const { writeFileSync, existsSync } = await import("node:fs");
    const legacy = join(workdir, "phantombot", "windows-logon.json");
    const { mkdirSync } = await import("node:fs");
    mkdirSync(join(workdir, "phantombot"), { recursive: true });
    writeFileSync(legacy, JSON.stringify({ mode: "password", username: "PC\\old" }));
    // A persona installed before the scoping still heals in password mode.
    expect(await readTaskLogon("oldbot")).toEqual({
      mode: "password",
      username: "PC\\old",
    });
    // A SECOND persona installing must NOT delete the shared marker: doing so
    // would silently downgrade oldbot's heal/relaunch to interactive and
    // re-break headless operation. Scoped markers win reads, so the stale
    // file is inert for the persona that just installed.
    await writeTaskLogon("newbot", { mode: "interactive" });
    expect(existsSync(legacy)).toBe(true);
    expect(await readTaskLogon("newbot")).toEqual({ mode: "interactive" });
    expect(await readTaskLogon("oldbot")).toEqual({
      mode: "password",
      username: "PC\\old",
    });
  });

  test("a persona-scoped interactive marker beats a legacy password marker", async () => {
    const { writeFileSync, mkdirSync } = await import("node:fs");
    mkdirSync(join(workdir, "phantombot"), { recursive: true });
    await writeTaskLogon("newbot", { mode: "interactive" });
    // A stale shared marker left behind by an older build must NOT override
    // this persona's scoped choice.
    writeFileSync(
      join(workdir, "phantombot", "windows-logon.json"),
      JSON.stringify({ mode: "password", username: "PC\\old" }),
    );
    expect(await readTaskLogon("newbot")).toEqual({ mode: "interactive" });
  });
});
