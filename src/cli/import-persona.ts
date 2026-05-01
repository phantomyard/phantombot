/**
 * `phantombot import-persona <openclaw-dir>` — copy an OpenClaw agent
 * directory's persona files into phantombot's personas dir, and (if
 * --no-telegram is not passed) sniff the standard OpenClaw config at
 * ~/.openclaw/openclaw.json for a Telegram bot block; if found, write
 * it to phantombot's [channels.telegram].
 *
 * The persona-file work is in src/importer/openclaw.ts.
 * The telegram sniff is in src/cli/telegram.ts (parseOpenClawTelegram).
 */

import { defineCommand } from "citty";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

import { type Config, loadConfig } from "../config.ts";
import {
  type ImportPersonaResult,
  importPersona,
} from "../importer/openclaw.ts";
import type { WriteSink } from "../lib/io.ts";
import { setIn, updateConfigToml } from "../lib/configWriter.ts";
import { parseOpenClawTelegram } from "./telegram.ts";

export interface RunImportPersonaInput {
  source: string;
  as?: string;
  overwrite?: boolean;
  /** Skip the OpenClaw config sniff entirely. Default false. */
  noTelegram?: boolean;
  /** Override personas root (defaults to config.personasDir). */
  personasDir?: string;
  /** Override config (mainly for testing). */
  config?: Config;
  /** Override the openclaw.json path the sniff looks at. */
  openclawConfigPath?: string;
  out?: WriteSink;
  err?: WriteSink;
}

export async function runImportPersona(
  input: RunImportPersonaInput,
): Promise<number> {
  const out = input.out ?? process.stdout;
  const err = input.err ?? process.stderr;

  const config = input.config ?? (await loadConfig());
  const personasDir = input.personasDir ?? config.personasDir;

  let result: ImportPersonaResult;
  try {
    result = await importPersona({
      source: input.source,
      personasDir,
      as: input.as,
      overwrite: input.overwrite,
    });
  } catch (e) {
    err.write(`error: ${(e as Error).message}\n`);
    return 1;
  }

  out.write(`imported persona '${result.name}' to ${result.targetDir}\n`);
  out.write(`copied (${result.copied.length}):\n`);
  for (const f of result.copied) out.write(`  ${f}\n`);
  if (result.skipped.length > 0) {
    out.write(`skipped (${result.skipped.length}):\n`);
    for (const f of result.skipped) out.write(`  ${f}\n`);
  }
  out.write(
    "\nNote: conversation history was NOT imported (phantombot v1 has no transcript importer).\n",
  );

  if (!input.noTelegram) {
    const openclawJsonPath =
      input.openclawConfigPath ??
      join(homedir(), ".openclaw", "openclaw.json");
    const tg = await sniffOpenClawTelegram(openclawJsonPath);
    if (tg) {
      await updateConfigToml(config.configPath, (toml) => {
        setIn(toml, ["channels", "telegram", "token"], tg.token);
        setIn(toml, ["channels", "telegram", "poll_timeout_s"], 30);
        setIn(
          toml,
          ["channels", "telegram", "allowed_user_ids"],
          tg.allowedUserIds,
        );
      });
      out.write(
        `\nimported telegram config from ${openclawJsonPath}:\n` +
          `  token: ${maskToken(tg.token)}\n` +
          `  allowed users: ${tg.allowedUserIds.length === 0 ? "(none — anyone)" : tg.allowedUserIds.join(", ")}\n` +
          `  written to ${config.configPath}\n`,
      );
    } else {
      out.write(
        `\n(no openclaw telegram config at ${openclawJsonPath}; skipping)\n`,
      );
    }
  }

  return 0;
}

async function sniffOpenClawTelegram(
  path: string,
): Promise<{ token: string; allowedUserIds: number[] } | undefined> {
  let parsed: unknown;
  try {
    const content = await readFile(path, "utf8");
    parsed = JSON.parse(content);
  } catch {
    return undefined;
  }
  return parseOpenClawTelegram(parsed);
}

function maskToken(t: string): string {
  if (t.length <= 12) return "***";
  return t.slice(0, 6) + "…" + t.slice(-4);
}

export default defineCommand({
  meta: {
    name: "import-persona",
    description:
      "Import a persona from an OpenClaw agent directory. Also imports the OpenClaw Telegram config from ~/.openclaw/openclaw.json if found (use --no-telegram to skip).",
  },
  args: {
    path: {
      type: "positional",
      description: "Path to the OpenClaw agent directory to import.",
      required: true,
    },
    as: {
      type: "string",
      description:
        "Target persona name (defaults to the basename of the source directory).",
    },
    overwrite: {
      type: "boolean",
      description: "Replace any existing persona with the same name.",
      default: false,
    },
    "no-telegram": {
      type: "boolean",
      description:
        "Skip the OpenClaw Telegram config sniff at ~/.openclaw/openclaw.json.",
      default: false,
    },
  },
  async run({ args }) {
    const code = await runImportPersona({
      source: String(args.path),
      as: args.as ? String(args.as) : undefined,
      overwrite: Boolean(args.overwrite),
      noTelegram: Boolean(args["no-telegram"]),
    });
    process.exitCode = code;
  },
});
