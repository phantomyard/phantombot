/**
 * Tests for the Windows argv-length workaround helper.
 *
 *   - argvNeedsTempFiles() gates ONLY on win32 (so POSIX behavior is
 *     untouched and the branch is testable on a Linux CI runner).
 *   - createHarnessTempDir() writes files and cleanup() removes the dir.
 */

import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import {
  argvNeedsTempFiles,
  createHarnessTempDir,
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
});
