/**
 * Tests for preloadEnvFiles + reloadEnvFiles. Two layers:
 *
 *   1. preloadEnvFiles (startup) — gives launchd parity with systemd's
 *      EnvironmentFile=. Existing env values must always win, so an
 *      explicit `FOO=bar phantombot ask …` from the shell beats whatever's
 *      persisted in ~/.env.
 *
 *   2. reloadEnvFiles (per-spawn) — the harnesses call this before each
 *      agent subprocess so a credential the agent saved on the previous
 *      turn (`phantombot env set FOO bar`) is visible without restarting
 *      the daemon. The contract: file-sourced keys are reloadable, but
 *      keys that were already in process.env at boot (shell-export,
 *      systemd) stay sticky — reload never touches them.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  preloadEnvFiles,
  reloadEnvFiles,
} from "../src/lib/envBootstrap.ts";

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

describe("reloadEnvFiles", () => {
  test("picks up a brand-new key added to the file post-boot", async () => {
    const path = join(workdir, ".env");
    await writeFile(path, "FOO=hello\n", "utf8");
    const env: NodeJS.ProcessEnv = {};
    const tracked = new Set<string>();
    await preloadEnvFiles({ files: [path], env, tracked });

    // Agent runs `phantombot env set BAR world` mid-session.
    await writeFile(path, "FOO=hello\nBAR=world\n", "utf8");
    const r = await reloadEnvFiles({ files: [path], env, tracked });

    expect(env.BAR).toBe("world");
    expect(r.updated).toContain("BAR");
    expect(r.removed).toEqual([]);
  });

  test("updates a previously file-sourced key when the file value changes", async () => {
    const path = join(workdir, ".env");
    await writeFile(path, "FOO=old\n", "utf8");
    const env: NodeJS.ProcessEnv = {};
    const tracked = new Set<string>();
    await preloadEnvFiles({ files: [path], env, tracked });
    expect(env.FOO).toBe("old");

    await writeFile(path, "FOO=new\n", "utf8");
    const r = await reloadEnvFiles({ files: [path], env, tracked });

    expect(env.FOO).toBe("new");
    expect(r.updated).toEqual(["FOO"]);
    expect(r.removed).toEqual([]);
  });

  test("shell-exported key is sticky — reload does NOT overwrite it from the file", async () => {
    const path = join(workdir, ".env");
    await writeFile(path, "FOO=from-file\n", "utf8");
    const env: NodeJS.ProcessEnv = { FOO: "from-shell" };
    const tracked = new Set<string>();
    await preloadEnvFiles({ files: [path], env, tracked });
    // Boot-time: shell value won, FOO is NOT tracked as file-sourced.
    expect(env.FOO).toBe("from-shell");
    expect(tracked.has("FOO")).toBe(false);

    // File changes mid-session.
    await writeFile(path, "FOO=updated-in-file\n", "utf8");
    const r = await reloadEnvFiles({ files: [path], env, tracked });

    // The shell export still wins. The file change is invisible — by design.
    expect(env.FOO).toBe("from-shell");
    expect(r.updated).toEqual([]);
  });

  test("removes a previously file-sourced key when the file no longer has it", async () => {
    const path = join(workdir, ".env");
    await writeFile(path, "FOO=hello\nBAR=world\n", "utf8");
    const env: NodeJS.ProcessEnv = {};
    const tracked = new Set<string>();
    await preloadEnvFiles({ files: [path], env, tracked });
    expect(env.BAR).toBe("world");

    // Agent runs `phantombot env unset BAR`.
    await writeFile(path, "FOO=hello\n", "utf8");
    const r = await reloadEnvFiles({ files: [path], env, tracked });

    expect(env.BAR).toBeUndefined();
    expect(env.FOO).toBe("hello"); // unrelated key untouched
    expect(r.removed).toEqual(["BAR"]);
    expect(tracked.has("BAR")).toBe(false);
  });

  test("does NOT remove a shell-exported key that's absent from the file", async () => {
    const path = join(workdir, ".env");
    await writeFile(path, "FOO=hello\n", "utf8");
    const env: NodeJS.ProcessEnv = { SHELL_ONLY: "from-shell" };
    const tracked = new Set<string>();
    await preloadEnvFiles({ files: [path], env, tracked });

    const r = await reloadEnvFiles({ files: [path], env, tracked });

    // SHELL_ONLY was never tracked → reload leaves it alone even though
    // it's not in the file.
    expect(env.SHELL_ONLY).toBe("from-shell");
    expect(r.removed).toEqual([]);
  });

  test("idempotent: a no-change reload reports nothing updated or removed", async () => {
    const path = join(workdir, ".env");
    await writeFile(path, "FOO=hello\nBAR=world\n", "utf8");
    const env: NodeJS.ProcessEnv = {};
    const tracked = new Set<string>();
    await preloadEnvFiles({ files: [path], env, tracked });

    const r = await reloadEnvFiles({ files: [path], env, tracked });

    expect(r.updated).toEqual([]);
    expect(r.removed).toEqual([]);
    expect(env.FOO).toBe("hello");
    expect(env.BAR).toBe("world");
  });

  test("a shell-exported key stays sticky even if it later appears in the file", async () => {
    const path = join(workdir, ".env");
    await writeFile(path, "FOO=from-file\n", "utf8");
    // OTHER simulates an unrelated boot-time shell export.
    const env: NodeJS.ProcessEnv = { OTHER: "shell" };
    const tracked = new Set<string>();
    await preloadEnvFiles({ files: [path], env, tracked });
    expect(env.FOO).toBe("from-file");
    expect(env.OTHER).toBe("shell");

    // Mid-session, someone runs `phantombot env set OTHER from-file`. The
    // shell already had OTHER, so reload must NOT clobber it — there's no
    // way to distinguish a brand-new file key from a collision against an
    // existing shell key, so the shell-wins rule wins by default.
    await writeFile(path, "FOO=from-file\nOTHER=from-file\n", "utf8");
    const r = await reloadEnvFiles({ files: [path], env, tracked });

    expect(env.OTHER).toBe("shell");
    expect(r.updated).not.toContain("OTHER");
  });

  test("multi-file reload preserves first-file-wins precedence", async () => {
    const a = join(workdir, "a.env");
    const b = join(workdir, "b.env");
    await writeFile(a, "FOO=from-a\n", "utf8");
    await writeFile(b, "FOO=from-b\nBAR=from-b\n", "utf8");
    const env: NodeJS.ProcessEnv = {};
    const tracked = new Set<string>();
    await preloadEnvFiles({ files: [a, b], env, tracked });
    expect(env.FOO).toBe("from-a");

    // Update file b's FOO; file a's FOO still wins.
    await writeFile(b, "FOO=from-b-updated\nBAR=from-b\n", "utf8");
    await reloadEnvFiles({ files: [a, b], env, tracked });
    expect(env.FOO).toBe("from-a");

    // Update file a's FOO; that DOES propagate (first file is the truth).
    await writeFile(a, "FOO=from-a-updated\n", "utf8");
    const r = await reloadEnvFiles({ files: [a, b], env, tracked });
    expect(env.FOO).toBe("from-a-updated");
    expect(r.updated).toContain("FOO");
  });
});
