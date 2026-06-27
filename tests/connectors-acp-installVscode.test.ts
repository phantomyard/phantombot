/**
 * VS Code extension auto-install tests — pure, vscode-free, no real `code` CLI.
 *
 * The whole install flow is exercised through the injectable `VscodeDeps` seam
 * so a single suite can drive linux / darwin / win32 path resolution and every
 * branch of idempotency + error isolation deterministically. Nothing here
 * touches the real filesystem or spawns a process (mirrors PR1's binaryResolver
 * / acpClient pure tests).
 *
 * Covers:
 *   - version comparison (parseVersion edge cases via compareVersions)
 *   - `code --list-extensions --show-versions` parsing (findInstalledVersion)
 *   - `code` CLI resolution across linux / darwin / win32 + the PATH-vs-absolute
 *     fallback, and the "code CLI missing" → not-detected fallback
 *   - idempotent skip when already current (>= bundled), install when missing,
 *     upgrade when older
 *   - error isolation: install command failure and a throwing dep never escape
 *   - the read-only checkVscode path used by doctor --no-repair (no mutation)
 */

import { describe, expect, test } from "bun:test";

import {
  checkVscode,
  codeCliName,
  compareVersions,
  findInstalledVersion,
  installVscode,
  resolveCodeCli,
  type RunResult,
  type VscodeDeps,
} from "../src/connectors/acp/installVscode.ts";

/** A recording fake of the `code` CLI + fs seam. */
interface FakeOpts {
  platform?: string;
  /** Map of "<cmd> <args.join(' ')>" → RunResult; absent ⇒ spawn-failure. */
  responses?: Record<string, RunResult>;
  /** Paths that "exist" on disk for the absolute-candidate fallback. */
  existing?: string[];
  env?: Record<string, string | undefined>;
  home?: string;
  tmp?: string;
}

function makeDeps(o: FakeOpts = {}) {
  const writes: Array<{ path: string; bytes: Uint8Array }> = [];
  const cleaned: string[] = [];
  const runs: Array<{ cmd: string; args: string[] }> = [];
  const existing = new Set(o.existing ?? []);
  const responses = o.responses ?? {};

  const deps: VscodeDeps = {
    platform: o.platform ?? "linux",
    env: o.env ?? {},
    homedir: () => o.home ?? "/home/dev",
    tmpdir: () => o.tmp ?? "/tmp",
    exists: (p) => existing.has(p),
    writeFile: (path, bytes) => writes.push({ path, bytes }),
    cleanup: (path) => cleaned.push(path),
    runCode: (cmd, args) => {
      runs.push({ cmd, args });
      const key = `${cmd} ${args.join(" ")}`;
      if (key in responses) return responses[key];
      // Default: a successful --install-extension (the common happy path) unless
      // a test explicitly overrides it via `responses`. Everything else is a
      // spawn-failure (undefined) so detection/idempotency branches stay strict.
      if (args[0] === "--install-extension") return OK();
      return undefined;
    },
  };
  return { deps, writes, cleaned, runs };
}

const OK = (stdout = "", stderr = ""): RunResult => ({ code: 0, stdout, stderr });
const FAIL = (code = 1, stderr = "boom"): RunResult => ({ code, stdout: "", stderr });

const ID = "phantomyard.phantombot-vscode";

describe("compareVersions", () => {
  test("orders major/minor/patch", () => {
    expect(compareVersions("1.0.0", "1.0.1")).toBeLessThan(0);
    expect(compareVersions("1.2.0", "1.1.9")).toBeGreaterThan(0);
    expect(compareVersions("2.0.0", "1.9.9")).toBeGreaterThan(0);
    expect(compareVersions("1.2.3", "1.2.3")).toBe(0);
  });
  test("missing parts default to 0", () => {
    expect(compareVersions("1.2", "1.2.0")).toBe(0);
    expect(compareVersions("1", "1.0.1")).toBeLessThan(0);
  });
  test("tolerates pre-release / garbage suffixes", () => {
    expect(compareVersions("1.2.3-pre", "1.2.3")).toBe(0);
    expect(compareVersions("1.2.x", "1.2.0")).toBe(0);
  });
});

