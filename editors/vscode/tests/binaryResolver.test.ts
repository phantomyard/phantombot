/**
 * Binary-resolution tests — drive the pure resolver with injected
 * platform/env/exists so a single suite exercises linux, darwin AND the win32
 * branch (which is implemented but has no real Windows host to run on).
 */

import { describe, expect, test } from "bun:test";

import {
  binaryName,
  findOnPath,
  installLocationCandidates,
  notFoundMessage,
  resolvePhantombotBinary,
} from "../src/binaryResolver.ts";

describe("binaryName", () => {
  test("appends .exe on win32 only", () => {
    expect(binaryName("linux")).toBe("phantombot");
    expect(binaryName("darwin")).toBe("phantombot");
    expect(binaryName("win32")).toBe("phantombot.exe");
  });
});

describe("resolvePhantombotBinary — precedence", () => {
  test("an existing configured path wins over everything", () => {
    const r = resolvePhantombotBinary({
      platform: "linux",
      env: { PATH: "/usr/bin", HOME: "/home/dev" },
      configuredPath: "/opt/custom/phantombot",
      exists: (p) => p === "/opt/custom/phantombot" || p === "/usr/bin/phantombot",
    });
    expect(r).toEqual({ path: "/opt/custom/phantombot", source: "setting" });
  });

  test("a stale (non-existent) configured path falls through to PATH", () => {
    const r = resolvePhantombotBinary({
      platform: "linux",
      env: { PATH: "/usr/bin", HOME: "/home/dev" },
      configuredPath: "/gone/phantombot",
      exists: (p) => p === "/usr/bin/phantombot",
    });
    expect(r).toEqual({ path: "/usr/bin/phantombot", source: "path" });
  });

  test("PATH is searched in order before install locations", () => {
    const r = resolvePhantombotBinary({
      platform: "linux",
      env: { PATH: "/a:/b:/c", HOME: "/home/dev" },
      exists: (p) => p === "/b/phantombot" || p === "/home/dev/.local/bin/phantombot",
    });
    // /b on PATH beats the install-location candidate.
    expect(r).toEqual({ path: "/b/phantombot", source: "path" });
  });

  test("falls back to a common install location when not on PATH", () => {
    const r = resolvePhantombotBinary({
      platform: "linux",
      env: { PATH: "/nowhere", HOME: "/home/dev" },
      exists: (p) => p === "/home/dev/.local/bin/phantombot",
    });
    expect(r).toEqual({
      path: "/home/dev/.local/bin/phantombot",
      source: "install-location",
    });
  });

  test("returns undefined when nothing resolves", () => {
    const r = resolvePhantombotBinary({
      platform: "linux",
      env: { PATH: "/nowhere", HOME: "/home/dev" },
      exists: () => false,
    });
    expect(r).toBeUndefined();
  });
});

describe("resolvePhantombotBinary — darwin", () => {
  test("probes the Homebrew Apple-Silicon path", () => {
    const candidates = installLocationCandidates("darwin", { HOME: "/Users/dev" });
    expect(candidates).toContain("/opt/homebrew/bin/phantombot");
    const r = resolvePhantombotBinary({
      platform: "darwin",
      env: { PATH: "/nowhere", HOME: "/Users/dev" },
      exists: (p) => p === "/opt/homebrew/bin/phantombot",
    });
    expect(r?.source).toBe("install-location");
  });
});

describe("resolvePhantombotBinary — win32 (implemented, untested on real host)", () => {
  test("uses ; as the PATH separator and phantombot.exe", () => {
    const found = findOnPath(
      "win32",
      { PATH: "C:\\bin;C:\\tools" },
      (p) => p === "C:\\tools\\phantombot.exe",
    );
    expect(found).toBe("C:\\tools\\phantombot.exe");
  });

  test("install-location candidates use LOCALAPPDATA + USERPROFILE", () => {
    const candidates = installLocationCandidates("win32", {
      LOCALAPPDATA: "C:\\Users\\dev\\AppData\\Local",
      USERPROFILE: "C:\\Users\\dev",
    });
    expect(
      candidates.some((c) => c.includes("AppData\\Local") && c.endsWith("phantombot.exe")),
    ).toBe(true);
    expect(candidates.some((c) => c.endsWith("phantombot.exe"))).toBe(true);
  });

  test("resolves a win32 install location end-to-end", () => {
    const r = resolvePhantombotBinary({
      platform: "win32",
      env: {
        PATH: "C:\\nowhere",
        LOCALAPPDATA: "C:\\Users\\dev\\AppData\\Local",
        USERPROFILE: "C:\\Users\\dev",
      },
      exists: (p) => p.endsWith("phantombot.exe") && p.includes("AppData\\Local"),
    });
    expect(r?.source).toBe("install-location");
    expect(r?.path.endsWith("phantombot.exe")).toBe(true);
  });
});

describe("notFoundMessage", () => {
  test("names the platform binary and points at the setting", () => {
    expect(notFoundMessage("linux")).toContain("phantombot");
    expect(notFoundMessage("linux")).toContain("phantombot.binaryPath");
    expect(notFoundMessage("win32")).toContain("phantombot.exe");
  });
});
