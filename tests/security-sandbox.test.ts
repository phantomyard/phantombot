import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import {
  mkdirSync,
  realpathSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  defaultSandboxHostPaths,
  runSandbox,
  sandboxEnvironment,
  windowsSystemPath,
  windowsModulePath,
} from "../src/security/sandbox.ts";
import {
  deleteWindowsProfile,
  freeDriveLetters,
  isStaleSandboxDrive,
  nulGrantsAppContainers,
  setWindowsAppContainerUsableForTests,
  windowsAppContainerUsable,
  windowsParents,
  withTraverseAce,
} from "../src/security/windows.ts";
import {
  prepareWindowsUntrustedScratch,
  sandboxRootSddl,
  sandboxUserSddl,
  windowsScratchTarget,
} from "../src/security/windowsScratch.ts";
import { prepareSandboxTools } from "../src/security/workspace.ts";
const dirs: string[] = [];
const fresh = () => {
  const d = mkdtempSync(join(tmpdir(), "pb-security-"));
  dirs.push(d);
  return d;
};
afterEach(() => {
  for (const d of dirs.splice(0)) {
    deleteWindowsProfile(d);
    rmSync(d, { recursive: true, force: true });
  }
});
const win = process.platform === "win32";
// Does this Windows build let AppContainers open NUL (git needs it)? Read once
// for real, then the confinement tests below always exercise the AppContainer.
const nulOpen = win && windowsAppContainerUsable();
beforeAll(() => setWindowsAppContainerUsableForTests(win ? true : undefined));
afterAll(() => setWindowsAppContainerUsableForTests(undefined));
const quote = (s: string) => (win ? JSON.stringify(s) : `'${s.replace(/'/g, "'\\''")}'`);
const cat = (p: string) => `${win ? "type" : "cat"} ${quote(p)}`;
test("sandbox has only an explicit clean environment", () => {
  const env = sandboxEnvironment("/work", "/neutral");
  expect(env).not.toHaveProperty("GITHUB_TOKEN");
  expect(env).not.toHaveProperty("PHANTOMBOT_ESCORT");
  expect(env).not.toHaveProperty("NODE_OPTIONS");
  expect(env).not.toHaveProperty("HTTP_PROXY");
  expect(env.HOME).toBe("/neutral");
  expect(env.XDG_CONFIG_HOME).toBe(join("/neutral", ".config"));
  expect(env.XDG_CACHE_HOME).toBe(join("/neutral", ".cache"));
});
test("real OS permits local work and denies reads/writes outside", async () => {
  const workspace = fresh(),
    outside = fresh(),
    file = join(outside, "secret");
  writeFileSync(file, "host-secret");
  const allowed = await runSandbox(workspace, "echo local > local.txt");
  expect(allowed.exitCode, allowed.output).toBe(0);
  expect(readFileSync(join(workspace, "local.txt"), "utf8")).toContain("local");
  const denied = await runSandbox(workspace, cat(file));
  expect(denied.exitCode).not.toBe(0);
  expect(denied.output).not.toContain("host-secret");
  await runSandbox(workspace, `echo overwritten > ${quote(file)}`);
  expect(readFileSync(file, "utf8")).toBe("host-secret");
}, 20000);
test("real symlink/junction escape does not read host files", async () => {
  const workspace = fresh(),
    outside = fresh();
  writeFileSync(join(outside, "secret"), "host-secret");
  symlinkSync(outside, join(workspace, "escape"), win ? "junction" : "dir");
  const r = await runSandbox(
    workspace,
    cat(join(workspace, "escape", "secret")),
  );
  expect(r.exitCode).not.toBe(0);
  expect(r.output).not.toContain("host-secret");
}, 15000);
test("repository child process inherits restrictions", async () => {
  const workspace = fresh(),
    outside = fresh();
  const file = join(outside, "secret");
  writeFileSync(file, "host-secret");
  const command = win
    ? `cmd /d /c ${cat(file)}`
    : `/bin/sh -c ${quote(cat(file))}`;
  const r = await runSandbox(workspace, command);
  expect(r.exitCode).not.toBe(0);
  expect(r.output).not.toContain("host-secret");
}, 15000);
test("sandbox env carries runtime-supplied secrets but never reserved names", () => {
  const env = sandboxEnvironment("/work", "/neutral", {
    GH_TOKEN: "gh-secret",
    LD_PRELOAD: "/evil.so",
    NODE_OPTIONS: "--require /evil",
    BUN_OPTIONS: "--preload /evil",
    PATH: "/evil",
    HOME: "/evil",
    PHANTOMBOT_SECURITY_SESSION: "x",
    "BAD-NAME": "x",
  });
  expect(env.GH_TOKEN).toBe("gh-secret");
  for (const k of ["LD_PRELOAD", "NODE_OPTIONS", "BUN_OPTIONS", "PHANTOMBOT_SECURITY_SESSION", "BAD-NAME"])
    expect(env).not.toHaveProperty(k);
  expect(env.HOME).toBe("/neutral");
  expect(env.PATH).not.toContain("/evil");
});
test("sandboxed command sees the secrets it was given", async () => {
  const workspace = fresh();
  const r = await runSandbox(
    workspace,
    win ? "echo %PROBE_SECRET%" : 'echo "$PROBE_SECRET"',
    { secrets: { PROBE_SECRET: "probe-value-1" } },
  );
  expect(r.exitCode, r.output).toBe(0);
  expect(r.output).toContain("probe-value-1");
}, 15000);
test("sandbox has TCP network (GHSA-w7w8); Windows AppContainer still cannot reach host loopback", async () => {
  const workspace = fresh();
  let calls = 0;
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: () => {
      calls++;
      return new Response("net-ok");
    },
  });
  try {
    const r = await runSandbox(
      workspace,
      `${win ? "curl.exe" : "curl"} -s --connect-timeout 2 --max-time 4 http://127.0.0.1:${server.port}/`,
    );
    if (win) {
      expect(r.exitCode).not.toBe(0);
      expect(calls).toBe(0);
    } else {
      expect(r.exitCode, r.output).toBe(0);
      expect(r.output).toContain("net-ok");
    }
  } finally {
    await server.stop(true);
  }
}, 15000);
test.skipIf(process.platform !== "linux")(
  "Linux sandbox refuses non-inet sockets (no host Unix sockets)",
  async () => {
    const workspace = fresh();
    const r = await runSandbox(
      workspace,
      "python3 -c 'import socket; socket.socket(socket.AF_UNIX)' 2>&1; echo rc=$?",
    );
    expect(r.output).toContain("Address family not supported");
    expect(r.output).toContain("rc=1");
  },
  15000,
);
test("process timeout terminates descendants", async () => {
  const workspace = fresh();
  const r = await runSandbox(
    workspace,
    win ? "ping -n 20 127.0.0.1 > nul" : "sleep 20",
    { timeoutMs: 1500 },
  );
  expect(r.exitCode).not.toBe(0);
}, 15000);
test("bundled sandbox permits an existing Bun/Node runtime with no host secrets", async () => {
  const workspace = fresh();
  prepareSandboxTools(workspace);
  const r = await runSandbox(
    workspace,
    `bun -e ${quote('console.log("runtime-ok"); console.log(process.env.GITHUB_TOKEN ?? "no-secret")')}`,
  );
  expect(r.exitCode, r.output).toBe(0);
  expect(r.output).toContain("runtime-ok");
  expect(r.output).toContain("no-secret");
}, 15000);

