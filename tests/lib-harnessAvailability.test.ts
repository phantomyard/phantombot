import { describe, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  executableExtensions,
  expandSystemdPath,
  whichBinary,
  checkConfiguredHarnesses,
  resolveHarnessBinsForConfig,
  type HarnessAvailability,
} from "../src/lib/harnessAvailability.ts";
import type { Config } from "../src/config.ts";

describe("expandSystemdPath", () => {
  test("expands %h to home directory", () => {
    const home = "/home/test";
    const path = "%h/.local/bin:/usr/bin";
    expect(expandSystemdPath(path, home)).toBe("/home/test/.local/bin:/usr/bin");
  });

  test("expands multiple occurrences of %h", () => {
    const home = "/home/test";
    const path = "%h/bin:%h/.local/bin";
    expect(expandSystemdPath(path, home)).toBe("/home/test/bin:/home/test/.local/bin");
  });
});

describe("executableExtensions", () => {
  test("POSIX resolves the bare name only", () => {
    expect(executableExtensions("linux")).toEqual([""]);
    expect(executableExtensions("darwin")).toEqual([""]);
  });

  test("Windows tries the bare name first, then each PATHEXT suffix", () => {
    expect(executableExtensions("win32", ".COM;.EXE;.BAT;.CMD")).toEqual([
      "",
      ".COM",
      ".EXE",
      ".BAT",
      ".CMD",
    ]);
  });

  test("Windows falls back to a sane PATHEXT default when unset", () => {
    // Without this, a bare `claude` never matches the shipped `claude.cmd`.
    expect(executableExtensions("win32", undefined)).toContain(".CMD");
    expect(executableExtensions("win32", undefined)).toContain(".EXE");
  });

  test("Windows tolerates whitespace and blank PATHEXT entries", () => {
    expect(executableExtensions("win32", " .EXE ; ; .CMD ")).toEqual([
      "",
      ".EXE",
      ".CMD",
    ]);
  });
});

describe("whichBinary", () => {
  test("resolves absolute paths", async () => {
    // /bin/sh should exist on most linux systems
    expect(await whichBinary("/bin/sh")).toBe("/bin/sh");
  });

  test("returns undefined for missing absolute paths", async () => {
    expect(await whichBinary("/tmp/definitely-not-there-12345")).toBeUndefined();
  });

  test("returns undefined for executable directories", async () => {
    const dir = await mkdtemp(join(tmpdir(), "phantombot-harness-dir-"));
    const executableDir = join(dir, "pi");
    await mkdir(executableDir);
    await chmod(executableDir, 0o755);

    expect(await whichBinary(executableDir)).toBeUndefined();
    expect(await whichBinary("pi", dir)).toBeUndefined();
  });

  test("resolves bare names from pathEnv", async () => {
    const pathEnv = "/bin:/usr/bin";
    expect(await whichBinary("sh", pathEnv)).toBe("/bin/sh");
  });

  // Windows-only: runs on the test-windows CI runner. Proves the bare harness
  // name `claude` resolves to the shipped `claude.cmd` via PATHEXT, and that the
  // PATH is split on `;` (not `:`, which would shred `C:\...` entries).
  const winTest = process.platform === "win32" ? test : test.skip;
  winTest("resolves a bare name to its .cmd via PATHEXT across a ';'-joined PATH", async () => {
    const dirA = await mkdtemp(join(tmpdir(), "phantombot-win-a-"));
    const dirB = await mkdtemp(join(tmpdir(), "phantombot-win-b-"));
    const cmd = join(dirB, "claude.cmd");
    await writeFile(cmd, "@echo off\r\nexit /b 0\r\n", "utf8");

    // dirA first (no match), dirB second - a ';'-joined, drive-letter PATH.
    const pathEnv = `${dirA};${dirB}`;
    expect(await whichBinary("claude", pathEnv)).toBe(cmd);
  });
});

describe("checkConfiguredHarnesses", () => {
  const config = {
    harnesses: {
      chain: ["claude", "pi"],
      claude: { bin: "sh" },
      pi: { bin: "definitely-missing-pi" },
      gemini: { bin: "gemini" },
    },
  } as unknown as Config;

  test("resolves available and missing harnesses", async () => {
    const dir = await mkdtemp(join(tmpdir(), "phantombot-harness-"));
    const sh = join(dir, "sh");
    await writeFile(sh, "#!/bin/sh\nexit 0\n", "utf8");
    await chmod(sh, 0o755);

    const pathEnv = dir;
    const results = await checkConfiguredHarnesses(config, pathEnv);

    const missingPi = results.find((result) => result.id === "pi");

    expect(results).toHaveLength(2);
    expect(results[0]).toMatchObject({ id: "claude", bin: "sh", resolved: sh });
    expect(missingPi).toMatchObject({ id: "pi", bin: "definitely-missing-pi" });
    expect(missingPi?.resolved).toBeUndefined();
  });

  test("falls back to discovery when a cached absolute harness path is stale", async () => {
    const dir = await mkdtemp(join(tmpdir(), "phantombot-harness-"));
    const pi = join(dir, "pi");
    await writeFile(pi, "#!/bin/sh\nexit 0\n", "utf8");
    await chmod(pi, 0o755);

    const staleConfig = {
      harnesses: {
        chain: ["pi"],
        claude: { bin: "claude" },
        pi: { bin: join(dir, "old", "pi") },
        gemini: { bin: "gemini" },
      },
    } as unknown as Config;

    const results = await checkConfiguredHarnesses(staleConfig, dir);

    expect(results).toEqual([
      {
        id: "pi",
        bin: join(dir, "old", "pi"),
        resolved: pi,
        source: "path",
      },
    ]);
  });
});

describe("resolveHarnessBinsForConfig", () => {
  // The whole point of issue #181 §1: the systemd oneshots (nightly/tick/ask)
  // must resolve a PATH-relative `pi` to its absolute path the way `run`
  // does, instead of handing the bare "pi" to the spawn and getting exit 127.
  const baseConfig = {
    harnesses: {
      chain: ["claude", "pi"],
      claude: { bin: "claude", model: "opus", fallbackModel: "sonnet" },
      pi: { bin: "pi", maxPayloadBytes: 1000 },
      gemini: { bin: "gemini", model: "" },
    },
  } as unknown as Config;

  test("rewrites config bins to the resolved absolute paths", async () => {
    const check = async (): Promise<HarnessAvailability[]> => [
      { id: "claude", bin: "claude", resolved: "/abs/claude", source: "path" },
      { id: "pi", bin: "pi", resolved: "/abs/pi", source: "search" },
    ];

    const { config, missing } = await resolveHarnessBinsForConfig(baseConfig, {
      check,
      persist: false,
    });

    expect(config.harnesses.claude.bin).toBe("/abs/claude");
    expect(config.harnesses.pi.bin).toBe("/abs/pi");
    expect(missing).toHaveLength(0);
    // copy-on-write — the input config is never mutated
    expect(baseConfig.harnesses.pi.bin).toBe("pi");
  });

  test("reports an unresolvable binary as missing and leaves its bin alone", async () => {
    const check = async (): Promise<HarnessAvailability[]> => [
      { id: "claude", bin: "claude", resolved: "/abs/claude", source: "path" },
      { id: "pi", bin: "pi" }, // not found anywhere
    ];

    const { config, missing } = await resolveHarnessBinsForConfig(baseConfig, {
      check,
      persist: false,
    });

    expect(config.harnesses.claude.bin).toBe("/abs/claude");
    expect(config.harnesses.pi.bin).toBe("pi");
    expect(missing.map((m) => m.id)).toEqual(["pi"]);
  });
});
