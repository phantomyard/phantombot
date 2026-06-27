/**
 * `phantombot acp install vscode` backend — install the first-party VS Code
 * extension from the .vsix bundled in the phantombot binary.
 *
 * Unlike Zed (which is a settings.json merge — VS Code has NO native ACP and NO
 * settings-only agent registration), VS Code's integration is a real extension.
 * So "register phantombot into VS Code" means: ship OUR built extension (the one
 * added in #211) as a .vsix embedded in the binary, stamp it to disk, and run
 * `code --install-extension <vsix>` — but ONLY when it's missing or older than
 * the bundled version. This installs OUR extension; it has zero marketplace and
 * zero third-party dependency.
 *
 * Everything here is pure + dependency-injected so the platform/path/version/
 * idempotency logic runs under `bun test` with no `vscode` and no real `code`
 * CLI on the box (mirrors PR1's binaryResolver/acpClient). The only impure bits
 * are funnelled through the injected `Deps` seam.
 *
 * HARD RULES:
 *   - Detection-gated: never attempt install unless the `code` CLI is actually
 *     resolvable. No `code` ⇒ a clear "VS Code CLI not found" doctor/log line,
 *     never a hang and never a throw.
 *   - Idempotent + version-aware: compare the installed extension version (from
 *     `code --list-extensions --show-versions`) to the bundled version; only
 *     install when missing or strictly older.
 *   - Error-isolated: this never throws out of its top-level entry point. The
 *     reconcile loop in autoInstall.ts also wraps it, but we belt-and-suspenders
 *     here too.
 *   - win32-ready: a 3-way platform switch (linux/darwin/win32) resolves the
 *     `code` CLI and the temp .vsix path correctly on each.
 */

import { posix, win32 } from "node:path";

import {
  VSCODE_EXTENSION_ID,
  VSCODE_EXTENSION_VERSION,
  VSCODE_VSIX_BASE64,
  VSCODE_VSIX_FILENAME,
} from "../../lib/vscodeExtensionAsset.generated.ts";

export type Platform = "linux" | "darwin" | "win32" | string;

/** Result of running the `code` CLI: exit code + captured stdout/stderr. */
export interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

/**
 * Injected impure seams. In production these are wired to node:child_process /
 * node:fs / node:os in `defaultVscodeDeps()`. Tests pass fakes so the whole
 * install flow runs deterministically with no `code`, no fs, no spawning.
 */
export interface VscodeDeps {
  platform: Platform;
  env: Record<string, string | undefined>;
  /** os.homedir(). */
  homedir(): string;
  /** os.tmpdir(). */
  tmpdir(): string;
  /** Existence probe for resolving the `code` CLI on PATH / install dirs. */
  exists(p: string): boolean;
  /** Write the decoded .vsix bytes to disk (recursive mkdir of parent). */
  writeFile(path: string, bytes: Uint8Array): void;
  /** Best-effort cleanup of the staged .vsix (never throws). */
  cleanup(path: string): void;
  /** Run `code <args>` and capture output. Returns undefined if spawn fails. */
  runCode(cmd: string, args: string[]): RunResult | undefined;
}

export type VscodeInstallAction =
  /** `code` CLI not found — VS Code not installed / not on PATH. Nothing done. */
  | "not-detected"
  /** Installed extension is already >= bundled version. No install run. */
  | "current"
  /** Extension was missing; we installed it. */
  | "installed"
  /** An older version was installed; we upgraded it. */
  | "updated"
  /** `code --install-extension` failed (surfaced, not thrown). */
  | "error";

export interface VscodeInstallResult {
  /** 0 success/no-op, 1 a real failure. */
  code: number;
  action: VscodeInstallAction;
  /** The bundled extension version we install. */
  bundledVersion: string;
  /** The version found installed before we ran, if any. */
  installedVersion?: string;
  /** The resolved `code` CLI command, if found. */
  codeCommand?: string;
  /** Human-readable detail (the doctor/log line). */
  message: string;
}

