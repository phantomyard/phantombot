import { socketPair, receiveListener, superviseProc } from "./linux-notify.ts";
import {
  closeSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
} from "node:fs";
import { spawn } from "node:child_process";
import { homedir, tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative } from "node:path";
import { windowsAppContainerUsable, windowsSandbox } from "./windows.ts";
import { log } from "../lib/logger.ts";
import { linuxSandbox } from "./linux.ts";
import { phantombotSelfCommand } from "../lib/embeddedPi.ts";

export const SANDBOX_SUBCOMMAND = "__sandbox_exec";
/** Runtime-set (PHANTOMBOT_ is a reserved secret prefix): host read-only paths. */
export const ENV_SANDBOX_READ = "PHANTOMBOT_SANDBOX_READ";

/** Host paths a sandboxed command may READ (never write). */
export interface SandboxHostPaths {
  /** Files or directories, absolute. Missing ones are skipped. */
  read: string[];
  /** Directories appended to PATH (each must also be in `read`). */
  path: string[];
  /**
   * The real home. `read` entries below it are linked at the same relative
   * path in the sandbox's neutral HOME, so `~/.ssh/id.pub` works inside.
   */
  home?: string;
}

/**
 * The user's own tool logins, read-only, so `gh` and `git` authenticate in a
 * sandboxed turn exactly as they do in a trusted one (no extra vault names).
 * `~/.config` is mirrored too, per child: see sandboxConfigEntries.
 */
export const SANDBOX_TOOL_LOGINS = [[".gitconfig"], [".git-credentials"]];

/** `~/.config` children that are never mirrored: the runtime's own state. */
export const SANDBOX_HIDDEN_CONFIG = new Set(["phantombot", "phantomchat"]);

/** Files only a Chromium/Electron profile has (cookies, web storage). */
const BROWSER_MARKERS = [
  "Local State",
  "Cookies",
  join("Network", "Cookies"),
  "Local Storage",
  "Session Storage",
];

/**
 * A Chromium/Electron profile (browsers, Electron apps), at the folder itself
 * or one level down (`BraveSoftware/Brave-Browser`): cookies are live web
 * sessions, which are not in the vault, so they stay hidden.
 */
function isBrowserProfile(dir: string): boolean {
  const marked = (d: string) => BROWSER_MARKERS.some((n) => existsSync(join(d, n)));
  if (marked(dir)) return true;
  try {
    return readdirSync(dir, { withFileTypes: true }).some(
      (e) => e.isDirectory() && marked(join(dir, e.name)),
    );
  } catch {
    return false; // a file, or unreadable: nothing to hide inside
  }
}

/**
 * Every child of `~/.config`, read-only, except the runtime's own folders and
 * browser profiles. Enumerated rather than listed, so a new tool's login
 * (gog, gcloud, helm, ...) works without anyone maintaining a list. Each
 * child is its own read rule because Landlock cannot hide a folder inside an
 * allowed one.
 */
export function sandboxConfigEntries(home: string): string[] {
  const config = join(home, ".config");
  let names: string[] = [];
  try {
    names = readdirSync(config);
  } catch {
    return [];
  }
  return names
    .filter((n) => !SANDBOX_HIDDEN_CONFIG.has(n.toLowerCase()))
    .map((n) => join(config, n))
    .filter((p) => !isBrowserProfile(p))
    .sort();
}

/**
 * The owner's model (GHSA-w7w8): the only WRITABLE directory is the turn's
 * scratch workspace. Read-only: ~/.local/bin, SSH PUBLIC keys, the tool
 * logins above and ~/.config (minus the runtime's own folders and browser
 * profiles). Everything else in the home folder, including every persona
 * folder (so identity.json, the vault, prompts, config and policy), stays
 * unreachable.
 */
export function defaultSandboxHostPaths(home = homedir()): SandboxHostPaths {
  const bin = join(home, ".local", "bin"),
    ssh = join(home, ".ssh");
  let pub: string[] = [];
  try {
    pub = readdirSync(ssh)
      .filter((n) => n.endsWith(".pub"))
      .map((n) => join(ssh, n));
  } catch {
    /* no ~/.ssh */
  }
  const logins = [
    ...SANDBOX_TOOL_LOGINS.map((p) => join(home, ...p)),
    ...sandboxConfigEntries(home),
  ];
  return { read: [bin, ...pub, ...logins], path: [bin], home };
}

