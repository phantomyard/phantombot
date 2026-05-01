/**
 * `phantombot heartbeat` — short, mechanical maintenance pass.
 *
 * Runs every 30 minutes via systemd timer (installed by `phantombot install`).
 * No LLM call. See src/lib/heartbeat.ts for what it does.
 */

import { defineCommand } from "citty";
import { existsSync } from "node:fs";
import { join } from "node:path";

import { type Config, loadConfig, personaDir } from "../config.ts";
import { runHeartbeat } from "../lib/heartbeat.ts";
import type { WriteSink } from "../lib/io.ts";

function indexPath(persona: string): string {
  return join(
    process.env.XDG_DATA_HOME || join(process.env.HOME ?? "", ".local/share"),
    "phantombot",
    "memory-index",
    `${persona}.sqlite`,
  );
}

export interface RunHeartbeatCliInput {
  config?: Config;
  persona?: string;
  out?: WriteSink;
  err?: WriteSink;
}

export async function runHeartbeatCli(
  input: RunHeartbeatCliInput = {},
): Promise<number> {
  const out = input.out ?? process.stdout;
  const err = input.err ?? process.stderr;
  const config = input.config ?? (await loadConfig());
  const persona = input.persona ?? config.defaultPersona;
  const dir = personaDir(config, persona);

  if (!existsSync(dir)) {
    err.write(`persona '${persona}' not found at ${dir}\n`);
    return 2;
  }

  const r = await runHeartbeat({
    personaDir: dir,
    indexPath: indexPath(persona),
  });
  out.write(
    `heartbeat ok: promoted ${r.promoted.length}, ` +
      `stale ${r.staleRecent.length}, ` +
      `indexed ${r.indexedFiles}\n`,
  );
  return 0;
}

export default defineCommand({
  meta: {
    name: "heartbeat",
    description:
      "Mechanical 30-min maintenance: promote tagged daily-file lines to drawers, scan ## Recent for staleness, refresh FTS index. No LLM call.",
  },
  args: {
    persona: {
      type: "string",
      description: "Persona name (default: configured default).",
    },
  },
  async run({ args }) {
    process.exitCode = await runHeartbeatCli({
      persona: args.persona ? String(args.persona) : undefined,
    });
  },
});
