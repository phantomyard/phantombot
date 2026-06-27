/**
 * Language-Model-Chat-Provider bridge tests.
 *
 * The load-bearing guarantee here is doubling-prevention: VS Code replays the
 * ENTIRE transcript on every turn, but phantombot keeps its own server-side
 * memory, so the bridge must forward ONLY the latest user turn and bin the rest.
 * These tests pin that, plus image/file attachment handling and streaming —
 * all with no `vscode` dependency, against structural fakes.
 */

import { describe, expect, test } from "bun:test";

import {
  driveLmResponse,
  estimateTokens,
  latestUserPrompt,
  LM_ROLE_ASSISTANT,
  LM_ROLE_USER,
  type LmMessageLike,
} from "../src/lmBridge.ts";
import type { AcpClient } from "../src/acpClient.ts";
import type { AcpContentBlock, AcpStopReason } from "../src/protocol.ts";

/** Structural text part (mirrors vscode.LanguageModelTextPart). */
const text = (value: string) => ({ value });
/** Structural data part (mirrors vscode.LanguageModelDataPart). */
const data = (mimeType: string, bytes: Uint8Array) => ({ mimeType, data: bytes });

function msg(role: number, content: unknown[]): LmMessageLike {
  return { role, content };
}

describe("latestUserPrompt — doubling prevention", () => {
  test("drops ALL prior history, forwarding only the latest user turn", () => {
    const messages = [
      msg(LM_ROLE_USER, [text("first question")]),
      msg(LM_ROLE_ASSISTANT, [text("first answer")]),
      msg(LM_ROLE_USER, [text("second question")]),
      msg(LM_ROLE_ASSISTANT, [text("second answer")]),
      msg(LM_ROLE_USER, [text("the new thing I just typed")]),
    ];
    const blocks = latestUserPrompt(messages);
    expect(blocks).toEqual([
      { type: "text", text: "the new thing I just typed" },
    ]);
  });

  test("returns [] when there is no user message (nothing to send)", () => {
    expect(latestUserPrompt([msg(LM_ROLE_ASSISTANT, [text("hi")])])).toEqual([]);
    expect(latestUserPrompt([])).toEqual([]);
  });

  test("ignores trailing assistant/context messages after the last user turn", () => {
    // Even if VS Code appends an assistant scaffold after the user message,
    // we still anchor on the LAST user message's content.
    const messages = [
      msg(LM_ROLE_USER, [text("real prompt")]),
      msg(LM_ROLE_ASSISTANT, [text("injected context blob")]),
    ];
    expect(latestUserPrompt(messages)).toEqual([
      { type: "text", text: "real prompt" },
    ]);
  });

  test("joins multiple text parts of the latest turn", () => {
    const messages = [
      msg(LM_ROLE_USER, [text("part one"), text("part two")]),
    ];
    expect(latestUserPrompt(messages)).toEqual([
      { type: "text", text: "part one\n\npart two" },
    ]);
  });
});

describe("latestUserPrompt — attachments", () => {
  test("pasted/dragged image becomes an ACP image block (base64)", () => {
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47]); // ‹PNG magic›
    const messages = [
      msg(LM_ROLE_USER, [text("what is this?"), data("image/png", png)]),
    ];
    const blocks = latestUserPrompt(messages);
    expect(blocks).toEqual([
      { type: "text", text: "what is this?" },
      {
        type: "image",
        data: Buffer.from(png).toString("base64"),
        mimeType: "image/png",
      },
    ]);
  });

  test("image-only turn (no text) still forwards the image", () => {
    const jpg = new Uint8Array([0xff, 0xd8, 0xff]);
    const blocks = latestUserPrompt([
      msg(LM_ROLE_USER, [data("image/jpeg", jpg)]),
    ]);
    expect(blocks).toEqual([
      {
        type: "image",
        data: Buffer.from(jpg).toString("base64"),
        mimeType: "image/jpeg",
      },
    ]);
  });

  test("dragged non-image file is decoded and folded into the text turn", () => {
    const fileBytes = new TextEncoder().encode("export const x = 1;");
    const blocks = latestUserPrompt([
      msg(LM_ROLE_USER, [
        text("explain this file"),
        data("text/plain", fileBytes),
      ]),
    ]);
    expect(blocks).toEqual([
      { type: "text", text: "explain this file\n\nexport const x = 1;" },
    ]);
  });

  test("tool-call / unknown parts are dropped", () => {
    const blocks = latestUserPrompt([
      msg(LM_ROLE_USER, [
        text("hi"),
        { callId: "c1", name: "someTool", input: {} }, // tool-call-ish
        { weird: true },
      ]),
    ]);
    expect(blocks).toEqual([{ type: "text", text: "hi" }]);
  });
});

// ── driveLmResponse ───────────────────────────────────────────────────────

interface FakeClient extends AcpClient {
  cancels: string[];
  promptedBlocks: AcpContentBlock[] | undefined;
}

function makeFakeClient(opts: {
  text?: string[];
  stopReason?: AcpStopReason;
  blockUntilCancel?: boolean;
}): FakeClient {
  const cancels: string[] = [];
  let cancelled = false;
  let release: (() => void) | undefined;
  const fake = {
    cancels,
    promptedBlocks: undefined as AcpContentBlock[] | undefined,
    cancel(sessionId: string) {
      cancels.push(sessionId);
      cancelled = true;
      release?.();
    },
    async prompt(
      _sessionId: string,
      blocks: AcpContentBlock[],
      handlers: { onText?(t: string): void },
    ): Promise<AcpStopReason> {
      fake.promptedBlocks = blocks;
      for (const t of opts.text ?? []) handlers.onText?.(t);
      if (opts.blockUntilCancel) {
        // Settle as cancelled once the cancel notification has arrived,
        // regardless of cancel/prompt ordering (mirrors the server).
        if (!cancelled) await new Promise<void>((r) => (release = r));
        return "cancelled";
      }
      return opts.stopReason ?? "end_turn";
    },
  };
  return fake as unknown as FakeClient;
}

describe("driveLmResponse", () => {
  test("streams text chunks via makeTextPart and returns the stop reason", async () => {
    const client = makeFakeClient({ text: ["Hello ", "world"] });
    const reported: string[] = [];
    const blocks: AcpContentBlock[] = [{ type: "text", text: "hi" }];
    const stop = await driveLmResponse({
      client,
      sessionId: "acp_s",
      blocks,
      progress: { report: (p: { v: string }) => reported.push(p.v) },
      makeTextPart: (t) => ({ v: t }),
    });
    expect(reported).toEqual(["Hello ", "world"]);
    expect(stop).toBe("end_turn");
    // The exact reduced blocks reach the agent — nothing extra stapled on.
    expect(client.promptedBlocks).toEqual(blocks);
  });

  test("a pre-cancelled token fires session/cancel up front", async () => {
    const client = makeFakeClient({ blockUntilCancel: true });
    const stop = await driveLmResponse({
      client,
      sessionId: "acp_s",
      blocks: [{ type: "text", text: "hi" }],
      progress: { report: () => {} },
      makeTextPart: (t) => ({ v: t }),
      token: {
        isCancellationRequested: true,
        onCancellationRequested: () => ({ dispose: () => {} }),
      },
    });
    expect(client.cancels).toEqual(["acp_s"]);
    expect(stop).toBe("cancelled");
  });
});

describe("estimateTokens", () => {
  test("empty string is zero", () => {
    expect(estimateTokens("")).toBe(0);
  });
  test("~4 chars per token, at least 1", () => {
    expect(estimateTokens("a")).toBe(1);
    expect(estimateTokens("12345678")).toBe(2);
  });
});
