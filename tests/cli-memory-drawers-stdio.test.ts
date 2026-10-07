/**
 * Regression tests for the `memory drawers` stdio sentinels: `--export -`
 * (stdout) and `--import -` (stdin), exactly as `--help` documents them.
 *
 * Why this drives citty's `runCommand` rather than `runMemoryDrawers`:
 * the #652 bug lived entirely in the arg-parsing layer. citty's value
 * reader refuses tokens that start with `-` (it reads them as flags), so
 * the bare `-` the user typed never reached `runMemoryDrawers` — `--export -`
 * arrived as "" and fell through to `mkdir("")` (ENOENT), while `--import -`
 * went looking for `<kind>.md` in the current directory and quietly said
 * "no file". `runMemoryDrawers` has handled `"-"` correctly since #418;
 * only the wrapper could lose it.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { runCommand } from "citty";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import memoryCmd from "../src/cli/memory.ts";

const encoder = new TextEncoder();

function stdinFromText(text: string): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(encoder.encode(text));
      controller.close();
    },
  });
}

describe("memory drawers stdio sentinels (--export - / --import -)", () => {
  let dir = "";
  const saved: Record<string, string | undefined> = {};

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "phantombot-drawers-stdio-"));
    await mkdir(join(dir, "personas", "phantom"), { recursive: true });
    for (const k of ["XDG_CONFIG_HOME", "XDG_DATA_HOME", "XDG_STATE_HOME"]) {
      saved[k] = process.env[k];
      process.env[k] = dir;
    }
    saved.PHANTOMBOT_MEMORY_DB = process.env.PHANTOMBOT_MEMORY_DB;
    process.env.PHANTOMBOT_MEMORY_DB = join(dir, "memory.sqlite");
    saved.PHANTOMBOT_DEFAULT_PERSONA = process.env.PHANTOMBOT_DEFAULT_PERSONA;
    process.env.PHANTOMBOT_DEFAULT_PERSONA = "phantom";
    process.exitCode = undefined;
  });

  afterEach(async () => {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    process.exitCode = undefined;
    await rm(dir, { recursive: true, force: true });
  });

  /** Run a drawers subcommand, capturing whatever it writes to stdout. */
  async function runDrawers(rawArgs: string[]): Promise<string> {
    const chunks: string[] = [];
    const originalWrite = process.stdout.write;
    process.stdout.write = ((chunk: string | Uint8Array) => {
      chunks.push(
        typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk),
      );
      return true;
    }) as typeof process.stdout.write;
    try {
      await runCommand(memoryCmd, { rawArgs: ["drawers", ...rawArgs] });
    } finally {
      process.stdout.write = originalWrite;
    }
    return chunks.join("");
  }

  test("`--export -` writes the drawer markdown to stdout, no mkdir involved", async () => {
    await runDrawers(["--file", "the stdout-export lesson", "--kind", "lessons"]);
    const out = await runDrawers(["--export", "-"]);
    expect(process.exitCode ?? 0).toBe(0);
    expect(out).toContain("the stdout-export lesson");
    // The header that marks this as the lessons drawer's markdown, not the
    // ranked listing that a `--export` to a directory would never print.
    expect(out).toContain("# Lessons");
  });

  test("`--export - --kind lessons --with-id` filters and carries id markers", async () => {
    await runDrawers(["--file", "only-lessons entry", "--kind", "lessons"]);
    await runDrawers(["--file", "only-people entry", "--kind", "people"]);
    const out = await runDrawers([
      "--export",
      "-",
      "--kind",
      "lessons",
      "--with-id",
    ]);
    expect(process.exitCode ?? 0).toBe(0);
    expect(out).toContain("only-lessons entry");
    expect(out).not.toContain("only-people entry");
    expect(out).toContain("<!-- id: lessons:");
  });

  test("`--import -` reads the drawer from stdin and files its entries", async () => {
    const originalStdin = process.stdin;
    Object.defineProperty(process, "stdin", {
      value: stdinFromText("- refiled through stdin\n"),
      configurable: true,
    });
    try {
      const out = await runDrawers(["--import", "-", "--kind", "lessons"]);
      expect(process.exitCode ?? 0).toBe(0);
      // Post-fix the output names the STDIN form, not a `<kind>.md` probe of
      // the current directory reporting "no file, skipped".
      expect(out).toContain("lessons");
      expect(out).not.toContain("no file, skipped");
    } finally {
      Object.defineProperty(process, "stdin", { value: originalStdin });
    }
    // The entry actually landed in the drawer table.
    const listing = await runDrawers(["--kind", "lessons"]);
    expect(listing).toContain("refiled through stdin");
  });
});