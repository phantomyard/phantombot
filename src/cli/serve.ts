/**
 * `phantombot serve [--telegram]` — long-running channel listener.
 *
 * Telegram is the only channel for v1. Other channels (signal, googlechat)
 * can land later by adding flags + adapter classes. The flag-based dispatch
 * keeps `phantombot` itself a single command rather than introducing a
 * `serve <channel>` sub-subcommand layer.
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

export interface RunServeInput {
  telegram?: boolean;
  /** Override config for testing. */
  config?: Config;
  out?: WriteSink;
  err?: WriteSink;
}

export async function runServe(input: RunServeInput): Promise<number> {
  const out = input.out ?? process.stdout;
  const err = input.err ?? process.stderr;

  if (!input.telegram) {
    err.write("specify a channel: --telegram\n");
    return 2;
  }

  const config = input.config ?? (await loadConfig());
  const tg = config.channels.telegram;
  if (!tg) {
    err.write(
      "no telegram bot token configured. Set TELEGRAM_BOT_TOKEN or [channels.telegram].token in config.toml\n",
    );
    return 2;
  }

  const persona = config.defaultPersona;
  const agentDir = personaDir(config, persona);
  if (!existsSync(agentDir)) {
    err.write(`persona '${persona}' not found at ${agentDir}\n`);
    err.write(
      "import one with `phantombot import-persona <openclaw-agent-dir>`\n",
    );
    return 2;
  }

  const harnesses = buildHarnessChain(config, err);
  if (harnesses.length === 0) {
    err.write("no harnesses configured\n");
    return 2;
  }

  const memory = await openMemoryStore(config.memoryDbPath);
  const transport = new HttpTelegramTransport(tg.token);

  out.write(
    `phantombot serve --telegram — persona: ${persona}, harnesses: ${config.harnesses.chain.join(",")}\n`,
  );
  out.write(`long-poll timeout: ${tg.pollTimeoutS}s; ` +
    `allowed users: ${tg.allowedUserIds.length === 0 ? "ANY (no allowlist)" : tg.allowedUserIds.join(",")}\n`);
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
    name: "serve",
    description:
      "Run a long-lived channel listener (currently --telegram only). Stays in the foreground; daemonize via systemd or nohup.",
  },
  args: {
    telegram: {
      type: "boolean",
      description: "Listen on Telegram via long-poll.",
      default: false,
    },
  },
  async run({ args }) {
    const code = await runServe({ telegram: Boolean(args.telegram) });
    process.exitCode = code;
  },
});
