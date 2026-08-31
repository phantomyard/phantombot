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
import { probeBootState, bootHookStillNeeded } from "../src/lib/autostartBoot.ts";

describe("probeBootState", () => {
  test("linux: linger file for the current user + phantombot owns it → boot", async () => {
    const dir = mkdtempSync(join(tmpdir(), "linger-"));
    try {
      const user = (await import("node:os")).userInfo().username;
      writeFileSync(join(dir, user), "");
      expect(
        await probeBootState("any", { platform: "linux", lingerDir: dir, lingerOwned: true }),
      ).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("linux: linger file but NOT phantombot-owned → NOT boot (init prerequisite / admin flag)", async () => {
    // Linger is a phantombot init prerequisite and per-USER host state with
    // no provenance — labelling an inherited flag Boot would arm a teardown
    // that could kill unrelated systemd --user services.
    const dir = mkdtempSync(join(tmpdir(), "linger-"));
    try {
      const user = (await import("node:os")).userInfo().username;
      writeFileSync(join(dir, user), "");
      expect(await probeBootState("any", { platform: "linux", lingerDir: dir })).toBe(false);
      expect(
        await probeBootState("any", { platform: "linux", lingerDir: dir, lingerOwned: false }),
      ).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("linux: owned but no linger file → not boot", async () => {
    const dir = mkdtempSync(join(tmpdir(), "linger-"));
    try {
      expect(
        await probeBootState("any", { platform: "linux", lingerDir: dir, lingerOwned: true }),
      ).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("linux: no linger file → not boot", async () => {
    const dir = mkdtempSync(join(tmpdir(), "linger-"));
    try {
      expect(await probeBootState("any", { platform: "linux", lingerDir: dir })).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("linux: unreadable linger dir → false (fail closed to Login)", async () => {
    expect(
      await probeBootState("any", { platform: "linux", lingerDir: "/nonexistent-lena-probe" }),
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

  test("live linux host: probe runs against the real linger dir without sudo", async () => {
    // Read-only smoke: must not throw and must answer boolean.
    const r = await probeBootState("lena");
    expect(typeof r).toBe("boolean");
  });
});

describe("bootHookStillNeeded", () => {
  const probe = async (p: string) => p === "inherited-boot";

  test("recorded boot member → needed", async () => {
    expect(await bootHookStillNeeded(["a"], { a: "boot" }, probe)).toBe(true);
  });

  test("unrecorded member probed boot (inherited) → needed", async () => {
    expect(await bootHookStillNeeded(["inherited-boot"], {}, probe)).toBe(true);
  });

  test("stale LOGIN record but probe says boot → needed (probe wins over the record)", async () => {
    // A login record from an install path that predates the record must not
    // mask a real plist/linger — otherwise teardown removes hooks that are
    // still in use.
    expect(
      await bootHookStillNeeded(["stale-login"], { "stale-login": "login" }, probe),
    ).toBe(false); // probe returns false for any name but inherited-boot
    expect(
      await bootHookStillNeeded(["inherited-boot"], { "inherited-boot": "login" }, probe),
    ).toBe(true);
  });

  test("no boot members (probe agrees) → not needed", async () => {
    expect(await bootHookStillNeeded(["a"], { a: "login" }, probe)).toBe(false);
    expect(await bootHookStillNeeded([], {}, probe)).toBe(false);
  });
});

// ---------- Teardown (Caveat-2) ----------

import {
  disableBootLinux,
  disableBootLinuxPasswordless,
  teardownBootMac,
  teardownBootMacPasswordless,
  teardownBootWindows,
  registerLoginTasksWindows,
} from "../src/lib/autostartBoot.ts";

describe("disableBootLinux", () => {
  test("passwordless: disable-linger with -n", async () => {
    const calls: string[][] = [];
    const r = await disableBootLinuxPasswordless("u", runner((a) => {
      calls.push(a);
      return { exit: 0 };
    }));
    expect(r.status).toBe("ok");
    expect(calls).toEqual([["sudo", "-n", "loginctl", "disable-linger", "u"]]);
  });

  test("wrong password → invalid-credential, linger never touched", async () => {
    const calls: string[][] = [];
    const r = await disableBootLinux("wrong", "u", runner((a) => {
      calls.push(a);
      if (a.includes("-v")) return { exit: 1, stderr: "sudo: 1 incorrect password attempt" };
      return { exit: 0 };
    }));
    expect(r.status).toBe("invalid-credential");
    expect(calls.some((c) => c.includes("disable-linger"))).toBe(false);
  });

  test("right password: validate then disable-linger with -S -k", async () => {
    const calls: string[][] = [];
    const inputs: (string | undefined)[] = [];
    const r = await disableBootLinux("good", "u", {
      run: async (a, opts) => {
        calls.push(a);
        inputs.push(opts?.input);
        if (a.includes("-v")) return { exit: 0, stdout: "", stderr: "" };
        return { exit: 0, stdout: "", stderr: "" };
      },
    });
    expect(r.status).toBe("ok");
    const linger = calls.find((c) => c.includes("disable-linger"));
    expect(linger?.slice(0, 3)).toEqual(["sudo", "-S", "-k"]);
    expect(inputs[calls.indexOf(linger!)]).toBe("good\n");
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
