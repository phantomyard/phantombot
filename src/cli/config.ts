/**
 * `phantombot config` — print resolved config and the paths phantombot reads from.
 * `phantombot config edit` — open config.toml in $EDITOR.
 */

import { defineCommand } from "citty";
import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { type Config, loadConfig } from "../config.ts";
import type { WriteSink } from "../lib/io.ts";
import { statePath } from "../state.ts";

export interface RunConfigInput {
  config?: Config;
  out?: WriteSink;
}

export async function runConfig(input: RunConfigInput = {}): Promise<number> {
  const out = input.out ?? process.stdout;
  const config = input.config ?? (await loadConfig());

  out.write("phantombot configuration:\n\n");
  out.write(`  default_persona  = ${config.defaultPersona}\n`);
  out.write(`  turn_timeout_ms  = ${config.turnTimeoutMs}\n`);
  out.write(`  personas_dir     = ${config.personasDir}\n`);
  out.write(`  memory_db        = ${config.memoryDbPath}\n`);
  out.write(`  config_file      = ${config.configPath}`);
  out.write(existsSync(config.configPath) ? "\n" : "  (does not exist)\n");
  out.write(`  state_file       = ${statePath()}`);
  out.write(existsSync(statePath()) ? "\n" : "  (does not exist)\n");

  out.write("\nharnesses (in chain order):\n");
  for (const id of config.harnesses.chain) {
    out.write(`  - ${id}\n`);
  }

  out.write("\n  claude:\n");
  out.write(`    bin             = ${config.harnesses.claude.bin}\n`);
  out.write(`    model           = ${config.harnesses.claude.model}\n`);
  out.write(
    `    fallback_model  = ${config.harnesses.claude.fallbackModel || "(none)"}\n`,
  );

  out.write("\n  pi:\n");
  out.write(`    bin                = ${config.harnesses.pi.bin}\n`);
  out.write(
    `    max_payload_bytes  = ${config.harnesses.pi.maxPayloadBytes}\n`,
  );

  out.write(
    "\nResolution priority (highest wins): env vars > state.json > config.toml > defaults\n",
  );
  return 0;
}

export interface RunConfigEditInput {
  config?: Config;
  editor?: string;
  out?: WriteSink;
  err?: WriteSink;
  /** Override the spawn implementation for testing. */
  spawn?: (cmd: string[]) => Promise<number>;
}

export async function runConfigEdit(
  input: RunConfigEditInput = {},
): Promise<number> {
  const out = input.out ?? process.stdout;
  const err = input.err ?? process.stderr;
  const config = input.config ?? (await loadConfig());
  const editor = input.editor ?? process.env.EDITOR ?? "vi";

  if (!existsSync(config.configPath)) {
    await mkdir(dirname(config.configPath), { recursive: true });
    await writeFile(
      config.configPath,
      `# phantombot config — see \`phantombot config\` for resolved values.\n` +
        `# All settings are optional; built-in defaults apply.\n\n`,
      "utf8",
    );
    out.write(`created empty config at ${config.configPath}\n`);
  }

  const spawnImpl =
    input.spawn ??
    (async (cmd: string[]) => {
      const proc = Bun.spawn(cmd);
      return await proc.exited;
    });

  const exit = await spawnImpl([editor, config.configPath]);
  if (exit !== 0) {
    err.write(`editor exited with code ${exit}\n`);
    return exit;
  }
  return 0;
}

const editCmd = defineCommand({
  meta: {
    name: "edit",
    description: "Open the phantombot config file in $EDITOR.",
  },
  async run() {
    const code = await runConfigEdit();
    process.exitCode = code;
  },
});

export default defineCommand({
  meta: {
    name: "config",
    description:
      "Print resolved phantombot configuration and the paths it reads from.",
  },
  subCommands: {
    edit: editCmd,
  },
  async run() {
    const code = await runConfig();
    process.exitCode = code;
  },
});
