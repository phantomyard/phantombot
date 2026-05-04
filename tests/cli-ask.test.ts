import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Readable } from "node:stream";

import { readAllStdin, runAsk } from "../src/cli/ask.ts";
import type { Config } from "../src/config.ts";
import type {
  Harness,
  HarnessChunk,
  HarnessRequest,
} from "../src/harnesses/types.ts";
import { openMemoryStore, type MemoryStore } from "../src/memory/store.ts";

class ScriptedHarness implements Harness {
  invocations = 0;
  lastRequest?: HarnessRequest;
  constructor(
    public readonly id: string,
    private readonly script: HarnessChunk[],
  ) {}
  async available(): Promise<boolean> {
    return true;
  }
  async *invoke(req: HarnessRequest): AsyncGenerator<HarnessChunk> {
    this.invocations++;
    this.lastRequest = req;
    for (const c of this.script) yield c;
  }
}

class CapturingSink {
  buf = "";
  write(s: string): boolean {
    this.buf += s;
    return true;
  }
}

let workdir: string;
let memory: MemoryStore;
let config: Config;

beforeEach(async () => {
  workdir = await mkdtemp(join(tmpdir(), "phantombot-ask-"));
  memory = await openMemoryStore(join(workdir, "memory.sqlite"));

  const personaDir = join(workdir, "personas", "phantom");
  await mkdir(personaDir, { recursive: true });
  await writeFile(join(personaDir, "BOOT.md"), "# Phantom\n", "utf8");

  config = {
    defaultPersona: "phantom",
    harnessIdleTimeoutMs: 5000,
    harnessHardTimeoutMs: 5000,
    personasDir: join(workdir, "personas"),
    memoryDbPath: join(workdir, "memory.sqlite"),
    configPath: join(workdir, "config.toml"),
    harnesses: {
      chain: ["claude"],
      claude: { bin: "claude", model: "opus", fallbackModel: "sonnet" },
      pi: { bin: "pi", maxPayloadBytes: 1 },
      gemini: { bin: "gemini", model: "" },
    },
    channels: {},
    embeddings: { provider: "none" },
    voice: { provider: "none" },
  };
});

afterEach(async () => {
  await memory.close();
  await rm(workdir, { recursive: true, force: true });
});

describe("runAsk — happy path", () => {
  test("prints the harness's final reply to stdout and exits 0", async () => {
    const harness = new ScriptedHarness("h", [
      { type: "text", text: "Hi! " },
      { type: "text", text: "I'm Robbie." },
      { type: "done", finalText: "Hi! I'm Robbie." },
    ]);
    const out = new CapturingSink();
    const err = new CapturingSink();
    const code = await runAsk({
      prompt: "who are you?",
      config,
      memory,
      harnesses: [harness],
      out,
      err,
    });
    expect(code).toBe(0);
    expect(out.buf).toBe("Hi! I'm Robbie.\n");
    expect(err.buf).toBe("");
    expect(harness.invocations).toBe(1);
    expect(harness.lastRequest?.userMessage).toBe("who are you?");
    // noHistory default → empty history passed in.
    expect(harness.lastRequest?.history).toEqual([]);
  });

  test("preserves trailing newline if harness already supplied one", async () => {
    const harness = new ScriptedHarness("h", [
      { type: "done", finalText: "answer\n" },
    ]);
    const out = new CapturingSink();
    const code = await runAsk({
      prompt: "q",
      config,
      memory,
      harnesses: [harness],
      out,
      err: new CapturingSink(),
    });
    expect(code).toBe(0);
    expect(out.buf).toBe("answer\n");
  });
});

