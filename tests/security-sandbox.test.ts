import { afterEach, expect, test } from "bun:test";
import {
  mkdirSync,
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
} from "../src/security/sandbox.ts";
import { deleteWindowsProfile } from "../src/security/windows.ts";
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
test("defaultSandboxHostPaths grants tool dirs and only public SSH keys", () => {
  const home = fresh();
  mkdirSync(join(home, ".ssh"));
  writeFileSync(join(home, ".ssh", "id_ed25519"), "PRIVATE");
  writeFileSync(join(home, ".ssh", "id_ed25519.pub"), "ssh-ed25519 PUB");
  const paths = defaultSandboxHostPaths(home);
  expect(paths.read).toEqual([
    join(home, ".local", "bin"),
    join(home, "tools"),
    join(home, ".ssh", "id_ed25519.pub"),
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
        "cat ~/tools/script.txt; echo",
        "cat ~/.ssh/id_x.pub; echo",
        `cat ${quote(join(home, ".ssh", "id_x"))} || echo private-hidden`,
        `cat ${quote(join(home, ".bashrc"))} || echo home-hidden`,
        `touch ${quote(join(home, "tools", "new"))} || echo tools-readonly`,
        "touch here && echo workspace-writable",
      ].join("\n"),
      { hostPaths: { ...defaultSandboxHostPaths(home), home } },
    );
    expect(r.output).toContain("tool-ran");
    expect(r.output).toContain("tool-file");
    expect(r.output).toContain("PUBKEY");
    expect(r.output).toContain("private-hidden");
    expect(r.output).not.toContain("PRIVATE-KEY");
    expect(r.output).toContain("home-hidden");
    expect(r.output).not.toContain("HOME-SECRET");
    expect(r.output).toContain("tools-readonly");
    expect(r.output).toContain("workspace-writable");
  },
  20000,
);
