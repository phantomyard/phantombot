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
  ensureTasksCurrent,
  generateHeartbeatTaskXml,
  generateNightlyTaskXml,
  generatePhantombotTaskXml,
  generateTickTaskXml,
  installPhantombotTasks,
  launcherVbsPath,
  LAUNCHER_VBS,
  type SchtasksResult,
  type SchtasksRunner,
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
    // Four cheap queries and nothing else.
    expect(st.calls.every((c) => c[0] === "/Query")).toBe(true);
    expect(st.calls.length).toBe(4);
  });

  test("moved binary: all four tasks drifted → all re-registered", async () => {
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