test("launcher never executes repository Bun preloads outside confinement", async () => {
  const workspace = fresh(),
    outside = fresh(),
    canary = join(outside, "escaped");
  writeFileSync(
    join(workspace, "bunfig.toml"),
    `preload = [${JSON.stringify(join(workspace, "preload.ts"))}]\n`,
  );
  writeFileSync(
    join(workspace, "preload.ts"),
    `import{writeFileSync}from"node:fs";writeFileSync(${JSON.stringify(canary)},"escaped");`,
  );
  // XDG route: the model learns the workspace path from broker({manifest:true}),
  // so a global bunfig planted there must not be reachable via XDG_CONFIG_HOME.
  mkdirSync(join(workspace, ".config"), { mode: 0o700 });
  writeFileSync(
    join(workspace, ".config", ".bunfig.toml"),
    `preload = [${JSON.stringify(canary)}]\n`,
  );
  const r = await runSandbox(workspace, "echo preload-safe");
  expect(r.exitCode, r.output).toBe(0);
  expect(() => readFileSync(canary)).toThrow();
}, 15000);

// The owner's model: only the workspace is writable; tool dirs and SSH PUBLIC
// keys are read-only; everything else in the home stays hidden.
test("defaultSandboxHostPaths grants ~/.local/bin and only public SSH keys", () => {
  const home = fresh();
  mkdirSync(join(home, ".ssh"));
  writeFileSync(join(home, ".ssh", "id_ed25519"), "PRIVATE");
  writeFileSync(join(home, ".ssh", "id_ed25519.pub"), "ssh-ed25519 PUB");
  const paths = defaultSandboxHostPaths(home);
  expect(paths.read).toEqual([
    join(home, ".local", "bin"),
    join(home, ".ssh", "id_ed25519.pub"),
    join(home, ".config", "gh"),
    join(home, ".config", "git"),
    join(home, ".gitconfig"),
    join(home, ".git-credentials"),
  ]);
  expect(paths.path).toEqual([join(home, ".local", "bin")]);
});

