/**
 * `phantombot ask` — one-shot turn.
 *
 * Loads config, resolves the persona dir, opens memory, builds the harness
 * chain, runs one turn through the orchestrator, and streams the assistant
 * reply to stdout. Progress notes are dropped (re-enable later if --verbose
 * is added). Errors land on stderr and set a non-zero exit code.
 *
 * The bulk of the work is in `runAsk`, exported for testing without going
 * through process.argv / Citty.
 */

import { defineCommand } from "citty";
import { existsSync } from "node:fs";

import { type Config, loadConfig, personaDir } from "../config.ts";
import { ClaudeHarness } from "../harnesses/claude.ts";
import { PiHarness } from "../harnesses/pi.ts";
import type { Harness } from "../harnesses/types.ts";
import type { WriteSink } from "../lib/io.ts";
import { openMemoryStore } from "../memory/store.ts";
import { runTurn } from "../orchestrator/turn.ts";

export interface RunAskInput {
  message: string;
  persona?: string;
  noHistory?: boolean;
  /** stdout sink — defaults to process.stdout. */
  out?: WriteSink;
  /** stderr sink — defaults to process.stderr. */
  err?: WriteSink;
  /** Override config loading (mainly for tests). */
  config?: Config;
}

export async function runAsk(input: RunAskInput): Promise<number> {
  const out = input.out ?? process.stdout;
  const err = input.err ?? process.stderr;

  const config = input.config ?? (await loadConfig());
  const personaName = input.persona ?? config.defaultPersona;
  const dir = personaDir(config, personaName);

  if (!existsSync(dir)) {
    err.write(`persona '${personaName}' not found at ${dir}\n`);
    err.write(
      `run \`phantombot import-persona <openclaw-agent-dir> --as ${personaName}\` to set it up\n`,
    );
    return 2;
  }

  const harnesses = buildHarnessChain(config, err);
  if (harnesses.length === 0) {
    err.write("no harnesses configured (config.harnesses.chain is empty)\n");
    return 2;
  }

  const memory = await openMemoryStore(config.memoryDbPath);

  let exitCode = 0;
  let sawDone = false;

  try {
    for await (const chunk of runTurn({
      persona: personaName,
      conversation: "cli:default",
      userMessage: input.message,
      agentDir: dir,
      harnesses,
      memory,
      timeoutMs: config.turnTimeoutMs,
      noHistory: input.noHistory,
    })) {
      switch (chunk.type) {
        case "text":
          out.write(chunk.text);
          break;
        case "progress":
          // Quiet by default. A future --verbose flag can surface these.
          break;
        case "done":
          out.write("\n");
          sawDone = true;
          break;
        case "error":
          err.write(`error: ${chunk.error}\n`);
          exitCode = 1;
          break;
      }
    }
  } finally {
    await memory.close();
  }

  // Defensive: a stream that ends without `done` or `error` is a harness bug.
  if (!sawDone && exitCode === 0) exitCode = 1;
  return exitCode;
}

function buildHarnessChain(config: Config, err: WriteSink): Harness[] {
  const harnesses: Harness[] = [];
  for (const id of config.harnesses.chain) {
    if (id === "claude") {
      harnesses.push(new ClaudeHarness(config.harnesses.claude));
    } else if (id === "pi") {
      harnesses.push(new PiHarness(config.harnesses.pi));
    } else {
      err.write(`warning: unknown harness '${id}', skipping\n`);
    }
  }
  return harnesses;
}

export default defineCommand({
  meta: {
    name: "ask",
    description: "Send a one-shot message and print the response.",
  },
  args: {
    message: {
      type: "positional",
      description: "The message to send to the agent.",
      required: true,
    },
    persona: {
      type: "string",
      description: "Persona name (overrides the configured default).",
    },
    "no-history": {
      type: "boolean",
      description: "Ignore prior turns from memory for this invocation.",
      default: false,
    },
  },
  async run({ args }) {
    const code = await runAsk({
      message: String(args.message),
      persona: args.persona ? String(args.persona) : undefined,
      noHistory: Boolean(args["no-history"]),
    });
    process.exitCode = code;
  },
});
