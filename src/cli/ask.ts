/**
 * `phantombot ask <prompt>` — fire a single prompt through the same
 * persona + harness chain that backs the long-running `run` listener,
 * print the assistant's final reply to stdout, and exit.
 *
 * Designed for callers that want Robbie's brain as a one-shot tool:
 *   - the voice agent's old `ask_robbie` relay (formerly an HTTP POST to
 *     OpenClaw on 127.0.0.1:18789);
 *   - shell scripts and other local tooling that want a quick answer
 *     without standing up a Telegram conversation.
 *
 * Defaults to `--no-history`, so each invocation is stateless. The
 * persona files (SOUL.md, IDENTITY.md, MEMORY.md, etc.) are still loaded
 * into the system prompt every call — only the rolling conversation
 * history is suppressed. Pass `--history` plus `--conversation <id>` to
 * thread asks together (e.g. for a multi-turn debugging session).
 *
 * Output is the FINAL assistant text only — no progress chatter, no
 * tool-call traces, no trailing newline beyond what the harness emits.
 * That keeps `phantombot ask` cleanly composable with shell pipes and
 * `child_process.exec` callers.
 *
 * Exit codes:
 *   0  success
 *   1  generic failure (lock contention, harness chain produced no text)
 *   2  configuration error (no harnesses, persona missing, missing prompt)
 */

import { defineCommand } from "citty";
import { existsSync } from "node:fs";

import { type Config, loadConfig, personaDir } from "../config.ts";
import { buildHarnessChain } from "../harnesses/buildChain.ts";
import type { Harness } from "../harnesses/types.ts";
import type { WriteSink } from "../lib/io.ts";
import { openMemoryStore, type MemoryStore } from "../memory/store.ts";
import { runTurn } from "../orchestrator/turn.ts";

export interface RunAskInput {
  /** The user prompt. Required. */
  prompt: string;
  /** Override the persona (default: config.defaultPersona). */
  persona?: string;
  /** Conversation key for history scoping. Default "cli:ask". */
  conversation?: string;
  /** Persist + load history for this conversation. Default false (stateless). */
  history?: boolean;
  /**
   * Stream assistant text to `out` as `text` chunks arrive, instead of
   * buffering and writing the final reply at the end. Lets downstream
   * consumers (e.g. the voice agent's Twilio relay) start TTS on the
   * first sentence while the rest is still being generated.
   *
   * Tool-call chatter never reaches us as `text` chunks — runTurn
   * surfaces those as `progress`/`heartbeat` — so streaming is safe:
   * what hits stdout is exactly the assistant's spoken reply.
   */
  stream?: boolean;
  /** Test injection points. */
  config?: Config;
  memory?: MemoryStore;
  harnesses?: Harness[];
  out?: WriteSink;
  err?: WriteSink;
  signal?: AbortSignal;
}