test.skipIf(win)(
  "read-only host paths: readable via ~, bin on PATH, private key and rest of home hidden",
  async () => {
    const home = fresh(),
      ws = fresh();
    for (const d of [".local/bin", "tools", ".ssh"])
      mkdirSync(join(home, d), { recursive: true });
    writeFileSync(join(home, ".local/bin/pbtool"), "#!/bin/sh\necho tool-ran\n", { mode: 0o755 });
    writeFileSync(join(home, "tools", "script.txt"), "tool-file");
    writeFileSync(join(home, ".ssh", "id_x.pub"), "ssh-ed25519 PUBKEY");
    writeFileSync(join(home, ".ssh", "id_x"), "PRIVATE-KEY");
    writeFileSync(join(home, ".bashrc"), "HOME-SECRET");
    const r = await runSandbox(
      ws,
      [
        "pbtool",
        `cat ${quote(join(home, "tools", "script.txt"))} || echo tools-hidden`,
        "cat ~/.ssh/id_x.pub; echo",
        `cat ${quote(join(home, ".ssh", "id_x"))} || echo private-hidden`,
        `cat ${quote(join(home, ".bashrc"))} || echo home-hidden`,
        `touch ~/.ssh/new || echo ssh-readonly`,
        "touch here && echo workspace-writable",
      ].join("\n"),
      { hostPaths: { ...defaultSandboxHostPaths(home), home } },
    );
    expect(r.output).toContain("tool-ran");
    expect(r.output).toContain("tools-hidden");
    expect(r.output).not.toContain("tool-file");
    expect(r.output).toContain("PUBKEY");
    expect(r.output).toContain("private-hidden");
    expect(r.output).not.toContain("PRIVATE-KEY");
    expect(r.output).toContain("home-hidden");
    expect(r.output).not.toContain("HOME-SECRET");
    expect(r.output).toContain("ssh-readonly");
    expect(r.output).toContain("workspace-writable");
  },
  20000,
);

test("sandbox env carries the trusted turn's PHANTOMBOT_* context", () => {
  const env = sandboxEnvironment("/work", "/neutral", { PHANTOMBOT_PERSONA: "evil" }, [], {
    persona: "robbie",
    conversation: "tick:1",
    turnId: "t-1",
    session: '{"url":"x"}',
  });
  expect(env.PHANTOMBOT_PERSONA).toBe("robbie");
  expect(env.PHANTOMBOT_CONVERSATION).toBe("tick:1");
  expect(env.PHANTOMBOT_TURN_ID).toBe("t-1");
  expect(env.PHANTOMBOT_SECURITY_SESSION).toBe('{"url":"x"}');
  expect(env.PHANTOMBOT_SCRATCH).toBe("/work");
  // No ~/.gitconfig mirrored: git still ignores any global config.
  expect(env.GIT_CONFIG_GLOBAL).toBe(win ? "NUL" : "/dev/null");
  // A secret cannot pose as context.
  expect(sandboxEnvironment("/work", "/neutral", { PHANTOMBOT_PERSONA: "evil" })).not.toHaveProperty("PHANTOMBOT_PERSONA");
});

