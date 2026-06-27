/**
 * ACP client handshake + streaming tests.
 *
 * These drive the REAL `AcpClient` over an in-memory `AcpTransport` (a fake
 * duplex) — no real `phantombot acp` subprocess, no `vscode` dependency. The
 * fake transport mirrors the wire contract the server implements: it receives
 * the client's serialized JSON lines, and we feed back exactly the responses /
 * `session/update` notifications the real server emits (grounded in
 * src/connectors/acp/server.ts).
 */

import { describe, expect, test } from "bun:test";

import { AcpClient, type AcpTransport } from "../src/acpClient.ts";
import { resetIdCounter } from "../src/protocol.ts";

/**
 * A fake transport that captures what the client writes and lets the test push
 * lines / stderr / close back. Models the agent side of the pipe.
 */
class FakeTransport implements AcpTransport {
  written: string[] = [];
  private lineHandler: (line: string) => void = () => {};
  private stderrHandler: (text: string) => void = () => {};
  private closeHandler: (info: { code: number | null }) => void = () => {};
  closed = false;

  write(line: string): void {
    this.written.push(line);
  }
  onLine(handler: (line: string) => void): void {
    this.lineHandler = handler;
  }
  onStderr(handler: (text: string) => void): void {
    this.stderrHandler = handler;
  }
  onClose(handler: (info: { code: number | null }) => void): void {
    this.closeHandler = handler;
  }
  close(): void {
    this.closed = true;
  }

  // ── test-side drivers ──
  /** Parse the most recent written message. */
  lastSent(): any {
    return JSON.parse(this.written[this.written.length - 1]!);
  }
  sent(index: number): any {
    return JSON.parse(this.written[index]!);
  }
  /** Push a server line to the client. */
  push(obj: unknown): void {
    this.lineHandler(JSON.stringify(obj));
  }
  pushRaw(line: string): void {
    this.lineHandler(line);
  }
  pushStderr(text: string): void {
    this.stderrHandler(text);
  }
  fireClose(code: number | null): void {
    this.closeHandler({ code });
  }
}

describe("AcpClient — initialize", () => {
  test("sends an initialize request and resolves the negotiated result", async () => {
    resetIdCounter();
    const t = new FakeTransport();
    const client = new AcpClient({ transport: t });

    const p = client.initialize();
    const sent = t.lastSent();
    expect(sent.jsonrpc).toBe("2.0");
    expect(sent.method).toBe("initialize");
    expect(sent.params.protocolVersion).toBe(1);
    expect(typeof sent.id).toBe("number");

    // Reply with the exact shape the server's handleInitialize emits.
    t.push({
      jsonrpc: "2.0",
      id: sent.id,
      result: {
        protocolVersion: 1,
        agentInfo: { name: "Phantombot", version: "0.1.0-dev" },
        authMethods: [],
        agentCapabilities: {
          loadSession: true,
          promptCapabilities: { image: true, audio: false, embeddedContext: true },
        },
      },
    });

    const result = await p;
    expect(result.protocolVersion).toBe(1);
    expect(result.agentInfo?.name).toBe("Phantombot");
    expect(result.agentCapabilities?.loadSession).toBe(true);
  });
});

describe("AcpClient — session/new", () => {
  test("requests a session and returns the minted sessionId", async () => {
    const t = new FakeTransport();
    const client = new AcpClient({ transport: t });

    const p = client.newSession("/home/dev/proj");
    const sent = t.lastSent();
    expect(sent.method).toBe("session/new");
    expect(sent.params.cwd).toBe("/home/dev/proj");
    expect(sent.params.mcpServers).toEqual([]);

    t.push({ jsonrpc: "2.0", id: sent.id, result: { sessionId: "acp_abc123" } });
    expect(await p).toBe("acp_abc123");
  });
});

