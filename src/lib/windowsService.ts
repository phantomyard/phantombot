/** Windows SCM backend for the always-on phantombot daemon. */

import type { WriteSink } from "./io.ts";
import type { ServiceControl } from "./systemd.ts";

export const PHANTOMBOT_SERVICE_NAME = "Phantombot";
export const PHANTOMBOT_SERVICE_DISPLAY_NAME = "Phantombot Agent";

export interface ScResult { exitCode: number; stdout: string; stderr: string }
export interface ScRunner { run(args: string[]): Promise<ScResult> }

export class BunScRunner implements ScRunner {
  async run(args: string[]): Promise<ScResult> {
    const proc = Bun.spawn(["sc.exe", ...args], { stdout: "pipe", stderr: "pipe", windowsHide: true });
    const [exitCode, stdout, stderr] = await Promise.all([
      proc.exited,
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ]);
    return { exitCode, stdout, stderr };
  }
}

export interface WindowsServiceOptions {
  hostPath: string;
  binPath: string;
  /** `DOMAIN\\user` or `.\\user`; SCM stores the password securely. */
  user: string;
  password: string;
  sc: ScRunner;
  out?: WriteSink;
  err?: WriteSink;
}

function serviceBinaryPath(hostPath: string, binPath: string): string {
  return `"${hostPath}" "${binPath}" run`;
}

export async function installWindowsService(opts: WindowsServiceOptions): Promise<boolean> {
  const out = opts.out ?? process.stdout;
  const err = opts.err ?? process.stderr;
  const binPath = serviceBinaryPath(opts.hostPath, opts.binPath);
  const existing = await opts.sc.run(["query", PHANTOMBOT_SERVICE_NAME]);
  if (existing.exitCode === 0) {
    const changed = await opts.sc.run(["config", PHANTOMBOT_SERVICE_NAME, `binPath= ${binPath}`, "start= auto", `obj= ${opts.user}`, `password= ${opts.password}`]);
    if (changed.exitCode !== 0) {
      err.write(`sc.exe config ${PHANTOMBOT_SERVICE_NAME} failed: ${changed.stderr || changed.stdout}\n`);
      return false;
    }
  } else {
    const created = await opts.sc.run(["create", PHANTOMBOT_SERVICE_NAME, `binPath= ${binPath}`, `DisplayName= ${PHANTOMBOT_SERVICE_DISPLAY_NAME}`, "start= auto", `obj= ${opts.user}`, `password= ${opts.password}`]);
    if (created.exitCode !== 0) {
      err.write(`sc.exe create ${PHANTOMBOT_SERVICE_NAME} failed: ${created.stderr || created.stdout}\n`);
      return false;
    }
  }
  const started = await opts.sc.run(["start", PHANTOMBOT_SERVICE_NAME]);
  if (started.exitCode !== 0 && !/already running/i.test(started.stderr + started.stdout)) {
    err.write(`sc.exe start ${PHANTOMBOT_SERVICE_NAME} failed: ${started.stderr || started.stdout}\n`);
    return false;
  }
  out.write(`Windows service ${PHANTOMBOT_SERVICE_NAME} installed and started.\n`);
  return true;
}

export async function uninstallWindowsService(opts: Pick<WindowsServiceOptions, "sc" | "out" | "err">): Promise<void> {
  const out = opts.out ?? process.stdout;
  const err = opts.err ?? process.stderr;
  await opts.sc.run(["stop", PHANTOMBOT_SERVICE_NAME]);
  const removed = await opts.sc.run(["delete", PHANTOMBOT_SERVICE_NAME]);
  if (removed.exitCode !== 0 && !/does not exist|1060/i.test(removed.stderr + removed.stdout)) {
    err.write(`sc.exe delete ${PHANTOMBOT_SERVICE_NAME} returned ${removed.exitCode}: ${removed.stderr || removed.stdout}\n`);
  }
  out.write(`Windows service ${PHANTOMBOT_SERVICE_NAME} removed.\n`);
}

export function defaultWindowsServiceHostPath(dataDir: string): string {
  return `${dataDir.replace(/[\\/]$/, "")}\\phantombot-service.exe`;
}

export function defaultWindowsServiceControl(sc: ScRunner = new BunScRunner()): ServiceControl {
  const result = async (verb: string): Promise<{ ok: boolean; stderr?: string }> => {
    const r = await sc.run([verb, PHANTOMBOT_SERVICE_NAME]);
    return r.exitCode === 0
      ? { ok: true }
      : { ok: false, stderr: r.stderr.trim() || r.stdout.trim() || `sc.exe ${verb} failed` };
  };
  return {
    async isActive() {
      const r = await sc.run(["query", PHANTOMBOT_SERVICE_NAME]);
      return r.exitCode === 0 && /STATE\s*:\s*\d+\s+RUNNING/i.test(r.stdout);
    },
    start: () => result("start"),
    stop: () => result("stop"),
    restart: async () => {
      const stopped = await result("stop");
      if (!stopped.ok && !/1062|not started/i.test(stopped.stderr ?? "")) return stopped;
      return result("start");
    },
    async rerenderUnitIfStale() { return { rerendered: false }; },
  };
}
