/**
 * Fake `phantombot acp` child used by tests/connectors-acp-opencodeProvider.test.ts.
 *
 * Speaks the same newline-delimited JSON-RPC 2.0 slice the real server does
 * (initialize / authenticate / session.new / session.prompt / session.cancel)
 * and records every prompt it receives so the test can assert exactly which
 * turns the provider decided to send.
 *
 * Env knobs:
 *   FAKE_ACP_LOG=<path>        JSONL of {event, ...} — prompts, cancels, exits
 *   FAKE_ACP_DELAY_MS=<n>      delay before answering session/prompt
 *   FAKE_ACP_DIE_ON_PROMPT=1   exit(3) instead of answering (mid-turn death)
 */

import { appendFileSync } from "node:fs";
import { createInterface } from "node:readline";

const logPath = process.env.FAKE_ACP_LOG;
const delay = Number(process.env.FAKE_ACP_DELAY_MS ?? "0");
const dieOnPrompt = process.env.FAKE_ACP_DIE_ON_PROMPT === "1";

function record(entry) {
  if (!logPath) return;
  try {
    appendFileSync(logPath, `${JSON.stringify(entry)}\n`);
  } catch {
    // logging is best-effort
  }
}

let sessionSeq = 0;
/** sessionId → pending prompt state */
const pending = new Map();

function send(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

function text(update) {
  return { jsonrpc: "2.0", method: "session/update", params: update };
}

const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });
rl.on("line", (line) => {
  const trimmed = line.trim();
  if (!trimmed) return;
  let message;
  try {
    message = JSON.parse(trimmed);
  } catch {
    return;
  }

  switch (message.method) {
    case "initialize":
      record({ event: "initialize" });
      send({
        jsonrpc: "2.0",
        id: message.id,
        result: {
          protocolVersion: 1,
          agentInfo: { name: "fake-phantombot", version: "0.0.0" },
          authMethods: [],
          agentCapabilities: { loadSession: true },
        },
      });
      return;
    case "authenticate":
      send({ jsonrpc: "2.0", id: message.id, result: null });
      return;
    case "session/new": {
      sessionSeq += 1;
      const sessionId = `session-${sessionSeq}`;
      record({ event: "session/new", sessionId, cwd: message.params?.cwd });
      send({ jsonrpc: "2.0", id: message.id, result: { sessionId } });
      return;
    }
    case "session/prompt": {
      const sessionId = message.params?.sessionId;
      const prompt = message.params?.prompt ?? [];
      record({ event: "prompt", sessionId, prompt, id: message.id });

      if (dieOnPrompt) {
        record({ event: "die", sessionId });
        process.exit(3);
      }

      const textValue = prompt.map((part) => (part?.type === "text" ? part.text : "")).join("\n");
      const state = { id: message.id, sessionId, cancelled: false };
      pending.set(sessionId, state);

      const finish = () => {
        if (!pending.has(sessionId)) return;
        pending.delete(sessionId);
        send({
          jsonrpc: "2.0",
          id: state.id,
          result: { stopReason: state.cancelled ? "cancelled" : "end_turn" },
        });
      };

      setTimeout(() => {
        if (!state.cancelled) {
          send(text({ sessionId, update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "echo:" } } }));
          send(text({ sessionId, update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: textValue } } }));
          send(
            text({
              sessionId,
              update: {
                sessionUpdate: "tool_call",
                toolCallId: "t1",
                title: "reading a file",
                status: "completed",
              },
            }),
          );
        }
        finish();
      }, delay);
      return;
    }
    case "session/cancel": {
      const sessionId = message.params?.sessionId;
      record({ event: "cancel", sessionId });
      const state = pending.get(sessionId);
      if (state) state.cancelled = true;
      return;
    }
    default:
      return;
  }
});

process.on("SIGTERM", () => process.exit(0));
