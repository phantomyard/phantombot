/**
 * `phantombot run` — long-running channel listener (Telegram for v1).
 * Stays in the foreground. Ctrl-C to stop. Daemonize via systemd
 * (`phantombot install`) or `nohup phantombot run &`.
 *
 * Replaces the older `phantombot serve --telegram`.
 */

import { defineCommand } from "citty";
import { existsSync } from "node:fs";

import {
  HttpTelegramTransport,
  runTelegramServer,
} from "../channels/telegram.ts";
import { type Config, loadConfig, personaDir } from "../config.ts";
import { ClaudeHarness } from "../harnesses/claude.ts";
import { PiHarness } from "../harnesses/pi.ts";
import type { Harness } from "../harnesses/types.ts";
import type { WriteSink } from "../lib/io.ts";
import { openMemoryStore } from "../memory/store.ts";

export interface RunInput {
  config?: Config;
  out?: WriteSink;
  err?: WriteSink;
}

export async function runRun(input: RunInput = {}): Promise<number> {
  const out = input.out ?? process.stdout;
  const err = input.err ?? process.stderr;

  const config = input.config ?? (await loadConfig());
  const tg = config.channels.telegram;
  if (!tg) {
    err.write(
      "no telegram bot token configured. Run `phantombot telegram` to set one up.\n",
    );
    return 2;
  }

  const persona = config.defaultPersona;
  const agentDir = personaDir(config, persona);
  if (!existsSync(agentDir)) {
    err.write(
      `persona '${persona}' not found at ${agentDir}\n` +
        "import or create one with `phantombot import-persona <openclaw-dir>` " +
        "or `phantombot create-persona`.\n",
    );
    return 2;
  }

  const harnesses = buildHarnessChain(config, err);
  if (harnesses.length === 0) {
    err.write(
      "no harnesses configured. Run `phantombot harness` to pick at least one.\n",
    );
    return 2;
  }

  const memory = await openMemoryStore(config.memoryDbPath);
  const transport = new HttpTelegramTransport(tg.token);

  out.write(
    `phantombot — persona '${persona}', harnesses ${config.harnesses.chain.join(" → ")}\n`,
  );
  out.write(
    `telegram long-poll ${tg.pollTimeoutS}s; allowed users: ${
      tg.allowedUserIds.length === 0 ? "ANY (no allowlist)" : tg.allowedUserIds.join(",")
    }\n`,
  );
  out.write("Ctrl-C to stop.\n");

  const ac = new AbortController();
  const onSig = () => ac.abort();
  process.on("SIGINT", onSig);
  process.on("SIGTERM", onSig);

  try {
    await runTelegramServer({
      config,
      memory,
      harnesses,
      agentDir,
      persona,
      transport,
      signal: ac.signal,
      out,
      err,
    });
  } finally {
    process.off("SIGINT", onSig);
    process.off("SIGTERM", onSig);
    await memory.close();
  }
  return 0;
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
    name: "run",
    description:
      "Run phantombot in the foreground (Telegram listener + harness loop). Ctrl-C to stop.",
  },
  async run() {
    const code = await runRun();
    process.exitCode = code;
  },
});
