/**
 * Tests for runInstall + runUninstall — checks the bin-path validation,
 * XDG_RUNTIME_DIR check, and end-to-end systemctl call sequence with a
 * mocked runner.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { rmrf } from "./fixtures/rmrf.ts";
import { runInstall } from "../src/cli/install.ts";
import { runUninstall } from "../src/cli/uninstall.ts";
import type {
  LaunchctlResult,
  LaunchctlRunner,
} from "../src/lib/launchd.ts";
import type {
  SchtasksResult,
  SchtasksRunner,
} from "../src/lib/taskScheduler.ts";
import type {
  SystemctlResult,
  SystemctlRunner,
  UserSystemdEnv,
} from "../src/lib/systemd.ts";

class FakeSystemctl implements SystemctlRunner {
  calls: string[][] = [];
  async run(args: readonly string[]): Promise<SystemctlResult> {
    this.calls.push([...args]);
    return { exitCode: 0, stdout: "", stderr: "" };
  }
}

class FakeLaunchctl implements LaunchctlRunner {
  calls: string[][] = [];
  async run(args: readonly string[]): Promise<LaunchctlResult> {
    this.calls.push([...args]);
    return { exitCode: 0, stdout: "", stderr: "" };
  }
}

class FakeSchtasks implements SchtasksRunner {
  calls: string[][] = [];
  responses: SchtasksResult[] = [];
  /** Per-task registered XML; /Query answers from this (missing → exit 1). */
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

