/**
 * `phantombot history` — print the most recent N turns from memory for
 * the current persona, oldest first. Both user and assistant turns,
 * across every conversation under that persona.
 */

import { defineCommand } from "citty";
import { type Config, loadConfig } from "../config.ts";
import type { WriteSink } from "../lib/io.ts";
import { openMemoryStore } from "../memory/store.ts";

export interface RunHistoryInput {
  persona?: string;
  n?: number;
  config?: Config;
  out?: WriteSink;
}

export async function runHistory(input: RunHistoryInput = {}): Promise<number> {
  const out = input.out ?? process.stdout;
  const config = input.config ?? (await loadConfig());
  const persona = input.persona ?? config.defaultPersona;
  const n = input.n ?? 20;

  const memory = await openMemoryStore(config.memoryDbPath);
  try {
    const turns = await memory.recentTurnsForDisplay(persona, n);
    if (turns.length === 0) {
      out.write(`no turns recorded for persona '${persona}'\n`);
      return 0;
    }
    out.write(`last ${turns.length} turn(s) for persona '${persona}':\n\n`);
    for (const t of turns) {
      const ts = t.createdAt.toISOString().replace("T", " ").slice(0, 19);
      out.write(`[${ts}] ${t.role} (${t.conversation}):\n`);
      out.write(indent(t.text, "    "));
      out.write("\n\n");
    }
  } finally {
    await memory.close();
  }
  return 0;
}

function indent(text: string, prefix: string): string {
  return text
    .split("\n")
    .map((line) => prefix + line)
    .join("\n");
}

export default defineCommand({
  meta: {
    name: "history",
    description: "Show recent turns from memory for the current persona.",
  },
  args: {
    persona: {
      type: "string",
      description: "Persona name (defaults to the configured default persona).",
    },
    n: {
      type: "string",
      description: "Number of turns to display.",
      default: "20",
    },
  },
  async run({ args }) {
    const n = Number(args.n ?? 20);
    const code = await runHistory({
      persona: args.persona ? String(args.persona) : undefined,
      n: Number.isFinite(n) && n > 0 ? Math.floor(n) : 20,
    });
    process.exitCode = code;
  },
});