describe("AcpClient — session/prompt streaming", () => {
  test("streams ordered agent_message_chunks then resolves the stop reason", async () => {
    const t = new FakeTransport();
    const client = new AcpClient({ transport: t });

    const chunks: string[] = [];
    const tools: string[] = [];
    const p = client.prompt("acp_s", "say hi", {
      onText: (txt) => chunks.push(txt),
      onToolCall: (title) => tools.push(title),
    });

    const sent = t.lastSent();
    expect(sent.method).toBe("session/prompt");
    expect(sent.params.sessionId).toBe("acp_s");
    expect(sent.params.prompt).toEqual([{ type: "text", text: "say hi" }]);

    // Agent streams updates exactly as server.ts does.
    t.push({
      jsonrpc: "2.0",
      method: "session/update",
      params: {
        sessionId: "acp_s",
        update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Hello " } },
      },
    });
    t.push({
      jsonrpc: "2.0",
      method: "session/update",
      params: {
        sessionId: "acp_s",
        update: { sessionUpdate: "tool_call", toolCallId: "tool_1", title: "thinking", status: "in_progress" },
      },
    });
    t.push({
      jsonrpc: "2.0",
      method: "session/update",
      params: {
        sessionId: "acp_s",
        update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "world" } },
      },
    });
    // Then the prompt request resolves.
    t.push({ jsonrpc: "2.0", id: sent.id, result: { stopReason: "end_turn" } });

    const stopReason = await p;
    expect(stopReason).toBe("end_turn");
    expect(chunks).toEqual(["Hello ", "world"]);
    expect(tools).toEqual(["thinking"]);
  });

  test("ignores updates for a different sessionId", async () => {
    const t = new FakeTransport();
    const client = new AcpClient({ transport: t });
    const chunks: string[] = [];
    const p = client.prompt("acp_mine", "go", { onText: (txt) => chunks.push(txt) });
    const sent = t.lastSent();

    // An update for a foreign session must NOT leak into this prompt.
    t.push({
      jsonrpc: "2.0",
      method: "session/update",
      params: {
        sessionId: "acp_other",
        update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "leak" } },
      },
    });
    t.push({ jsonrpc: "2.0", id: sent.id, result: { stopReason: "end_turn" } });

    await p;
    expect(chunks).toEqual([]);
  });

  test("cancel sends a session/cancel notification and the prompt settles cancelled", async () => {
    const t = new FakeTransport();
    const client = new AcpClient({ transport: t });
    const p = client.prompt("acp_c", "long task");
    const promptSent = t.lastSent();

    client.cancel("acp_c");
    const cancelMsg = t.lastSent();
    expect(cancelMsg.method).toBe("session/cancel");
    expect(cancelMsg.id).toBeUndefined(); // notification — no id
    expect(cancelMsg.params.sessionId).toBe("acp_c");

    // Server settles the prompt as cancelled (server.ts: abort → stopReason).
    t.push({ jsonrpc: "2.0", id: promptSent.id, result: { stopReason: "cancelled" } });
    expect(await p).toBe("cancelled");
  });
});

describe("AcpClient — session/load replay", () => {
  test("routes replayed user+assistant chunks to the load handlers", async () => {
    const t = new FakeTransport();
    const client = new AcpClient({ transport: t });
    const texts: string[] = [];
    const p = client.loadSession("acp_loaded", "/home/dev/p", {
      onText: (txt) => texts.push(txt),
    });
    const sent = t.lastSent();
    expect(sent.method).toBe("session/load");
    expect(sent.params.sessionId).toBe("acp_loaded");

    // Server replays history as user_message_chunk + agent_message_chunk.
    t.push({
      jsonrpc: "2.0",
      method: "session/update",
      params: {
        sessionId: "acp_loaded",
        update: { sessionUpdate: "user_message_chunk", content: { type: "text", text: "earlier Q" } },
      },
    });
    t.push({
      jsonrpc: "2.0",
      method: "session/update",
      params: {
        sessionId: "acp_loaded",
        update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "earlier A" } },
      },
    });
    // LoadSessionResponse struct — NEVER null (the #207 lesson).
    t.push({ jsonrpc: "2.0", id: sent.id, result: { modes: null } });

    const result = await p;
    expect(result).not.toBeNull();
    expect(texts).toEqual(["earlier Q", "earlier A"]);
  });
});

describe("AcpClient — error + lifecycle handling", () => {
  test("a JSON-RPC error response rejects the request", async () => {
    const t = new FakeTransport();
    const client = new AcpClient({ transport: t });
    const p = client.prompt("acp_bad", "x");
    const sent = t.lastSent();
    t.push({
      jsonrpc: "2.0",
      id: sent.id,
      error: { code: -32602, message: "unknown sessionId 'acp_bad'" },
    });
    await expect(p).rejects.toThrow(/-32602.*unknown sessionId/);
  });

  test("subprocess close rejects all in-flight requests", async () => {
    const t = new FakeTransport();
    const client = new AcpClient({ transport: t });
    const p = client.prompt("acp_s", "hi");
    t.fireClose(1);
    await expect(p).rejects.toThrow(/exited with code 1/);
  });

  test("requests after close reject immediately rather than hanging", async () => {
    const t = new FakeTransport();
    const client = new AcpClient({ transport: t });
    t.fireClose(0);
    await expect(client.newSession("/x")).rejects.toThrow(/closed/);
  });

  test("a non-JSON line is dropped via the diagnostic sink, not thrown", async () => {
    const diags: string[] = [];
    const t = new FakeTransport();
    const client = new AcpClient({ transport: t, onDiagnostic: (d) => diags.push(d) });
    const p = client.initialize();
    const sent = t.lastSent();
    t.pushRaw("this is not json");
    t.push({ jsonrpc: "2.0", id: sent.id, result: { protocolVersion: 1 } });
    await p;
    expect(diags.some((d) => d.includes("non-JSON"))).toBe(true);
  });

  test("stderr from the agent is forwarded to the diagnostic sink", async () => {
    const diags: string[] = [];
    const t = new FakeTransport();
    new AcpClient({ transport: t, onDiagnostic: (d) => diags.push(d) });
    t.pushStderr("[acp] some warning");
    expect(diags).toContain("[acp] some warning");
  });

  test("a short request timeout fires when no response arrives", async () => {
    const t = new FakeTransport();
    const client = new AcpClient({ transport: t, requestTimeoutMs: 10 });
    await expect(client.initialize()).rejects.toThrow(/timed out/);
  });

  test("dispose tears down the transport and rejects pending work", async () => {
    const t = new FakeTransport();
    const client = new AcpClient({ transport: t });
    const p = client.prompt("acp_s", "hi");
    client.dispose();
    expect(t.closed).toBe(true);
    await expect(p).rejects.toThrow();
  });
});