/** Minimal task XML carrying a Principal with the given SID (ownership check). */
function principalXml(sid: string): string {
  return (
    `<Task xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">` +
    `<Principals><Principal id="Author"><UserId>${sid}</UserId>` +
    `<LogonType>InteractiveToken</LogonType></Principal></Principals></Task>`
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
let unitPath: string;
let installPaths: {
  heartbeatServicePath: string;
  heartbeatTimerPath: string;
  nightlyServicePath: string;
  nightlyTimerPath: string;
  tickServicePath: string;
  tickTimerPath: string;
};

beforeEach(async () => {
  workdir = await mkdtemp(join(tmpdir(), "phantombot-install-"));
  unitPath = join(workdir, "phantombot-phantom.service");
  // Without these, runInstall would write companion units into the real
  // ~/.config/systemd/user/ on the test runner — see #44.
  installPaths = {
    heartbeatServicePath: join(workdir, "phantombot-phantom-heartbeat.service"),
    heartbeatTimerPath: join(workdir, "phantombot-phantom-heartbeat.timer"),
    nightlyServicePath: join(workdir, "phantombot-nightly.service"),
    nightlyTimerPath: join(workdir, "phantombot-nightly.timer"),
    tickServicePath: join(workdir, "phantombot-phantom-tick.service"),
    tickTimerPath: join(workdir, "phantombot-phantom-tick.timer"),
  };
});

afterEach(async () => {
  await rmrf(workdir);
});

const sysEnvReady = (): UserSystemdEnv => ({
  ready: true,
  autoSet: false,
  runtimeDir: "/run/user/1000",
});
const sysEnvAutoSet = (): UserSystemdEnv => ({
  ready: true,
  autoSet: true,
  runtimeDir: "/run/user/1003",
});
const sysEnvMissing = (): UserSystemdEnv => ({
  ready: false,
  autoSet: false,
  reason: "/run/user/1003 does not exist — enable linger first: sudo loginctl enable-linger kai",
});

describe("runInstall (linux/systemd)", () => {
  test("rejects when bin name isn't 'phantombot'", async () => {
    const out = new CaptureStream();
    const err = new CaptureStream();
    const sys = new FakeSystemctl();
    const code = await runInstall({
      binPath: "/usr/bin/bun",
      unitPath,
      systemctl: sys,
      out,
      err,
      ensureSystemdEnv: sysEnvReady,
      platform: "linux",
    });
    expect(code).toBe(2);
    expect(err.text).toContain("compiled binary");
    expect(sys.calls).toEqual([]);
  });

  test("rejects when systemd env detection fails (linger disabled)", async () => {
    const out = new CaptureStream();
    const err = new CaptureStream();
    const sys = new FakeSystemctl();
    const code = await runInstall({
      binPath: "/usr/local/bin/phantombot",
      unitPath,
      systemctl: sys,
      out,
      err,
      ensureSystemdEnv: sysEnvMissing,
      platform: "linux",
    });
    expect(code).toBe(2);
    expect(err.text).toContain("no user-level systemd bus available");
    expect(err.text).toContain("loginctl enable-linger");
  });

  test("auto-set message printed when systemd env is auto-detected", async () => {
    const out = new CaptureStream();
    const err = new CaptureStream();
    const sys = new FakeSystemctl();
    const code = await runInstall({
      binPath: "/usr/local/bin/phantombot",
      unitPath,
      ...installPaths,
      systemctl: sys,
      out,
      err,
      ensureSystemdEnv: sysEnvAutoSet,
      platform: "linux",
    });
    expect(code).toBe(0);
    expect(out.text).toContain(
      "auto-detected XDG_RUNTIME_DIR=/run/user/1003",
    );
  });

  test("happy path writes unit + runs reload/enable/start, returns 0", async () => {
    const out = new CaptureStream();
    const err = new CaptureStream();
    const sys = new FakeSystemctl();
    const code = await runInstall({
      binPath: "/usr/local/bin/phantombot",
      unitPath,
      ...installPaths,
      systemctl: sys,
      out,
      err,
      ensureSystemdEnv: sysEnvReady,
      platform: "linux",
    });
    expect(code).toBe(0);
    expect(sys.calls.map((a) => a.join(" "))).toEqual([
      "--user daemon-reload",
      "--user enable phantombot-phantom.service",
      "--user start phantombot-phantom.service",
      "--user enable phantombot-phantom-heartbeat.timer",
      "--user start phantombot-phantom-heartbeat.timer",
      "--user enable phantombot-phantom-tick.timer",
      "--user start phantombot-phantom-tick.timer",
    ]);
    // The trailing manage block advertises the clean subcommands (identical
    // on every OS), not the raw systemctl/schtasks incantations.
    expect(out.text).toContain("manage phantombot:");
    expect(out.text).toContain("phantombot restart");
    expect(out.text).toContain("phantombot logs");
    // No auto-set message when env was already set.
    expect(out.text).not.toContain("auto-detected");
  });
});

describe("runInstall (darwin/launchd)", () => {
  test("happy path writes plists + bootstraps each into the gui domain", async () => {
    const out = new CaptureStream();
    const err = new CaptureStream();
    const lc = new FakeLaunchctl();
    const code = await runInstall({
      binPath: "/Users/andrew/.local/bin/phantombot",
      plistPath: join(workdir, "dev.phantombot.phantombot.plist"),
      heartbeatPlistPath: join(workdir, "dev.phantombot.heartbeat.plist"),
      nightlyPlistPath: join(workdir, "dev.phantombot.nightly.plist"),
      tickPlistPath: join(workdir, "dev.phantombot.tick.plist"),
      domain: "gui/501",
      launchctl: lc,
      out,
      err,
      platform: "darwin",
    });
    expect(code).toBe(0);
    // bootouts of nothing × 3, then bootstrap each plist × 3 (the retired
    // nightly agent is neither written nor bootstrapped). We check the verb
    // sequence rather than full strings so the test stays readable.
    const verbs = lc.calls.map((c) => c[0]);
    expect(verbs).toEqual([
      "bootout",
      "bootout",
      "bootout",
      "bootstrap",
      "bootstrap",
      "bootstrap",
    ]);
    // bootstraps target the correct domain.
    for (const c of lc.calls.filter((c) => c[0] === "bootstrap")) {
      expect(c[1]).toBe("gui/501");
    }
  });

  test("doesn't fall through to systemctl on darwin (the bug Andrew hit on his Mac)", async () => {
    const out = new CaptureStream();
    const err = new CaptureStream();
    const sys = new FakeSystemctl();
    const lc = new FakeLaunchctl();
    const code = await runInstall({
      binPath: "/Users/andrew/.local/bin/phantombot",
      plistPath: join(workdir, "dev.phantombot.phantombot.plist"),
      heartbeatPlistPath: join(workdir, "dev.phantombot.heartbeat.plist"),
      nightlyPlistPath: join(workdir, "dev.phantombot.nightly.plist"),
      tickPlistPath: join(workdir, "dev.phantombot.tick.plist"),
      domain: "gui/501",
      systemctl: sys,
      launchctl: lc,
      out,
      err,
      platform: "darwin",
    });
    expect(code).toBe(0);
    // No systemctl calls — the regression test for the original Mac bug.
    expect(sys.calls).toEqual([]);
    // No "loginctl" appears anywhere.
    expect(err.text).not.toContain("loginctl");
    expect(out.text).not.toContain("loginctl");
  });

  test("rejects when bin name isn't 'phantombot' regardless of platform", async () => {
    const err = new CaptureStream();
    const lc = new FakeLaunchctl();
    const code = await runInstall({
      binPath: "/Users/andrew/.local/bin/bun",
      domain: "gui/501",
      launchctl: lc,
      out: new CaptureStream(),
      err,
      platform: "darwin",
    });
    expect(code).toBe(2);
    expect(err.text).toContain("compiled binary");
    expect(lc.calls).toEqual([]);
  });
});

const WIN_BIN2 =
  "C:\\Users\\megan\\AppData\\Local\\phantombot\\bin\\phantombot.exe";

describe("runInstall (windows/schtasks)", () => {
  const WIN_BIN =
    "C:\\Users\\andrew\\AppData\\Local\\phantombot\\bin\\phantombot.exe";

  test("accepts the .exe binary and imports all four tasks", async () => {
    const out = new CaptureStream();
    const err = new CaptureStream();
    const st = new FakeSchtasks();
    const code = await runInstall({
      binPath: WIN_BIN,
      persona: "testbot",
      sid: "S-1-5-21-1-2-3-1001",
      xmlDir: workdir,
      schtasks: st,
      out,
      err,
      platform: "windows",
    });
    expect(code).toBe(0);
    // Three /Create imports, one per live task.
    const creates = st.calls.filter((c) => c[0] === "/Create");
    expect(creates.length).toBe(3);
    expect(out.text).toContain("registered");
    expect(out.text).toContain("while logged in");
  });

  test("doesn't fall through to systemctl or launchctl on windows", async () => {
    const sys = new FakeSystemctl();
    const lc = new FakeLaunchctl();
    const st = new FakeSchtasks();
    const code = await runInstall({
      binPath: WIN_BIN,
      persona: "testbot",
      sid: "S-1-5-21-1-2-3-1001",
      xmlDir: workdir,
      systemctl: sys,
      launchctl: lc,
      schtasks: st,
      out: new CaptureStream(),
      err: new CaptureStream(),
      platform: "windows",
    });
    expect(code).toBe(0);
    expect(sys.calls).toEqual([]);
    expect(lc.calls).toEqual([]);
  });

  test("propagates a schtasks import failure as a non-zero exit", async () => {
    const err = new CaptureStream();
    const st = new FakeSchtasks();
    st.responses = [
      { exitCode: 1, stdout: "", stderr: "cannot find" },
      { exitCode: 1, stdout: "", stderr: "Access is denied" },
    ];
    const code = await runInstall({
      binPath: WIN_BIN,
      persona: "testbot",
      sid: "S-1-5-21-1-2-3-1001",
      xmlDir: workdir,
      schtasks: st,
      out: new CaptureStream(),
      err,
      platform: "windows",
    });
    expect(code).toBe(1);
    expect(err.text).toContain("could not register scheduled task");
  });

  test("rejects a non-phantombot binary on windows too", async () => {
    const err = new CaptureStream();
    const st = new FakeSchtasks();
    const code = await runInstall({
      binPath: "C:\\Program Files\\bun\\bun.exe",
      xmlDir: workdir,
      schtasks: st,
      out: new CaptureStream(),
      err,
      platform: "windows",
    });
    expect(code).toBe(2);
    expect(err.text).toContain("compiled binary");
    expect(st.calls).toEqual([]);
  });
});

describe("runUninstall (windows/schtasks)", () => {
  test("deletes all four tasks and reports complete", async () => {
    const out = new CaptureStream();
    const st = new FakeSchtasks();
    const sid = "S-1-5-21-1-2-3-1001";
    // 3 live + 1 retired persona-scoped task, plus 4 legacy pre-rename names,
    // all owned by us. Uninstall must clear the retired nightly task too.
    const names = [
      "phantombot-testbot",
      "heartbeat-testbot",
      "nightly-testbot",
      "tick-testbot",
      "phantombot",
      "heartbeat",
      "nightly",
      "tick",
    ];
    for (const n of names) st.registry[`\\Phantombot\\${n}`] = principalXml(sid);
    const code = await runUninstall({
      persona: "testbot",
      sid,
      schtasks: st,
      out,
      err: new CaptureStream(),
      platform: "windows",
    });
    expect(code).toBe(0);
    const deletes = st.calls.filter((c) => c[0] === "/Delete");
    expect(deletes.length).toBe(8);
    expect(out.text).toContain("uninstall complete");
  });

  test("leaves another Windows account's tasks alone", async () => {
    const out = new CaptureStream();
    const st = new FakeSchtasks();
    const foreign = "S-1-5-21-9-9-9-1005";
    st.registry["\\Phantombot\\phantombot-testbot"] = principalXml(foreign);
    const code = await runUninstall({
      persona: "testbot",
      sid: "S-1-5-21-1-2-3-1001",
      schtasks: st,
      out,
      err: new CaptureStream(),
      platform: "windows",
    });
    expect(code).toBe(0);
    expect(st.calls.filter((c) => c[0] === "/Delete")).toEqual([]);
    expect(st.registry["\\Phantombot\\phantombot-testbot"]).toBeDefined();
    expect(out.text).toContain("owned by another Windows account");
  });
});

describe("runUninstall (linux/systemd)", () => {
  test("issues stop/disable/daemon-reload regardless of unit existing", async () => {
    const out = new CaptureStream();
    const err = new CaptureStream();
    const sys = new FakeSystemctl();
    const code = await runUninstall({
      unitPath,
      systemctl: sys,
      out,
      err,
      ensureSystemdEnv: sysEnvReady,
      platform: "linux",
    });
    expect(code).toBe(0);
    expect(sys.calls.map((a) => a.join(" "))).toEqual([
      "--user stop phantombot-phantom-tick.timer",
      "--user disable phantombot-phantom-tick.timer",
      "--user stop phantombot-nightly.timer",
      "--user disable phantombot-nightly.timer",
      "--user stop phantombot-phantom-heartbeat.timer",
      "--user disable phantombot-phantom-heartbeat.timer",
      "--user stop phantombot-phantom.service",
      "--user disable phantombot-phantom.service",
      "--user daemon-reload",
    ]);
    expect(out.text).toContain("uninstall complete");
  });

  test("warns and continues with file removal when systemd env is missing", async () => {
    const out = new CaptureStream();
    const err = new CaptureStream();
    const sys = new FakeSystemctl();
    const code = await runUninstall({
      unitPath,
      systemctl: sys,
      out,
      err,
      ensureSystemdEnv: sysEnvMissing,
      platform: "linux",
    });
    expect(code).toBe(0);
    expect(err.text).toContain("no user-level systemd bus available");
  });
});

describe("runUninstall (darwin/launchd)", () => {
  test("boots out each label without touching systemctl", async () => {
    const out = new CaptureStream();
    const err = new CaptureStream();
    const sys = new FakeSystemctl();
    const lc = new FakeLaunchctl();
    const code = await runUninstall({
      plistPath: join(workdir, "dev.phantombot.phantombot.plist"),
      heartbeatPlistPath: join(workdir, "dev.phantombot.heartbeat.plist"),
      nightlyPlistPath: join(workdir, "dev.phantombot.nightly.plist"),
      tickPlistPath: join(workdir, "dev.phantombot.tick.plist"),
      domain: "gui/501",
      systemctl: sys,
      launchctl: lc,
      out,
      err,
      platform: "darwin",
    });
    expect(code).toBe(0);
    expect(sys.calls).toEqual([]);
    expect(lc.calls.length).toBe(4);
    expect(lc.calls.every((c) => c[0] === "bootout")).toBe(true);
    expect(out.text).toContain("uninstall complete");
  });
});

describe("runInstall (windows) logged-off prompt flow", () => {

  test("answering no keeps interactive mode (no /RU, no password)", async () => {
    const st = new FakeSchtasks();
    const out = new CaptureStream();
    const code = await runInstall({
      binPath: WIN_BIN2,
      persona: "testbot",
      sid: "S-1-5-21-1-2-3-1001",
      xmlDir: workdir,
      schtasks: st,
      out,
      err: new CaptureStream(),
      platform: "windows",
      promptRunLoggedOff: async () => false,
    });
    expect(code).toBe(0);
    const creates = st.calls.filter((c) => c[0] === "/Create");
    expect(creates.length).toBe(3);
    for (const c of creates) {
      expect(c).not.toContain("/RU");
      expect(c).not.toContain("/RP");
    }
    expect(out.text).toContain("while logged in");
  });

  test("answering yes asks for the password and registers with /RU + /RP", async () => {
    const st = new FakeSchtasks();
    const out = new CaptureStream();
    let askedPassword = false;
    const code = await runInstall({
      binPath: WIN_BIN2,
      persona: "testbot",
      sid: "S-1-5-21-1-2-3-1001",
      xmlDir: workdir,
      schtasks: st,
      out,
      err: new CaptureStream(),
      platform: "windows",
      promptRunLoggedOff: async () => true,
      promptPassword: async () => {
        askedPassword = true;
        return "s3cret!";
      },
      whoami: async () => "MEGAN-PC\\megan",
      readVaultWindowsPassword: async () => null,
      validateWindowsCredential: async () => true,
      saveVaultWindowsPassword: async () => {},
    });
    expect(code).toBe(0);
    expect(askedPassword).toBe(true);
    const creates = st.calls.filter((c) => c[0] === "/Create");
    // 3 password tasks + the interactive login-fallback twin.
    expect(creates.length).toBe(4);
    for (const c of creates.filter((c) => !c.some((a) => a.includes("login-testbot")))) {
      expect(c).toContain("/RU");
      expect(c).toContain("MEGAN-PC\\megan");
      expect(c).toContain("/RP");
    }
    expect(out.text).toContain("whether or not anyone is logged on");
  });

  test("cancelling the prompt aborts the install with exit 2", async () => {
    const st = new FakeSchtasks();
    const err = new CaptureStream();
    const code = await runInstall({
      binPath: WIN_BIN2,
      persona: "testbot",
      sid: "S-1-5-21-1-2-3-1001",
      xmlDir: workdir,
      schtasks: st,
      out: new CaptureStream(),
      err,
      platform: "windows",
      promptRunLoggedOff: async () => null,
    });
    expect(code).toBe(2);
    expect(err.text).toContain("cancelled");
    expect(st.calls).toEqual([]);
  });
});

  test("scripted mode: runLoggedOff + password flag skips all prompts", async () => {
    const st = new FakeSchtasks();
    const out = new CaptureStream();
    let prompted = false;
    const code = await runInstall({
      binPath: WIN_BIN2,
      persona: "testbot",
      sid: "S-1-5-21-1-2-3-1001",
      xmlDir: workdir,
      schtasks: st,
      out,
      err: new CaptureStream(),
      platform: "windows",
      runLoggedOff: true,
      windowsPassword: "s3cret!",
      whoami: async () => "MEGAN-PC\\megan",
      promptRunLoggedOff: async () => {
        prompted = true;
        return false;
      },
      readVaultWindowsPassword: async () => null,
      validateWindowsCredential: async () => true,
      saveVaultWindowsPassword: async () => {},
    });
    expect(code).toBe(0);
    expect(prompted).toBe(false);
    const creates = st.calls.filter((c) => c[0] === "/Create");
    // 3 password tasks + the interactive login-fallback twin.
    expect(creates.length).toBe(4);
    for (const c of creates.filter((c) => !c.some((a) => a.includes("login-testbot")))) {
      expect(c).toContain("/RP");
    }
    expect(out.text).toContain("whether or not anyone is logged on");
  });

  test("scripted mode: runLoggedOff without a password fails clearly", async () => {
    const st = new FakeSchtasks();
    const err = new CaptureStream();
    const prev = process.env.PHANTOMBOT_WINDOWS_PASSWORD;
    delete process.env.PHANTOMBOT_WINDOWS_PASSWORD;
    try {
      const code = await runInstall({
        binPath: WIN_BIN2,
        persona: "testbot",
        sid: "S-1-5-21-1-2-3-1001",
        xmlDir: workdir,
        schtasks: st,
        out: new CaptureStream(),
        err,
        platform: "windows",
        runLoggedOff: true,
        whoami: async () => "MEGAN-PC\\megan",
        readVaultWindowsPassword: async () => null,
      });
      expect(code).toBe(2);
      expect(err.text).toContain("needs the Windows password");
      expect(st.calls).toEqual([]);
    } finally {
      if (prev !== undefined) process.env.PHANTOMBOT_WINDOWS_PASSWORD = prev;
    }
  });

  test("Enter reuses the saved vault password", async () => {
    const st = new FakeSchtasks();
    const code = await runInstall({
      binPath: WIN_BIN2,
      persona: "testbot",
      sid: "S-1-5-21-1-2-3-1001",
      xmlDir: workdir,
      schtasks: st,
      out: new CaptureStream(),
      err: new CaptureStream(),
      platform: "windows",
      whoami: async () => "MEGAN-PC\\megan",
      promptRunLoggedOff: async () => true,
      // User pressed Enter (empty) at the password prompt.
      promptPassword: async () => "",
      readVaultWindowsPassword: async () => "vault-pw",
      validateWindowsCredential: async () => true,
      saveVaultWindowsPassword: async () => {},
    });
    expect(code).toBe(0);
    const pwCreates = st.calls.filter(
      (c) => c[0] === "/Create" && !c.some((a) => a.includes("login-testbot")),
    );
    expect(pwCreates.length).toBe(3);
    // The reused vault password was applied via /RP.
    for (const c of pwCreates) {
      expect(c).toContain("/RP");
      expect(c).toContain("vault-pw");
    }
  });

  test("a wrong password falls back to interactive/login mode (no boot task)", async () => {
    const st = new FakeSchtasks();
    const out = new CaptureStream();
    let saved = false;
    const code = await runInstall({
      binPath: WIN_BIN2,
      persona: "testbot",
      sid: "S-1-5-21-1-2-3-1001",
      xmlDir: workdir,
      schtasks: st,
      out,
      err: new CaptureStream(),
      platform: "windows",
      whoami: async () => "MEGAN-PC\\megan",
      promptRunLoggedOff: async () => true,
      promptPassword: async () => "wrong-pw",
      readVaultWindowsPassword: async () => null,
      validateWindowsCredential: async () => false,
      saveVaultWindowsPassword: async () => {
        saved = true;
      },
    });
    expect(code).toBe(0);
    // No password-mode registration: no /RP anywhere, and no login-fallback
    // task is CREATED (interactive install still probes it for cleanup).
    expect(st.calls.some((c) => c.includes("/RP"))).toBe(false);
    expect(
      st.calls.some(
        (c) => c[0] === "/Create" && c.some((a) => a.includes("login-testbot")),
      ),
    ).toBe(false);
    // A wrong password is never persisted to the vault.
    expect(saved).toBe(false);
    expect(out.text).toContain("did not validate");
  });

  test("unattended reinstall honours a persisted password mode (boot-schema migration path)", async () => {
    const st = new FakeSchtasks();
    const code = await runInstall({
      binPath: WIN_BIN2,
      persona: "testbot",
      sid: "S-1-5-21-1-2-3-1001",
      xmlDir: workdir,
      schtasks: st,
      out: new CaptureStream(),
      err: new CaptureStream(),
      platform: "windows",
      whoami: async () => "MEGAN-PC\\megan",
      // No prompt seam + no runLoggedOff flag = unattended. Persisted mode +
      // saved password drive it, exactly like a silent boot-schema migration.
      readPersistedLogonMode: async () => "password",
      readVaultWindowsPassword: async () => "migrated-pw",
      validateWindowsCredential: async () => true,
      saveVaultWindowsPassword: async () => {},
    });
    expect(code).toBe(0);
    const pwCreates = st.calls.filter(
      (c) => c[0] === "/Create" && !c.some((a) => a.includes("login-testbot")),
    );
    expect(pwCreates.length).toBe(3);
    for (const c of pwCreates) expect(c).toContain("migrated-pw");
    // The interactive login-fallback twin is registered too.
    expect(st.calls.some((c) => c.some((a) => a.includes("login-testbot")))).toBe(
      true,
    );
  });

  test("unattended reinstall with no saved password downgrades to interactive, loudly", async () => {
    const st = new FakeSchtasks();
    const out = new CaptureStream();
    const code = await runInstall({
      binPath: WIN_BIN2,
      persona: "testbot",
      sid: "S-1-5-21-1-2-3-1001",
      xmlDir: workdir,
      schtasks: st,
      out,
      err: new CaptureStream(),
      platform: "windows",
      whoami: async () => "MEGAN-PC\\megan",
      readPersistedLogonMode: async () => "password",
      readVaultWindowsPassword: async () => null,
    });
    expect(code).toBe(0);
    expect(st.calls.some((c) => c.includes("/RP"))).toBe(false);
    expect(out.text).toContain("no saved password is available");
  });