test.skipIf(win)(
  "gh/git logins: readable inside like a trusted turn, never writable",
  async () => {
    const home = fresh(),
      ws = fresh();
    mkdirSync(join(home, ".config", "gh"), { recursive: true });
    writeFileSync(join(home, ".config", "gh", "hosts.yml"), "github.com:\n    oauth_token: GH-LOGIN\n");
    writeFileSync(join(home, ".gitconfig"), "[user]\n\tname = Login Name\n");
    writeFileSync(join(home, ".git-credentials"), "https://u:CRED@github.com\n");
    const r = await runSandbox(
      ws,
      [
        'cat "$XDG_CONFIG_HOME/gh/hosts.yml"',
        "git config --global user.name",
        "cat ~/.git-credentials",
        'echo x >> "$XDG_CONFIG_HOME/gh/hosts.yml" || echo gh-readonly',
        "echo x >> ~/.gitconfig || echo git-readonly",
        'echo "scratch=$PHANTOMBOT_SCRATCH persona=$PHANTOMBOT_PERSONA"',
      ].join("\n"),
      { hostPaths: { ...defaultSandboxHostPaths(home), home }, context: { persona: "p1" } },
    );
    expect(r.output).toContain("GH-LOGIN");
    expect(r.output).toContain("Login Name");
    expect(r.output).toContain("CRED");
    expect(r.output).toContain("gh-readonly");
    expect(r.output).toContain("git-readonly");
    expect(r.output).toContain(`scratch=${realpathSync(ws)} persona=p1`);
  },
  20000,
);

const CAP = "S-1-15-3-1024-1-2-3";
test("windowsParents lists every parent, drive root first", () => {
  expect(windowsParents("C:\\Users\\me\\scratch\\run")).toEqual([
    "C:\\",
    "C:\\Users",
    "C:\\Users\\me",
    "C:\\Users\\me\\scratch",
  ]);
  expect(windowsParents("C:\\")).toEqual([]);
  expect(windowsParents("\\\\server\\share\\x")).toEqual([]);
});
test("withTraverseAce adds one read-attributes ACE after the explicit ACEs", () => {
  const dacl = "D:AI(A;;FA;;;S-1-5-21-1)(A;OICIID;FA;;;SY)";
  const next = withTraverseAce(dacl, CAP);
  expect(next).toBe(`D:AI(A;;FA;;;S-1-5-21-1)(A;;0x100080;;;${CAP})(A;OICIID;FA;;;SY)`);
  expect(withTraverseAce(next, CAP)).toBe(next); // idempotent
  // No inheritance flags on the new ACE: children never gain it.
  expect(next).not.toContain(`(A;OI;0x100080;;;${CAP})`);
  // Unparseable, empty or absent DACLs are left alone.
  expect(withTraverseAce("D:", CAP)).toBe("D:");
  expect(withTraverseAce("D:NO_ACCESS_CONTROL", CAP)).toBe("D:NO_ACCESS_CONTROL");
  expect(withTraverseAce("D:(XA;;FX;;;WD;(Member_of {SID(BA)}))", CAP)).toBe(
    "D:(XA;;FX;;;WD;(Member_of {SID(BA)}))",
  );
});
test("windowsModulePath lists only built-in and machine-wide module folders", () => {
  expect(windowsModulePath({ SystemRoot: "C:\\Windows", ProgramFiles: "C:\\Program Files" })).toBe(
    "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\Modules;C:\\Program Files\\WindowsPowerShell\\Modules",
  );
});