/** Join path segments using the TARGET platform's rules (not the host's). */
function joinFor(platform: Platform, ...segments: string[]): string {
  return platform === "win32" ? win32.join(...segments) : posix.join(...segments);
}

/** The `code` CLI executable name for the platform. */
export function codeCliName(platform: Platform): string {
  return platform === "win32" ? "code.cmd" : "code";
}

/**
 * Parse `a.b.c` into numeric parts. Non-numeric / pre-release suffixes are
 * truncated at the first non-digit run so `1.2.3-pre` ≈ `1.2.3`. Missing parts
 * default to 0 so `1.2` compares as `1.2.0`.
 */
function parseVersion(v: string): [number, number, number] {
  const parts = v
    .trim()
    .split(".")
    .slice(0, 3)
    .map((p) => {
      const m = /^\d+/.exec(p.trim());
      return m ? Number(m[0]) : 0;
    });
  return [parts[0] ?? 0, parts[1] ?? 0, parts[2] ?? 0];
}

/**
 * Compare two semver-ish versions. Returns <0 if a<b, 0 if equal, >0 if a>b.
 * Tolerant of garbage (treats unparseable segments as 0) so a weird installed
 * version never throws — at worst we re-install, which is safe + idempotent.
 */
export function compareVersions(a: string, b: string): number {
  const pa = parseVersion(a);
  const pb = parseVersion(b);
  for (let i = 0; i < 3; i++) {
    if (pa[i]! !== pb[i]!) return pa[i]! - pb[i]!;
  }
  return 0;
}

/**
 * Find the installed version of `extensionId` in the lines emitted by
 * `code --list-extensions --show-versions` (format: `publisher.name@1.2.3`,
 * one per line). Case-insensitive on the id (VS Code lower-cases ids).
 */
export function findInstalledVersion(
  listOutput: string,
  extensionId: string,
): string | undefined {
  const want = extensionId.toLowerCase();
  for (const rawLine of listOutput.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line.length === 0) continue;
    const at = line.lastIndexOf("@");
    if (at <= 0) continue;
    const id = line.slice(0, at).toLowerCase();
    const ver = line.slice(at + 1).trim();
    if (id === want && ver.length > 0) return ver;
  }
  return undefined;
}

/**
 * Candidate absolute locations for the `code` CLI, per platform — used only as
 * a fallback when bare `code` isn't on PATH (the resolver tries PATH first via
 * the injected `runCode`/`exists`). These mirror the default install layouts.
 */
function codeInstallCandidates(deps: VscodeDeps): string[] {
  const { platform, env, homedir } = deps;
  if (platform === "win32") {
    const local = env.LOCALAPPDATA;
    const out: string[] = [];
    if (local) {
      out.push(
        joinFor(platform, local, "Programs", "Microsoft VS Code", "bin", "code.cmd"),
      );
    }
    out.push(
      joinFor(platform, "C:\\Program Files", "Microsoft VS Code", "bin", "code.cmd"),
      joinFor(
        platform,
        "C:\\Program Files (x86)",
        "Microsoft VS Code",
        "bin",
        "code.cmd",
      ),
    );
    return out;
  }
  if (platform === "darwin") {
    return [
      "/Applications/Visual Studio Code.app/Contents/Resources/app/bin/code",
      joinFor(
        platform,
        homedir(),
        "Applications",
        "Visual Studio Code.app",
        "Contents",
        "Resources",
        "app",
        "bin",
        "code",
      ),
    ];
  }
  // linux + anything else
  return [
    "/usr/bin/code",
    "/usr/local/bin/code",
    "/snap/bin/code",
    joinFor(platform, homedir(), ".local", "bin", "code"),
  ];
}

