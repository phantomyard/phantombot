/**
 * The OpenCode provider package (src/connectors/acp/opencode/provider/index.mjs)
 * driven against a fake `phantombot acp` child.
 *
 * These are the behaviours that decide whether the integration is usable at all:
 *   - text deltas reach OpenCode, tool_calls never do (OpenCode would try to
 *     execute a tool Phantombot already ran itself);
 *   - only the turns Phantombot has NOT seen are sent (OpenCode replays the whole
 *     transcript, Phantombot owns the memory);
 *   - a diverging transcript starts a NEW session instead of silently resuming
 *     somebody else's conversation;
 *   - cancel is honoured, child death and a missing binary surface as errors
 *     rather than as empty successful replies.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const modulePath = join(root, "src/connectors/acp/opencode/provider/index.mjs");
const fixturePath = join(root, "tests/fixtures/fake-acp-agent.mjs");

const { createPhantombot } = (await import(pathToFileURL(modulePath).href)) as {
  createPhantombot: (settings?: Record<string, unknown>) => {
    languageModel(modelID: string): any;
  };
};

/** One temp dir per test: the fake agent's transcript log lives here. */
let workDir = "";

beforeEach(() => {
  workDir = mkdtempSync(join(tmpdir(), "pb-opencode-provider-"));
  process.env.FAKE_ACP_LOG = join(workDir, "acp.jsonl");
  process.env.FAKE_ACP_ARGV_LOG = join(workDir, "argv.json");
});

afterEach(() => {
  delete process.env.FAKE_ACP_LOG;
  delete process.env.FAKE_ACP_ARGV_LOG;
  delete process.env.FAKE_ACP_DELAY_MS;
  delete process.env.FAKE_ACP_DIE_ON_PROMPT;
  delete process.env.FAKE_ACP_EXIT_AFTER_PROMPT;
  delete process.env.FAKE_ACP_NO_LOAD_SESSION;
  delete process.env.FAKE_ACP_INIT_DELAY_MS;
  try {
    rmSync(workDir, { recursive: true, force: true });
  } catch {
    // best effort
  }
});

function events(): Array<Record<string, any>> {
  try {
    return readFileSync(process.env.FAKE_ACP_LOG!, "utf8")
      .split("\n")
      .filter((line) => line.trim().length > 0)
      .map((line) => JSON.parse(line) as Record<string, any>);
  } catch {
    return [];
  }
}

function prompts(): string[][] {
  return events()
    .filter((entry) => entry.event === "prompt")
    .map((entry) => (entry.prompt as Array<{ type: string; text?: string }>).map((part) => part.text ?? ""));
}

function model(persona: string, extra: Record<string, unknown> = {}) {
  const provider = createPhantombot({
    command: process.execPath,
    args: [fixturePath],
    ...extra,
  });
  return provider.languageModel(persona);
}

/**
 * A model whose child is a SHIM that records its argv and then hands the same
 * stdin/stdout to the fake agent — the only way to observe the DEFAULT argv,
 * because `args` in these tests normally replaces it with the fixture path.
 */
function shimModel(persona: string, extra: Record<string, unknown> = {}) {
  const shimPath = join(workDir, "argv-shim.mjs");
  writeFileSync(
    shimPath,
    [
      `#!${process.execPath}`,
      'import { writeFileSync } from "node:fs";',
      'writeFileSync(process.env.FAKE_ACP_ARGV_LOG, JSON.stringify(process.argv.slice(2)));',
      `await import(${JSON.stringify(pathToFileURL(fixturePath).href)});`,
      "",
    ].join("\n"),
    { mode: 0o755 },
  );
  const provider = createPhantombot({ command: shimPath, ...extra });
  return provider.languageModel(persona);
}

function spawnedArgv(): string[] {
  return JSON.parse(readFileSync(process.env.FAKE_ACP_ARGV_LOG!, "utf8"));
}

function userTurn(text: string) {
  return { role: "user", content: [{ type: "text", text }] };
}

function assistantTurn(text: string) {
  return { role: "assistant", content: [{ type: "text", text }] };
}

async function collect(stream: ReadableStream<any>) {
  const reader = stream.getReader();
  const parts: any[] = [];
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      parts.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  return parts;
}

function textOf(parts: any[]): string {
  return parts
    .filter((part) => part.type === "text-delta")
    .map((part) => part.delta)
    .join("");
}

