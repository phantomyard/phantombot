import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  loadEnvFile,
  parseEnv,
  saveEnvFile,
  updateEnvFile,
} from "../src/lib/envFile.ts";

let workdir: string;
let envPath: string;

beforeEach(async () => {
  workdir = await mkdtemp(join(tmpdir(), "phantombot-env-"));
  envPath = join(workdir, ".env");
});

afterEach(async () => {
  await rm(workdir, { recursive: true, force: true });
});

describe("parseEnv", () => {
  test("parses KEY=value lines, skips comments and blanks", () => {
    expect(
      parseEnv(`# comment\nFOO=bar\n\n  BAZ=qux  \n# another\nQUOTED="with space"\n`),
    ).toEqual({
      FOO: "bar",
      BAZ: "qux",
      QUOTED: "with space",
    });
  });

  test("handles single-quoted values", () => {
    expect(parseEnv("X='quoted'\n")).toEqual({ X: "quoted" });
  });
});

describe("saveEnvFile / loadEnvFile round-trip", () => {
  test("writes the file and reads it back", async () => {
    await saveEnvFile(envPath, { FOO: "bar", PHANTOMBOT_X: "abc-123" });
    expect(existsSync(envPath)).toBe(true);
    expect(await loadEnvFile(envPath)).toEqual({
      FOO: "bar",
      PHANTOMBOT_X: "abc-123",
    });
  });

  test("write quotes values with spaces or special chars", async () => {
    await saveEnvFile(envPath, { X: "has space", Y: "no-special" });
    const text = await readFile(envPath, "utf8");
    expect(text).toContain('X="has space"');
    expect(text).toContain("Y=no-special");
  });

  test("file mode is 600 after save (owner-only)", async () => {
    await saveEnvFile(envPath, { FOO: "bar" });
    const s = await stat(envPath);
    // Mode bits we care about: rwx for owner, none for group/world.
    expect((s.mode & 0o077).toString(8)).toBe("0");
  });

  test("loadEnvFile returns {} when file is missing", async () => {
    expect(await loadEnvFile(envPath)).toEqual({});
  });
});

describe("updateEnvFile", () => {
  test("merges patch into existing keys", async () => {
    await saveEnvFile(envPath, { A: "1", B: "2" });
    await updateEnvFile(envPath, { B: "two", C: "3" });
    expect(await loadEnvFile(envPath)).toEqual({
      A: "1",
      B: "two",
      C: "3",
    });
  });

  test("empty value DELETES the key", async () => {
    await saveEnvFile(envPath, { A: "1", B: "2" });
    await updateEnvFile(envPath, { B: "" });
    expect(await loadEnvFile(envPath)).toEqual({ A: "1" });
  });

  test("creates the file if it doesn't exist", async () => {
    await updateEnvFile(envPath, { NEW: "1" });
    expect(await loadEnvFile(envPath)).toEqual({ NEW: "1" });
  });

  test("ignores keys that aren't valid env-var names", async () => {
    await saveEnvFile(envPath, {
      VALID: "1",
      "with-dash": "skipped",
      "1starts-digit": "skipped",
    });
    expect(await loadEnvFile(envPath)).toEqual({ VALID: "1" });
  });
});

describe("preserves keys it doesn't know about", () => {
  test("hand-edited additional vars survive an updateEnvFile call", async () => {
    await writeFile(
      envPath,
      "USER_VAR=keep_me\nPHANTOMBOT_X=managed\n",
      "utf8",
    );
    await updateEnvFile(envPath, { PHANTOMBOT_X: "managed_v2" });
    expect(await loadEnvFile(envPath)).toEqual({
      USER_VAR: "keep_me",
      PHANTOMBOT_X: "managed_v2",
    });
  });
});
