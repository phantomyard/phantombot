/**
 * Tests for the platform-router. We can't easily mutate process.platform
 * mid-test, so the routing functions are read-only on currentPlatform();
 * what we CAN check is the shape of the returned hint strings (Linux on
 * the CI box) and that defaultServiceControl() returns a working object
 * with the right interface.
 */

import { describe, expect, test } from "bun:test";

import {
  currentPlatform,
  defaultServiceControl,
  logsCommand,
  logsSpec,
  restartCommand,
  selfRestart,
  startCommand,
  statusCommand,
  stopCommand,
  type ServiceControl,
} from "../src/lib/platform.ts";

describe("currentPlatform", () => {
  test("returns linux/darwin/windows/unsupported only", () => {
    const p = currentPlatform();
    expect(["linux", "darwin", "windows", "unsupported"]).toContain(p);
  });

  test("matches process.platform for each supported platform", () => {
    if (process.platform === "linux") expect(currentPlatform()).toBe("linux");
    if (process.platform === "darwin") expect(currentPlatform()).toBe("darwin");
    if (process.platform === "win32") expect(currentPlatform()).toBe("windows");
  });
});

describe("hint commands shape per platform", () => {
  test("on linux: systemctl/journalctl strings", async () => {
    if (process.platform !== "linux") return; // guard for CI on darwin
    expect(await restartCommand()).toContain("systemctl --user restart phantombot");
    expect(await statusCommand()).toContain("systemctl --user status phantombot");
    expect(logsCommand()).toContain("journalctl --user -u phantombot");
  });

  test("on darwin: launchctl strings", async () => {
    if (process.platform !== "darwin") return;
    expect(await restartCommand()).toContain("launchctl kickstart -k");
    expect(await restartCommand()).toContain("dev.phantombot.phantombot");
    expect(await statusCommand()).toContain("launchctl print");
    expect(logsCommand()).toContain("Library/Logs/phantombot");
  });

  test("on windows: Task Scheduler strings", async () => {
    if (process.platform !== "win32") return;
    expect(await restartCommand()).toContain("schtasks /End");
    expect(await statusCommand()).toContain("schtasks /Query");
    expect(logsCommand()).toContain("phantombot\\logs\\phantombot.out.log");
  });
});

describe("start/stop hint commands per platform", () => {
  test("on linux: systemctl start/stop", async () => {
    if (process.platform !== "linux") return;
    expect(await startCommand()).toBe("systemctl --user start phantombot");
    expect(await stopCommand()).toBe("systemctl --user stop phantombot");
  });

  test("on darwin: launchctl bootstrap/bootout", async () => {
    if (process.platform !== "darwin") return;
    expect(await startCommand()).toContain("launchctl bootstrap");
    expect(await startCommand()).toContain("dev.phantombot.phantombot");
    expect(await stopCommand()).toContain("launchctl bootout");
  });

  test("on windows: Task Scheduler start/stop", async () => {
    if (process.platform !== "win32") return;
    expect(await startCommand()).toContain("schtasks /Change");
    expect(await stopCommand()).toContain("schtasks /Change");
  });
});

describe("windows hints name the persona-scoped task", () => {
  // The whole point of the persona-suffixed rename: every hint the CLI
  // prints must address `\Phantombot\phantombot-<persona>` — the legacy
  // unsuffixed task no longer exists after install, so a hint that names
  // it is a copy-pasteable command that fails.
  const win = { platform: "windows" as const, persona: "megan" };
  const task = "\\Phantombot\\phantombot-megan";

  test("restart", async () => {
    const cmd = await restartCommand(win);
    expect(cmd).toBe(`schtasks /End /TN "${task}" & schtasks /Run /TN "${task}"`);
  });

  test("start", async () => {
    const cmd = await startCommand(win);
    expect(cmd).toBe(`schtasks /Change /TN "${task}" /ENABLE & schtasks /Run /TN "${task}"`);
  });

  test("stop", async () => {
    const cmd = await stopCommand(win);
    expect(cmd).toBe(`schtasks /Change /TN "${task}" /DISABLE & schtasks /End /TN "${task}"`);
  });

  test("status", async () => {
    const cmd = await statusCommand(win);
    expect(cmd).toBe(`schtasks /Query /TN "${task}" /V /FO LIST`);
  });

  test("no hint contains the legacy unsuffixed task name", async () => {
    for (const cmd of [
      await restartCommand(win),
      await startCommand(win),
      await stopCommand(win),
      await statusCommand(win),
    ]) {
      expect(cmd).not.toContain('"\\Phantombot\\phantombot"');
      expect(cmd).toContain("phantombot-megan");
    }
  });
});