describe("findInstalledVersion", () => {
  const list = `ms-python.python@2024.1.0\n${ID}@0.1.0\nesbenp.prettier-vscode@10.0.0\n`;
  test("finds the target id's version", () => {
    expect(findInstalledVersion(list, ID)).toBe("0.1.0");
  });
  test("case-insensitive on id (VS Code lower-cases ids)", () => {
    expect(findInstalledVersion(`PhantomYard.PhantomBot-VSCode@9.9.9`, ID)).toBe(
      "9.9.9",
    );
  });
  test("returns undefined when absent or empty", () => {
    expect(findInstalledVersion("other.ext@1.0.0", ID)).toBeUndefined();
    expect(findInstalledVersion("", ID)).toBeUndefined();
  });
});

describe("codeCliName / resolveCodeCli platform switch", () => {
  test("cli name is code.cmd on win32, code elsewhere", () => {
    expect(codeCliName("win32")).toBe("code.cmd");
    expect(codeCliName("linux")).toBe("code");
    expect(codeCliName("darwin")).toBe("code");
  });

  test("linux: bare `code` on PATH resolves", () => {
    const { deps } = makeDeps({
      platform: "linux",
      responses: { "code --version": OK("1.90.0") },
    });
    expect(resolveCodeCli(deps)).toBe("code");
  });

  test("darwin: falls back to the .app absolute path when PATH lacks code", () => {
    const appBin =
      "/Applications/Visual Studio Code.app/Contents/Resources/app/bin/code";
    const { deps } = makeDeps({
      platform: "darwin",
      existing: [appBin],
      responses: { [`${appBin} --version`]: OK("1.90.0") },
    });
    expect(resolveCodeCli(deps)).toBe(appBin);
  });

  test("win32: falls back to LOCALAPPDATA install path (code.cmd)", () => {
    const local = "C:\\Users\\dev\\AppData\\Local";
    const cmd = `${local}\\Programs\\Microsoft VS Code\\bin\\code.cmd`;
    const { deps } = makeDeps({
      platform: "win32",
      env: { LOCALAPPDATA: local },
      existing: [cmd],
      responses: { [`${cmd} --version`]: OK("1.90.0") },
    });
    expect(resolveCodeCli(deps)).toBe(cmd);
  });

  test("no code anywhere → undefined (the missing-CLI signal)", () => {
    const { deps } = makeDeps({ platform: "linux" }); // no responses, nothing exists
    expect(resolveCodeCli(deps)).toBeUndefined();
  });
});

