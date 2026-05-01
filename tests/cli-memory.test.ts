/**
 * Tests for the `phantombot memory` subcommand handlers (run* fns).
 * The Citty wrappers themselves are trivial and not unit-tested.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  runMemoryGet,
  runMemoryIndex,
  runMemoryList,
  runMemorySearch,
  runMemoryToday,
} from "../src/cli/memory.ts";
import type { Config } from "../src/config.ts";

class CaptureStream {
  chunks: string[] = [];
  write(s: string | Uint8Array): boolean {
    this.chunks.push(typeof s === "string" ? s : new TextDecoder().decode(s));
    return true;
  }
  get text(): string {
    return this.chunks.join("");
  }
}

let workdir: string;
let config: Config;
let indexPath: string;

beforeEach(async () => {
  workdir = await mkdtemp(join(tmpdir(), "phantombot-mem-"));
  await mkdir(join(workdir, "personas", "phantom", "memory"), {
    recursive: true,
  });
  await mkdir(join(workdir, "personas", "phantom", "kb", "concepts"), {
    recursive: true,
  });
  indexPath = join(workdir, "index.sqlite");
  config = {
    defaultPersona: "phantom",
    turnTimeoutMs: 600_000,
    personasDir: join(workdir, "personas"),
    memoryDbPath: join(workdir, "memory.sqlite"),
    configPath: join(workdir, "config.toml"),
    harnesses: {
      chain: ["claude"],
      claude: { bin: "claude", model: "opus", fallbackModel: "sonnet" },
      pi: { bin: "pi", maxPayloadBytes: 1_500_000 },
    },
    channels: {},
    embeddings: { provider: "none" },
  };
});

afterEach(async () => {
  await rm(workdir, { recursive: true, force: true });
});

async function note(rel: string, content: string) {
  await writeFile(join(workdir, "personas", "phantom", rel), content);
}

describe("runMemorySearch", () => {
  test("returns JSON results for a matching query", async () => {
    await note("kb/concepts/Foo.md", "deye inverter facts");
    const out = new CaptureStream();
    const code = await runMemorySearch({
      query: "deye",
      config,
      indexPath,
      out,
      err: new CaptureStream(),
    });
    expect(code).toBe(0);
    const parsed = JSON.parse(out.text);
    expect(parsed.persona).toBe("phantom");
    expect(parsed.query).toBe("deye");
    expect(parsed.results.length).toBe(1);
    expect(parsed.results[0].path).toBe("kb/concepts/Foo.md");
  });

  test("returns persona-not-found error and exit 2", async () => {
    const out = new CaptureStream();
    const err = new CaptureStream();
    const code = await runMemorySearch({
      query: "anything",
      persona: "nope",
      config,
      indexPath,
      out,
      err,
    });
    expect(code).toBe(2);
    expect(err.text).toContain("not found");
  });

  test("respects --scope memory|kb", async () => {
    await note("memory/decisions.md", "telegram bot");
    await note("kb/concepts/Telegram.md", "telegram api");
    const out = new CaptureStream();
    await runMemorySearch({
      query: "telegram",
      scope: "memory",
      config,
      indexPath,
      out,
      err: new CaptureStream(),
    });
    const parsed = JSON.parse(out.text);
    expect(parsed.results).toHaveLength(1);
    expect(parsed.results[0].scope).toBe("memory");
  });
});

describe("runMemoryGet", () => {
  test("cats a persona-relative file", async () => {
    await note("kb/concepts/A.md", "# A\n\nbody");
    const out = new CaptureStream();
    const code = await runMemoryGet({
      path: "kb/concepts/A.md",
      config,
      out,
      err: new CaptureStream(),
    });
    expect(code).toBe(0);
    expect(out.text).toBe("# A\n\nbody");
  });

  test("refuses absolute paths and traversals", async () => {
    const out = new CaptureStream();
    const err = new CaptureStream();
    const code = await runMemoryGet({
      path: "/etc/passwd",
      config,
      out,
      err,
    });
    expect(code).toBe(2);
    expect(err.text).toContain("refusing path outside persona dir");

    const err2 = new CaptureStream();
    const code2 = await runMemoryGet({
      path: "../../../etc/passwd",
      config,
      out: new CaptureStream(),
      err: err2,
    });
    expect(code2).toBe(2);
    expect(err2.text).toContain("refusing path outside");
  });

  test("returns 1 when the file doesn't exist", async () => {
    const err = new CaptureStream();
    const code = await runMemoryGet({
      path: "kb/concepts/MissingNote.md",
      config,
      out: new CaptureStream(),
      err,
    });
    expect(code).toBe(1);
    expect(err.text).toContain("not found");
  });
});

describe("runMemoryList", () => {
  test("lists files in a persona-relative dir, marks dirs vs files", async () => {
    await note("kb/concepts/A.md", "");
    await mkdir(
      join(workdir, "personas", "phantom", "kb", "concepts", "subdir"),
    );
    const out = new CaptureStream();
    const code = await runMemoryList({
      path: "kb/concepts",
      config,
      out,
      err: new CaptureStream(),
    });
    expect(code).toBe(0);
    expect(out.text).toContain("f  A.md");
    expect(out.text).toContain("d  subdir");
  });
});

describe("runMemoryToday", () => {
  test("creates memory/ and prints YYYY-MM-DD.md path", async () => {
    const out = new CaptureStream();
    const code = await runMemoryToday({
      config,
      date: "2026-05-02",
      out,
      err: new CaptureStream(),
    });
    expect(code).toBe(0);
    expect(out.text.trim()).toBe(
      join(workdir, "personas", "phantom", "memory", "2026-05-02.md"),
    );
    expect(existsSync(join(workdir, "personas", "phantom", "memory"))).toBe(
      true,
    );
  });
});

describe("runMemoryIndex", () => {
  test("--rebuild reports the count of files re-indexed", async () => {
    await note("kb/concepts/A.md", "alpha");
    await note("kb/concepts/B.md", "beta");
    const out = new CaptureStream();
    const code = await runMemoryIndex({
      config,
      indexPath,
      rebuild: true,
      out,
      err: new CaptureStream(),
    });
    expect(code).toBe(0);
    expect(out.text).toContain("rebuilt index for 'phantom': 2 file(s)");
  });

  test("incremental refresh reports 0 on a fresh index that's been refreshed once", async () => {
    await note("kb/concepts/A.md", "alpha");
    await runMemoryIndex({
      config,
      indexPath,
      out: new CaptureStream(),
      err: new CaptureStream(),
    });
    const out = new CaptureStream();
    await runMemoryIndex({
      config,
      indexPath,
      out,
      err: new CaptureStream(),
    });
    expect(out.text).toContain("0 file(s)");
  });
});

describe("integration — search picks up files written between calls", () => {
  test("incremental search after adding a note returns the new note", async () => {
    await note("kb/concepts/A.md", "alpha");
    const out1 = new CaptureStream();
    await runMemorySearch({
      query: "alpha",
      config,
      indexPath,
      out: out1,
      err: new CaptureStream(),
    });
    expect(JSON.parse(out1.text).results).toHaveLength(1);

    // Wait a millisecond so the new file's mtime > A.md's
    await new Promise((r) => setTimeout(r, 5));
    await note("kb/concepts/B.md", "alpha and beta");
    const out2 = new CaptureStream();
    await runMemorySearch({
      query: "alpha",
      config,
      indexPath,
      out: out2,
      err: new CaptureStream(),
    });
    expect(JSON.parse(out2.text).results).toHaveLength(2);
  });
});