describe("logsSpec", () => {
  test("follow default is true, lines default 50", () => {
    const spec = logsSpec();
    if (process.platform === "linux") {
      expect(spec).toEqual({
        cmd: "journalctl",
        args: ["--user", "-u", "phantombot", "-n", "50", "-f"],
      });
    } else if (process.platform === "darwin") {
      expect(spec?.cmd).toBe("tail");
      expect(spec?.args).toContain("-f");
      expect(spec?.args).toContain("-n");
    } else if (process.platform === "win32") {
      expect(spec?.cmd).toBe("powershell");
      expect(spec?.args.join(" ")).toContain("-Wait");
      expect(spec?.args.join(" ")).toContain("-Tail 50");
    }
  });

  test("--no-follow drops the follow flag", () => {
    const spec = logsSpec({ follow: false, lines: 10 });
    if (process.platform === "linux") {
      expect(spec?.args).not.toContain("-f");
      expect(spec?.args).toEqual(["--user", "-u", "phantombot", "-n", "10"]);
    } else if (process.platform === "darwin") {
      expect(spec?.args).not.toContain("-f");
      expect(spec?.args).toContain("10");
    } else if (process.platform === "win32") {
      expect(spec?.args.join(" ")).not.toContain("-Wait");
      expect(spec?.args.join(" ")).toContain("-Tail 10");
    }
  });
});

describe("defaultServiceControl", () => {
  test("returns an object with the ServiceControl interface", () => {
    const svc = defaultServiceControl();
    expect(typeof svc.isActive).toBe("function");
    expect(typeof svc.start).toBe("function");
    expect(typeof svc.stop).toBe("function");
    expect(typeof svc.restart).toBe("function");
    expect(typeof svc.rerenderUnitIfStale).toBe("function");
  });

  test("isActive doesn't throw — it returns false when the backend isn't reachable", async () => {
    const svc = defaultServiceControl();
    // We don't care what it returns; we care that it doesn't blow up
    // when no service-manager bus is available (e.g. CI containers).
    await expect(svc.isActive()).resolves.toBeDefined();
  });
});

describe("selfRestart", () => {
  function trackingSvc(result: { ok: boolean; stderr?: string } = { ok: true }) {
    const calls: number[] = [];
    const svc: ServiceControl = {
      async isActive() {
        return true;
      },
      async start() {
        return { ok: true };
      },
      async stop() {
        return { ok: true };
      },
      async restart() {
        calls.push(1);
        return result;
      },
      async rerenderUnitIfStale() {
        return { rerendered: false };
      },
    };
    return { svc, calls };
  }

  test("POSIX: delegates to the supervisor's restart()", async () => {
    const { svc, calls } = trackingSvc({ ok: true });
    const r = await selfRestart({ serviceControl: svc, procPlatform: "linux" });
    expect(r.ok).toBe(true);
    expect(calls.length).toBe(1);
  });

  test("POSIX: surfaces a failed supervisor restart", async () => {
    const { svc } = trackingSvc({ ok: false, stderr: "boom" });
    const r = await selfRestart({ serviceControl: svc, procPlatform: "darwin" });
    expect(r.ok).toBe(false);
    expect(r.stderr).toBe("boom");
  });

  test("Windows: schedules a deferred relaunch, then triggers a clean exit and never calls schtasks restart()", async () => {
    const { svc, calls } = trackingSvc({ ok: true });
    let shutdowns = 0;
    const relaunchCalls: number[] = [];
    const r = await selfRestart({
      serviceControl: svc,
      procPlatform: "win32",
      scheduleRelaunch: async ({ selfPid }) => {
        relaunchCalls.push(selfPid);
        return { ok: true };
      },
      triggerShutdown: () => {
        shutdowns++;
      },
    });
    expect(r.ok).toBe(true);
    // We must NOT End/Run our own task tree — the detached watcher relaunches us.
    expect(calls.length).toBe(0);
    // Relaunch is scheduled with our pid BEFORE we go down.
    expect(relaunchCalls).toEqual([process.pid]);
    expect(shutdowns).toBe(1);
  });

  test("Windows: still exits when relaunch scheduling fails, and surfaces the fallback", async () => {
    const { svc } = trackingSvc({ ok: true });
    let shutdowns = 0;
    const r = await selfRestart({
      serviceControl: svc,
      procPlatform: "win32",
      scheduleRelaunch: async () => ({ ok: false, stderr: "powershell exited 1" }),
      triggerShutdown: () => {
        shutdowns++;
      },
    });
    // Non-fatal: we still trigger shutdown (keep-alive is the backstop)...
    expect(shutdowns).toBe(1);
    // ...but the failure is surfaced for logging.
    expect(r.ok).toBe(false);
    expect(r.stderr).toContain("keep-alive");
  });
});
