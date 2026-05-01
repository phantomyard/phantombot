/**
 * Interactive chat REPL for `phantombot chat`.
 *
 * Uses node:readline (works under Bun) with a persisted history file at
 * $XDG_DATA_HOME/phantombot/repl-history. Slash commands (/help, /persona,
 * /clear, /history, /quit) are handled inline; anything else gets routed
 * through runTurn and streamed to stdout token-by-token.
 *
 * Ctrl-C aborts the in-flight turn (kills the harness subprocess via
 * AbortController) and re-prompts. Ctrl-D exits cleanly.
 *
 * runChat does the wiring; handleSlash is exported separately so the
 * slash command dispatch is unit-testable without driving readline.
 */

import * as readline from "node:readline";
import { existsSync } from "node:fs";
import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import {
  type Config,
  loadConfig,
  personaDir,
  xdgDataHome,
} from "../config.ts";
import { ClaudeHarness } from "../harnesses/claude.ts";
import { PiHarness } from "../harnesses/pi.ts";
import type { Harness } from "../harnesses/types.ts";
import type { WriteSink } from "../lib/io.ts";
import { type MemoryStore, openMemoryStore } from "../memory/store.ts";
import { runTurn } from "../orchestrator/turn.ts";

const SLASH_HELP: ReadonlyArray<readonly [string, string]> = [
  ["/help", "show this help"],
  ["/persona <name>", "switch persona for this session"],
  ["/clear", "clear the screen"],
  ["/history", "show recent turns from memory"],
  ["/quit", "exit (Ctrl-D also works)"],
];

export interface SlashContext {
  config: Config;
  persona: string;
  memory: MemoryStore;
  out: WriteSink;
  err: WriteSink;
  setPersona: (name: string) => void;
}

export type SlashResult = "continue" | "quit" | "unknown";

export async function handleSlash(
  line: string,
  ctx: SlashContext,
): Promise<SlashResult> {
  const parts = line.trim().split(/\s+/);
  const cmd = parts[0];
  const rest = parts.slice(1);

  switch (cmd) {
    case "/help":
      ctx.out.write("commands:\n");
      for (const [k, v] of SLASH_HELP) ctx.out.write(`  ${k.padEnd(20)} ${v}\n`);
      return "continue";

    case "/quit":
    case "/exit":
      return "quit";

    case "/clear":
      ctx.out.write("\x1b[2J\x1b[H");
      return "continue";

    case "/persona": {
      const name = rest[0];
      if (!name) {
        ctx.err.write("usage: /persona <name>\n");
        return "continue";
      }
      const dir = personaDir(ctx.config, name);
      if (!existsSync(dir)) {
        ctx.err.write(`persona '${name}' not found at ${dir}\n`);
        return "continue";
      }
      ctx.setPersona(name);
      ctx.out.write(`switched to persona: ${name}\n`);
      return "continue";
    }

    case "/history": {
      const turns = await ctx.memory.recentTurnsForDisplay(ctx.persona, 10);
      if (turns.length === 0) {
        ctx.out.write(`no turns recorded for persona '${ctx.persona}'\n`);
      } else {
        for (const t of turns) {
          const ts = t.createdAt.toISOString().replace("T", " ").slice(0, 19);
          const truncated =
            t.text.length > 100 ? t.text.slice(0, 100) + "..." : t.text;
          ctx.out.write(`[${ts}] ${t.role}: ${truncated}\n`);
        }
      }
      return "continue";
    }

    default:
      ctx.err.write(`unknown command: ${cmd} (try /help)\n`);
      return "unknown";
  }
}

export interface RunChatInput {
  persona?: string;
  /** Override config for testing. */
  config?: Config;
}

export async function runChat(input: RunChatInput = {}): Promise<number> {
  const out = process.stdout;
  const err = process.stderr;

  const config = input.config ?? (await loadConfig());
  let persona = input.persona ?? config.defaultPersona;

  let dir = personaDir(config, persona);
  if (!existsSync(dir)) {
    err.write(`persona '${persona}' not found at ${dir}\n`);
    err.write(
      `import one with \`phantombot import-persona <openclaw-agent-dir>\`\n`,
    );
    return 2;
  }

  const harnesses = buildHarnessChain(config, err);
  if (harnesses.length === 0) {
    err.write("no harnesses configured\n");
    return 2;
  }

  const memory = await openMemoryStore(config.memoryDbPath);
  const historyPath = join(xdgDataHome(), "phantombot", "repl-history");
  await ensureFile(historyPath);
  const seedHistory = await loadHistoryLines(historyPath);

  const rl = readline.createInterface({
    input: process.stdin,
    output: out,
    terminal: true,
    historySize: 1000,
  });
  // node:readline tracks history internally; seed it most-recent-first.
  const rlAny = rl as unknown as { history?: string[] };
  if (Array.isArray(rlAny.history)) rlAny.history.unshift(...seedHistory);

  out.write(`phantombot chat — persona: ${persona}\n`);
  out.write(`type /help for commands, Ctrl-D to exit\n\n`);
  rl.setPrompt("> ");
  rl.prompt();

  let abort: AbortController | undefined;

  rl.on("SIGINT", () => {
    if (abort) {
      abort.abort();
    } else {
      out.write("\n(use Ctrl-D to exit, or /quit)\n");
      rl.prompt();
    }
  });

  return new Promise<number>((resolve) => {
    rl.on("close", async () => {
      out.write("\n");
      await memory.close();
      resolve(0);
    });

    rl.on("line", async (raw) => {
      const line = raw.trim();
      if (!line) {
        rl.prompt();
        return;
      }

      void appendFile(historyPath, line + "\n", "utf8").catch(() => {});

      if (line.startsWith("/")) {
        const result = await handleSlash(line, {
          config,
          persona,
          memory,
          out,
          err,
          setPersona: (next) => {
            persona = next;
            dir = personaDir(config, next);
          },
        });
        if (result === "quit") {
          rl.close();
          return;
        }
        rl.prompt();
        return;
      }

      abort = new AbortController();
      try {
        let sawDone = false;
        for await (const chunk of runTurn({
          persona,
          conversation: "cli:default",
          userMessage: line,
          agentDir: dir,
          harnesses,
          memory,
          timeoutMs: config.turnTimeoutMs,
        })) {
          if (abort.signal.aborted) break;
          switch (chunk.type) {
            case "text":
              out.write(chunk.text);
              break;
            case "progress":
              break;
            case "done":
              out.write("\n");
              sawDone = true;
              break;
            case "error":
              err.write(`\nerror: ${chunk.error}\n`);
              break;
          }
        }
        if (abort.signal.aborted) out.write("\n[aborted]\n");
        else if (!sawDone) out.write("\n");
      } catch (e) {
        err.write(`\nerror: ${(e as Error).message}\n`);
      } finally {
        abort = undefined;
        out.write("\n");
        rl.prompt();
      }
    });
  });
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

async function loadHistoryLines(path: string): Promise<string[]> {
  try {
    const text = await readFile(path, "utf8");
    return text.split("\n").filter((l) => l.length > 0).reverse();
  } catch {
    return [];
  }
}

async function ensureFile(path: string): Promise<void> {
  if (existsSync(path)) return;
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, "", "utf8");
}
