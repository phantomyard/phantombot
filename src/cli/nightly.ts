/**
 * `phantombot nightly` — runs the cognitive distillation pass.
 *
 * Spawns the harness once with the nightly prompt as a system-prompt
 * suffix and the prompt body as the user message. Conversation key is
 * `system:nightly:<YYYY-MM-DD>` so it's isolated from Telegram chats
 * and from any other phantombot conversation namespace.
 *
 * Schedule: runs daily at 02:00 local via systemd timer (installed
 * by `phantombot install`). Manual invocation works the same.
 */

import { defineCommand } from "citty";
import { existsSync } from "node:fs";

import { type Config, loadConfig, personaDir } from "../config.ts";
import { ClaudeHarness } from "../harnesses/claude.ts";
import { PiHarness } from "../harnesses/pi.ts";
import type { Harness } from "../harnesses/types.ts";
import type { WriteSink } from "../lib/io.ts";
import { log } from "../lib/logger.ts";
import {
  buildNightlyPromptForPersona,
  nightlyConversationKey,
  saveNightlyState,
} from "../lib/nightly.ts";
import { openMemoryStore } from "../memory/store.ts";
import { runTurn } from "../orchestrator/turn.ts";

export interface RunNightlyInput {
  config?: Config;
  persona?: string;
  /** Override "today" — useful for backfill or testing. ISO YYYY-MM-DD. */
  today?: string;
  out?: WriteSink;
  err?: WriteSink;
}

export async function runNightly(input: RunNightlyInput = {}): Promise<number> {
  const out = input.out ?? process.stdout;
  const err = input.err ?? process.stderr;

  const config = input.config ?? (await loadConfig());
  const persona = input.persona ?? config.defaultPersona;
  const dir = personaDir(config, persona);
  if (!existsSync(dir)) {
    err.write(`persona '${persona}' not found at ${dir}\n`);
    return 2;
  }

  const harnesses = buildHarnessChain(config, err);
  if (harnesses.length === 0) {
    err.write("no harnesses configured\n");
    return 2;
  }

  const today = input.today ?? new Date().toISOString().slice(0, 10);
  const conversation = nightlyConversationKey(today);
  const prompt = await buildNightlyPromptForPersona(dir, persona, today);

  out.write(
    `nightly: persona='${persona}' date=${today} conversation=${conversation}\n`,
  );

  const memory = await openMemoryStore(config.memoryDbPath);
  const startedAt = Date.now();
  let finalReply = "";
  let errored: string | undefined;

  try {
    for await (const chunk of runTurn({
      persona,
      conversation,
      userMessage: prompt,
      agentDir: dir,
      harnesses,
      memory,
      timeoutMs: 30 * 60_000, // 30-minute hard cap on the cognitive pass
      systemPromptSuffix:
        "You are operating in NIGHTLY MAINTENANCE MODE. " +
        "Skip pleasantries. Do work, write files, report briefly.",
    })) {
      if (chunk.type === "text") finalReply += chunk.text;
      if (chunk.type === "done") finalReply = chunk.finalText;
      if (chunk.type === "error") errored = chunk.error;
    }
  } catch (e) {
    errored = (e as Error).message;
    log.error("nightly: turn threw", { error: errored });
  } finally {
    await memory.close();
  }

  const durationMs = Date.now() - startedAt;
  // If the harness wrote .nightly-state.json itself (per the prompt), great.
  // We ALSO record a phantombot-side timestamp so we never lose the
  // last-run anchor even if the harness flubbed phase 5.
  await saveNightlyState(dir, {
    last_run: new Date().toISOString(),
    last_status: errored ? "error" : "ok",
    ...(errored ? { errors: [errored] } : {}),
  });

  out.write(
    `nightly ${errored ? "FAILED" : "ok"}: ` +
      `${durationMs}ms, ${finalReply.length} reply chars` +
      (errored ? ` — ${errored}` : "") +
      `\n`,
  );
  log.info("nightly: complete", {
    persona,
    date: today,
    durationMs,
    replyChars: finalReply.length,
    ok: !errored,
  });
  return errored ? 1 : 0;
}

function buildHarnessChain(config: Config, err: WriteSink): Harness[] {
  const out: Harness[] = [];
  for (const id of config.harnesses.chain) {
    if (id === "claude") out.push(new ClaudeHarness(config.harnesses.claude));
    else if (id === "pi") out.push(new PiHarness(config.harnesses.pi));
    else err.write(`warning: unknown harness '${id}', skipping\n`);
  }
  return out;
}

export default defineCommand({
  meta: {
    name: "nightly",
    description:
      "Run the cognitive distillation pass — promote, KB-feed, compress. Isolated conversation; long-running; manual or via the systemd timer.",
  },
  args: {
    persona: {
      type: "string",
      description: "Persona name (default: configured default).",
    },
    date: {
      type: "string",
      description: "Override today's date (YYYY-MM-DD); useful for backfill.",
    },
  },
  async run({ args }) {
    process.exitCode = await runNightly({
      persona: args.persona ? String(args.persona) : undefined,
      today: args.date ? String(args.date) : undefined,
    });
  },
});