function encodeReadPaths(paths: string[]): string {
  for (const p of paths)
    if (!isAbsolute(p) || /[\x00-\x1f]/.test(p))
      throw new Error("invalid sandbox read path");
  return paths.join("\n");
}
const LISTENER_DEADLINE_MS = 15_000;
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
  const readPaths = (process.env[ENV_SANDBOX_READ] ?? "")
    .split("\n")
    .filter((p) => isAbsolute(p));
  process.chdir(realpathSync(workspace));
  return linuxSandbox(
    realpathSync(workspace),
    realpathSync(executable),
    argv,
    readPaths,
  );
}

function seatbeltString(s: string): string {
  if (/[\x00-\x1f]/.test(s)) throw new Error("invalid sandbox path");
  return JSON.stringify(s);
}
export function seatbeltProfile(
  workspace: string,
  readPaths: string[] = [],
): string {
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
; dyld ignition opens the root directory before resolving its system cache.
; A literal directory grant does not allow reading any of its children.
(allow file-read* (literal "/"))
(allow signal (target self))
(allow mach-lookup (global-name "com.apple.logd") (global-name "com.apple.system.logger") (global-name "com.apple.system.opendirectoryd.libinfo"))
(allow file-read* file-map-executable ${runtimePaths})
(allow file-read* (literal "/dev/random") (literal "/dev/urandom") (literal "/private/etc/localtime") (literal "/private/etc/passwd"))
(allow file-read* file-write* (literal "/dev/null"))
(allow file* (subpath ${seatbeltString(workspace)}))${readPaths.map((p) => `\n(allow file-read* file-map-executable (subpath ${seatbeltString(p)}))`).join("")}
; GHSA-w7w8: untrusted turns need the network (git, gh, APIs) and DNS/TLS.
(allow network*)
(allow mach-lookup (global-name "com.apple.dnssd.service") (global-name "com.apple.trustd") (global-name "com.apple.trustd.agent") (global-name "com.apple.SecurityServer") (global-name "com.apple.SystemConfiguration.configd") (global-name "com.apple.SystemConfiguration.DNSConfiguration"))
(allow file-read* (literal "/private/etc/hosts") (literal "/private/etc/resolv.conf") (literal "/private/var/run/resolv.conf") (literal "/private/etc/services") (literal "/private/etc/protocols") (literal "/private/etc/group") (subpath "/private/etc/ssl") (subpath "/Library/Keychains") (subpath "/usr/local") (subpath "/opt/homebrew"))
; /usr/bin/git and friends are xcrun shims into the developer tools.
(allow file-read* file-map-executable (subpath "/Library/Developer/CommandLineTools") (regex #"^/Applications/Xcode[^/]*\.app/") (literal "/private/var/db/xcode_select_link") (subpath "/private/var/select"))`;
}

/**
 * Neutral launcher home outside the workspace. The launcher resolves global
 * runtime config (bunfig from HOME and XDG_CONFIG_HOME) before confinement, so
 * a model-planted config must not be reachable through those lookups; the
 * confined child cannot write here either, so it holds no cross-run state.
 */
export function neutralSandboxHome(): string {
  return mkdtempSync(join(tmpdir(), "pb-sandbox-home-"));
}

export function discardSandboxHome(home: string): void {
  rmSync(home, { recursive: true, force: true });
}

/**
 * Names a secret may NOT take inside the sandbox: the fixed variables below,
 * and anything a loader or runtime acts on. The Linux/Windows launcher runs
 * before confinement with this env, so a loader variable would act outside
 * the boundary. Everything else in the persona vault passes (GHSA-w7w8:
 * untrusted turns get the whole vault; the judge and escort are the guard).
 */
const SECRET_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
const RESERVED_SECRET =
  /^(?:LD_|DYLD_|BUN_|NODE_|PHANTOMBOT_|GIT_CONFIG|XDG_)|^(?:PATH|HOME|USERPROFILE|TMPDIR|TMP|TEMP|OPENSSL_CONF|CI|GIT_TERMINAL_PROMPT|LANG|LOCALAPPDATA|APPDATA|SystemRoot|ComSpec|PATHEXT|BASH_ENV|ENV|SHELLOPTS|PS4|IFS)$/i;
export function sandboxSecretEnv(
  secrets: Record<string, string | undefined> | undefined,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(secrets ?? {}))
    if (
      typeof v === "string" &&
      !v.includes("\0") &&
      SECRET_NAME.test(k) &&
      !RESERVED_SECRET.test(k)
    )
      out[k] = v;
  return out;
}

/**
 * The turn context a trusted turn's tools see (envBootstrap.withPersonaEnv),
 * runtime-supplied, never model input. `session` lets `phantombot` inside the
 * sandbox reach memory and notify through the session (escort-judged).
 */
export interface SandboxContext {
  persona?: string;
  conversation?: string;
  turnId?: string;
  session?: string;
}
export const SANDBOX_CONTEXT_ENV = {
  persona: "PHANTOMBOT_PERSONA",
  conversation: "PHANTOMBOT_CONVERSATION",
  turnId: "PHANTOMBOT_TURN_ID",
  session: "PHANTOMBOT_SECURITY_SESSION",
} as const;
export function sandboxContextFromEnv(env: NodeJS.ProcessEnv): SandboxContext {
  const out: SandboxContext = {};
  for (const [k, name] of Object.entries(SANDBOX_CONTEXT_ENV))
    if (env[name]) out[k as keyof SandboxContext] = env[name];
  return out;
}

/**
 * The fixed variables, plus the persona's secrets when the runtime passes
 * them. No ambient proxy, loader, shell-startup or engine variable survives,
 * and no secret can override a fixed variable.
 */
export function sandboxEnvironment(
  workspace: string,
  home: string,
  secrets?: Record<string, string | undefined>,
  extraPath: string[] = [],
  context: SandboxContext = {},
): NodeJS.ProcessEnv {
  const sep = process.platform === "win32" ? ";" : ":";
  const ctx: Record<string, string> = {};
  for (const [k, name] of Object.entries(SANDBOX_CONTEXT_ENV)) {
    const v = context[k as keyof SandboxContext];
    if (typeof v === "string" && v && !/[\x00\n\r]/.test(v)) ctx[name] = v;
  }
  const gitGlobal = join(home, ".gitconfig");
  const extra = extraPath.length ? sep + extraPath.join(sep) : "";
  return {
    ...sandboxSecretEnv(secrets),
    ...ctx,
    PHANTOMBOT_SCRATCH: workspace,
    PATH:
      process.platform === "win32"
        ? `${windowsSystemPath(process.env).join(";")};${join(workspace, ".tools")}${extra}`
        : `${process.platform === "darwin" ? "/opt/homebrew/bin:/usr/local/bin:" : ""}/usr/bin:/bin:/usr/sbin:/sbin:${join(workspace, ".tools")}${extra}`,
    HOME: home,
    USERPROFILE: home,
    TMPDIR: join(workspace, ".tmp"),
    TMP: join(workspace, ".tmp"),
    TEMP: join(workspace, ".tmp"),
    BUN_INSTALL_CACHE_DIR: join(workspace, ".bun", "install", "cache"),
    XDG_CACHE_HOME: join(home, ".cache"),
    XDG_CONFIG_HOME: join(home, ".config"),
    OPENSSL_CONF: process.platform === "win32" ? "NUL" : "/dev/null",
    GIT_CONFIG_NOSYSTEM: "1",
    // The user's ~/.gitconfig when it is mirrored read-only (tool logins).
    GIT_CONFIG_GLOBAL: existsSync(gitGlobal)
      ? gitGlobal
      : process.platform === "win32"
        ? "NUL"
        : "/dev/null",
    CI: "1",
    GIT_TERMINAL_PROMPT: "0",
    LANG: "C.UTF-8",
    ...(process.platform === "win32"
      ? {
          LOCALAPPDATA: process.env.LOCALAPPDATA ?? join(home, ".local"),
          APPDATA: join(home, ".config"),
          SystemRoot: process.env.SystemRoot ?? "C:\\Windows",
          ComSpec: `${process.env.SystemRoot ?? "C:\\Windows"}\\System32\\cmd.exe`,
          // Standard machine variables PowerShell/.NET and installers expect.
          ...windowsMachineEnv(process.env),
          // Without it Windows PowerShell falls back to the machine module path,
          // which can list folders the AppContainer cannot read (CI runners'
          // C:\Modules), and then core cmdlets like Set-Content fail to load.
          PSModulePath: windowsModulePath(process.env),
          // Files the elevated host made are owned by Administrators, not the
          // sandbox's user, so git refuses them as "dubious ownership". The
          // workspace is the sandbox's own disposable directory.
          GIT_CONFIG_COUNT: "1",
          GIT_CONFIG_KEY_0: "safe.directory",
          GIT_CONFIG_VALUE_0: "*",
          // The workspace is a mapped drive letter; git resolves it to the
          // real path and would refuse to cross that "filesystem" boundary.
          GIT_DISCOVERY_ACROSS_FILESYSTEM: "1",
        }
      : {}),
  };
}

/**
 * Windows PATH inside the AppContainer: System32, Windows PowerShell, and the
 * host PATH entries under the Windows or Program Files folders (git, gh,
 * pwsh, node installs). Those are readable to ALL APPLICATION PACKAGES by
 * default; per-user folders are not, so they are left out. The launcher
 * recomputes this from the PATH it was given, so it must be idempotent.
 */
export function windowsSystemPath(env: NodeJS.ProcessEnv): string[] {
  const root = env.SystemRoot ?? "C:\\Windows";
  const bases = [root, env.ProgramFiles, env["ProgramFiles(x86)"], env.ProgramW6432]
    .filter((b): b is string => !!b)
    .map((b) => b.replace(/[\\/]+$/, "").toLowerCase() + "\\");
  const out = [`${root}\\System32`, `${root}\\System32\\WindowsPowerShell\\v1.0`];
  const seen = new Set(out.map((p) => p.toLowerCase()));
  for (const raw of (env.PATH ?? env.Path ?? "").split(";")) {
    const entry = raw.trim().replace(/[\\/]+$/, "");
    const key = entry.toLowerCase();
    if (!entry || seen.has(key) || /[%"\n\r]/.test(entry)) continue;
    if (!bases.some((b) => key.startsWith(b))) continue;
    seen.add(key);
    out.push(entry);
  }
  return out;
}

const WINDOWS_MACHINE_ENV = [
  "SystemDrive",
  "windir",
  "ProgramData",
  "ALLUSERSPROFILE",
  "ProgramFiles",
  "ProgramFiles(x86)",
  "ProgramW6432",
  "CommonProgramFiles",
  "CommonProgramFiles(x86)",
  "CommonProgramW6432",
  "PUBLIC",
  "COMPUTERNAME",
  "OS",
  "NUMBER_OF_PROCESSORS",
  "PROCESSOR_ARCHITECTURE",
  "PROCESSOR_IDENTIFIER",
  "PROCESSOR_LEVEL",
  "PROCESSOR_REVISION",
  "PATHEXT",
] as const;
/** Windows PowerShell's built-in and machine-wide module folders only. */
export function windowsModulePath(env: NodeJS.ProcessEnv): string {
  const root = env.SystemRoot ?? "C:\\Windows";
  const out = [`${root}\\System32\\WindowsPowerShell\\v1.0\\Modules`];
  if (env.ProgramFiles) out.push(`${env.ProgramFiles}\\WindowsPowerShell\\Modules`);
  return out.join(";");
}

function windowsMachineEnv(env: NodeJS.ProcessEnv): Record<string, string> {
  const out: Record<string, string> = {};
  for (const key of WINDOWS_MACHINE_ENV) {
    const v = env[key];
    if (typeof v === "string" && v && !/[\x00\n\r]/.test(v)) out[key] = v;
  }
  return out;
}

/** Arbitrary repository code executes only below this boundary. */
export async function runSandbox(
  workspace: string,
  command: string,
  opts: {
    signal?: AbortSignal;
    timeoutMs?: number;
    stdin?: Uint8Array;
    /** Persona secrets for the sandboxed command (runtime-supplied, never model input). */
    secrets?: Record<string, string | undefined>;
    /**
     * Read-only host paths (runtime-supplied, never model input). Linux and
     * macOS only: on Windows they would need ACL changes on host folders.
     */
    hostPaths?: SandboxHostPaths;
    /** Turn context (persona, conversation, turn, session); runtime-supplied. */
    context?: SandboxContext;
    /** Test/runtime host self-exec override; never from model input. */ launcher?: string[];
  } = {},
): Promise<SandboxResult> {
  workspace = realpathSync(workspace);
  const readable =
    process.platform === "win32" ? [] : resolveReadPaths(opts.hostPaths?.read);
  const extraPath =
    process.platform === "win32"
      ? []
      : resolveReadPaths(opts.hostPaths?.path).filter((p) =>
          readable.includes(p),
        );
  for (const path of [".tmp", ".cache", ".config", ".tools"])
    mkdirSync(join(workspace, path), { recursive: true, mode: 0o700 });
  let invocation: string[];
  let unconfined = false;
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
      seatbeltProfile(workspace, readable),
      "/bin/sh",
      "-c",
      command,
    ];
  else if (process.platform === "win32" && !windowsAppContainerUsable()) {
    // Fail open (never deny service): this Windows build's NUL device is
    // closed to AppContainers, so git and most tools could not start inside
    // one. Run in the scratch folder with the sandbox env, unconfined; the
    // threat judge still screened the turn.
    windowsUnconfinedNotice();
    unconfined = true;
    const cmd = `${process.env.SystemRoot ?? "C:\\Windows"}\\System32\\cmd.exe`;
    invocation = [cmd, `/d /s /c "${command}"`];
  } else if (process.platform === "win32")
    invocation = [
      ...(opts.launcher ?? phantombotSelfCommand()),
      SANDBOX_SUBCOMMAND,
      workspace,
      command,
    ];
  else throw new Error("sandbox unavailable on this platform");
  if (opts.signal?.aborted) throw new Error("sandbox cancelled");
  const home = neutralSandboxHome();
  if (readable.length && opts.hostPaths?.home)
    linkHomePaths(home, opts.hostPaths.home, opts.hostPaths.read);
  const sockets = process.platform === "linux" ? socketPair() : undefined;
  const child = spawn(invocation[0]!, invocation.slice(1), {
    // The launcher itself must not discover bunfig/preloads from the repo.
    cwd:
      process.platform === "darwin" || unconfined
        ? workspace
        : process.platform === "win32"
          ? `${process.env.SystemRoot ?? "C:\\Windows"}\\System32`
          : "/",
    env: {
      ...(unconfined
        ? sandboxEnvironment(workspace, home, opts.secrets, extraPath, opts.context)
        : launcherEnvironment(workspace, home, opts.secrets, extraPath, opts.context)),
      ...(process.platform === "linux" && readable.length
        ? { [ENV_SANDBOX_READ]: encodeReadPaths(readable) }
        : {}),
    },
    stdio: [
      opts.stdin ? "pipe" : "ignore",
      "pipe",
      "pipe",
      ...(sockets ? [sockets[1]] : []),
    ],
    detached: process.platform !== "win32",
    windowsHide: true,
    windowsVerbatimArguments: unconfined,
  });
  let supervision: Promise<void> | undefined;
  let supervisorStopped = false;
  let listenerPending = !!sockets;
  // A child that never hands over its listener can never finish (its trapped
  // opens wait on us), so fail fast instead of hanging until the turn timeout.
  const listenerDeadline = Date.now() + LISTENER_DEADLINE_MS;
  const listenerTimer = sockets
    ? setInterval(() => {
        if (!listenerPending) return;
        if (Date.now() > listenerDeadline) {
          read(Buffer.from("sandbox unavailable: supervisor listener not received\n"));
          stop();
          return;
        }
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
    discardSandboxHome(home);
  }
}

let unconfinedNoticeShown = false;
function windowsUnconfinedNotice(): void {
  if (unconfinedNoticeShown) return;
  unconfinedNoticeShown = true;
  log.warn(
    "Windows sandbox off: this Windows build blocks AppContainers from the NUL device (git cannot run); untrusted commands run unconfined in their scratch folder. Windows 11 26H2 (build 26300) or later runs them sandboxed.",
  );
}

/** AppContainer resolution uses the caller's LocalAppData, never the child's. */
function launcherEnvironment(
  workspace: string,
  home: string,
  secrets?: Record<string, string | undefined>,
  extraPath: string[] = [],
  context?: SandboxContext,
): NodeJS.ProcessEnv {
  const env = sandboxEnvironment(workspace, home, secrets, extraPath, context);
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

/** Resolved, existing, absolute paths only (a symlink grants its target). */
function resolveReadPaths(paths: string[] | undefined): string[] {
  const out: string[] = [];
  for (const p of paths ?? []) {
    if (!isAbsolute(p)) continue;
    try {
      statSync(p);
      const r = realpathSync(p);
      if (!out.includes(r)) out.push(r);
    } catch {
      /* missing: skipped */
    }
  }
  return out;
}

/** `~/x` inside = the granted host path; only for paths below the real home. */
function linkHomePaths(neutral: string, realHome: string, paths: string[]): void {
  for (const p of paths) {
    const rel = relative(realHome, p);
    if (!rel || rel.startsWith("..") || isAbsolute(rel)) continue;
    try {
      statSync(p);
      const at = join(neutral, rel);
      mkdirSync(dirname(at), { recursive: true, mode: 0o700 });
      symlinkSync(p, at);
    } catch {
      /* missing or not linkable: the path just is not mirrored */
    }
  }
}
