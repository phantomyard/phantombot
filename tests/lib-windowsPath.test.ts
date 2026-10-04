/**
 * Windows PATH handling for harness children (issue #647).
 *
 * The bug: on Windows PATH is spelled `Path`, and an env spread out of
 * `process.env` is case-SENSITIVE. The PATH helpers read `env.PATH`, saw
 * nothing, and wrote a second `PATH` variable holding only phantombot's own
 * dirs — which the child resolved instead of the real one, losing System32 and
 * with it `where`, `powershell.exe` and every other shell.
 *
 * These run on every platform: the Windows behaviour is driven through the
 * injectable `platform` argument, so Linux CI pins it.
 */
import { afterEach, describe, expect, test } from "bun:test";
import {
  clearHarnessBinDirs,
  harnessChildEnv,
  prependToPath,
  recordHarnessBinDirs,
  withHarnessBinDirsOnPath,
} from "../src/lib/processGroup.ts";
import {
  WINDOWS_MACHINE_ENV_KEY,
  WINDOWS_USER_ENV_KEY,
  expandWindowsEnvRefs,
  normalizePathKey,
  parseRegQueryPath,
  pathKeyOf,
  readWindowsLoginPath,
  withWindowsLoginPath,
} from "../src/lib/windowsPath.ts";

const SYS = "C:\\WINDOWS\\system32;C:\\WINDOWS";

/** Every key in `env` that Windows would treat as PATH. */
function pathKeys(env: Record<string, string | undefined>): string[] {
  return Object.keys(env).filter((k) => k.toLowerCase() === "path");
}

describe("pathKeyOf / normalizePathKey", () => {
  test("finds the Windows `Path` spelling; POSIX is always PATH", () => {
    expect(pathKeyOf({ Path: SYS }, "win32")).toBe("Path");
    expect(pathKeyOf({ path: SYS }, "win32")).toBe("path");
    expect(pathKeyOf({}, "win32")).toBe("PATH");
    // On POSIX `Path` is an unrelated variable.
    expect(pathKeyOf({ Path: "x" }, "linux")).toBe("PATH");
  });

  test("collapses Path + PATH into one variable, keeping every entry", () => {
    const out = normalizePathKey({ Path: SYS, PATH: "C:\\pb;C:\\windows\\" }, "win32");
    expect(pathKeys(out)).toEqual(["Path"]);
    // C:\windows\ is the same dir as C:\WINDOWS — de-duplicated.
    expect(out.Path).toBe(`${SYS};C:\\pb`);
  });

  test("same reference when there is nothing to collapse, and off Windows", () => {
    const one = { Path: SYS };
    expect(normalizePathKey(one, "win32")).toBe(one);
    const posix = { Path: "a", PATH: "/usr/bin" };
    expect(normalizePathKey(posix, "linux")).toBe(posix);
  });
});

describe("prependToPath — the #647 regression", () => {
  test("Windows: prepends onto the existing `Path`, never a second `PATH`", () => {
    const env = { Path: SYS, OTHER: "1" };
    const out = prependToPath(env, ["C:\\pb"], "win32");
    expect(pathKeys(out)).toEqual(["Path"]);
    expect(out.Path).toBe(`C:\\pb;${SYS}`);
    // System32 survives — this is what `where powershell.exe` needs.
    expect(out.Path).toContain("C:\\WINDOWS\\system32");
    expect(env).toEqual({ Path: SYS, OTHER: "1" });
  });

  test("Windows: heals an env that already carries both spellings", () => {
    const out = prependToPath({ Path: SYS, PATH: "C:\\old" }, ["C:\\pb"], "win32");
    expect(pathKeys(out)).toEqual(["Path"]);
    expect(out.Path).toBe(`C:\\pb;${SYS};C:\\old`);
  });

  test("Windows: recorded harness dirs land on `Path` too", () => {
    clearHarnessBinDirs();
    recordHarnessBinDirs(["/opt/pi/bin/pi"]);
    try {
      const out = withHarnessBinDirsOnPath({ Path: SYS }, "win32");
      expect(pathKeys(out)).toEqual(["Path"]);
      expect(out.Path).toBe(`/opt/pi/bin;${SYS}`);
    } finally {
      clearHarnessBinDirs();
    }
  });

  test("POSIX is unchanged: PATH with ':' and `Path` left alone", () => {
    const out = prependToPath({ PATH: "/usr/bin", Path: "x" }, ["/opt/a"], "linux");
    expect(out.PATH).toBe("/opt/a:/usr/bin");
    expect(out.Path).toBe("x");
  });
});