export async function runAsk(input: RunAskInput): Promise<number> {
  const out = input.out ?? process.stdout;
  const err = input.err ?? process.stderr;

  const prompt = input.prompt?.trim();
  if (!prompt) {
    err.write("phantombot ask: empty prompt\n");
    return 2;
  }

  const config = input.config ?? (await loadConfig());
  const persona = input.persona ?? config.defaultPersona;
  const agentDir = personaDir(config, persona);
  if (!existsSync(agentDir)) {
    err.write(
      `phantombot ask: persona '${persona}' not found at ${agentDir}\n`,
    );
    return 2;
  }

  const harnesses = input.harnesses ?? buildHarnessChain(config, err);
  if (harnesses.length === 0) {
    err.write(
      "phantombot ask: no harnesses configured. Run `phantombot harness` to pick at least one.\n",
    );
    return 2;
  }

  const memory =
    input.memory ?? (await openMemoryStore(config.memoryDbPath));
  const ownsMemory = !input.memory;

  const stream = input.stream === true;
  let finalText = "";
  let succeeded = false;
  try {
    for await (const chunk of runTurn({
      persona,
      conversation: input.conversation ?? "cli:ask",
      userMessage: prompt,
      agentDir,
      harnesses,
      memory,
      idleTimeoutMs: config.harnessIdleTimeoutMs,
      hardTimeoutMs: config.harnessHardTimeoutMs,
      noHistory: !input.history,
      // Streaming consumers benefit from pre-tool narration: the
      // assistant's intent sentence flushes to stdout before the
      // tool's silence begins. Non-streaming consumers see the whole
      // reply at the end anyway, so narration is just bloat there.
      // `phantombot ask --stream` is also what the voice agent's
      // Twilio relay calls into — Twilio gets the same benefit for
      // free, no Twilio-specific code path needed.
      toolNarration: stream,
      signal: input.signal,
    })) {
      if (chunk.type === "text") {
        finalText += chunk.text;
        if (stream) {
          // Flush each text chunk straight to stdout as it lands.
          // text chunks are guaranteed assistant-spoken text only —
          // tool calls / chain-of-thought come through as
          // progress/heartbeat and are dropped here, same as
          // non-stream mode.
          out.write(chunk.text);
        }
      }
      if (chunk.type === "done") {
        // In non-stream mode we prefer the harness's authoritative
        // finalText (it may be reformatted). In stream mode we've
        // already flushed everything, so we just mark success and
        // skip the final write below — re-emitting finalText would
        // duplicate the reply on stdout.
        finalText = chunk.finalText;
        succeeded = true;
      }
    }
  } catch (e) {
    err.write(`phantombot ask: ${(e as Error).message}\n`);
    if (ownsMemory) await memory.close();
    return 1;
  }

  if (ownsMemory) await memory.close();

  if (!succeeded) {
    err.write("phantombot ask: harness chain produced no final reply\n");
    return 1;
  }

  if (!stream) {
    out.write(finalText);
  }
  // Trail a newline if the harness didn't, so shell consumers don't get
  // a half-line at the prompt. Idempotent: if finalText already ends
  // with \n we leave it alone. Applies to both modes: a streamed run
  // also benefits from a clean line terminator.
  if (!finalText.endsWith("\n")) out.write("\n");
  return 0;
}

export default defineCommand({
  meta: {
    name: "ask",
    description:
      "Run one prompt through the persona + harness chain, print the reply to stdout, and exit. Stateless by default; pass --history --conversation <id> to thread.",
  },
  args: {
    prompt: {
      type: "positional",
      required: true,
      description:
        'The prompt to send. Quote it if it has spaces. Pass "-" to read from stdin instead.',
    },
    persona: {
      type: "string",
      description:
        "Persona name to use (default: the configured default persona).",
    },
    conversation: {
      type: "string",
      description:
        'Conversation key for history scoping (default: "cli:ask"). Only meaningful with --history.',
    },
    history: {
      type: "boolean",
      description:
        "Persist this turn and load prior turns for the conversation. Default off (stateless).",
      default: false,
    },
    stream: {
      type: "boolean",
      description:
        "Stream assistant text to stdout as chunks arrive (lower latency for downstream consumers).",
      default: false,
    },
  },
  async run({ args }) {
    let prompt = String(args.prompt ?? "");
    if (prompt === "-") {
      try {
        prompt = await readAllStdin();
      } catch (e) {
        process.stderr.write(`phantombot ask: ${(e as Error).message}\n`);
        process.exitCode = 2;
        return;
      }
    }
    process.exitCode = await runAsk({
      prompt,
      persona: args.persona ? String(args.persona) : undefined,
      conversation: args.conversation ? String(args.conversation) : undefined,
      history: Boolean(args.history),
      stream: Boolean(args.stream),
    });
  },
});

/**
 * Read all of stdin to a string. Refuses to read from a TTY — if the
 * caller asked for `-` but stdin isn't piped, we'd hang forever waiting
 * for an EOF that only arrives on Ctrl-D. Failing fast with a clear
 * message is friendlier than a silent hang. (Flagged by Kai in PR #71.)
 */
export async function readAllStdin(
  stdin: NodeJS.ReadStream = process.stdin,
): Promise<string> {
  if (stdin.isTTY) {
    throw new Error(
      'cannot read prompt from "-": stdin is a TTY. ' +
        'Pipe input (e.g. `echo "hi" | phantombot ask -`) ' +
        "or pass the prompt as an argument.",
    );
  }
  const chunks: Buffer[] = [];
  for await (const chunk of stdin) {
    chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
  }
  return Buffer.concat(chunks).toString("utf8");
}
