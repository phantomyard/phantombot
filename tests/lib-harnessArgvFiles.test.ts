/**
 * Tests for the argv-length workaround helper.
 *
 *   - argvNeedsTempFiles() is unconditional on win32 and size-gated
 *     everywhere else (both branches testable on a Linux CI runner).
 *   - createHarnessTempDir() writes files and cleanup() removes the dir.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, utimesSync, writeFileSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ARGV_SPILL_THRESHOLD_BYTES,
  MAX_ARG_STRLEN_BYTES,
  argvNeedsTempFiles,
  cleanupPersonaTmpDir,
  createHarnessTempDir,
  personaTmpDir,
} from "../src/lib/harnessArgvFiles.ts";

describe("argvNeedsTempFiles", () => {
  test("win32 spills unconditionally, whatever the payload size", () => {
    // Windows' limit is on the WHOLE command line, so no per-payload size
    // test can clear it — the other args share the same 8,191-char budget.
    expect(argvNeedsTempFiles("win32")).toBe(true);
    expect(argvNeedsTempFiles("win32", 0)).toBe(true);
    expect(argvNeedsTempFiles("win32", 10)).toBe(true);
  });

  test("a small payload still rides on argv everywhere else", () => {
    for (const platform of ["linux", "darwin", "freebsd"] as const) {
      expect(argvNeedsTempFiles(platform, 0)).toBe(false);
      expect(argvNeedsTempFiles(platform, 8 * 1024)).toBe(false);
      // No size given: the caller has no single dominant payload, so keep
      // the old platform-only answer.
      expect(argvNeedsTempFiles(platform)).toBe(false);
    }
  });

  test("an oversized payload spills on POSIX too (#426)", () => {
    for (const platform of ["linux", "darwin", "freebsd"] as const) {
      expect(argvNeedsTempFiles(platform, ARGV_SPILL_THRESHOLD_BYTES)).toBe(
        false,
      );
      expect(argvNeedsTempFiles(platform, ARGV_SPILL_THRESHOLD_BYTES + 1)).toBe(
        true,
      );
      // The size that actually wedged a persona: a 140KB system prompt.
      expect(argvNeedsTempFiles(platform, 140_659)).toBe(true);
    }
  });

  test("the threshold leaves real headroom under the kernel's per-string cap", () => {
    // MAX_ARG_STRLEN is 32 pages minus the NUL. It is NOT `getconf ARG_MAX`
    // (~2MB, which bounds argv+envp in total) and cannot be raised, so the
    // spill threshold has to sit under it with room to spare.
    expect(MAX_ARG_STRLEN_BYTES).toBe(32 * 4096 - 1);
    expect(ARGV_SPILL_THRESHOLD_BYTES).toBeLessThan(MAX_ARG_STRLEN_BYTES);
    expect(MAX_ARG_STRLEN_BYTES - ARGV_SPILL_THRESHOLD_BYTES).toBeGreaterThan(
      30 * 1024,
    );
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