describe("installVscode idempotency + actions", () => {
  test("code CLI missing → not-detected, nothing written, no throw", () => {
    const { deps, writes } = makeDeps({ platform: "linux" });
    const r = installVscode({ deps });
    expect(r.action).toBe("not-detected");
    expect(r.code).toBe(0);
    expect(r.message).toContain("VS Code CLI not found");
    expect(writes).toHaveLength(0);
  });

  test("already current (installed >= bundled) → skip, no write", () => {
    const { deps, writes, runs } = makeDeps({
      platform: "linux",
      responses: {
        "code --version": OK("1.90.0"),
        "code --list-extensions --show-versions": OK(`${ID}@1.0.0\n`),
      },
    });
    const r = installVscode({ deps, bundledVersion: "1.0.0", extensionId: ID });
    expect(r.action).toBe("current");
    expect(writes).toHaveLength(0);
    // Never ran --install-extension.
    expect(runs.some((x) => x.args.includes("--install-extension"))).toBe(false);
  });

  test("newer installed than bundled → still current (no downgrade)", () => {
    const { deps } = makeDeps({
      platform: "linux",
      responses: {
        "code --version": OK("1.90.0"),
        "code --list-extensions --show-versions": OK(`${ID}@2.0.0\n`),
      },
    });
    const r = installVscode({ deps, bundledVersion: "1.0.0", extensionId: ID });
    expect(r.action).toBe("current");
  });

  test("missing extension → installs (writes vsix, runs --install-extension --force, cleans up)", () => {
    const { deps, writes, cleaned, runs } = makeDeps({
      platform: "linux",
      responses: {
        "code --version": OK("1.90.0"),
        "code --list-extensions --show-versions": OK("other.ext@1.0.0\n"),
        // --install-extension answered OK by makeDeps' default.
      },
    });

    const r = installVscode({ deps, bundledVersion: "0.1.0", extensionId: ID });
    // Installed with --force (idempotent reinstall flag).
    expect(
      runs.some(
        (x) => x.args[0] === "--install-extension" && x.args.includes("--force"),
      ),
    ).toBe(true);
    expect(r.action).toBe("installed");
    expect(r.code).toBe(0);
    expect(writes).toHaveLength(1);
    expect(writes[0]!.path).toBe("/tmp/phantombot-phantombot-vscode-0.1.0.vsix");
    expect(writes[0]!.bytes.byteLength).toBeGreaterThan(0); // real vsix bytes
    expect(cleaned).toContain("/tmp/phantombot-phantombot-vscode-0.1.0.vsix");
  });

  test("older installed → updated", () => {
    const { deps } = makeDeps({
      platform: "linux",
      responses: {
        "code --version": OK("1.90.0"),
        "code --list-extensions --show-versions": OK(`${ID}@0.0.9\n`),
        // --install-extension answered OK by makeDeps' default.
      },
    });
    const r = installVscode({ deps, bundledVersion: "1.0.0", extensionId: ID });
    expect(r.action).toBe("updated");
    expect(r.installedVersion).toBe("0.0.9");
  });

  test("win32: vsix staged with a Windows temp path", () => {
    const { deps, writes } = makeDeps({
      platform: "win32",
      env: { LOCALAPPDATA: "C:\\Users\\dev\\AppData\\Local" },
      home: "C:\\Users\\dev",
      tmp: "C:\\Users\\dev\\AppData\\Local\\Temp",
      responses: {
        // On win32 the resolved CLI is `code.cmd`, so the probe + list calls
        // are keyed on `code.cmd`, not bare `code`.
        "code.cmd --version": OK("1.90.0"),
        "code.cmd --list-extensions --show-versions": OK(""),
      },
    });
    const r = installVscode({ deps, bundledVersion: "0.1.0", extensionId: ID });
    expect(r.action).toBe("installed");
    const staged = writes[0]!.path;
    expect(staged).toContain("\\"); // win32 separators
    expect(staged.endsWith("phantombot-phantombot-vscode-0.1.0.vsix")).toBe(true);
  });

  test("`code --install-extension` failure → error (code 1), not a throw", () => {
    const { deps } = makeDeps({
      platform: "linux",
      responses: {
        "code --version": OK("1.90.0"),
        "code --list-extensions --show-versions": OK(""),
        "code --install-extension /tmp/phantombot-phantombot-vscode-0.1.0.vsix --force":
          FAIL(1, "no marketplace"),
      },
    });
    const r = installVscode({ deps, bundledVersion: "0.1.0", extensionId: ID });
    expect(r.action).toBe("error");
    expect(r.code).toBe(1);
    expect(r.message).toContain("install-extension");
  });

  test("a throwing dep is caught → error result, never escapes", () => {
    const { deps } = makeDeps({ platform: "linux" });
    deps.runCode = () => {
      throw new Error("kaboom");
    };
    const r = installVscode({ deps });
    // resolveCodeCli calls runCode which throws; resolveCodeCli has no try/catch,
    // so installVscode's outer catch turns it into an error result — never escapes.
    expect(r.action).toBe("error");
    expect(r.code).toBe(1);
    expect(r.message).toContain("kaboom");
  });
});

describe("checkVscode (read-only, doctor --no-repair)", () => {
  test("never writes, never installs — reports needs-install as `installed` action", () => {
    const { deps, writes, runs } = makeDeps({
      platform: "linux",
      responses: {
        "code --version": OK("1.90.0"),
        "code --list-extensions --show-versions": OK(""),
      },
    });
    const r = checkVscode({ deps, bundledVersion: "0.1.0", extensionId: ID });
    expect(r.action).toBe("installed"); // "would install"
    expect(writes).toHaveLength(0);
    expect(runs.some((x) => x.args[0] === "--install-extension")).toBe(false);
  });

  test("current installation reports current", () => {
    const { deps } = makeDeps({
      platform: "linux",
      responses: {
        "code --version": OK("1.90.0"),
        "code --list-extensions --show-versions": OK(`${ID}@1.0.0`),
      },
    });
    const r = checkVscode({ deps, bundledVersion: "1.0.0", extensionId: ID });
    expect(r.action).toBe("current");
  });

  test("no code CLI → not-detected", () => {
    const { deps } = makeDeps({ platform: "linux" });
    expect(checkVscode({ deps }).action).toBe("not-detected");
  });
});
