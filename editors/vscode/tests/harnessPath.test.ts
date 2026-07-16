/**
 * PATH-parity tests for the ACP child spawn — reproduces the Windows
 * pi-only-collapse scenario (claude resolves by absolute path but its OWN
 * launch fails because `~/.local/bin` isn't on the PATH VS Code hands the
 * child) and asserts the fix adds the well-known harness install dirs
 * without disturbing anything already present. Pure, no fs, no `vscode`.
 */

import { describe, expect, test } from "bun:test";

import {
  harnessInstallDirs,
  withHarnessInstallDirsOnPath,
  type EnvMap,
} from "../src/harnessPath.ts";

describe("harnessInstallDirs", () => {
  test("POSIX: covers the same static set as the daemon's harnessSearchPath", () => {
    const dirs = harnessInstallDirs("/home/andrew", "linux", {});
    expect(dirs).toContain("/home/andrew/.local/bin");
    expect(dirs).toContain("/home/andrew/.bun/bin");
    expect(dirs).toContain("/home/andrew/.volta/bin");
    expect(dirs).toContain("/home/andrew/.npm-global/bin");
  });

  test("Windows: adds %APPDATA%\\npm when APPDATA is set", () => {
    const dirs = harnessInstallDirs(
      "C:\\Users\\andrew",
      "win32",
      { APPDATA: "C:\\Users\\andrew\\AppData\\Roaming" },
    );
    expect(dirs).toContain("C:\\Users\\andrew\\AppData\\Roaming\\npm");
    expect(dirs).toContain("C:\\Users\\andrew\\.local\\bin");
  });

  test("Windows: omits the APPDATA npm dir when APPDATA is unset", () => {
    const dirs = harnessInstallDirs("C:\\Users\\andrew", "win32", {});
    expect(
      dirs.some((d) => d.toLowerCase().includes("appdata") || d.toLowerCase().includes("roaming")),
    ).toBe(false);
  });
});

describe("withHarnessInstallDirsOnPath", () => {
  test("POSIX: prepends install dirs ahead of the existing PATH", () => {
    const env: EnvMap = { HOME: "/home/andrew", PATH: "/usr/bin:/bin" };
    const next = withHarnessInstallDirsOnPath(env, "linux");
    expect(next.PATH).toContain("/home/andrew/.local/bin");
    expect(next.PATH).toContain("/home/andrew/.bun/bin");
    // Original entries preserved, and at the tail.
    expect(next.PATH?.endsWith("/usr/bin:/bin")).toBe(true);
  });

  test("does not duplicate a dir already on PATH", () => {
    const env: EnvMap = {
      HOME: "/home/andrew",
      PATH: "/home/andrew/.local/bin:/usr/bin",
    };
    const next = withHarnessInstallDirsOnPath(env, "linux");
    const occurrences = (next.PATH ?? "").split(":").filter(
      (e) => e === "/home/andrew/.local/bin",
    ).length;
    expect(occurrences).toBe(1);
  });

  test("never mutates the input env object", () => {
    const env: EnvMap = { HOME: "/home/andrew", PATH: "/usr/bin" };
    const snapshot = { ...env };
    withHarnessInstallDirsOnPath(env, "linux");
    expect(env).toEqual(snapshot);
  });

  test("no-op when home cannot be resolved (env has neither HOME nor USERPROFILE)", () => {
    const env: EnvMap = { PATH: "/usr/bin" };
    const next = withHarnessInstallDirsOnPath(env, "linux");
    expect(next).toBe(env);
  });

  test(
    "Windows: the pi-only-collapse repro \u2014 claude resolves by absolute path " +
      "but the extension's PATH lacks ~/.local/bin, so claude's OWN spawn (a " +
      "Node shebang script needing `node` beside it) would fail; the fix adds " +
      "the dir so that launch has what it needs",
    () => {
      const env: EnvMap = {
        USERPROFILE: "C:\\Users\\andrew",
        PATH: "C:\\Windows\\system32;C:\\Windows",
      };
      const next = withHarnessInstallDirsOnPath(env, "win32");
      expect(next.PATH).toContain("C:\\Users\\andrew\\.local\\bin");
      expect(next.PATH?.split(";")[0]).toBe("C:\\Users\\andrew\\.local\\bin");
    },
  );

  test("Windows: falls back to HOMEDRIVE + HOMEPATH when USERPROFILE is unset", () => {
    const env: EnvMap = {
      HOMEDRIVE: "C:",
      HOMEPATH: "\\Users\\andrew",
      PATH: "C:\\Windows",
    };
    const next = withHarnessInstallDirsOnPath(env, "win32");
    expect(next.PATH).toContain("C:\\Users\\andrew\\.local\\bin");
  });
});