describe("registry PATH parsing", () => {
  test("parses REG_EXPAND_SZ and REG_SZ, tolerates CRLF and a missing value", () => {
    const out =
      "\r\nHKEY_CURRENT_USER\\Environment\r\n" +
      "    Path    REG_EXPAND_SZ    %USERPROFILE%\\bin;C:\\Program Files\\Git\\cmd\r\n\r\n";
    expect(parseRegQueryPath(out)).toBe("%USERPROFILE%\\bin;C:\\Program Files\\Git\\cmd");
    expect(parseRegQueryPath("\nHKLM\\X\n    PATH    REG_SZ    C:\\a\n")).toBe("C:\\a");
    expect(parseRegQueryPath("ERROR: The system was unable to find the specified registry key or value.")).toBeUndefined();
    // PATHEXT must not be mistaken for Path.
    expect(parseRegQueryPath("    PATHEXT    REG_SZ    .COM;.EXE\n")).toBeUndefined();
  });

  test("expands %VAR% case-insensitively and leaves unknown refs verbatim", () => {
    const env = { SystemRoot: "C:\\WINDOWS", USERPROFILE: "C:\\Users\\a" };
    expect(expandWindowsEnvRefs("%systemroot%\\system32;%USERPROFILE%\\bin;%NOPE%\\x", env)).toBe(
      "C:\\WINDOWS\\system32;C:\\Users\\a\\bin;%NOPE%\\x",
    );
  });

  test("login PATH is machine first, then user", () => {
    const reader = (key: string) =>
      key === WINDOWS_MACHINE_ENV_KEY
        ? "%SystemRoot%\\system32;%SystemRoot%"
        : key === WINDOWS_USER_ENV_KEY
          ? "%LOCALAPPDATA%\\Microsoft\\WindowsApps;"
          : undefined;
    const env = { SystemRoot: "C:\\WINDOWS", LOCALAPPDATA: "C:\\Users\\a\\AppData\\Local" };
    expect(readWindowsLoginPath(env, reader)).toEqual([
      "C:\\WINDOWS\\system32",
      "C:\\WINDOWS",
      "C:\\Users\\a\\AppData\\Local\\Microsoft\\WindowsApps",
    ]);
  });
});

describe("withWindowsLoginPath — the full interactive-login PATH", () => {
  const reader = (key: string) =>
    key === WINDOWS_MACHINE_ENV_KEY
      ? "%SystemRoot%\\system32;C:\\Program Files\\Git\\cmd"
      : "%USERPROFILE%\\AppData\\Local\\Microsoft\\WindowsApps";
  const vars = { SystemRoot: "C:\\WINDOWS", USERPROFILE: "C:\\Users\\a" };

  test("appends registry entries the daemon's PATH lacks; existing order wins", () => {
    // A daemon started before Git was installed: Git is in the registry only.
    const env = { ...vars, Path: "C:\\pb;C:\\windows\\System32\\" };
    const out = withWindowsLoginPath(env, { platform: "win32", reader });
    expect(pathKeys(out)).toEqual(["Path"]);
    expect(out.Path).toBe(
      "C:\\pb;C:\\windows\\System32\\;C:\\Program Files\\Git\\cmd;" +
        "C:\\Users\\a\\AppData\\Local\\Microsoft\\WindowsApps",
    );
    expect(env.Path).toBe("C:\\pb;C:\\windows\\System32\\");
  });

  test("restores System32 for a child handed a PATH without it", () => {
    const out = withWindowsLoginPath({ ...vars, PATH: "C:\\pb" }, { platform: "win32", reader });
    expect(out.PATH!.split(";")).toContain("C:\\WINDOWS\\system32");
  });

  test("same reference when the env already has everything", () => {
    const env = {
      ...vars,
      Path: "C:\\WINDOWS\\system32;C:\\Program Files\\Git\\cmd;C:\\Users\\a\\AppData\\Local\\Microsoft\\WindowsApps",
    };
    expect(withWindowsLoginPath(env, { platform: "win32", reader })).toBe(env);
  });

  test("a failed registry read leaves the env untouched", () => {
    const env = { ...vars, Path: "C:\\pb" };
    expect(withWindowsLoginPath(env, { platform: "win32", reader: () => undefined })).toBe(env);
  });

  test("no-op off Windows — the reader is never consulted", () => {
    const env = { PATH: "/usr/bin" };
    const out = withWindowsLoginPath(env, {
      platform: "linux",
      reader: () => {
        throw new Error("must not read the registry on POSIX");
      },
    });
    expect(out).toBe(env);
  });
});

describe("harnessChildEnv — what a Windows harness child is actually handed", () => {
  afterEach(() => clearHarnessBinDirs());

  test("one PATH variable: harness dirs first, the real Path kept, login PATH appended", () => {
    recordHarnessBinDirs(["/opt/pi/bin/pi"]);
    // The exact shape every harness builds: a plain-object spread of
    // process.env, where Windows spells the variable `Path`.
    const spread = { SystemRoot: "C:\\WINDOWS", Path: "C:\\WINDOWS\\system32;C:\\WINDOWS" };
    const out = harnessChildEnv("phantombot", spread, "win32", (e) =>
      withWindowsLoginPath(e, {
        platform: "win32",
        reader: (key) => (key === WINDOWS_USER_ENV_KEY ? "C:\\Users\\a\\bin" : undefined),
      }),
    );
    expect(pathKeys(out)).toEqual(["Path"]);
    // (phantombot's own install dir may sit between them when the test runner
    // is itself the compiled binary — hence order checks, not an exact string.)
    const entries = out.Path!.split(";");
    expect(entries[0]).toBe("/opt/pi/bin");
    expect(entries.slice(-3)).toEqual(["C:\\WINDOWS\\system32", "C:\\WINDOWS", "C:\\Users\\a\\bin"]);
    expect(spread.Path).toBe("C:\\WINDOWS\\system32;C:\\WINDOWS");
  });
});
