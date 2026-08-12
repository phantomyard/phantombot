/**
 * Tests for the Windows argv-length workaround helper.
 *
 *   - argvNeedsTempFiles() gates ONLY on win32 (so POSIX behavior is
 *     untouched and the branch is testable on a Linux CI runner).
 *   - createHarnessTempDir() writes files and cleanup() removes the dir.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, utimesSync, writeFileSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  argvNeedsTempFiles,
  cleanupPersonaTmpDir,
  createHarnessTempDir,
  personaTmpDir,
} from "../src/lib/harnessArgvFiles.ts";

describe("argvNeedsTempFiles", () => {
  test("true only on win32", () => {
    expect(argvNeedsTempFiles("win32")).toBe(true);
    expect(argvNeedsTempFiles("linux")).toBe(false);
    expect(argvNeedsTempFiles("darwin")).toBe(false);
    expect(argvNeedsTempFiles("freebsd")).toBe(false);
  });
});

describe("createHarnessTempDir", () => {
  test("writes file contents and returns an absolute path inside the dir", async () => {
    const temp = await createHarnessTempDir();
    try {
      const p = await temp.file("payload.md", "hello payload");
      expect(p.startsWith(temp.dir)).toBe(true);
      expect(existsSync(p)).toBe(true);
      expect(await readFile(p, "utf8")).toBe("hello payload");
    } finally {
      await temp.cleanup();
    }
  });

  test("cleanup removes the whole dir and its files", async () => {
    const temp = await createHarnessTempDir();
    const p = await temp.file("system-prompt.md", "persona");
    expect(existsSync(temp.dir)).toBe(true);
    await temp.cleanup();
    expect(existsSync(temp.dir)).toBe(false);
    expect(existsSync(p)).toBe(false);
  });

  test("cleanup is idempotent and never throws", async () => {
    const temp = await createHarnessTempDir();
    await temp.cleanup();
    // Second cleanup on an already-removed dir must resolve, not reject.
    await expect(temp.cleanup()).resolves.toBeUndefined();
  });

  test("creates the harness dir under a supplied baseDir (issue #365)", async () => {
    const personaDir = await mkdtemp(join(tmpdir(), "pb-persona-"));
    try {
      const base = personaTmpDir(personaDir);
      const temp = await createHarnessTempDir(base);
      try {
        expect(temp.dir.startsWith(base)).toBe(true);
        expect(existsSync(temp.dir)).toBe(true);
      } finally {
        await temp.cleanup();
      }
    } finally {
      await rm(personaDir, { recursive: true, force: true });
    }
  });

  test("creates the persona tmp base on first use even if absent", async () => {
    const personaDir = await mkdtemp(join(tmpdir(), "pb-persona-"));
    try {
      // Note: personaTmpDir NOT called first — createHarnessTempDir must mkdir.
      const base = join(personaDir, "tmp");
      expect(existsSync(base)).toBe(false);
      const temp = await createHarnessTempDir(base);
      try {
        expect(existsSync(base)).toBe(true);
        expect(temp.dir.startsWith(base)).toBe(true);
      } finally {
        await temp.cleanup();
      }
    } finally {
      await rm(personaDir, { recursive: true, force: true });
    }
  });
});

describe("personaTmpDir", () => {
  const created: string[] = [];
  afterEach(async () => {
    for (const d of created.splice(0)) await rm(d, { recursive: true, force: true });
  });

  test("returns <personaDir>/tmp and creates it", () => {
    const personaDir = join(tmpdir(), `pb-persona-${Date.now()}-${Math.random()}`);
    created.push(personaDir);
    const dir = personaTmpDir(personaDir);
    expect(dir).toBe(join(personaDir, "tmp"));
    expect(existsSync(dir)).toBe(true);
  });
});

describe("cleanupPersonaTmpDir", () => {
  const created: string[] = [];
  afterEach(async () => {
    for (const d of created.splice(0)) await rm(d, { recursive: true, force: true });
  });

  test("removes owned entries older than maxAge, keeps fresh ones", () => {
    const personaDir = join(tmpdir(), `pb-persona-${Date.now()}-${Math.random()}`);
    created.push(personaDir);
    const tmp = personaTmpDir(personaDir);

    const stale = join(tmp, "phantombot-harness-stale");
    const fresh = join(tmp, "phantombot-harness-fresh");
    mkdirSync(stale, { recursive: true });
    mkdirSync(fresh, { recursive: true });
    writeFileSync(join(stale, "f"), "x");
    writeFileSync(join(fresh, "f"), "x");
    // Backdate the stale dir 25h — past the fat 24h default gate.
    const old = new Date(Date.now() - 25 * 3_600_000);
    utimesSync(stale, old, old);

    cleanupPersonaTmpDir(personaDir); // default 24h gate

    expect(existsSync(stale)).toBe(false);
    expect(existsSync(fresh)).toBe(true);
  });

  test("also sweeps stale phantombot-route-* dirs", () => {
    const personaDir = join(tmpdir(), `pb-persona-${Date.now()}-${Math.random()}`);
    created.push(personaDir);
    const tmp = personaTmpDir(personaDir);

    const staleRoute = join(tmp, "phantombot-route-stale");
    mkdirSync(staleRoute, { recursive: true });
    writeFileSync(join(staleRoute, "system.md"), "x");
    const old = new Date(Date.now() - 25 * 3_600_000);
    utimesSync(staleRoute, old, old);

    cleanupPersonaTmpDir(personaDir);

    expect(existsSync(staleRoute)).toBe(false);
  });

  // Regression for the Kai/Lena blocker (#367): the sweep must NOT delete
  // anything it didn't create, no matter how old — <personaDir>/tmp is the
  // persona's own space and an agent or operator may drop scratch data there.
  test("never deletes non-phantombot entries, even when ancient", () => {
    const personaDir = join(tmpdir(), `pb-persona-${Date.now()}-${Math.random()}`);
    created.push(personaDir);
    const tmp = personaTmpDir(personaDir);

    const userDir = join(tmp, "my-scratch-data");
    const userFile = join(tmp, "notes.txt");
    mkdirSync(userDir, { recursive: true });
    writeFileSync(join(userDir, "keep"), "important");
    writeFileSync(userFile, "important");
    // Backdate both a full week — far past the gate.
    const ancient = new Date(Date.now() - 7 * 24 * 3_600_000);
    utimesSync(userDir, ancient, ancient);
    utimesSync(userFile, ancient, ancient);

    cleanupPersonaTmpDir(personaDir);

    expect(existsSync(userDir)).toBe(true);
    expect(existsSync(userFile)).toBe(true);
  });

  test("honours an explicit maxAgeMs override", () => {
    const personaDir = join(tmpdir(), `pb-persona-${Date.now()}-${Math.random()}`);
    created.push(personaDir);
    const tmp = personaTmpDir(personaDir);

    const stale = join(tmp, "phantombot-harness-old");
    mkdirSync(stale, { recursive: true });
    const old = new Date(Date.now() - 2 * 3_600_000); // 2h old
    utimesSync(stale, old, old);

    cleanupPersonaTmpDir(personaDir, 3_600_000); // explicit 1h gate → reap

    expect(existsSync(stale)).toBe(false);
  });

  test("never throws when the tmp dir does not exist", () => {
    const personaDir = join(tmpdir(), `pb-persona-missing-${Date.now()}`);
    expect(() => cleanupPersonaTmpDir(personaDir)).not.toThrow();
  });
});
