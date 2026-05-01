/**
 * Tests for the REPL.
 *
 * The full readline loop is hard to drive in unit tests, so we focus on
 * the testable parts:
 *   - handleSlash dispatch (pure-ish function)
 *   - runChat early-exit paths (missing persona, empty harness chain)
 *
 * Manual REPL behavior (line input, Ctrl-C abort, Ctrl-D exit, history
 * persistence) is verified by hand.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Config } from "../src/config.ts";
import {
  type MemoryStore,
  openMemoryStore,
} from "../src/memory/store.ts";
import { handleSlash, runChat } from "../src/repl/index.ts";

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
let memory: MemoryStore;
let config: Config;

beforeEach(async () => {
  workdir = await mkdtemp(join(tmpdir(), "phantombot-repl-"));
  await mkdir(join(workdir, "personas", "phantom"), { recursive: true });
  await writeFile(
    join(workdir, "personas", "phantom", "BOOT.md"),
    "# Phantom",
    "utf8",
  );
  memory = await openMemoryStore(":memory:");
  config = {
    defaultPersona: "phantom",
    turnTimeoutMs: 5_000,
    personasDir: join(workdir, "personas"),
    memoryDbPath: join(workdir, "memory.sqlite"),
    configPath: join(workdir, "config.toml"),
    harnesses: {
      chain: ["claude"],
      claude: { bin: "claude", model: "opus", fallbackModel: "sonnet" },
      pi: { bin: "pi", maxPayloadBytes: 1_000_000 },
    },
    channels: {},
  };
});

afterEach(async () => {
  await memory.close();
  await rm(workdir, { recursive: true, force: true });
});

function newCtx(overrides: Partial<Parameters<typeof handleSlash>[1]> = {}) {
  const out = new CaptureStream();
  const err = new CaptureStream();
  let persona = "phantom";
  return {
    out,
    err,
    persona: () => persona,
    ctx: {
      config,
      persona,
      memory,
      out,
      err,
      setPersona: (name: string) => {
        persona = name;
      },
      ...overrides,
    },
  };
}

describe("handleSlash", () => {
  test("/help prints commands", async () => {
    const { ctx, out } = newCtx();
    const result = await handleSlash("/help", ctx);
    expect(result).toBe("continue");
    expect(out.text).toContain("/help");
    expect(out.text).toContain("/persona");
    expect(out.text).toContain("/clear");
    expect(out.text).toContain("/history");
    expect(out.text).toContain("/quit");
  });

  test("/quit returns 'quit'", async () => {
    const { ctx } = newCtx();
    expect(await handleSlash("/quit", ctx)).toBe("quit");
    expect(await handleSlash("/exit", ctx)).toBe("quit");
  });

  test("/clear emits an ANSI clear sequence", async () => {
    const { ctx, out } = newCtx();
    await handleSlash("/clear", ctx);
    expect(out.text).toContain("\x1b[2J");
  });

  test("/persona <name> switches persona when the dir exists", async () => {
    await mkdir(join(config.personasDir, "robbie"));
    await writeFile(
      join(config.personasDir, "robbie", "SOUL.md"),
      "# robbie",
    );
    const { ctx, out } = newCtx();
    let switched: string | undefined;
    ctx.setPersona = (n) => {
      switched = n;
    };
    const result = await handleSlash("/persona robbie", ctx);
    expect(result).toBe("continue");
    expect(switched).toBe("robbie");
    expect(out.text).toContain("switched to persona: robbie");
  });

  test("/persona without a name prints usage", async () => {
    const { ctx, err } = newCtx();
    const result = await handleSlash("/persona", ctx);
    expect(result).toBe("continue");
    expect(err.text).toContain("usage: /persona");
  });

  test("/persona <missing> prints not-found and does NOT switch", async () => {
    const { ctx, err } = newCtx();
    let switched = false;
    ctx.setPersona = () => {
      switched = true;
    };
    const result = await handleSlash("/persona doesnotexist", ctx);
    expect(result).toBe("continue");
    expect(switched).toBe(false);
    expect(err.text).toContain("not found");
  });

  test("/history with no turns prints helpful message", async () => {
    const { ctx, out } = newCtx();
    await handleSlash("/history", ctx);
    expect(out.text).toContain("no turns recorded");
  });

  test("/history with turns prints them", async () => {
    await memory.appendTurn({
      persona: "phantom",
      conversation: "cli:default",
      role: "user",
      text: "hello",
    });
    await memory.appendTurn({
      persona: "phantom",
      conversation: "cli:default",
      role: "assistant",
      text: "hi back",
    });
    const { ctx, out } = newCtx();
    await handleSlash("/history", ctx);
    expect(out.text).toContain("user: hello");
    expect(out.text).toContain("assistant: hi back");
  });

  test("/history truncates long lines", async () => {
    await memory.appendTurn({
      persona: "phantom",
      conversation: "cli:default",
      role: "assistant",
      text: "x".repeat(200),
    });
    const { ctx, out } = newCtx();
    await handleSlash("/history", ctx);
    expect(out.text).toContain("...");
  });

  test("unknown slash command returns 'unknown' and writes hint", async () => {
    const { ctx, err } = newCtx();
    const result = await handleSlash("/wat", ctx);
    expect(result).toBe("unknown");
    expect(err.text).toContain("unknown command");
    expect(err.text).toContain("/help");
  });
});

describe("runChat — early exits", () => {
  test("returns 2 when the persona dir does not exist", async () => {
    const code = await runChat({
      persona: "doesnotexist",
      config,
    });
    expect(code).toBe(2);
  });

  test("returns 2 when the harness chain is empty", async () => {
    const code = await runChat({
      config: { ...config, harnesses: { ...config.harnesses, chain: [] } },
    });
    expect(code).toBe(2);
  });
});
