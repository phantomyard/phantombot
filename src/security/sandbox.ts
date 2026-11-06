import { socketPair, receiveListener, superviseProc } from "./linux-notify.ts";
import { closeSync } from "node:fs";
import { spawn } from "node:child_process";
import { mkdirSync, realpathSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { windowsSandbox } from "./windows.ts";
import { linuxSandbox } from "./linux.ts";
import { phantombotSelfCommand } from "../lib/embeddedPi.ts";

export const SANDBOX_SUBCOMMAND = "__sandbox_exec";
const MAX_OUTPUT = 512 * 1024;
export interface SandboxResult {
  exitCode: number;
  output: string;
  truncated: boolean;
}

/** Used only by the clean self-exec child, never in an engine's host process. */
export function sandboxExecChild(args: string[]): never {
  const [workspace, executable, ...argv] = args;
  if (
    !workspace ||
    !executable ||
    !isAbsolute(workspace) ||
    (process.platform !== "win32" && !isAbsolute(executable))
  )
    throw new Error("invalid sandbox launch");
  if (process.platform === "win32")
    process.exit(windowsSandbox(realpathSync(workspace), executable));
  if (process.platform !== "linux")
    throw new Error("unsupported sandbox launcher");
  process.chdir(realpathSync(workspace));
  return linuxSandbox(realpathSync(workspace), realpathSync(executable), argv);
}

function seatbeltString(s: string): string {
  if (/[\x00-\x1f]/.test(s)) throw new Error("invalid sandbox path");
  return JSON.stringify(s);
}
export function seatbeltProfile(workspace: string): string {
  const system = [
    "/System/Library",
    "/System/Cryptexes",
    "/System/Volumes/Preboot/Cryptexes",
    "/usr/bin",
    "/usr/sbin",
    "/usr/lib",
    "/usr/libexec",
    "/usr/share",
    "/bin",
    "/sbin",
    "/Library/Apple",
    "/private/var/db/dyld",
  ];
  const runtimePaths = system
    .map((p) => `(subpath ${seatbeltString(p)})`)
    .join(" ");
  return `(version 1)(deny default)
(allow process-exec process-fork sysctl-read)
(allow process-info-pidinfo (target self))
(allow file-read-metadata)
(allow signal (target self))
(allow mach-lookup (global-name "com.apple.logd") (global-name "com.apple.system.logger") (global-name "com.apple.system.opendirectoryd.libinfo"))
(allow file-read* file-map-executable ${runtimePaths})
(allow file-read* (literal "/dev/random") (literal "/dev/urandom") (literal "/private/etc/localtime") (literal "/private/etc/passwd"))
(allow file-read* file-write* (literal "/dev/null"))
(allow file* (subpath ${seatbeltString(workspace)}))`;
}

/** No ambient credential, proxy, loader, shell-startup or engine variable survives. */
export function sandboxEnvironment(workspace: string): NodeJS.ProcessEnv {
  return {
    PATH:
      process.platform === "win32"
        ? `${process.env.SystemRoot ?? "C:\\Windows"}\\System32;${join(workspace, ".tools")}`
        : `/usr/bin:/bin:/usr/sbin:/sbin:${join(workspace, ".tools")}`,
    HOME: workspace,
    USERPROFILE: workspace,
    TMPDIR: join(workspace, ".tmp"),
    TMP: join(workspace, ".tmp"),
    TEMP: join(workspace, ".tmp"),
    BUN_INSTALL_CACHE_DIR: join(workspace, ".bun", "install", "cache"),
    XDG_CACHE_HOME: join(workspace, ".cache"),
    XDG_CONFIG_HOME: join(workspace, ".config"),
    OPENSSL_CONF: process.platform === "win32" ? "NUL" : "/dev/null",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: process.platform === "win32" ? "NUL" : "/dev/null",
    CI: "1",
    GIT_TERMINAL_PROMPT: "0",
    LANG: "C.UTF-8",
    ...(process.platform === "win32"
      ? {
          LOCALAPPDATA: process.env.LOCALAPPDATA ?? join(workspace, ".local"),
          APPDATA: join(workspace, ".config"),
          SystemRoot: process.env.SystemRoot ?? "C:\\Windows",
          ComSpec: `${process.env.SystemRoot ?? "C:\\Windows"}\\System32\\cmd.exe`,
        }
      : {}),
  };
}

/** Arbitrary repository code executes only below this boundary. */
export async function runSandbox(
  workspace: string,
  command: string,
  opts: {
    signal?: AbortSignal;
    timeoutMs?: number;
    stdin?: Uint8Array;
    /** Test/runtime host self-exec override; never from model input. */ launcher?: string[];
  } = {},
): Promise<SandboxResult> {
  workspace = realpathSync(workspace);
  for (const path of [".tmp", ".cache", ".config", ".tools"])
    mkdirSync(join(workspace, path), { recursive: true, mode: 0o700 });
  let invocation: string[];
  if (process.platform === "linux")
    invocation = [
      ...(opts.launcher ?? phantombotSelfCommand()),
      SANDBOX_SUBCOMMAND,
      workspace,
      "/bin/sh",
      "-c",
      command,
    ];
  else if (process.platform === "darwin")
    invocation = [
      "/usr/bin/sandbox-exec",
      "-p",
      seatbeltProfile(workspace),
      "/bin/sh",
      "-c",
      command,
    ];
  else if (process.platform === "win32")
    invocation = [
      ...(opts.launcher ?? phantombotSelfCommand()),
      SANDBOX_SUBCOMMAND,
      workspace,
      command,
    ];
  else throw new Error("sandbox unavailable on this platform");
  if (opts.signal?.aborted) throw new Error("sandbox cancelled");
  const sockets = process.platform === "linux" ? socketPair() : undefined;
  const child = spawn(invocation[0]!, invocation.slice(1), {
    // The launcher itself must not discover bunfig/preloads from the repo.
    cwd:
      process.platform === "darwin"
        ? workspace
        : process.platform === "win32"
          ? `${process.env.SystemRoot ?? "C:\\Windows"}\\System32`
          : "/",
    env: launcherEnvironment(workspace),
    stdio: [
      opts.stdin ? "pipe" : "ignore",
      "pipe",
      "pipe",
      ...(sockets ? [sockets[1]] : []),
    ],
    detached: process.platform !== "win32",
    windowsHide: true,
  });
  let supervision: Promise<void> | undefined;
  let supervisorStopped = false;
  let listenerPending = !!sockets;
  const listenerTimer = sockets
    ? setInterval(() => {
        if (!listenerPending) return;
        try {
          const fd = receiveListener(sockets[0]);
          if (fd === undefined) return;
          listenerPending = false;
          closeSync(sockets[0]);
          clearInterval(listenerTimer);
          supervision = superviseProc(fd, () => supervisorStopped).catch(() =>
            stop(),
          );
        } catch {
          stop();
        }
      }, 2)
    : undefined;
  if (sockets) closeSync(sockets[1]);
  const stop = () => {
    try {
      if (process.platform !== "win32" && child.pid)
        process.kill(-child.pid, "SIGKILL");
      else child.kill("SIGKILL");
    } catch {
      /* already gone */
    }
  };
  let output = Buffer.alloc(0),
    truncated = false;
  const read = (data: Buffer) => {
    const left = MAX_OUTPUT - output.length;
    if (data.length > left) truncated = true;
    if (left > 0) output = Buffer.concat([output, data.subarray(0, left)]);
  };
  child.stdin?.on("error", () => {});
  if (opts.stdin) child.stdin?.end(opts.stdin);
  child.stdout!.on("data", read);
  child.stderr!.on("data", read);
  child.once("exit", stop);
  const timer = setTimeout(
    stop,
    Math.min(120_000, Math.max(1, opts.timeoutMs ?? 120_000)),
  );
  opts.signal?.addEventListener("abort", stop, { once: true });
  try {
    const exitCode = await new Promise<number>((resolve, reject) => {
      child.once("error", reject);
      child.once("close", (code) => resolve(code ?? 137));
    });
    return { exitCode, output: output.toString("utf8"), truncated };
  } finally {
    if (listenerTimer) clearInterval(listenerTimer);
    if (sockets && listenerPending) closeSync(sockets[0]);
    clearTimeout(timer);
    opts.signal?.removeEventListener("abort", stop);
    stop();
    supervisorStopped = true;
    await supervision;
  }
}

/** AppContainer resolution uses the caller's LocalAppData, never the child's. */
function launcherEnvironment(workspace: string): NodeJS.ProcessEnv {
  const env = sandboxEnvironment(workspace);
  if (process.platform === "win32") {
    for (const key of [
      "LOCALAPPDATA",
      "APPDATA",
      "USERPROFILE",
      "SystemDrive",
      "windir",
    ]) {
      if (process.env[key]) env[key] = process.env[key];
    }
  }
  return env;
}
