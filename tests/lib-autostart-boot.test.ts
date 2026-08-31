import { describe, expect, test } from "bun:test";
import {
  enableBootLinux,
  enableBootLinuxPasswordless,
  probeSudoPasswordless,
  validateSudoPassword,
  type SpawnRunner,
} from "../src/lib/autostartBoot.ts";

function runner(
  impl: (argv: string[], opts?: { input?: string }) => { exit: number; stdout?: string; stderr?: string },
): SpawnRunner {
  return {
    run: async (argv, opts) => {
      const r = impl(argv, opts);
      return { exit: r.exit, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
    },
  };
}

describe("probeSudoPasswordless", () => {
  test("exit 0 → passwordless", async () => {
    let argv: string[] = [];
    const r = await probeSudoPasswordless(
      runner((a) => {
        argv = a;
        return { exit: 0 };
      }),
    );
    expect(argv).toEqual(["sudo", "-n", "true"]);
    expect(r).toBe(true);
  });

  test("exit 1 with 'a password is required' → password needed", async () => {
    const r = await probeSudoPasswordless(
      runner(() => ({ exit: 1, stderr: "sudo: a password is required" })),
    );
    expect(r).toBe(false);
  });

  test("sudo missing entirely → password path (never crash)", async () => {
    const r = await probeSudoPasswordless(
      runner(() => ({ exit: 127, stderr: "command not found: sudo" })),
    );
    expect(r).toBe(false);
  });
});

describe("enableBootLinuxPasswordless", () => {
  test("runs enable-linger with -n, as the user", async () => {
    let argv: string[] = [];
    const r = await enableBootLinuxPasswordless(
      "aghodges",
      runner((a) => {
        argv = a;
        return { exit: 0 };
      }),
    );
    expect(argv).toEqual(["sudo", "-n", "loginctl", "enable-linger", "aghodges"]);
    expect(r.status).toBe("ok");
  });

  test("linger failure (despite passwordless sudo) → failed, not invalid-credential", async () => {
    const r = await enableBootLinuxPasswordless(
      "u",
      runner(() => ({ exit: 1, stderr: "Could not enable linger" })),
    );
    expect(r).toEqual({ status: "failed", error: "Could not enable linger" });
  });
});

describe("validateSudoPassword / enableBootLinux", () => {
  test("wrong password → invalid-credential (re-prompt signal)", async () => {
    const v = await validateSudoPassword(
      "wrong",
      runner((_a, opts) => ({
        exit: 1,
        stderr: "sudo: 1 incorrect password attempt",
        ...(opts?.input ? {} : {}),
      })),
    );
    expect(v.status).toBe("invalid-credential");
  });

  test("right password → ok, then linger runs with -S -k and the password on stdin", async () => {
    const calls: string[][] = [];
    const r = await enableBootLinux(
      "secret",
      "aghodges",
      runner((a, opts) => {
        calls.push(a);
        if (a.includes("-v")) {
          // validator: succeeds only for the right password
          return (opts?.input ?? "").includes("secret")
            ? { exit: 0 }
            : { exit: 1, stderr: "sudo: 1 incorrect password attempt" };
        }
        return { exit: 0 };
      }),
    );
    expect(calls[1]).toEqual(["sudo", "-S", "-k", "loginctl", "enable-linger", "aghodges"]);
    expect(r.status).toBe("ok");
  });
});

// ---------- Boot-state probe (Caveat-1 display fix) ----------

import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { probeBootState, bootHookStillNeeded, loginHookNeeded } from "../src/lib/autostartBoot.ts";

describe("probeBootState", () => {
  test("linux: enabled daemon unit → boot (unit-level doctrine)", async () => {
    expect(
      await probeBootState("any", { platform: "linux", unitEnabledReader: async () => true }),
    ).toBe(true);
  });

  test("linux: disabled unit → not boot, regardless of linger", async () => {
    // Linger is NEVER read for display — it is a one-way prerequisite that
    // may carry other services, not an autostart feature we own.
    expect(
      await probeBootState("any", { platform: "linux", unitEnabledReader: async () => false }),
    ).toBe(false);
  });

  test("linux: probe failing → false (fail closed to Login)", async () => {
    expect(
      await probeBootState("any", {
        platform: "linux",
        unitEnabledReader: async () => {
          throw new Error("systemctl missing");
        },
      }),
    ).toBe(false);
  });

  test("darwin: our LaunchDaemon plist → boot; foreign plists ignored", async () => {
    const dir = mkdtempSync(join(tmpdir(), "daemons-"));
    try {
      writeFileSync(join(dir, "com.other.daemon.plist"), "");
      expect(await probeBootState("any", { platform: "darwin", daemonDir: dir })).toBe(false);
      writeFileSync(join(dir, "dev.phantombot.phantombot.plist"), "");
      expect(await probeBootState("any", { platform: "darwin", daemonDir: dir })).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("windows: password-mode logon marker → boot; interactive → not", async () => {
    expect(
      await probeBootState("ironman", {
        platform: "windows",
        logonReader: async () => ({ mode: "password" }),
      }),
    ).toBe(true);
    expect(
      await probeBootState("ironman", {
        platform: "windows",
        logonReader: async () => ({ mode: "interactive" }),
      }),
    ).toBe(false);
  });

  test("live linux host: probe reads the real unit state without sudo", async () => {
    // Read-only smoke: must not throw and must answer boolean.
    const r = await probeBootState("lena");
    expect(typeof r).toBe("boolean");
  });
});

describe("bootHookStillNeeded (records-only)", () => {
  test("recorded boot member → unit stays enabled", () => {
    expect(bootHookStillNeeded(["a"], { a: "boot" })).toBe(true);
  });

  test("no boot records → not needed (probe is display-only, never consulted here)", () => {
    // Records-only BY DESIGN: the outgoing persona's unit is still enabled
    // while we decide, so a live probe would be circular. The enable-only
    // doctrine always writes a boot record when Boot is selected.
    expect(bootHookStillNeeded(["a"], { a: "login" })).toBe(false);
    expect(bootHookStillNeeded(["inherited"], {})).toBe(false);
    expect(bootHookStillNeeded([], {})).toBe(false);
  });
});

describe("loginHookNeeded", () => {
  test("any remaining on-list persona (boot excluded) needs the login hook", () => {
    expect(loginHookNeeded(["a"], { a: "login" })).toBe(true);
    expect(loginHookNeeded(["a"], {})).toBe(true); // inherited → login
    expect(loginHookNeeded([], {})).toBe(false);
    expect(loginHookNeeded(["a"], { a: "boot" })).toBe(false);
  });
});

// ---------- Teardown (Caveat-2) ----------

import {
  enableDaemonUnit,
  disableDaemonUnit,
  probeDaemonUnitEnabled,
  probeLingerLinux,
  teardownBootMac,
  teardownBootMacPasswordless,
  teardownBootWindows,
  registerLoginTasksWindows,
} from "../src/lib/autostartBoot.ts";

describe("daemon unit control (enable-only linger doctrine)", () => {
  test("enableDaemonUnit: systemctl --user enable, no sudo, no linger", async () => {
    const calls: string[][] = [];
    const r = await enableDaemonUnit(runner((a) => {
      calls.push(a);
      return { exit: 0 };
    }));
    expect(r.status).toBe("ok");
    expect(calls).toEqual([["systemctl", "--user", "enable", "phantombot.service"]]);
  });

  test("disableDaemonUnit: systemctl --user disable — the ONLY boot teardown on Linux", async () => {
    const calls: string[][] = [];
    const r = await disableDaemonUnit(runner((a) => {
      calls.push(a);
      return { exit: 0 };
    }));
    expect(r.status).toBe("ok");
    expect(calls).toEqual([["systemctl", "--user", "disable", "phantombot.service"]]);
  });

  test("unit disable failure → failed with systemctl's message", async () => {
    const r = await disableDaemonUnit(
      runner(() => ({ exit: 1, stderr: "Failed to disable unit" })),
    );
    expect(r).toEqual({ status: "failed", error: "Failed to disable unit" });
  });

  test("probeDaemonUnitEnabled: exit 0 → enabled", async () => {
    let argv: string[] = [];
    const on = await probeDaemonUnitEnabled(runner((a) => {
      argv = a;
      return { exit: 0, stdout: "enabled\n" };
    }));
    expect(argv).toEqual(["systemctl", "--user", "is-enabled", "phantombot.service"]);
    expect(on).toBe(true);
    expect(await probeDaemonUnitEnabled(runner(() => ({ exit: 1, stdout: "disabled\n" })))).toBe(false);
  });

  test("linger probe: file exists → true; missing → false (read-only, one-way)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "linger-"));
    try {
      const user = (await import("node:os")).userInfo().username;
      writeFileSync(join(dir, user), "");
      expect(await probeLingerLinux(user, dir)).toBe(true);
      expect(await probeLingerLinux("no-such-user-lena", dir)).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("live host: probeLingerLinux answers without sudo", async () => {
    expect(typeof await probeLingerLinux()).toBe("boolean");
  });
});

describe("teardownBootMac", () => {
  test("passwordless: bootout + rm only OUR plists", async () => {
    const dir = mkdtempSync(join(tmpdir(), "daemons-"));
    try {
      writeFileSync(join(dir, "dev.phantombot.phantombot.plist"), "");
      writeFileSync(join(dir, "com.other.plist"), "");
      const calls: string[][] = [];
      const r = await teardownBootMacPasswordless(runner((a) => {
        calls.push(a);
        return { exit: 0 };
      }), { daemonDir: dir });
      expect(r.status).toBe("ok");
      expect(calls.some((c) => c.includes("bootout") && c.join(" ").includes("dev.phantombot"))).toBe(true);
      expect(calls.some((c) => c.includes("com.other.plist"))).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("no our-plists → ok without any sudo", async () => {
    const calls: string[][] = [];
    const r = await teardownBootMacPasswordless(runner((a) => {
      calls.push(a);
      return { exit: 0 };
    }), { daemonDir: mkdtempSync(join(tmpdir(), "empty-")) });
    expect(r.status).toBe("ok");
    expect(calls).toEqual([]);
  });

  test("passwordless: bootout failure (job busy) aborts BEFORE rm — plist stays", async () => {
    const dir = mkdtempSync(join(tmpdir(), "daemons-"));
    try {
      const plist = join(dir, "dev.phantombot.phantombot.plist");
      writeFileSync(plist, "");
      const calls: string[][] = [];
      const r = await teardownBootMacPasswordless(runner((a) => {
        calls.push(a);
        if (a.includes("bootout")) return { exit: 3, stderr: "Boot-out failed: 3: job busy" };
        return { exit: 0 };
      }), { daemonDir: dir });
      expect(r.status).toBe("failed");
      if (r.status !== "failed") throw new Error("unreachable");
      expect(r.error).toContain("job busy");
      expect(calls.some((c) => c.includes("rm"))).toBe(false); // never removed a loaded daemon
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("passwordless: bootout 'not loaded' tolerated — rm still runs", async () => {
    const dir = mkdtempSync(join(tmpdir(), "daemons-"));
    try {
      const plist = join(dir, "dev.phantombot.phantombot.plist");
      writeFileSync(plist, "");
      const calls: string[][] = [];
      const r = await teardownBootMacPasswordless(runner((a) => {
        calls.push(a);
        if (a.includes("bootout")) return { exit: 3, stderr: "Boot-out failed: 3: No such process" };
        return { exit: 0 };
      }), { daemonDir: dir });
      expect(r.status).toBe("ok");
      expect(calls.some((c) => c.includes("rm"))).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("password path: validate first, wrong password → invalid-credential", async () => {
    const calls: string[][] = [];
    const r = await teardownBootMac("wrong", runner((a) => {
      calls.push(a);
      if (a.includes("-v")) return { exit: 1, stderr: "sudo: 1 incorrect password attempt" };
      return { exit: 0 };
    }));
    expect(r.status).toBe("invalid-credential");
    expect(calls.some((c) => c.includes("bootout"))).toBe(false);
  });
});

describe("windows teardown / login re-register", () => {
  function fakeSchtasks() {
    const calls: string[][] = [];
    const ownedXml =
      '<Task><Principals><Principal id="Author"><UserId>S-1-5-21-TEST</UserId></Principal></Principals></Task>';
    return {
      calls,
      run: async (argv: string[]) => {
        calls.push(argv);
        // /Query /XML → owned task XML; /Delete → success.
        return argv.includes("/Query")
          ? { exitCode: 0, stdout: ownedXml, stderr: "" }
          : { exitCode: 0, stdout: "", stderr: "" };
      },
    };
  }

  test("teardownBootWindows uninstalls the persona's task set", async () => {
    const schtasks = fakeSchtasks();
    const r = await teardownBootWindows("ironman", {
      schtasks,
      sid: "S-1-5-21-TEST",
      accountName: "BOX\\tester",
      out: { write: () => {} },
      err: { write: () => {} },
    });
    expect(r.status).toBe("ok");
    expect(schtasks.calls.some((c) => c.join(" ").includes("/Delete"))).toBe(true);
  });

  test("registerLoginTasksWindows registers interactive tasks (no password)", async () => {
    const schtasks = fakeSchtasks();
    const r = await registerLoginTasksWindows("bun", "ironman", {
      schtasks,
      xmlDir: mkdtempSync(join(tmpdir(), "xml-")),
      sid: "S-1-5-21-TEST",
      accountName: "BOX\\tester",
      out: { write: () => {} },
      err: { write: () => {} },
    });
    expect(r.status).toBe("ok");
    expect(schtasks.calls.some((c) => c.join(" ").includes("/Create"))).toBe(true);
  });
});
