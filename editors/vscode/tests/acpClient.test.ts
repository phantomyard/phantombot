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

import {
  AcpClient,
  buildAcpSpawnCommand,
  resolveSpawnCwd,
  type AcpTransport,
} from "../src/acpClient.ts";
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

describe("buildAcpSpawnCommand — Windows shim safety", () => {
  test("native .exe on Windows spawns directly, no shell wrapper", () => {
    const { command, args } = buildAcpSpawnCommand(
      "C:\\Program Files\\phantombot\\phantombot.exe",
      undefined,
      "win32",
    );
    expect(command).toBe("C:\\Program Files\\phantombot\\phantombot.exe");
    expect(args).toEqual(["acp"]);
  });

  test("non-Windows platform never routes through cmd.exe", () => {
    const { command, args } = buildAcpSpawnCommand(
      "/usr/local/bin/phantombot",
      "megan",
      "linux",
    );
    expect(command).toBe("/usr/local/bin/phantombot");
    expect(args).toEqual(["acp", "--persona", "megan"]);
  });

  test(".cmd shim on Windows goes through cmd.exe /d /s /c with discrete argv", () => {
    const { command, args } = buildAcpSpawnCommand(
      "C:\\npm\\phantombot.cmd",
      "megan",
      "win32",
    );
    expect(command).toBe("cmd.exe");
    expect(args).toEqual([
      "/d",
      "/s",
      "/c",
      "C:\\npm\\phantombot.cmd",
      "acp",
      "--persona",
      "megan",
    ]);
  });

  test(".bat shim on Windows is treated the same as .cmd", () => {
    const { command } = buildAcpSpawnCommand(
      "C:\\npm\\phantombot.bat",
      undefined,
      "win32",
    );
    expect(command).toBe("cmd.exe");
  });

  test("SECURITY: an injection payload in persona stays a single argv element", () => {
    // A malicious .code-workspace could set persona to a cmd-injection string.
    // It must remain one discrete argv token — NOT be split on the `&`, so cmd
    // (with Node's argv quoting) treats it literally and cannot run calc.exe.
    const evil = 'lena" & calc.exe & echo "';
    const { command, args } = buildAcpSpawnCommand(
      "C:\\npm\\phantombot.cmd",
      evil,
      "win32",
    );
    expect(command).toBe("cmd.exe");
    // The payload is exactly one element, untouched — no shell:true parsing.
    expect(args).toEqual([
      "/d",
      "/s",
      "/c",
      "C:\\npm\\phantombot.cmd",
      "acp",
      "--persona",
      evil,
    ]);
    expect(args.filter((a) => a === evil)).toHaveLength(1);
    // And nothing was split into a standalone "calc.exe" token.
    expect(args).not.toContain("calc.exe");
  });
});

describe("available_commands_update", () => {
  test("is captured at session/new, when NO prompt is in flight", async () => {
    // THE BUG: session updates were routed only through `promptStreams`, which
    // is empty outside a prompt — and the server sends the commands menu on
    // session/new and session/load. So every advertisement hit the floor.
    resetIdCounter();
    const t = new FakeTransport();
    const client = new AcpClient({ transport: t });

    const p = client.newSession("/repo");
    const req = t.lastSent();
    t.push({
      jsonrpc: "2.0",
      method: "session/update",
      params: {
        sessionId: "s1",
        update: {
          sessionUpdate: "available_commands_update",
          availableCommands: [
            { name: "stop", description: "Abort the turn that's currently running" },
            {
              name: "harness",
              description: "List or switch the active harness",
              input: { hint: "<harness id> — omit to list" },
            },
          ],
        },
      },
    });
    t.push({ jsonrpc: "2.0", id: req.id, result: { sessionId: "s1" } });
    await p;

    expect(client.availableCommands("s1").map((c) => c.name)).toEqual([
      "stop",
      "harness",
    ]);
    // Unknown sessions are empty, never undefined.
    expect(client.availableCommands("nope")).toEqual([]);
    client.dispose();
  });

  test("does not disturb prompt streaming", async () => {
    resetIdCounter();
    const t = new FakeTransport();
    const client = new AcpClient({ transport: t });

    const chunks: string[] = [];
    const p = client.prompt("s1", "hi", { onText: (x) => chunks.push(x) });
    const req = t.lastSent();
    t.push({
      jsonrpc: "2.0",
      method: "session/update",
      params: {
        sessionId: "s1",
        update: {
          sessionUpdate: "available_commands_update",
          availableCommands: [{ name: "help", description: "Show the available commands" }],
        },
      },
    });
    t.push({
      jsonrpc: "2.0",
      method: "session/update",
      params: {
        sessionId: "s1",
        update: {
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text: "hello" },
        },
      },
    });
    t.push({ jsonrpc: "2.0", id: req.id, result: { stopReason: "end_turn" } });

    expect(await p).toBe("end_turn");
    expect(chunks).toEqual(["hello"]);
    expect(client.availableCommands("s1").map((c) => c.name)).toEqual(["help"]);
    client.dispose();
  });
});

describe("resolveSpawnCwd — untitled-editor ENOENT guard", () => {
  test("returns the candidate cwd when it exists on disk", () => {
    const cwd = resolveSpawnCwd(
      "/home/andrew/project",
      (p) => p === "/home/andrew/project",
      () => "/home/andrew",
    );
    expect(cwd).toBe("/home/andrew/project");
  });

  test(
    "falls back to home when the candidate doesn't exist — the untitled-editor " +
      "repro (spawn ENOENT -4058): VS Code hands an /untitled-1-style resource " +
      "path that is never a real directory",
    () => {
      const cwd = resolveSpawnCwd(
        "/untitled-1",
        () => false,
        () => "/home/andrew",
      );
      expect(cwd).toBe("/home/andrew");
    },
  );

  test("falls back to home when no candidate is given at all", () => {
    const cwd = resolveSpawnCwd(undefined, () => false, () => "/home/andrew");
    expect(cwd).toBe("/home/andrew");
  });

  test("falls back to home when the exists() check itself throws", () => {
    const cwd = resolveSpawnCwd(
      "/some/weird/path",
      () => {
        throw new Error("EPERM");
      },
      () => "/home/andrew",
    );
    expect(cwd).toBe("/home/andrew");
  });

  test("empty-string candidate is treated as absent, falls back to home", () => {
    const cwd = resolveSpawnCwd("   ", () => true, () => "/home/andrew");
    expect(cwd).toBe("/home/andrew");
  });
});