describe("opencode provider package", () => {
  test("streams text deltas and never emits tool calls", async () => {
    const language = model("streamer");
    const { stream } = await language.doStream({
      prompt: [userTurn("hello there")],
    });
    const parts = await collect(stream);

    expect(textOf(parts)).toBe("echo:hello there");
    expect(parts.some((part) => part.type === "tool-call")).toBe(false);
    expect(parts.some((part) => part.type === "tool-input-start")).toBe(false);
    const finish = parts.at(-1)!;
    expect(finish.type).toBe("finish");
    expect(finish.finishReason.unified).toBe("stop");
    expect(prompts()).toEqual([["hello there"]]);
  });

  test("sends only the unseen turns of a continued conversation", async () => {
    const language = model("dedupe");

    await collect((await language.doStream({ prompt: [userTurn("first")] })).stream);
    await collect(
      (
        await language.doStream({
          prompt: [userTurn("first"), assistantTurn("echo:first"), userTurn("second")],
        })
      ).stream,
    );

    // Phantombot already has "first"; replaying the transcript would double-count it.
    expect(prompts()).toEqual([["first"], ["second"]]);
    // Both turns landed in the SAME ACP session.
    const sessionIds = events()
      .filter((entry) => entry.event === "prompt")
      .map((entry) => entry.sessionId);
    expect(sessionIds[0]).toBe(sessionIds[1]);
    expect(events().filter((entry) => entry.event === "session/new").length).toBe(1);
  });

  test("a different opening message starts a new session", async () => {
    const language = model("forker");

    await collect((await language.doStream({ prompt: [userTurn("alpha")] })).stream);
    await collect((await language.doStream({ prompt: [userTurn("beta")] })).stream);

    expect(events().filter((entry) => entry.event === "session/new").length).toBe(2);
    expect(prompts()).toEqual([["alpha"], ["beta"]]);
  });

  test("a continued turn stays in the same session", async () => {
    const language = model("continuer");

    await collect((await language.doStream({ prompt: [userTurn("start")] })).stream);
    await collect(
      (
        await language.doStream({
          prompt: [userTurn("start"), assistantTurn("echo:start"), userTurn("more")],
        })
      ).stream,
    );

    expect(events().filter((entry) => entry.event === "session/new").length).toBe(1);
    expect(prompts()).toEqual([["start"], ["more"]]);
  });

  test("an EDITED earlier turn branches instead of resuming the other thread", async () => {
    const language = model("brancher");

    await collect((await language.doStream({ prompt: [userTurn("start")] })).stream);
    // The user rewrote the first message: the new transcript is not an extension
    // of the stored one, so it must NOT be fed into that session.
    await collect(
      (
        await language.doStream({
          prompt: [userTurn("start, but rewritten"), assistantTurn("echo:start"), userTurn("go")],
        })
      ).stream,
    );

    expect(events().filter((entry) => entry.event === "session/new").length).toBe(2);
    expect(prompts()).toEqual([["start"], ["go"]]);
  });

  test("answers OpenCode's session-title request locally", async () => {
    const language = model("titles");
    const { stream } = await language.doStream({
      prompt: [
        {
          role: "system",
          content: "You name conversations so the user can find them later in a list of past sessions.",
        },
        userTurn("Add a retry to the billing webhook"),
      ],
    });
    const parts = await collect(stream);

    expect(textOf(parts)).toBe("Add a retry to the billing");
    // No child was spawned and no Phantombot turn was spent on a title.
    expect(events()).toEqual([]);
  });

  test("system-reminders are stripped before the turn is keyed or sent", async () => {
    const language = model("reminders");
    const { stream } = await language.doStream({
      prompt: [userTurn("ship it<system-reminder>noise</system-reminder>")],
    });
    await collect(stream);
    expect(prompts()).toEqual([["ship it"]]);
  });

  test("abort sends session/cancel and closes the turn as cancelled", async () => {
    process.env.FAKE_ACP_DELAY_MS = "400";
    const language = model("aborter");
    const controller = new AbortController();
    const { stream } = await language.doStream({
      prompt: [userTurn("long job")],
      abortSignal: controller.signal,
    });
    setTimeout(() => controller.abort(), 80);
    const parts = await collect(stream);

    expect(events().some((entry) => entry.event === "cancel")).toBe(true);
    const finish = parts.at(-1)!;
    expect(finish.type).toBe("finish");
    expect(finish.finishReason.raw).toBe("cancelled");
  }, 15_000);

  test("a child that dies mid-turn surfaces an error, never an empty reply", async () => {
    process.env.FAKE_ACP_DIE_ON_PROMPT = "1";
    const language = model("dyer");
    const { stream } = await language.doStream({ prompt: [userTurn("boom")] });
    const parts = await collect(stream);

    const error = parts.find((part) => part.type === "error");
    expect(error).toBeDefined();
    expect(String(error.error.message)).toContain("phantombot acp exited");
  });

  test("a missing binary names the fix", async () => {
    const provider = createPhantombot({
      command: "/nonexistent/phantombot-binary",
      args: ["acp"],
    });
    const language = provider.languageModel("missing");
    const { stream } = await language.doStream({ prompt: [userTurn("hi")] });
    const parts = await collect(stream);

    const error = parts.find((part) => part.type === "error");
    expect(error).toBeDefined();
    expect(String(error.error.message)).toContain("phantombot acp install opencode");
  });

  test("a transcript whose ASSISTANT history disagrees starts a new session", async () => {
    const language = model("assistant-history");

    await collect((await language.doStream({ prompt: [userTurn("hello")] })).stream);
    // A different chat that opens with the same word but carries a reply this
    // instance never produced: resuming would attach the private answer we DID
    // produce to it, and the client would see history it never had.
    await collect(
      (
        await language.doStream({
          prompt: [
            userTurn("hello"),
            assistantTurn("A different answer from a different chat"),
            userTurn("summarize MAPLE"),
          ],
        })
      ).stream,
    );

    expect(events().filter((entry) => entry.event === "session/new").length).toBe(2);
    expect(prompts()).toEqual([["hello"], ["summarize MAPLE"]]);
  });

  test("a matching assistant reply keeps the conversation in one session", async () => {
    const language = model("assistant-match");

    await collect((await language.doStream({ prompt: [userTurn("hello")] })).stream);
    await collect(
      (
        await language.doStream({
          prompt: [userTurn("hello"), assistantTurn("echo:hello"), userTurn("again")],
        })
      ).stream,
    );

    expect(events().filter((entry) => entry.event === "session/new").length).toBe(1);
    expect(prompts()).toEqual([["hello"], ["again"]]);
  });

  test("a replaced child re-registers known sessions with session/load", async () => {
    process.env.FAKE_ACP_EXIT_AFTER_PROMPT = "1";
    const language = model("restorer");

    await collect((await language.doStream({ prompt: [userTurn("first")] })).stream);
    // Wait for the child to be gone before continuing, so the provider has to
    // spawn a replacement for the second turn.
    await Bun.sleep(200);

    await collect(
      (
        await language.doStream({
          prompt: [userTurn("first"), assistantTurn("echo:first"), userTurn("second")],
        })
      ).stream,
    );

    const loads = events().filter((entry) => entry.event === "session/load");
    expect(loads.map((entry) => entry.sessionId)).toEqual(["session-1"]);
    // No stale id ever reached the new child.
    expect(events().filter((entry) => entry.event === "unknown-session")).toEqual([]);
    const sessionIds = events()
      .filter((entry) => entry.event === "prompt")
      .map((entry) => entry.sessionId);
    expect(sessionIds).toEqual(["session-1", "session-1"]);
    expect(prompts()).toEqual([["first"], ["second"]]);
  });

  test("sessions are dropped, not reused, when the new child cannot load them", async () => {
    process.env.FAKE_ACP_EXIT_AFTER_PROMPT = "1";
    process.env.FAKE_ACP_NO_LOAD_SESSION = "1";
    const language = model("no-loader");

    await collect((await language.doStream({ prompt: [userTurn("first")] })).stream);
    await Bun.sleep(200);

    const parts = await collect(
      (
        await language.doStream({
          prompt: [userTurn("first"), assistantTurn("echo:first"), userTurn("second")],
        })
      ).stream,
    );

    expect(events().filter((entry) => entry.event === "session/load")).toEqual([]);
    expect(events().filter((entry) => entry.event === "unknown-session")).toEqual([]);
    expect(events().filter((entry) => entry.event === "session/new").length).toBe(2);
    expect(textOf(parts)).toBe("echo:second");
  });

  test("an already-aborted turn never reaches the child", async () => {
    const language = model("pre-aborted");
    const controller = new AbortController();
    controller.abort();

    const { stream } = await language.doStream({
      prompt: [userTurn("DO NOT EXECUTE THIS")],
      abortSignal: controller.signal,
    });
    const parts = await collect(stream);

    // Nothing spawned, nothing sent: no process, no session, no prompt.
    expect(events()).toEqual([]);
    const finish = parts.at(-1)!;
    expect(finish.type).toBe("finish");
    expect(finish.finishReason.raw).toBe("cancelled");
  });

  test("a turn aborted while queued never reaches the child", async () => {
    process.env.FAKE_ACP_DELAY_MS = "400";
    const language = model("queued-abort");

    const first = collect((await language.doStream({ prompt: [userTurn("first")] })).stream);
    const controller = new AbortController();
    const { stream } = await language.doStream({
      prompt: [userTurn("first"), assistantTurn("echo:first"), userTurn("queued turn")],
      abortSignal: controller.signal,
    });
    const queued = collect(stream);

    await Bun.sleep(50);
    controller.abort();

    await first;
    const parts = await queued;

    // Only the first turn was ever sent; the aborted one must not run the agent loop.
    expect(prompts()).toEqual([["first"]]);
    expect(events().some((entry) => entry.event === "cancel")).toBe(false);
    const finish = parts.at(-1)!;
    expect(finish.type).toBe("finish");
    expect(finish.finishReason.raw).toBe("cancelled");
  }, 15_000);

  test("two transcripts matching equally well start a third session", async () => {
    // Ambiguity must NOT be resolved by picking a winner: chat A and chat B both
    // end at [u:X, a:echo:X], so a third turn continuing exactly that state
    // belongs to neither and has to open its own session.
    const language = model("tied");

    await collect((await language.doStream({ prompt: [userTurn("X")] })).stream);
    await collect((await language.doStream({ prompt: [userTurn("X")] })).stream);
    await collect(
      (
        await language.doStream({
          prompt: [userTurn("X"), assistantTurn("echo:X"), userTurn("Z")],
        })
      ).stream,
    );

    expect(events().filter((entry) => entry.event === "session/new").length).toBe(3);
    expect(prompts()).toEqual([["X"], ["X"], ["Z"]]);
  });

  test("a turn aborted while the child is still initializing never prompts it", async () => {
    // The window between the queue-time check and the dispatch-time check: the
    // abort lands inside ensureConnection, so without the second guard the agent
    // loop would run and then race the kill timer.
    process.env.FAKE_ACP_INIT_DELAY_MS = "800";
    const language = model("init-abort");
    const controller = new AbortController();

    const { stream } = await language.doStream({
      prompt: [userTurn("DO NOT EXECUTE THIS")],
      abortSignal: controller.signal,
    });
    const collected = collect(stream);
    await Bun.sleep(120);
    controller.abort();
    const parts = await collected;

    expect(prompts()).toEqual([]);
    const finish = parts.at(-1)!;
    expect(finish.type).toBe("finish");
    expect(finish.finishReason.raw).toBe("cancelled");
  }, 15_000);

  test("a second chat with an identical opening starts a new session", async () => {
    const language = model("same-opening");

    await collect((await language.doStream({ prompt: [userTurn("Hello")] })).stream);
    // Chat B opens with the same word. The wire cannot tell this apart from a
    // retry of chat A's first turn, so the only safe reading is a new thread:
    // resuming would answer B inside A's context.
    await collect((await language.doStream({ prompt: [userTurn("Hello")] })).stream);

    expect(events().filter((entry) => entry.event === "session/new").length).toBe(2);
    expect(prompts()).toEqual([["Hello"], ["Hello"]]);
  });

  test("spawns the CLI with the `--persona=` form its arg parser accepts", async () => {
    const language = shimModel("argv-form");
    await collect((await language.doStream({ prompt: [userTurn("hi")] })).stream);

    // ONE argv entry: the spaced pair is parsed as an unknown COMMAND by citty,
    // so `phantombot acp --persona <id>` never starts a turn for a real user.
    expect(spawnedArgv()).toEqual(["acp", "--persona=argv-form"]);
  });

  test("explicit args override the default argv", async () => {
    const language = shimModel("argv-override", { args: ["acp", "--persona=explicit"] });
    await collect((await language.doStream({ prompt: [userTurn("hi")] })).stream);

    expect(spawnedArgv()).toEqual(["acp", "--persona=explicit"]);
  });

  // Pins the OTHER half of the contract: the form above parses against the real
  // CLI. Skipped (and REPORTED as skipped) where no build is installed — CI has
  // none, so an early `return` would read as coverage it does not have.
  const realBinary = Bun.which("phantombot");
  test.skipIf(!realBinary)("the real CLI accepts the argv the provider builds", async () => {
    const binary = realBinary!;
    const child = Bun.spawnSync({
      cmd: [binary, "acp", "--persona=argv-form"],
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
      timeout: 20_000,
    });
    const stderr = child.stderr.toString();
    expect(stderr).not.toContain("Unknown command");
  }, 30_000);

  test("doGenerate folds the stream into content", async () => {
    const language = model("generator");
    const result = await language.doGenerate({ prompt: [userTurn("ping")] });
    expect(result.content).toEqual([{ type: "text", text: "echo:ping" }]);
    expect(result.finishReason.unified).toBe("stop");
  });
});
