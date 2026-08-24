import { describe, expect, test } from "bun:test";
import {
  isUsablePersistedBin,
  usablePersistedBin,
} from "../src/lib/harnessBinPath.ts";

describe("isUsablePersistedBin", () => {
  test("Windows rejects a POSIX-rooted path persisted by a WSL/Git-Bash run", () => {
    // The exact shape from issue #450: path.win32.isAbsolute() says true, so
    // the resolver happily tries it and always misses.
    expect(isUsablePersistedBin("/bin/claude", "win32")).toBe(false);
    expect(isUsablePersistedBin("/usr/local/bin/pi", "win32")).toBe(false);
    expect(isUsablePersistedBin("\\bin\\claude", "win32")).toBe(false);
  });

  test("Windows keeps drive-letter and UNC paths", () => {
    expect(isUsablePersistedBin("C:\\Users\\a\\AppData\\npm\\claude.cmd", "win32")).toBe(true);
    expect(isUsablePersistedBin("c:/tools/claude.cmd", "win32")).toBe(true);
    expect(isUsablePersistedBin("\\\\server\\share\\claude.cmd", "win32")).toBe(true);
  });

  test("POSIX rejects a drive-letter path persisted by a Windows run", () => {
    expect(isUsablePersistedBin("C:\\npm\\claude.cmd", "linux")).toBe(false);
    expect(isUsablePersistedBin("\\\\server\\share\\claude", "linux")).toBe(false);
  });

  test("POSIX keeps ordinary absolute paths", () => {
    expect(isUsablePersistedBin("/home/a/.bun/bin/claude", "linux")).toBe(true);
    expect(isUsablePersistedBin("/usr/bin/claude", "darwin")).toBe(true);
  });

  test("bare names stay usable on both platforms", () => {
    expect(isUsablePersistedBin("claude", "win32")).toBe(true);
    expect(isUsablePersistedBin("claude.cmd", "win32")).toBe(true);
    expect(isUsablePersistedBin("claude", "linux")).toBe(true);
  });

  test("empty string is never usable", () => {
    expect(isUsablePersistedBin("", "linux")).toBe(false);
    expect(isUsablePersistedBin("", "win32")).toBe(false);
  });

  test("a well-formed path that simply does not exist is KEPT", () => {
    // Shape only — existence is resolveHarnessBinary's job, and reporting a
    // missing install against the configured path is the honest diagnostic.
    expect(isUsablePersistedBin("/nonexistent/claude", "linux")).toBe(true);
  });
});

describe("usablePersistedBin", () => {
  test("passes a usable value through for the ?? chain", () => {
    expect(usablePersistedBin("/usr/bin/claude", "linux")).toBe("/usr/bin/claude");
  });

  test("returns undefined so loadConfig falls through to the bare-name default", () => {
    expect(usablePersistedBin("/bin/claude", "win32")).toBeUndefined();
  });

  test("undefined in, undefined out", () => {
    expect(usablePersistedBin(undefined, "win32")).toBeUndefined();
  });
});