/**
 * Resolve a runnable `code` command, or undefined if VS Code's CLI isn't
 * present. Strategy: try the bare CLI name first (relies on PATH via the
 * injected runner's spawn) by probing `code --version`; if that fails, fall
 * back to well-known absolute install paths. Pure w.r.t. the injected deps.
 */
export function resolveCodeCli(deps: VscodeDeps): string | undefined {
  const bare = codeCliName(deps.platform);
  // PATH probe: a successful `--version` is the authoritative "it's runnable".
  const probe = deps.runCode(bare, ["--version"]);
  if (probe && probe.code === 0) return bare;

  // Fallback: absolute candidates that exist on disk AND answer --version.
  for (const cand of codeInstallCandidates(deps)) {
    if (!deps.exists(cand)) continue;
    const r = deps.runCode(cand, ["--version"]);
    if (r && r.code === 0) return cand;
  }
  return undefined;
}

export interface InstallVscodeOptions {
  deps?: VscodeDeps;
  /** Override the bundled version (tests). Default: the embedded constant. */
  bundledVersion?: string;
  /** Override the extension id (tests). Default: the embedded constant. */
  extensionId?: string;
}

/**
 * Read-only status check: resolve the `code` CLI and compare the installed
 * extension version to the bundled one WITHOUT installing anything. Used by
 * `doctor --no-repair` so drift is diagnosable without mutating the machine.
 * NEVER throws, NEVER writes. Actions are limited to not-detected / current /
 * needs-install / needs-update / error.
 */
export function checkVscode(
  options: InstallVscodeOptions = {},
): VscodeInstallResult {
  const deps = options.deps ?? defaultVscodeDeps();
  const bundledVersion = options.bundledVersion ?? VSCODE_EXTENSION_VERSION;
  const extensionId = options.extensionId ?? VSCODE_EXTENSION_ID;

  try {
    const codeCommand = resolveCodeCli(deps);
    if (!codeCommand) {
      return {
        code: 0,
        action: "not-detected",
        bundledVersion,
        message: "VS Code CLI not found — nothing to check.",
      };
    }
    const list = deps.runCode(codeCommand, [
      "--list-extensions",
      "--show-versions",
    ]);
    const installedVersion = list
      ? findInstalledVersion(list.stdout, extensionId)
      : undefined;
    if (
      installedVersion !== undefined &&
      compareVersions(installedVersion, bundledVersion) >= 0
    ) {
      return {
        code: 0,
        action: "current",
        bundledVersion,
        installedVersion,
        codeCommand,
        message: `VS Code extension ${extensionId}@${installedVersion} current.`,
      };
    }
    // Missing or older — report as the action a repair WOULD take.
    return {
      code: 0,
      action: installedVersion === undefined ? "installed" : "updated",
      bundledVersion,
      installedVersion,
      codeCommand,
      message:
        installedVersion === undefined
          ? `VS Code extension ${extensionId} not installed (bundled ${bundledVersion}).`
          : `VS Code extension ${extensionId} ${installedVersion} older than bundled ${bundledVersion}.`,
    };
  } catch (e) {
    return {
      code: 1,
      action: "error",
      bundledVersion,
      message: `VS Code extension check failed: ${(e as Error).message}`,
    };
  }
}

/**
 * Idempotently install/upgrade the bundled phantombot VS Code extension via the
 * `code` CLI. Pure orchestration over the injected deps; NEVER throws.
 */
