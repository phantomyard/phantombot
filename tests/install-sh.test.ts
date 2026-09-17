/**
 * install.sh's checklist, tested as a checklist.
 *
 * The "Verifying" and service steps used to print a green tick unconditionally
 * — the verify block was a no-op `if` and the service install ran under
 * `>/dev/null 2>&1 || true`. Both would have reported success for a zero-byte
 * download or a service that never registered, which is strictly worse than
 * not checking, so each step gets a test that the tick tracks reality.
 */
import { describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const INSTALL_SH = join(import.meta.dir, "..", "install.sh");

/** Write an executable stand-in for the phantombot binary. */
function fakeBin(dir: string, body: string): string {
  const p = join(dir, "fake-phantombot");
  writeFileSync(p, `#!/bin/sh\n${body}\n`);
  chmodSync(p, 0o755);
  return p;
}

async function runInstaller(
  devBin: string,
  installDir: string,
  home: string = mkdtempSync(join(tmpdir(), "pb-install-home-")),
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  // install.sh appends a PATH line to $HOME/.bashrc (or .zshrc). Every run
  // gets its own HOME/SHELL/ZDOTDIR so a test can never write the developer's
  // real rc file (it did, twice: 2026-09-11 and 2026-09-17).
  const proc = Bun.spawn(["sh", INSTALL_SH], {
    env: {
      ...process.env,
      HOME: home,
      ZDOTDIR: home,
      SHELL: "/bin/bash",
      PHANTOMBOT_DEV_BIN: devBin,
      PHANTOMBOT_INSTALL_DIR: installDir,
      PHANTOMBOT_SKIP_TUI: "1",
    },
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const stdout = await new Response(proc.stdout).text();
  const stderr = await new Response(proc.stderr).text();
  return { stdout, stderr, exitCode: await proc.exited };
}

describe("install.sh checklist", () => {
  test("Verifying runs the binary and fails red when it does not work", async () => {
    const dir = mkdtempSync(join(tmpdir(), "pb-install-bad-"));
    // The shape a truncated download or wrong-arch asset takes: the file is
    // there and executable, and it cannot run.
    const bin = fakeBin(dir, 'echo "not an executable for this arch" >&2\nexit 1');
    const r = await runInstaller(bin, join(dir, "bin"));

    expect(r.stdout).toContain("Verifying");
    expect(r.stdout).not.toContain("Installation completed");
    expect(r.stderr).toContain("--version failed");
    expect(r.exitCode).toBe(1);
  });

  test("Verifying reports the version it actually got back", async () => {
    const dir = mkdtempSync(join(tmpdir(), "pb-install-ok-"));
    const bin = fakeBin(dir, 'if [ "$1" = "--version" ]; then echo "phantombot 9.9.9"; fi\nexit 0');
    const r = await runInstaller(bin, join(dir, "bin"));

    expect(r.stdout).toContain("phantombot 9.9.9");
    expect(r.stdout).toContain("Installation completed successfully.");
    expect(r.exitCode).toBe(0);
  });

  test("a failed service install is surfaced, not swallowed", async () => {
    const dir = mkdtempSync(join(tmpdir(), "pb-install-svc-"));
    // Verifies fine; the service registration is what fails.
    const bin = fakeBin(
      dir,
      'if [ "$1" = "--version" ]; then echo "phantombot 9.9.9"; exit 0; fi\n' +
        'if [ "$1" = "install" ]; then echo "systemctl: unit refused" >&2; exit 3; fi\n' +
        "exit 0",
    );
    const r = await runInstaller(bin, join(dir, "bin"));

    expect(r.stderr).toContain("service install failed (exit 3)");
    expect(r.stderr).toContain("systemctl: unit refused");
    // The binary IS usable, so the installer must say so rather than claim
    // an unqualified success or pretend nothing happened.
    expect(r.stdout).not.toContain("Installation completed successfully.");
    expect(r.stdout).toContain("the background service is not");
  });

  test("an install dir containing spaces still verifies and installs", async () => {
    // `exec $PB_BIN` relied on word splitting, so a PHANTOMBOT_INSTALL_DIR
    // with a space in it split the binary path into two words and every call
    // site broke (review, Lena). The dev-fallback's `bun src/index.ts` is the
    // only thing that may split, and it now lives in $PB_ARGS.
    const dir = mkdtempSync(join(tmpdir(), "pb-install-space-"));
    const bin = fakeBin(dir, 'if [ "$1" = "--version" ]; then echo "phantombot 9.9.9"; fi\nexit 0');
    const r = await runInstaller(bin, join(dir, "My Programs", "bin"));

    expect(r.stderr).not.toContain("No such file or directory");
    expect(r.stdout).toContain("phantombot 9.9.9");
    expect(r.stdout).toContain("Installation completed successfully.");
    expect(r.exitCode).toBe(0);
  });

  test("PATH setup writes only the sandboxed HOME's rc file, once", async () => {
    const dir = mkdtempSync(join(tmpdir(), "pb-install-rc-"));
    const home = join(dir, "home");
    mkdirSync(home);
    const bin = fakeBin(dir, 'if [ "$1" = "--version" ]; then echo "phantombot 9.9.9"; fi\nexit 0');
    const installDir = join(dir, "bin");

    expect((await runInstaller(bin, installDir, home)).exitCode).toBe(0);
    expect((await runInstaller(bin, installDir, home)).exitCode).toBe(0);

    const rc = readFileSync(join(home, ".bashrc"), "utf8");
    expect(rc.split("# added by phantombot installer").length - 1).toBe(1);
    expect(rc).toContain(installDir);
  });

  test("the suite never runs with the developer's real HOME", () => {
    // Preload (tests/testEnvIsolation.ts) swaps HOME for a throwaway dir.
    const root = process.env.PHANTOMBOT_TEST_ISOLATION_ROOT ?? "";
    expect(root).not.toBe("");
    expect(process.env.HOME?.startsWith(root)).toBe(true);
    expect(process.env.HOME).not.toBe(process.env.PHANTOMBOT_TEST_REAL_HOME);
  });

  test("PB_BIN is quoted at every call site", async () => {
    const text = await Bun.file(INSTALL_SH).text();
    // An unquoted $PB_BIN is the bug itself; $PB_ARGS unquoted is deliberate.
    const unquoted = text
      .split("\n")
      .filter((l) => !l.trimStart().startsWith("#"))
      .flatMap((l) => [...l.matchAll(/[^"$]\$PB_BIN\b/g)]);
    expect(unquoted.map((m) => m[0])).toEqual([]);
  });

  test("the success line never carries the old typo", async () => {
    const text = await Bun.file(INSTALL_SH).text();
    expect(text).not.toContain("succesfully");
  });
});
