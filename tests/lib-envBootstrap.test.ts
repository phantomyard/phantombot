/**
 * Tests for preloadEnvFiles — the startup hook that gives launchd parity
 * with systemd's EnvironmentFile=. Existing env values must always win
 * (so an explicit `FOO=bar phantombot ask …` from the shell beats
 * whatever's persisted in ~/.env).
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { preloadEnvFiles } from "../src/lib/envBootstrap.ts";

let workdir: string;

beforeEach(async () => {
  workdir = await mkdtemp(join(tmpdir(), "phantombot-envboot-"));
});

afterEach(async () => {
  await rm(workdir, { recursive: true, force: true });
});

describe("preloadEnvFiles", () => {
  test("loads keys from a .env file into the env map", async () => {
    const path = join(workdir, ".env");
    await writeFile(path, "FOO=hello\nBAR=world\n", "utf8");
    const env: NodeJS.ProcessEnv = {};
    const r = await preloadEnvFiles({ files: [path], env });
    expect(r.loaded.sort()).toEqual(["BAR", "FOO"]);
    expect(env.FOO).toBe("hello");
    expect(env.BAR).toBe("world");
  });

  test("existing env values win — does NOT overwrite a key already set in env", async () => {
    const path = join(workdir, ".env");
    await writeFile(path, "FOO=from-file\nBAR=from-file\n", "utf8");
    const env: NodeJS.ProcessEnv = { FOO: "from-shell" };
    const r = await preloadEnvFiles({ files: [path], env });
    // FOO not loaded because the shell already set it.
    expect(r.loaded).toEqual(["BAR"]);
    expect(env.FOO).toBe("from-shell");
    expect(env.BAR).toBe("from-file");
  });

  test("silent on missing files — fresh install with neither .env yet", async () => {
    const env: NodeJS.ProcessEnv = {};
    const r = await preloadEnvFiles({
      files: [join(workdir, "does-not-exist")],
      env,
    });
    expect(r.loaded).toEqual([]);
    expect(Object.keys(env)).toEqual([]);
  });

  test("multi-file: later files don't overwrite earlier ones (existing-wins applies to each file too)", async () => {
    const a = join(workdir, "a.env");
    const b = join(workdir, "b.env");
    await writeFile(a, "FOO=from-a\n", "utf8");
    await writeFile(b, "FOO=from-b\nBAR=from-b\n", "utf8");
    const env: NodeJS.ProcessEnv = {};
    await preloadEnvFiles({ files: [a, b], env });
    // FOO was set by file a; file b can't overwrite it.
    expect(env.FOO).toBe("from-a");
    expect(env.BAR).toBe("from-b");
  });
});