test("windowsSystemPath keeps only Windows/Program Files PATH entries", () => {
  const path = windowsSystemPath({
    SystemRoot: "C:\\Windows",
    ProgramFiles: "C:\\Program Files",
    PATH: [
      "C:\\Windows\\System32",
      "C:\\Program Files\\Git\\cmd\\",
      "C:\\Users\\me\\AppData\\Local\\bin",
      "C:\\Program Files\\nodejs",
      "%USERPROFILE%\\x",
      "D:\\tools",
    ].join(";"),
  });
  expect(path).toEqual([
    "C:\\Windows\\System32",
    "C:\\Windows\\System32\\WindowsPowerShell\\v1.0",
    "C:\\Program Files\\Git\\cmd",
    "C:\\Program Files\\nodejs",
  ]);
  // Idempotent: the launcher recomputes it from the PATH it was given.
  expect(
    windowsSystemPath({ SystemRoot: "C:\\Windows", ProgramFiles: "C:\\Program Files", PATH: path.join(";") }),
  ).toEqual(path);
});
test("Windows scratch lives under C:\\phantom-sandbox, per user and persona", () => {
  const sid = "S-1-5-21-1-2-3-1001";
  const a = windowsScratchTarget("C:", sid, "C:\\Users\\me\\.local\\share\\phantombot\\personas\\megan");
  expect(a).toMatch(/^C:\\phantom-sandbox\\S-1-5-21-1-2-3-1001\\megan-[0-9a-f]{12}$/);
  // Same name, different persona dir (CLI vs desktop engine): different folder.
  expect(windowsScratchTarget("C:\\", sid, "C:\\Users\\me\\AppData\\Roaming\\PhantomChat\\megan")).not.toBe(a);
  expect(windowsScratchTarget("C:", sid, "C:\\x\\a b&c")).toMatch(/\\a_b_c-[0-9a-f]{12}$/);
});
test("Windows scratch ACLs: private user folder, unlistable shared root", () => {
  const cap = "S-1-15-3-1024-9";
  const root = sandboxRootSddl(cap);
  expect(root.startsWith("D:P")).toBe(true); // nothing inherited from C:\
  expect(root).toContain("(A;;0x1200a4;;;AU)"); // add a folder, no listing
  expect(root).not.toMatch(/;;;AU\)[^]*;;;AU\)/);
  expect(root).toContain(`(A;;0x100080;;;${cap})`);
  const user = sandboxUserSddl("S-1-5-21-7", cap);
  expect(user).toBe(
    `D:P(A;OICI;FA;;;S-1-5-21-7)(A;OICI;FA;;;SY)(A;OICI;FA;;;BA)(A;;0x100080;;;${cap})`,
  );
  expect(user).not.toMatch(/;;;(AU|WD|BU)\)/);
});
test("drive letters: free ones only, Z first, never A-C", () => {
  const used = (1 << 2) | (1 << 25) | (1 << 3); // C:, Z:, D:
  const free = freeDriveLetters(used);
  expect(free[0]).toBe("Y:");
  expect(free).not.toContain("Z:");
  expect(free).not.toContain("D:");
  expect(free).not.toContain("C:");
  expect(free).not.toContain("A:");
  expect(free.length).toBe(21);
});
test("only drive letters left on deleted sandbox workspaces count as stale", () => {
  const gone = () => false;
  expect(isStaleSandboxDrive(["\\??\\C:\\phantom-sandbox\\S-1\\m-1\\c\\t"], gone)).toBe(true);
  expect(isStaleSandboxDrive(["\\??\\C:\\Users\\me\\p\\scratch\\untrusted\\c\\t"], gone)).toBe(true);
  expect(isStaleSandboxDrive(["\\??\\C:\\phantom-sandbox\\S-1\\m-1\\c\\t"], () => true)).toBe(false);
  expect(isStaleSandboxDrive(["\\??\\D:\\data"], gone)).toBe(false); // the user's own subst
  expect(isStaleSandboxDrive(["\\Device\\HarddiskVolume3"], gone)).toBe(false);
  expect(isStaleSandboxDrive(["\\??\\C:\\phantom-sandbox\\a", "\\??\\C:\\x"], gone)).toBe(false);
});
test.skipIf(win)("prepareWindowsUntrustedScratch is a no-op off Windows", () => {
  const agent = fresh();
  expect(prepareWindowsUntrustedScratch(join(agent, "scratch", "untrusted"), agent)).toBe(false);
});

/** A persona's untrusted turn workspace, as provisionScratch + the session make it. */
const windowsTurn = (persona: string) => {
  const agent = join(fresh(), persona);
  const root = join(agent, "scratch", "untrusted");
  expect(prepareWindowsUntrustedScratch(root, agent)).toBe(true);
  const real = realpathSync(root);
  expect(real.toLowerCase()).toContain("\\phantom-sandbox\\");
  dirs.push(real);
  const workspace = join(root, "conv", "turn");
  mkdirSync(workspace, { recursive: true });
  // Idempotent once linked.
  expect(prepareWindowsUntrustedScratch(root, agent)).toBe(true);
  const ws = realpathSync(workspace);
  dirs.push(ws); // its AppContainer profile is keyed on this path
  return ws;
};
const shellProbe =
  'powershell -NoProfile -NonInteractive -Command "Set-Content ps.txt ok; (Get-Location).Path"' +
  " && whoami && cd && dir /b";
