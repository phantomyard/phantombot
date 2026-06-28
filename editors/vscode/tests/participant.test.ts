/**
 * Participant-bridge tests.
 *
 * `bridgePromptToStream` is written against minimal structural interfaces so it
 * runs with no `vscode` dependency. We drive it with a fake ACP client (the
 * shape extension.ts uses) and a fake response stream, asserting that streamed
 * chunks land in the panel, tool calls become progress notes, and cancellation
 * fires session/cancel.
 */

import { describe, expect, test } from "bun:test";

import {
  bridgePromptToStream,
  type CancellationLike,
  type ResponseStream,
} from "../src/participant.ts";
import type { AcpClient } from "../src/acpClient.ts";
import type { AcpStopReason } from "../src/protocol.ts";

/** A fake stream recording markdown + progress writes. */
class FakeStream implements ResponseStream {
  md: string[] = [];
  prog: string[] = [];
  markdown(value: string): void {
    this.md.push(value);
  }
  progress(value: string): void {
    this.prog.push(value);
  }
}

/** A controllable cancellation token. */
class FakeToken implements CancellationLike {
  isCancellationRequested = false;
  private listeners: (() => void)[] = [];
  onCancellationRequested(listener: () => void): { dispose(): void } {
    this.listeners.push(listener);
    return { dispose: () => {} };
  }
  fire(): void {
    this.isCancellationRequested = true;
    for (const l of this.listeners) l();
  }
}

/**
 * A fake ACP client that, on prompt(), drives the supplied handlers with a
 * scripted set of chunks, then resolves a stop reason. Records cancels.
 */
function makeFakeClient(opts: {
  text?: string[];
  tools?: { title: string; status: string }[];
  stopReason?: AcpStopReason;
  /** If set, prompt() waits for cancel() before resolving (cancellation test). */
  blockUntilCancel?: boolean;
}): AcpClient & { cancels: string[]; sent: unknown[] } {
  const cancels: string[] = [];
  const sent: unknown[] = [];
  let cancelled = false;
  let releaseOnCancel: (() => void) | undefined;
  const fake = {
    cancels,
    sent,
    cancel(sessionId: string) {
      cancels.push(sessionId);
      cancelled = true;
      releaseOnCancel?.();
    },
    async prompt(
      _sessionId: string,
      _prompt: unknown,
      handlers: {
        onText?(t: string): void;
        onToolCall?(title: string, status: string): void;
      },
    ): Promise<AcpStopReason> {
      sent.push(_prompt);
      for (const t of opts.text ?? []) handlers.onText?.(t);
      for (const tc of opts.tools ?? []) handlers.onToolCall?.(tc.title, tc.status);
      if (opts.blockUntilCancel) {
        // The server settles a prompt as cancelled once the cancel notification
        // arrives — model that here regardless of cancel/prompt ordering.
        if (!cancelled) {
          await new Promise<void>((resolve) => {
            releaseOnCancel = resolve;
          });
        }
        return "cancelled";
      }
      return opts.stopReason ?? "end_turn";
    },
  };
  return fake as unknown as AcpClient & { cancels: string[] };
}

describe("bridgePromptToStream", () => {
  test("streams text chunks into the panel as markdown and returns the stop reason", async () => {
    const client = makeFakeClient({ text: ["Hello ", "world"], stopReason: "end_turn" });
    const stream = new FakeStream();
    const result = await bridgePromptToStream({
      client,
      sessionId: "acp_s",
      request: { prompt: "hi" },
      stream,
    });
    expect(stream.md).toEqual(["Hello ", "world"]);
    expect(result.stopReason).toBe("end_turn");
  });

  test("sends pre-built blocks verbatim when present (carries attachments)", async () => {
    const client = makeFakeClient({ text: ["ok"], stopReason: "end_turn" });
    const stream = new FakeStream();
    const blocks = [
      { type: "text", text: "look" },
      { type: "image", data: "BASE64", mimeType: "image/png" },
    ] as never;
    await bridgePromptToStream({
      client,
      sessionId: "acp_b",
      request: { prompt: "look", blocks },
      stream,
    });
    // The image block must reach the agent untouched — not be flattened to text.
    expect(client.sent[0]).toEqual(blocks);
  });

  test("falls back to prompt text when no blocks are supplied", async () => {
    const client = makeFakeClient({ text: ["ok"], stopReason: "end_turn" });
    const stream = new FakeStream();
    await bridgePromptToStream({
      client,
      sessionId: "acp_t",
      request: { prompt: "just text" },
      stream,
    });
    expect(client.sent[0]).toBe("just text");
  });

  test("maps tool_call updates to progress notes", async () => {
    const client = makeFakeClient({
      text: ["done"],
      tools: [{ title: "searching", status: "in_progress" }],
    });
    const stream = new FakeStream();
    await bridgePromptToStream({
      client,
      sessionId: "acp_s",
      request: { prompt: "find x" },
      stream,
    });
    expect(stream.prog).toEqual(["searching"]);
    expect(stream.md).toEqual(["done"]);
  });

  test("a pre-cancelled token fires session/cancel up front", async () => {
    const client = makeFakeClient({ blockUntilCancel: true });
    const token = new FakeToken();
    token.isCancellationRequested = true;
    const stream = new FakeStream();
    const result = await bridgePromptToStream({
      client,
      sessionId: "acp_pc",
      request: { prompt: "go" },
      stream,
      token,
    });
    expect(client.cancels).toContain("acp_pc");
    expect(result.stopReason).toBe("cancelled");
  });

  test("cancelling mid-turn fires session/cancel and settles cancelled", async () => {
    const client = makeFakeClient({ text: ["working"], blockUntilCancel: true });
    const token = new FakeToken();
    const stream = new FakeStream();
    const promise = bridgePromptToStream({
      client,
      sessionId: "acp_mid",
      request: { prompt: "long" },
      stream,
      token,
    });
    // Let the prompt emit its first chunk, then cancel.
    await new Promise((r) => setImmediate(r));
    token.fire();
    const result = await promise;
    expect(client.cancels).toEqual(["acp_mid"]);
    expect(result.stopReason).toBe("cancelled");
    expect(stream.md).toEqual(["working"]);
  });

  test("client errors propagate so the caller can render them", async () => {
    const failing = {
      cancel() {},
      async prompt(): Promise<AcpStopReason> {
        throw new Error("subprocess died");
      },
    } as unknown as AcpClient;
    await expect(
      bridgePromptToStream({
        client: failing,
        sessionId: "acp_e",
        request: { prompt: "x" },
        stream: new FakeStream(),
      }),
    ).rejects.toThrow(/subprocess died/);
  });
});
