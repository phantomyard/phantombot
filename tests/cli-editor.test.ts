import { describe, expect, it } from "bun:test";
import { runEditor } from "../src/cli/editor.ts";
import { Writable } from "node:stream";
import { mkdtemp, rm, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** Minimal in-memory WriteSink that captures output. */
function captureSink(): { sink: Writable; lines: string[] } {
  const lines: string[] = [];
  const sink = new Writable({
    write(chunk, _enc, cb) {
      const str = chunk.toString();
      for (const line of str.split("\n")) {
        if (line.trim()) lines.push(line.trim());
      }
      cb();
    },
  });
  return { sink, lines };
}

/** Parse captured lines as JSON chunks. */
function parseChunks(lines: string[]) {
  return lines.map((l) => JSON.parse(l));
}

/** Fake harness that returns a canned reply. */
function fakeHarness(reply = "Hello from the editor!") {
  return {
    id: "fake",
    available: async () => true,
    async *invoke() {
      yield { type: "text" as const, text: reply };
      yield { type: "done" as const, finalText: reply, meta: {} };
    },
  };
}

/** Fake config pointing at a temp personas dir. */
function fakeConfig(personasDir: string) {
  return {
    defaultPersona: "test",
    personasDir,
    harnesses: { chain: ["fake"] },
    harnessIdleTimeoutMs: 30_000,
    harnessHardTimeoutMs: 300_000,
    memoryDbPath: join(personasDir, "memory.db"),
    configPath: "/dev/null",
  } as any;
}

/** Create a minimal persona dir with required files. */
async function setupPersona(tmpDir: string) {
  const pdir = join(tmpDir, "test");
  await mkdir(pdir, { recursive: true });
  await writeFile(join(pdir, "BOOT.md"), "You are a test assistant.");
  await writeFile(join(pdir, "MEMORY.md"), "Test memory.");
  return pdir;
}

describe("editor", () => {
  it("rejects empty payload", async () => {
    const { sink, lines } = captureSink();
    const tmp = await mkdtemp(join(tmpdir(), "editor-test-"));
    await setupPersona(tmp);

    const code = await runEditor({
      payload: { message: "" },
      config: fakeConfig(tmp),
      harnesses: [fakeHarness()],
      out: sink,
      err: sink,
    });

    const chunks = parseChunks(lines);
    expect(code).toBe(3);
    expect(chunks[0].type).toBe("error");
    expect(chunks[0].message).toContain("required");

    await rm(tmp, { recursive: true, force: true });
  });

  it("streams text and done chunks", async () => {
    const tmp = await mkdtemp(join(tmpdir(), "editor-test-"));
    await setupPersona(tmp);
    const { sink, lines } = captureSink();

    const code = await runEditor({
      payload: { message: "explain this" },
      config: fakeConfig(tmp),
      harnesses: [fakeHarness("Sure, here's the explanation.")],
      out: sink,
      err: sink,
    });

    expect(code).toBe(0);
    const chunks = parseChunks(lines);
    const textChunks = chunks.filter((c: any) => c.type === "text");
    const doneChunks = chunks.filter((c: any) => c.type === "done");

    expect(textChunks.length).toBeGreaterThanOrEqual(1);
    expect(textChunks[0].content).toBe("Sure, here's the explanation.");
    expect(doneChunks.length).toBe(1);

    await rm(tmp, { recursive: true, force: true });
  });

  it("includes active file context in enriched message", async () => {
    const tmp = await mkdtemp(join(tmpdir(), "editor-test-"));
    await setupPersona(tmp);
    const { sink } = captureSink();

    let receivedMessage = "";
    const capturingHarness = {
      id: "fake",
      available: async () => true,
      async *invoke(req: any) {
        receivedMessage = req.userMessage;
        yield { type: "text" as const, text: "Got it" };
        yield { type: "done" as const, finalText: "Got it", meta: {} };
      },
    };

    await runEditor({
      payload: {
        message: "what's wrong here?",
        activeFile: {
          path: "src/app.ts",
          language: "typescript",
          content: "const x: number = 'oops';",
        },
      },
      config: fakeConfig(tmp),
      harnesses: [capturingHarness],
      out: sink,
      err: sink,
    });

    expect(receivedMessage).toContain("src/app.ts");
    expect(receivedMessage).toContain("typescript");
    expect(receivedMessage).toContain("what's wrong here?");

    await rm(tmp, { recursive: true, force: true });
  });

  it("includes diagnostics in enriched message", async () => {
    const tmp = await mkdtemp(join(tmpdir(), "editor-test-"));
    await setupPersona(tmp);
    const { sink } = captureSink();

    let receivedMessage = "";
    const capturingHarness = {
      id: "fake",
      available: async () => true,
      async *invoke(req: any) {
        receivedMessage = req.userMessage;
        yield { type: "text" as const, text: "Fixed" };
        yield { type: "done" as const, finalText: "Fixed", meta: {} };
      },
    };

    await runEditor({
      payload: {
        message: "fix this",
        diagnostics: [
          {
            path: "src/app.ts",
            line: 5,
            column: 3,
            message: "Type 'string' is not assignable to type 'number'",
            severity: "error",
          },
        ],
      },
      config: fakeConfig(tmp),
      harnesses: [capturingHarness],
      out: sink,
      err: sink,
    });

    expect(receivedMessage).toContain("Type 'string' is not assignable");
    expect(receivedMessage).toContain("ERROR");

    await rm(tmp, { recursive: true, force: true });
  });

  it("derives conversation ID from workspace", async () => {
    const tmp = await mkdtemp(join(tmpdir(), "editor-test-"));
    await setupPersona(tmp);
    const { sink, lines } = captureSink();

    const code = await runEditor({
      payload: {
        message: "hello",
        workspace: { root: "/home/user/myproject", openFiles: [] },
      },
      config: fakeConfig(tmp),
      harnesses: [fakeHarness()],
      out: sink,
      err: sink,
    });

    expect(code).toBe(0);
    const chunks = parseChunks(lines);
    expect(chunks.some((c: any) => c.type === "done")).toBe(true);

    await rm(tmp, { recursive: true, force: true });
  });

  it("passes persona override", async () => {
    const tmp = await mkdtemp(join(tmpdir(), "editor-test-"));
    // "custom" subdir does NOT exist — should report persona not found
    const { sink, lines } = captureSink();

    await runEditor({
      payload: { message: "hello", persona: "custom" },
      config: fakeConfig(tmp),
      harnesses: [fakeHarness()],
      out: sink,
      err: sink,
    });

    const chunks = parseChunks(lines);
    const errorChunks = chunks.filter((c: any) => c.type === "error");
    expect(errorChunks.length).toBe(1);
    expect(errorChunks[0].message).toContain("custom");

    await rm(tmp, { recursive: true, force: true });
  });

  it("reports harness errors", async () => {
    const tmp = await mkdtemp(join(tmpdir(), "editor-test-"));
    await setupPersona(tmp);
    const { sink, lines } = captureSink();

    const errorHarness = {
      id: "broken",
      available: async () => true,
      async *invoke() {
        yield {
          type: "error" as const,
          error: "connection failed",
          recoverable: true,
        };
      },
    };

    const code = await runEditor({
      payload: { message: "hello" },
      config: fakeConfig(tmp),
      harnesses: [errorHarness],
      out: sink,
      err: sink,
    });

    expect(code).toBe(1);
    const chunks = parseChunks(lines);
    const errorChunks = chunks.filter((c: any) => c.type === "error");
    expect(errorChunks.length).toBeGreaterThanOrEqual(1);

    await rm(tmp, { recursive: true, force: true });
  });

  it("model hint is included in enriched message", async () => {
    const tmp = await mkdtemp(join(tmpdir(), "editor-test-"));
    await setupPersona(tmp);
    const { sink } = captureSink();

    let receivedMessage = "";
    const capturingHarness = {
      id: "fake",
      available: async () => true,
      async *invoke(req: any) {
        receivedMessage = req.userMessage;
        yield { type: "text" as const, text: "ok" };
        yield { type: "done" as const, finalText: "ok", meta: {} };
      },
    };

    await runEditor({
      payload: {
        message: "look at this screenshot",
        modelHint: "vision",
      },
      config: fakeConfig(tmp),
      harnesses: [capturingHarness],
      out: sink,
      err: sink,
    });

    expect(receivedMessage).toContain("vision");

    await rm(tmp, { recursive: true, force: true });
  });

  it("attached files appear in enriched message", async () => {
    const tmp = await mkdtemp(join(tmpdir(), "editor-test-"));
    await setupPersona(tmp);
    const { sink } = captureSink();

    let receivedMessage = "";
    const capturingHarness = {
      id: "fake",
      available: async () => true,
      async *invoke(req: any) {
        receivedMessage = req.userMessage;
        yield { type: "text" as const, text: "ok" };
        yield { type: "done" as const, finalText: "ok", meta: {} };
      },
    };

    await runEditor({
      payload: {
        message: "review this config",
        attachedFiles: [
          { path: "config.toml", content: "[server]\nport = 8080" },
        ],
      },
      config: fakeConfig(tmp),
      harnesses: [capturingHarness],
      out: sink,
      err: sink,
    });

    expect(receivedMessage).toContain("config.toml");
    expect(receivedMessage).toContain("port = 8080");

    await rm(tmp, { recursive: true, force: true });
  });
});
