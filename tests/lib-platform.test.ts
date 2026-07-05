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
  restartCommand,
  selfRestart,
  statusCommand,
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
  test("on linux: systemctl/journalctl strings", () => {
    if (process.platform !== "linux") return; // guard for CI on darwin
    expect(restartCommand()).toContain("systemctl --user restart phantombot");
    expect(statusCommand()).toContain("systemctl --user status phantombot");
    expect(logsCommand()).toContain("journalctl --user -u phantombot");
  });

  test("on darwin: launchctl strings", () => {
    if (process.platform !== "darwin") return;
    expect(restartCommand()).toContain("launchctl kickstart -k");
    expect(restartCommand()).toContain("dev.phantombot.phantombot");
    expect(statusCommand()).toContain("launchctl print");
    expect(logsCommand()).toContain("Library/Logs/phantombot");
  });

  test("on windows: schtasks strings", () => {
    if (process.platform !== "win32") return;
    expect(restartCommand()).toContain("schtasks /Run /TN");
    expect(restartCommand()).toContain("\\Phantombot\\phantombot");
    expect(statusCommand()).toContain("schtasks /Query /TN");
    expect(logsCommand()).toContain("phantombot\\logs\\phantombot.out.log");
  });
});

describe("defaultServiceControl", () => {
  test("returns an object with the ServiceControl interface", () => {
    const svc = defaultServiceControl();
    expect(typeof svc.isActive).toBe("function");
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

  test("Windows: triggers a clean exit and never calls schtasks restart()", async () => {
    const { svc, calls } = trackingSvc({ ok: true });
    let shutdowns = 0;
    const r = await selfRestart({
      serviceControl: svc,
      procPlatform: "win32",
      triggerShutdown: () => {
        shutdowns++;
      },
    });
    expect(r.ok).toBe(true);
    // The keep-alive relaunches us; we must NOT End/Run our own task tree.
    expect(calls.length).toBe(0);
    expect(shutdowns).toBe(1);
  });
});
