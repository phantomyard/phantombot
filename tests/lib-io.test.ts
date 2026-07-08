/**
 * Tests for the shared atomic file-write helper (writeFileAtomic).
 *
 * The whole point of the helper is that a reader never observes a
 * half-written file: it writes to a pid/random-suffixed temp sibling and
 * rename()s it over the target (atomic on POSIX). These tests assert the
 * observable guarantees — correct contents, parent-dir creation, no leftover
 * temp files on success, no clobbering under concurrency, and (via a stubbed
 * failure) that a pre-existing good file survives a failed write intact.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeFileAtomic } from "../src/lib/io.ts";

let workdir: string;

beforeEach(async () => {
  workdir = await mkdtemp(join(tmpdir(), "phantombot-io-"));
});

afterEach(async () => {
  await rm(workdir, { recursive: true, force: true });
});

describe("writeFileAtomic", () => {
  test("writes the exact contents to the target", async () => {
    const target = join(workdir, "state.json");
    await writeFileAtomic(target, '{"a":1}\n');
    expect(await readFile(target, "utf8")).toBe('{"a":1}\n');
  });

  test("creates missing parent directories", async () => {
    const target = join(workdir, "nested", "deep", "state.json");
    await writeFileAtomic(target, "hello");
    expect(await readFile(target, "utf8")).toBe("hello");
  });

  test("leaves no temp files behind on success", async () => {
    const target = join(workdir, "state.json");
    await writeFileAtomic(target, "one");
    await writeFileAtomic(target, "two");
    const entries = await readdir(workdir);
    expect(entries).toEqual(["state.json"]);
    expect(entries.some((e) => e.endsWith(".tmp"))).toBe(false);
  });

  test("overwrites an existing file atomically (final contents win)", async () => {
    const target = join(workdir, "state.json");
    await writeFile(target, "old", "utf8");
    await writeFileAtomic(target, "new");
    expect(await readFile(target, "utf8")).toBe("new");
  });

  test("concurrent writes never yield a torn file", async () => {
    const target = join(workdir, "state.json");
    const payloads = Array.from({ length: 20 }, (_, i) => `payload-${i}`.padEnd(64, "x"));
    await Promise.all(payloads.map((p) => writeFileAtomic(target, p)));
    // Whatever won the race, the file must be one *complete* payload — never a
    // truncated or interleaved mix — and no temp files may linger.
    const final = await readFile(target, "utf8");
    expect(payloads).toContain(final);
    const entries = await readdir(workdir);
    expect(entries).toEqual(["state.json"]);
  });

  test("a pre-existing good file survives a failed write", async () => {
    const target = join(workdir, "state.json");
    await writeFileAtomic(target, "good");
    // A non-string payload makes the underlying writeFile reject; the target
    // must still hold the previous good contents, and no temp file remains.
    await expect(
      // @ts-expect-error deliberately bad payload to force a write failure
      writeFileAtomic(target, { not: "a string" }),
    ).rejects.toBeDefined();
    expect(await readFile(target, "utf8")).toBe("good");
    const entries = await readdir(workdir);
    expect(entries).toEqual(["state.json"]);
  });
});