const gitProbe =
  "git init -q r && cd r && git status --short" +
  " && git -c user.email=t@t -c user.name=t commit -q --allow-empty -m x && git log --oneline";
// git runs inside the AppContainer only where NUL is open to it (26H2+).
const toolProbe = nulOpen ? `${shellProbe} && ${gitProbe}` : shellProbe;
test("NUL DACL check matches real Windows builds", () => {
  // Windows 11 26H2 (build 26300): AppContainers may open NUL.
  expect(
    nulGrantsAppContainers(
      "D:(A;;0x1201bf;;;WD)(A;;FA;;;SY)(A;;FA;;;BA)(A;;0x1200a9;;;RC)(A;;0x1201bf;;;AC)(A;;0x1201bf;;;S-1-15-2-2)S:(ML;;NW;;;LW)",
    ),
  ).toBe(true);
  // Server 2022 (20348) / 2025 (26100): Everyone only, which excludes AppContainers.
  expect(
    nulGrantsAppContainers("D:(A;;0x1201bf;;;WD)(A;;FA;;;SY)(A;;FA;;;BA)(A;;0x1200a9;;;RC)S:AI(ML;;NW;;;LW)"),
  ).toBe(false);
  expect(nulGrantsAppContainers("D:(A;;0x1200a9;;;AC)")).toBe(false); // read-only
  expect(nulGrantsAppContainers("D:(D;;FA;;;AC)")).toBe(false); // deny ACE
  expect(nulGrantsAppContainers("")).toBe(false);
});
test.skipIf(!win)(
  "Windows without NUL for AppContainers fails open: git runs unconfined in the scratch",
  async () => {
    const workspace = windowsTurn("megan");
    setWindowsAppContainerUsableForTests(false);
    try {
      const run = await runSandbox(workspace, `${gitProbe} && cd`);
      expect(run.exitCode, run.output).toBe(0);
      expect(run.output.toLowerCase()).toContain(workspace.toLowerCase());
      const env = await runSandbox(workspace, "echo %PHANTOMBOT_SCRATCH%");
      expect(env.output.trim().toLowerCase()).toBe(workspace.toLowerCase());
    } finally {
      setWindowsAppContainerUsableForTests(true);
    }
  },
  90000,
);
test.skipIf(!win)(
  "Windows sandbox runs PowerShell, git and user32 tools in the workspace",
  async () => {
    const workspace = windowsTurn("megan"),
      outside = fresh();
    writeFileSync(join(outside, "secret"), "host-secret");
    const run = await runSandbox(workspace, toolProbe);
    expect(run.exitCode, run.output).toBe(0);
    expect(run.output).toContain("ps.txt");
    expect(readFileSync(join(workspace, "ps.txt"), "utf8")).toContain("ok");
    // The parent grants are attributes-only: siblings stay unreadable.
    const sibling = await runSandbox(workspace, `type ${quote(join(outside, "secret"))}`);
    expect(sibling.output).not.toContain("host-secret");
    const list = await runSandbox(workspace, `dir /b ${quote(outside)}`);
    expect(list.output).not.toContain("secret");
  },
  90000,
);
test.skipIf(!win)(
  "two Windows personas sandbox at once without seeing each other",
  async () => {
    const a = windowsTurn("lena"),
      b = windowsTurn("kai");
    writeFileSync(join(a, "mine"), "lena-secret");
    const [ra, rb] = await Promise.all([runSandbox(a, toolProbe), runSandbox(b, toolProbe)]);
    expect(ra.exitCode, ra.output).toBe(0);
    expect(rb.exitCode, rb.output).toBe(0);
    const peek = await runSandbox(b, `type ${quote(join(a, "mine"))}`);
    expect(peek.output).not.toContain("lena-secret");
    const list = await runSandbox(b, `dir /b ${quote(join(a, ".."))}`);
    expect(list.output).not.toContain("turn");
  },
  120000,
);
