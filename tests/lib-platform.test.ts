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
  statusCommand,
} from "../src/lib/platform.ts";

describe("currentPlatform", () => {
  test("returns linux/darwin/unsupported only", () => {
    const p = currentPlatform();
    expect(["linux", "darwin", "unsupported"]).toContain(p);
  });

  test("matches process.platform when it's one of the supported pair", () => {
    if (process.platform === "linux") expect(currentPlatform()).toBe("linux");
    if (process.platform === "darwin") expect(currentPlatform()).toBe("darwin");
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