export function installVscode(
  options: InstallVscodeOptions = {},
): VscodeInstallResult {
  const deps = options.deps ?? defaultVscodeDeps();
  const bundledVersion = options.bundledVersion ?? VSCODE_EXTENSION_VERSION;
  const extensionId = options.extensionId ?? VSCODE_EXTENSION_ID;

  try {
    // ── Detection gate: no usable `code` CLI ⇒ do nothing, say so clearly. ──
    const codeCommand = resolveCodeCli(deps);
    if (!codeCommand) {
      return {
        code: 0,
        action: "not-detected",
        bundledVersion,
        message:
          "VS Code CLI not found (`code` not on PATH or in a known install " +
          "location) — skipping VS Code extension install. Install VS Code and " +
          'run "Shell Command: Install \'code\' command in PATH" to enable it.',
      };
    }

    // ── Idempotency / version gate. ──
    const list = deps.runCode(codeCommand, [
      "--list-extensions",
      "--show-versions",
    ]);
    const installedVersion = list
      ? findInstalledVersion(list.stdout, extensionId)
      : undefined;

    if (
      installedVersion !== undefined &&
      compareVersions(installedVersion, bundledVersion) >= 0
    ) {
      return {
        code: 0,
        action: "current",
        bundledVersion,
        installedVersion,
        codeCommand,
        message: `VS Code extension ${extensionId}@${installedVersion} already current (bundled ${bundledVersion}).`,
      };
    }

    // ── Stage the bundled .vsix to a temp file, then install it. ──
    const vsixPath = joinFor(
      deps.platform,
      deps.tmpdir(),
      `phantombot-${VSCODE_VSIX_FILENAME}`,
    );
    const bytes = Uint8Array.from(Buffer.from(VSCODE_VSIX_BASE64, "base64"));
    deps.writeFile(vsixPath, bytes);

    try {
      const r = deps.runCode(codeCommand, ["--install-extension", vsixPath, "--force"]);
      if (!r || r.code !== 0) {
        return {
          code: 1,
          action: "error",
          bundledVersion,
          installedVersion,
          codeCommand,
          message:
            `\`code --install-extension\` failed for ${extensionId}@${bundledVersion}` +
            (r ? ` (exit ${r.code}): ${(r.stderr || r.stdout).trim()}` : " (could not spawn `code`)"),
        };
      }
    } finally {
      deps.cleanup(vsixPath);
    }

    const wasUpgrade = installedVersion !== undefined;
    return {
      code: 0,
      action: wasUpgrade ? "updated" : "installed",
      bundledVersion,
      installedVersion,
      codeCommand,
      message: wasUpgrade
        ? `Upgraded VS Code extension ${extensionId} ${installedVersion} → ${bundledVersion}.`
        : `Installed VS Code extension ${extensionId}@${bundledVersion}.`,
    };
  } catch (e) {
    // Belt-and-suspenders: the entry point never throws.
    return {
      code: 1,
      action: "error",
      bundledVersion,
      message: `VS Code extension install failed: ${(e as Error).message}`,
    };
  }
}

/** Production deps: real child_process / fs / os. */
export function defaultVscodeDeps(): VscodeDeps {
  // Lazy requires keep this module import-cheap and side-effect free for tests
  // that only exercise the pure helpers.
  const cp = require("node:child_process") as typeof import("node:child_process");
  const fs = require("node:fs") as typeof import("node:fs");
  const os = require("node:os") as typeof import("node:os");
  const nodePath = require("node:path") as typeof import("node:path");

  return {
    platform: process.platform,
    env: process.env,
    homedir: () => os.homedir(),
    tmpdir: () => os.tmpdir(),
    exists: (p) => fs.existsSync(p),
    writeFile: (p, bytes) => {
      fs.mkdirSync(nodePath.dirname(p), { recursive: true });
      fs.writeFileSync(p, bytes);
    },
    cleanup: (p) => {
      try {
        fs.rmSync(p, { force: true });
      } catch {
        /* best effort */
      }
    },
    runCode: (cmd, args) => {
      try {
        const res = cp.spawnSync(cmd, args, {
          encoding: "utf8",
          // On win32 `code.cmd` requires a shell to execute.
          shell: process.platform === "win32",
          timeout: 60_000,
        });
        if (res.error) return undefined;
        return {
          code: res.status ?? 1,
          stdout: res.stdout ?? "",
          stderr: res.stderr ?? "",
        };
      } catch {
        return undefined;
      }
    },
  };
}
