import { afterEach, expect, test } from "bun:test";
import {
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runSandbox, sandboxEnvironment } from "../src/security/sandbox.ts";
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
const quote = (s: string) => (win ? `"${s}"` : `'${s.replace(/'/g, "'\\''")}'`);
const cat = (p: string) => `${win ? "type" : "cat"} ${quote(p)}`;
test("sandbox has only an explicit clean environment", () => {
  const env = sandboxEnvironment("/work");
  expect(env).not.toHaveProperty("GITHUB_TOKEN");
  expect(env).not.toHaveProperty("PHANTOMBOT_ESCORT");
  expect(env).not.toHaveProperty("NODE_OPTIONS");
  expect(env).not.toHaveProperty("HTTP_PROXY");
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
test("real sockets cannot reach a host API", async () => {
  const workspace = fresh();
  let calls = 0;
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: () => {
      calls++;
      return new Response("host-secret");
    },
  });
  try {
    const r = await runSandbox(
      workspace,
      `${win ? "curl.exe" : "curl"} --connect-timeout 1 --max-time 2 http://127.0.0.1:${server.port}/`,
    );
    expect(r.exitCode).not.toBe(0);
    expect(calls).toBe(0);
    expect(r.output).not.toContain("host-secret");
  } finally {
    await server.stop(true);
  }
}, 15000);
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