describe("runAsk — statelessness", () => {
  test("default (no --history): no turns persisted to memory", async () => {
    const harness = new ScriptedHarness("h", [
      { type: "done", finalText: "ok" },
    ]);
    await runAsk({
      prompt: "first",
      config,
      memory,
      harnesses: [harness],
      out: new CapturingSink(),
      err: new CapturingSink(),
    });
    const turns = await memory.recentTurns("phantom", "cli:ask", 50);
    expect(turns).toEqual([]);
  });

  test("with history: persists user + assistant turns to the named conversation", async () => {
    const harness = new ScriptedHarness("h", [
      { type: "done", finalText: "ok" },
    ]);
    await runAsk({
      prompt: "remember this",
      history: true,
      conversation: "voice-agent:call-42",
      config,
      memory,
      harnesses: [harness],
      out: new CapturingSink(),
      err: new CapturingSink(),
    });
    const turns = await memory.recentTurns("phantom", "voice-agent:call-42", 50);
    expect(turns).toHaveLength(2);
    expect(turns[0]!.role).toBe("user");
    expect(turns[0]!.text).toBe("remember this");
    expect(turns[1]!.role).toBe("assistant");
    expect(turns[1]!.text).toBe("ok");
  });
});

describe("runAsk — error paths", () => {
  test("empty prompt → exit 2 with stderr message", async () => {
    const err = new CapturingSink();
    const code = await runAsk({
      prompt: "   ",
      config,
      memory,
      harnesses: [new ScriptedHarness("h", [])],
      out: new CapturingSink(),
      err,
    });
    expect(code).toBe(2);
    expect(err.buf).toContain("empty prompt");
  });

  test("missing persona dir → exit 2", async () => {
    const cfg = { ...config, defaultPersona: "ghost" };
    const err = new CapturingSink();
    const code = await runAsk({
      prompt: "hi",
      config: cfg,
      memory,
      harnesses: [new ScriptedHarness("h", [])],
      out: new CapturingSink(),
      err,
    });
    expect(code).toBe(2);
    expect(err.buf).toContain("persona 'ghost' not found");
  });

  test("no harnesses → exit 2", async () => {
    const err = new CapturingSink();
    const code = await runAsk({
      prompt: "hi",
      config,
      memory,
      harnesses: [],
      out: new CapturingSink(),
      err,
    });
    expect(code).toBe(2);
    expect(err.buf).toContain("no harnesses configured");
  });

  test("harness produces no done chunk → exit 1", async () => {
    const harness = new ScriptedHarness("h", [
      { type: "text", text: "partial..." },
    ]);
    const err = new CapturingSink();
    const code = await runAsk({
      prompt: "hi",
      config,
      memory,
      harnesses: [harness],
      out: new CapturingSink(),
      err,
    });
    expect(code).toBe(1);
    expect(err.buf).toContain("no final reply");
  });
});

describe("readAllStdin — TTY guard", () => {
  test("throws fast when stdin is a TTY (does not hang)", async () => {
    const fakeTty = new Readable({ read() {} }) as unknown as NodeJS.ReadStream;
    (fakeTty as { isTTY: boolean }).isTTY = true;
    await expect(readAllStdin(fakeTty)).rejects.toThrow(/stdin is a TTY/);
  });

  test("reads piped input normally when stdin is not a TTY", async () => {
    const piped = Readable.from([
      Buffer.from("hello "),
      Buffer.from("world"),
    ]) as unknown as NodeJS.ReadStream;
    (piped as { isTTY: boolean }).isTTY = false;
    expect(await readAllStdin(piped)).toBe("hello world");
  });
});

