/**
 * Tests for the OpenClaw → phantombot persona importer.
 *
 * Exercises both the importPersona() pure function and the runImportPersona()
 * CLI wrapper. Uses real temp directories so file-copy semantics, dotfile
 * exclusion, and subdir skipping are all verified end-to-end.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runImportPersona } from "../src/cli/import-persona.ts";
import {
  type ImportPersonaResult,
  importPersona,
} from "../src/importer/openclaw.ts";

let workdir: string;
let source: string;
let personasDir: string;

beforeEach(async () => {
  workdir = await mkdtemp(join(tmpdir(), "phantombot-importer-"));
  source = join(workdir, "openclaw-agent");
  personasDir = join(workdir, "personas");
  await mkdir(source, { recursive: true });
  await mkdir(personasDir, { recursive: true });
});

afterEach(async () => {
  await rm(workdir, { recursive: true, force: true });
});

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

async function fileExists(p: string): Promise<boolean> {
  try {
    await readFile(p, "utf8");
    return true;
  } catch {
    return false;
  }
}

describe("importPersona — happy path", () => {
  test("copies BOOT.md / MEMORY.md / tools.md (Robbie convention)", async () => {
    await writeFile(join(source, "BOOT.md"), "id");
    await writeFile(join(source, "MEMORY.md"), "mem");
    await writeFile(join(source, "tools.md"), "tools");

    const r = await importPersona({
      source,
      personasDir,
      as: "robbie",
    });

    expect(r.name).toBe("robbie");
    expect(r.targetDir).toBe(join(personasDir, "robbie"));
    expect(r.copied.sort()).toEqual(["BOOT.md", "MEMORY.md", "tools.md"]);
    expect(r.skipped).toEqual([]);
    expect(await fileExists(join(r.targetDir, "BOOT.md"))).toBe(true);
    expect(await fileExists(join(r.targetDir, "MEMORY.md"))).toBe(true);
    expect(await fileExists(join(r.targetDir, "tools.md"))).toBe(true);
  });

  test("copies SOUL.md / IDENTITY.md / AGENTS.md (modern OpenClaw)", async () => {
    await writeFile(join(source, "SOUL.md"), "soul");
    await writeFile(join(source, "AGENTS.md"), "agents");
    const r = await importPersona({ source, personasDir, as: "modern" });
    expect(r.copied.sort()).toEqual(["AGENTS.md", "SOUL.md"]);
  });

  test("copies bonus .md files (free agent context)", async () => {
    await writeFile(join(source, "BOOT.md"), "id");
    await writeFile(join(source, "playbook.md"), "extra");
    await writeFile(join(source, "notes.md"), "more");
    const r = await importPersona({ source, personasDir, as: "x" });
    expect(r.copied.sort()).toEqual([
      "BOOT.md",
      "notes.md",
      "playbook.md",
    ]);
  });

  test("derives persona name from source basename when --as omitted", async () => {
    const named = join(workdir, "robbie");
    await mkdir(named);
    await writeFile(join(named, "BOOT.md"), "id");
    const r = await importPersona({ source: named, personasDir });
    expect(r.name).toBe("robbie");
  });
});

describe("importPersona — what gets skipped", () => {
  test("skips dotfiles", async () => {
    await writeFile(join(source, "BOOT.md"), "id");
    await writeFile(join(source, ".env"), "secret=1");
    const r = await importPersona({ source, personasDir, as: "x" });
    expect(r.copied).toEqual(["BOOT.md"]);
    expect(r.skipped.some((s) => s.includes(".env"))).toBe(true);
  });

  test("skips SQLite files", async () => {
    await writeFile(join(source, "BOOT.md"), "id");
    await writeFile(join(source, "memory.sqlite"), "binary");
    await writeFile(join(source, "memory.sqlite-journal"), "binary");
    const r = await importPersona({ source, personasDir, as: "x" });
    expect(r.copied).toEqual(["BOOT.md"]);
    expect(r.skipped.some((s) => s.includes(".sqlite"))).toBe(true);
  });

  test("skips JSONL transcripts", async () => {
    await writeFile(join(source, "BOOT.md"), "id");
    await writeFile(join(source, "history.jsonl"), "{}");
    const r = await importPersona({ source, personasDir, as: "x" });
    expect(r.skipped.some((s) => s.includes("history.jsonl"))).toBe(true);
  });

  test("skips non-markdown files", async () => {
    await writeFile(join(source, "BOOT.md"), "id");
    await writeFile(join(source, "config.toml"), "key=val");
    await writeFile(join(source, "script.sh"), "#!/bin/bash");
    const r = await importPersona({ source, personasDir, as: "x" });
    expect(r.copied).toEqual(["BOOT.md"]);
    expect(r.skipped.length).toBe(2);
  });

  test("skips top-level subdirectories that aren't memory/ or kb/", async () => {
    await writeFile(join(source, "BOOT.md"), "id");
    await mkdir(join(source, "node_modules"));
    await mkdir(join(source, ".git"));
    await mkdir(join(source, "subdir"));
    const r = await importPersona({ source, personasDir, as: "x" });
    expect(r.copied).toEqual(["BOOT.md"]);
    expect(r.skipped.some((s) => s.includes("node_modules/"))).toBe(true);
    expect(r.skipped.some((s) => s.includes("subdir/"))).toBe(true);
  });
});

describe("importPersona — recursive memory/ and kb/ subdirs", () => {
  test("copies .md files from memory/ and kb/ recursively", async () => {
    await writeFile(join(source, "BOOT.md"), "id");
    await mkdir(join(source, "memory"));
    await writeFile(join(source, "memory", "decisions.md"), "we chose X");
    await writeFile(join(source, "memory", "2026-05-02.md"), "today");
    await mkdir(join(source, "kb", "concepts"), { recursive: true });
    await writeFile(
      join(source, "kb", "concepts", "DeyeInverter.md"),
      "deye specs",
    );
    await writeFile(join(source, "kb", "Home.md"), "# Home");
    const r = await importPersona({ source, personasDir, as: "x" });
    expect(r.copied).toContain("BOOT.md");
    // Files under memory/ and kb/ keep their parent-dir prefix in the
    // summary, so a top-level `decisions.md` (if it ever existed) would
    // be distinguishable from `memory/decisions.md`.
    expect(r.copied).toContain("memory/decisions.md");
    expect(r.copied).toContain("memory/2026-05-02.md");
    expect(r.copied).toContain("kb/Home.md");
    expect(r.copied).toContain("kb/concepts/DeyeInverter.md");
    const { join: j } = await import("node:path");
    const { readFile } = await import("node:fs/promises");
    const dec = await readFile(
      j(personasDir, "x", "memory", "decisions.md"),
      "utf8",
    );
    expect(dec).toBe("we chose X");
    const inv = await readFile(
      j(
        personasDir,
        "x",
        "kb",
        "concepts",
        "DeyeInverter.md",
      ),
      "utf8",
    );
    expect(inv).toBe("deye specs");
  });

  test("skips non-md files and dotfiles inside memory/ and kb/", async () => {
    await writeFile(join(source, "BOOT.md"), "id");
    await mkdir(join(source, "kb"));
    await writeFile(join(source, "kb", "data.json"), "{}");
    await writeFile(join(source, "kb", ".secret"), "shh");
    await writeFile(join(source, "kb", "Note.md"), "note");
    const r = await importPersona({ source, personasDir, as: "x" });
    expect(r.copied).toContain("kb/Note.md");
    expect(r.copied).not.toContain("data.json");
    expect(r.copied).not.toContain(".secret");
    expect(r.skipped.some((s) => s.includes("data.json"))).toBe(true);
    expect(r.skipped.some((s) => s.includes(".secret"))).toBe(true);
  });
});

describe("importPersona — error paths", () => {
  test("throws when source does not exist", async () => {
    expect(
      importPersona({
        source: join(workdir, "nope"),
        personasDir,
        as: "x",
      }),
    ).rejects.toThrow(/source path does not exist/);
  });

  test("throws when source is a file, not a directory", async () => {
    const f = join(workdir, "afile.md");
    await writeFile(f, "");
    expect(
      importPersona({ source: f, personasDir, as: "x" }),
    ).rejects.toThrow(/not a directory/);
  });

  test("throws when source has no identity file", async () => {
    await writeFile(join(source, "MEMORY.md"), "just memory");
    expect(
      importPersona({ source, personasDir, as: "x" }),
    ).rejects.toThrow(/no identity file/);
  });

  test("throws on invalid persona name", async () => {
    await writeFile(join(source, "BOOT.md"), "id");
    expect(
      importPersona({ source, personasDir, as: "has spaces" }),
    ).rejects.toThrow(/invalid persona name/);
  });

  test("throws when target persona exists and --overwrite is not set", async () => {
    await writeFile(join(source, "BOOT.md"), "id");
    await mkdir(join(personasDir, "x"));
    expect(
      importPersona({ source, personasDir, as: "x" }),
    ).rejects.toThrow(/already exists/);
  });

  test("--overwrite replaces an existing persona", async () => {
    await writeFile(join(source, "BOOT.md"), "new id");
    await mkdir(join(personasDir, "x"));
    await writeFile(join(personasDir, "x", "BOOT.md"), "old id");
    const r: ImportPersonaResult = await importPersona({
      source,
      personasDir,
      as: "x",
      overwrite: true,
    });
    const copiedContent = await readFile(
      join(r.targetDir, "BOOT.md"),
      "utf8",
    );
    expect(copiedContent).toBe("new id");
  });
});

describe("runImportPersona — CLI wrapper", () => {
  test("prints summary on success and returns 0", async () => {
    await writeFile(join(source, "BOOT.md"), "id");
    const out = new CaptureStream();
    const err = new CaptureStream();
    const code = await runImportPersona({
      source,
      as: "x",
      personasDir,
      out,
      err,
    });
    expect(code).toBe(0);
    expect(out.text).toContain("imported persona 'x'");
    expect(out.text).toContain("BOOT.md");
    expect(out.text).toContain("conversation history was NOT imported");
    expect(err.text).toBe("");
  });

  test("returns 1 and writes error to stderr on failure", async () => {
    const out = new CaptureStream();
    const err = new CaptureStream();
    const code = await runImportPersona({
      source: join(workdir, "nope"),
      as: "x",
      personasDir,
      out,
      err,
    });
    expect(code).toBe(1);
    expect(err.text).toContain("error:");
    expect(out.text).toBe("");
  });
});
