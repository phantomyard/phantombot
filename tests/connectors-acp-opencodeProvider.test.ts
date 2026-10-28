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
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
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
});

afterEach(() => {
  delete process.env.FAKE_ACP_LOG;
  delete process.env.FAKE_ACP_DELAY_MS;
  delete process.env.FAKE_ACP_DIE_ON_PROMPT;
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

  test("doGenerate folds the stream into content", async () => {
    const language = model("generator");
    const result = await language.doGenerate({ prompt: [userTurn("ping")] });
    expect(result.content).toEqual([{ type: "text", text: "echo:ping" }]);
    expect(result.finishReason.unified).toBe("stop");
  });
});