describe("runAsk — pre-tool narration", () => {
  test("--stream enables PRE_TOOL_NARRATION_INSTRUCTION (Twilio relay rides this)", async () => {
    const harness = new ScriptedHarness("h", [
      { type: "done", finalText: "ok" },
    ]);
    await runAsk({
      prompt: "hi",
      stream: true,
      config,
      memory,
      harnesses: [harness],
      out: new CapturingSink(),
      err: new CapturingSink(),
    });
    const prompt = harness.lastRequest?.systemPrompt ?? "";
    expect(prompt).toContain("Narration before tool calls");
    expect(prompt).toMatch(/user'?s language/i);
  });

  test("plain ask (no --stream) does NOT enable narration", async () => {
    const harness = new ScriptedHarness("h", [
      { type: "done", finalText: "ok" },
    ]);
    await runAsk({
      prompt: "hi",
      // stream defaults to false
      config,
      memory,
      harnesses: [harness],
      out: new CapturingSink(),
      err: new CapturingSink(),
    });
    const prompt = harness.lastRequest?.systemPrompt ?? "";
    expect(prompt).not.toContain("Narration before tool calls");
  });
});

describe("runAsk — streaming sink behavior", () => {
  // A sink that records each individual write() call so we can tell
  // delta-by-delta streaming apart from a single final write.
  class RecordingSink {
    writes: string[] = [];
    get buf(): string {
      return this.writes.join("");
    }
    write(s: string): boolean {
      this.writes.push(s);
      return true;
    }
  }

  test("--stream flushes each text delta to out as it arrives", async () => {
    // Three deltas pre-tool, then a final reformatted finalText. If
    // streaming is wired, the sink sees each delta separately *before*
    // the done chunk lands. If it isn't, we'd see a single finalText
    // write at the end (the non-stream behavior).
    const harness = new ScriptedHarness("h", [
      { type: "text", text: "Checking your inboxes" },
      { type: "text", text: " now" },
      { type: "text", text: "..." },
      { type: "done", finalText: "Checking your inboxes now... done." },
    ]);
    const out = new RecordingSink();
    const code = await runAsk({
      prompt: "any new mail?",
      stream: true,
      config,
      memory,
      harnesses: [harness],
      out,
      err: new CapturingSink(),
    });
    expect(code).toBe(0);
    // Each delta arrives as its own write() call — proves we didn't
    // buffer-then-emit. The trailing "\n" is the cleanup write at the
    // end (streamedText didn't end with \n, so ask.ts adds one).
    expect(out.writes).toEqual([
      "Checking your inboxes",
      " now",
      "...",
      "\n",
    ]);
    // And critically: the harness's authoritative finalText is *not*
    // re-emitted — that would duplicate the reply on stdout. We only
    // see the streamed deltas plus the cleanup newline.
    expect(out.buf).toBe("Checking your inboxes now...\n");
    expect(out.buf).not.toContain("done.");
  });

  test("non-stream mode writes finalText once at the end (no per-delta flushes)", async () => {
    const harness = new ScriptedHarness("h", [
      { type: "text", text: "partial " },
      { type: "text", text: "draft" },
      { type: "done", finalText: "Final reformatted reply." },
    ]);
    const out = new RecordingSink();
    const code = await runAsk({
      prompt: "q",
      // stream defaults to false
      config,
      memory,
      harnesses: [harness],
      out,
      err: new CapturingSink(),
    });
    expect(code).toBe(0);
    // Exactly two writes: the harness's finalText, then the trailing
    // newline. The mid-stream text deltas were correctly suppressed.
    expect(out.writes).toEqual(["Final reformatted reply.", "\n"]);
  });

  test("stream mode trailing-newline check uses streamed bytes, not finalText", async () => {
    // Regression for Kai's note: the trailing-newline check used to
    // consult `chunk.finalText` even in stream mode. If finalText ends
    // in "\n" but the streamed deltas didn't, we'd skip the cleanup
    // newline and leave stdout on a half-line. This test pins the
    // behavior: streamed bytes have no \n, finalText does, and we
    // still emit the cleanup \n.
    const harness = new ScriptedHarness("h", [
      { type: "text", text: "hello" },
      // finalText differs from the deltas (reformatted) AND ends in \n.
      { type: "done", finalText: "hello\n" },
    ]);
    const out = new RecordingSink();
    await runAsk({
      prompt: "q",
      stream: true,
      config,
      memory,
      harnesses: [harness],
      out,
      err: new CapturingSink(),
    });
    expect(out.writes).toEqual(["hello", "\n"]);
  });
});

describe("runAsk — persona override", () => {
  test("--persona <name> uses the named persona, not the default", async () => {
    const altDir = join(workdir, "personas", "lena");
    await mkdir(altDir, { recursive: true });
    await writeFile(join(altDir, "BOOT.md"), "# Lena\n", "utf8");

    const harness = new ScriptedHarness("h", [
      { type: "done", finalText: "from lena" },
    ]);
    const out = new CapturingSink();
    const code = await runAsk({
      prompt: "hi",
      persona: "lena",
      config,
      memory,
      harnesses: [harness],
      out,
      err: new CapturingSink(),
    });
    expect(code).toBe(0);
    expect(out.buf).toBe("from lena\n");
  });
});
