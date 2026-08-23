import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  applyHarnessChain,
  piInstallCommand,
  SUPPORTED_HARNESSES,
  whichBinary,
} from "../src/cli/harness.ts";

describe("Pi-default wizard wiring", () => {
  test("Pi is the default primary (first in SUPPORTED_HARNESSES)", () => {
    expect(SUPPORTED_HARNESSES[0]).toBe("pi");
  });

  test("piInstallCommand is the official user-space installer (POSIX)", () => {
    expect(piInstallCommand("linux")).toEqual([
      "sh",
      "-c",
      "curl -fsSL https://pi.dev/install.sh | sh",
    ]);
    expect(piInstallCommand("darwin")).toEqual([
      "sh",
      "-c",
      "curl -fsSL https://pi.dev/install.sh | sh",
    ]);
  });

  test("piInstallCommand uses the PowerShell installer on Windows (#269)", () => {
    expect(piInstallCommand("win32")).toEqual([
      "powershell",
      "-NoProfile",
      "-ExecutionPolicy",
      "Bypass",
      "-Command",
      "irm https://pi.dev/install.ps1 | iex",
    ]);
  });
});

let workdir: string;

beforeEach(async () => {
  workdir = await mkdtemp(join(tmpdir(), "phantombot-h-"));
});

afterEach(async () => {
  await rm(workdir, { recursive: true, force: true });
});

describe("whichBinary", () => {
  test("returns the absolute path when bin is an absolute executable", async () => {
    expect(await whichBinary("/bin/sh")).toBe("/bin/sh");
  });

  test("returns undefined for a non-existent absolute path", async () => {
    expect(await whichBinary("/this/does/not/exist")).toBeUndefined();
  });

  test("walks $PATH for bare command names", async () => {
    expect(await whichBinary("sh")).toBeTruthy();
  });

  test("returns undefined for a bare command not on PATH", async () => {
    expect(
      await whichBinary("definitely-not-a-real-command-9999"),
    ).toBeUndefined();
  });
});

describe("applyHarnessChain", () => {
  test("writes the chain to [harnesses].chain", async () => {
    const path = join(workdir, "config.toml");
    await applyHarnessChain(path, ["claude", "pi"]);
    const text = await readFile(path, "utf8");
    expect(text).toContain("[harnesses]");
    expect(text).toContain('chain = [ "claude", "pi" ]');
  });

  test("supports a single-element chain", async () => {
    const path = join(workdir, "config.toml");
    await applyHarnessChain(path, ["pi"]);
    const text = await readFile(path, "utf8");
    expect(text).toContain('chain = [ "pi" ]');
  });

  test("in persona scope the chain is the plain [harnesses].chain", async () => {
    // A persona's own file describes one persona, so its chain is
    // `[harnesses].chain` — the key loadConfig reads first for that persona.
    // Writing the legacy table into a persona file would be dropped on read
    // and the change would silently do nothing (phantombot#439).
    const path = join(workdir, "lena-config.toml");
    await applyHarnessChain(path, ["pi", "claude"], "lena", "persona");
    const text = await readFile(path, "utf8");
    expect(text).toContain('chain = [ "pi", "claude" ]');
    expect(text).not.toContain("personas");
  });

  test("writes a persona override without changing the global chain", async () => {
    const path = join(workdir, "config.toml");
    await applyHarnessChain(path, ["codex", "pi"]);
    await applyHarnessChain(path, ["claude", "codex"], "amanda");
    const text = await readFile(path, "utf8");
    expect(text).toContain('chain = [ "codex", "pi" ]');
    expect(text).toContain("[harnesses.personas.amanda]");
    expect(text).toContain('chain = [ "claude", "codex" ]');
  });
});
