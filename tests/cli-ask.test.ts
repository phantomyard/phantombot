/**
 * Integration test for `phantombot ask` — exercises runAsk against the
 * real ClaudeHarness pointed at tests/fixtures/fake-claude.sh, a real
 * SQLite memory store on disk, and a real persona dir on disk.
 *
 * The Citty `defineCommand` wrapper is trivial; the work is in runAsk.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve, join } from "node:path";
import { runAsk } from "../src/cli/ask.ts";
import type { Config } from "../src/config.ts";

const FAKE_CLAUDE = resolve(__dirname, "fixtures/fake-claude.sh");

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
let savedFakeMode: string | undefined;

beforeEach(async () => {
  workdir = await mkdtemp(join(tmpdir(), "phantombot-ask-"));
  const personaDir = join(workdir, "personas", "phantom");
  await mkdir(personaDir, { recursive: true });
  await writeFile(join(personaDir, "BOOT.md"), "# I am Phantom", "utf8");

  config = {
    defaultPersona: "phantom",
    turnTimeoutMs: 5_000,
    personasDir: join(workdir, "personas"),
    memoryDbPath: join(workdir, "memory.sqlite"),
    configPath: join(workdir, "config.toml"),
    harnesses: {
      chain: ["claude"],
      claude: { bin: FAKE_CLAUDE, model: "test", fallbackModel: "" },
      pi: { bin: "pi", maxPayloadBytes: 1_000_000 },
    },
  };

  savedFakeMode = process.env.FAKE_CLAUDE_MODE;
});

afterEach(async () => {
  if (savedFakeMode === undefined) delete process.env.FAKE_CLAUDE_MODE;
  else process.env.FAKE_CLAUDE_MODE = savedFakeMode;
  await rm(workdir, { recursive: true, force: true });
});

describe("runAsk — happy path", () => {
  test("prints text chunks to stdout, ends with a newline, exit 0", async () => {
    process.env.FAKE_CLAUDE_MODE = "normal";
    const out = new CaptureStream();
    const err = new CaptureStream();
    const code = await runAsk({
      message: "hi",
      out,
      err,
      config,
    });
    expect(code).toBe(0);
    expect(out.text).toBe("hello world\n");
    expect(err.text).toBe("");
  });

  test("persists user + assistant turns to the configured SQLite db", async () => {
    process.env.FAKE_CLAUDE_MODE = "normal";
    const out = new CaptureStream();
    const err = new CaptureStream();
    await runAsk({ message: "hi", out, err, config });
    // Open a fresh memory store against the same file to verify persistence.
    const { openMemoryStore } = await import("../src/memory/store.ts");
    const m = await openMemoryStore(config.memoryDbPath);
    const turns = await m.recentTurns("phantom", "cli:default", 10);
    await m.close();
    expect(turns).toEqual([
      { role: "user", text: "hi" },
      { role: "assistant", text: "hello world" },
    ]);
  });

  test("loads prior history into the harness on subsequent invocations", async () => {
    process.env.FAKE_CLAUDE_MODE = "normal";
    const out1 = new CaptureStream();
    const err1 = new CaptureStream();
    await runAsk({ message: "first", out: out1, err: err1, config });
    const out2 = new CaptureStream();
    const err2 = new CaptureStream();
    await runAsk({ message: "second", out: out2, err: err2, config });

    const { openMemoryStore } = await import("../src/memory/store.ts");
    const m = await openMemoryStore(config.memoryDbPath);
    const turns = await m.recentTurns("phantom", "cli:default", 10);
    await m.close();
    expect(turns.map((t) => `${t.role}:${t.text}`)).toEqual([
      "user:first",
      "assistant:hello world",
      "user:second",
      "assistant:hello world",
    ]);
  });
});

describe("runAsk — failure paths", () => {
  test("missing persona dir returns exit 2 with helpful message", async () => {
    const out = new CaptureStream();
    const err = new CaptureStream();
    const code = await runAsk({
      message: "hi",
      persona: "doesnotexist",
      out,
      err,
      config,
    });
    expect(code).toBe(2);
    expect(err.text).toContain("persona 'doesnotexist' not found");
    expect(err.text).toContain("import-persona");
    expect(out.text).toBe("");
    // Memory file should not have been touched.
    await expect(readFile(config.memoryDbPath, "utf8")).rejects.toThrow();
  });

  test("harness error returns exit 1 and does NOT persist", async () => {
    process.env.FAKE_CLAUDE_MODE = "error";
    const out = new CaptureStream();
    const err = new CaptureStream();
    const code = await runAsk({ message: "hi", out, err, config });
    expect(code).toBe(1);
    expect(err.text).toContain("error:");

    const { openMemoryStore } = await import("../src/memory/store.ts");
    const m = await openMemoryStore(config.memoryDbPath);
    const turns = await m.recentTurns("phantom", "cli:default", 10);
    await m.close();
    expect(turns).toEqual([]);
  });

  test("empty harness chain returns exit 2", async () => {
    const out = new CaptureStream();
    const err = new CaptureStream();
    const code = await runAsk({
      message: "hi",
      out,
      err,
      config: { ...config, harnesses: { ...config.harnesses, chain: [] } },
    });
    expect(code).toBe(2);
    expect(err.text).toContain("no harnesses configured");
  });
});

describe("runAsk — noHistory", () => {
  test("does not persist when noHistory is set", async () => {
    process.env.FAKE_CLAUDE_MODE = "normal";
    const out = new CaptureStream();
    const err = new CaptureStream();
    await runAsk({ message: "isolated", noHistory: true, out, err, config });

    const { openMemoryStore } = await import("../src/memory/store.ts");
    const m = await openMemoryStore(config.memoryDbPath);
    const turns = await m.recentTurns("phantom", "cli:default", 10);
    await m.close();
    expect(turns).toEqual([]);
  });
});
