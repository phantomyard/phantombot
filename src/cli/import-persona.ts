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
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import * as p from "@clack/prompts";

import { type Config, loadConfig, personaDir } from "../config.ts";
import {
  type ImportPersonaResult,
  importPersona,
} from "../importer/openclaw.ts";
import type { WriteSink } from "../lib/io.ts";
import { setIn, updateConfigToml } from "../lib/configWriter.ts";
import {
  type ArchivedPersona,
  listArchives,
  restoreArchive,
} from "../lib/personaArchive.ts";
import { ensurePersonaScaffold } from "../lib/personaScaffold.ts";
import { defaultServiceControl, type ServiceControl } from "../lib/systemd.ts";
import { parseOpenClawTelegram } from "./telegram.ts";

export interface RunImportPersonaInput {
  /** If provided, skip the TUI and import this directory directly. */
  source?: string;
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
  /** Override service-control for testing. */
  serviceControl?: ServiceControl;
  out?: WriteSink;
  err?: WriteSink;
}

/** Restore an archive to a (possibly new) persona name. Pure side-effect; testable. */
export async function applyRestore(
  config: Config,
  archive: ArchivedPersona,
  asName: string,
): Promise<{ name: string; dir: string; alsoArchived?: ArchivedPersona }> {
  const dst = personaDir(config, asName);
  let alsoArchived: ArchivedPersona | undefined;
  if (existsSync(dst)) {
    const { archivePersona } = await import("../lib/personaArchive.ts");
    alsoArchived = await archivePersona(config.personasDir, asName);
  }
  await restoreArchive(config.personasDir, archive, asName);
  return { name: asName, dir: dst, alsoArchived };
}

export async function runImportPersona(
  input: RunImportPersonaInput,
): Promise<number> {
  const out = input.out ?? process.stdout;
  const err = input.err ?? process.stderr;

  const config = input.config ?? (await loadConfig());
  const personasRoot = input.personasDir ?? config.personasDir;

  // No source path → interactive TUI.
  if (!input.source) {
    return runImportPersonaTui({
      config,
      personasRoot,
      noTelegram: input.noTelegram,
      openclawConfigPath: input.openclawConfigPath,
      serviceControl: input.serviceControl,
      out,
      err,
    });
  }

  let result: ImportPersonaResult;
  try {
    result = await importPersona({
      source: input.source,
      personasDir: personasRoot,
      as: input.as,
      overwrite: input.overwrite,
    });
  } catch (e) {
    err.write(`error: ${(e as Error).message}\n`);
    return 1;
  }

  // Ensure memory/ and kb/ scaffolding exists even if the source had none.
  // Idempotent — won't overwrite anything the importer just copied.
  const scaffold = await ensurePersonaScaffold(result.targetDir);

  out.write(`imported persona '${result.name}' to ${result.targetDir}\n`);
  out.write(`copied (${result.copied.length}):\n`);
  for (const f of result.copied) out.write(`  ${f}\n`);
  if (result.skipped.length > 0) {
    out.write(`skipped (${result.skipped.length}):\n`);
    for (const f of result.skipped) out.write(`  ${f}\n`);
  }
  if (scaffold.created.length > 0) {
    out.write(`scaffolded (${scaffold.created.length}):\n`);
    for (const f of scaffold.created) out.write(`  ${f}\n`);
  }
  out.write(
    "\nNote: conversation history was NOT imported (phantombot v1 has no transcript importer).\n",
  );

  if (!input.noTelegram) {
    await maybeImportOpenclawTelegram({
      config,
      openclawConfigPath: input.openclawConfigPath,
      out,
    });
  }

  await maybeRestartHint(input.serviceControl, out);
  return 0;
}

interface RunImportPersonaTuiInput {
  config: Config;
  personasRoot: string;
  noTelegram?: boolean;
  openclawConfigPath?: string;
  serviceControl?: ServiceControl;
  out: WriteSink;
  err: WriteSink;
}

async function runImportPersonaTui(
  input: RunImportPersonaTuiInput,
): Promise<number> {
  const { config, personasRoot } = input;
  p.intro("Import persona");

  const currentDefault = config.defaultPersona;
  if (existsSync(personaDir(config, currentDefault))) {
    p.note(
      `Current default: ${currentDefault}\n  ${personaDir(config, currentDefault)}`,
      "Status",
    );
  } else {
    p.note(
      `No persona configured yet (default would be '${currentDefault}').`,
      "Status",
    );
  }

  const archives = await listArchives(personasRoot);
  const choice = await p.select<"path" | "archive" | "cancel">({
    message: "What do you want to do?",
    options: [
      {
        value: "path",
        label: "Import from a directory (OpenClaw or phantombot-shaped)",
      },
      {
        value: "archive",
        label: `Restore an archived persona${archives.length > 0 ? ` (${archives.length} available)` : " (none yet)"}`,
        hint: archives.length === 0 ? "create-persona archives auto on overwrite" : undefined,
      },
      { value: "cancel", label: "Cancel" },
    ],
  });
  if (p.isCancel(choice) || choice === "cancel") {
    p.cancel("cancelled");
    return 0;
  }

  if (choice === "path") {
    return runImportFromPath(input);
  }
  return runRestoreArchive(input, archives);
}

async function runImportFromPath(
  input: RunImportPersonaTuiInput,
): Promise<number> {
  const sourcePath = await p.text({
    message: "Path to OpenClaw / phantombot persona directory",
    placeholder: "/home/me/clawd",
    validate: (v) => {
      if (!v || v.length === 0) return "path is required";
      if (!existsSync(v)) return `path does not exist: ${v}`;
      return undefined;
    },
  });
  if (p.isCancel(sourcePath)) {
    p.cancel("cancelled");
    return 0;
  }

  const asName = await p.text({
    message: "Target persona name (Enter to use the source basename)",
    placeholder: "",
    defaultValue: "",
  });
  if (p.isCancel(asName)) {
    p.cancel("cancelled");
    return 0;
  }

  const target = (asName as string).trim() || undefined;
  if (target && existsSync(personaDir(input.config, target))) {
    const ok = await p.confirm({
      message: `Persona '${target}' already exists. Overwrite (current dir will be archived)?`,
      initialValue: false,
    });
    if (p.isCancel(ok) || !ok) {
      p.cancel("cancelled");
      return 0;
    }
  }

  let result: ImportPersonaResult;
  try {
    result = await importPersona({
      source: sourcePath as string,
      personasDir: input.personasRoot,
      as: target,
      overwrite: true,
    });
  } catch (e) {
    p.cancel(`error: ${(e as Error).message}`);
    return 1;
  }
  const scaffold = await ensurePersonaScaffold(result.targetDir);
  p.note(
    `imported '${result.name}' to ${result.targetDir}\n` +
      `copied: ${result.copied.length} file(s)\n` +
      `skipped: ${result.skipped.length} file(s)\n` +
      `scaffolded: ${scaffold.created.length} new file(s)`,
    "Imported",
  );

  if (!input.noTelegram) {
    await maybeImportOpenclawTelegram({
      config: input.config,
      openclawConfigPath: input.openclawConfigPath,
      out: input.out,
    });
  }

  await maybeRestartHint(input.serviceControl, input.out);
  p.outro("done");
  return 0;
}

async function runRestoreArchive(
  input: RunImportPersonaTuiInput,
  archives: ArchivedPersona[],
): Promise<number> {
  if (archives.length === 0) {
    p.cancel(
      "no archives to restore. create-persona archives the previous persona automatically when you overwrite one.",
    );
    return 0;
  }

  const pick = await p.select<string>({
    message: "Choose an archive to restore",
    options: archives.map((a) => ({
      value: a.archiveName,
      label: `${a.name}  (${a.archivedAt.toISOString().slice(0, 19)}Z)`,
      hint: a.dir,
    })),
  });
  if (p.isCancel(pick)) {
    p.cancel("cancelled");
    return 0;
  }
  const chosen = archives.find((a) => a.archiveName === pick)!;

  const asName = await p.text({
    message: `Restore as (Enter to keep '${chosen.name}')`,
    placeholder: chosen.name,
    defaultValue: chosen.name,
    validate: (v) => {
      if (!v || v.length === 0) return undefined;
      if (!/^[a-z0-9_-]+$/.test(v))
        return "use lowercase letters, digits, '-', '_'";
      return undefined;
    },
  });
  if (p.isCancel(asName)) {
    p.cancel("cancelled");
    return 0;
  }
  const targetName = ((asName as string).trim() || chosen.name);

  if (existsSync(personaDir(input.config, targetName))) {
    const ok = await p.confirm({
      message: `Persona '${targetName}' already exists. Overwrite (current dir will be archived)?`,
      initialValue: false,
    });
    if (p.isCancel(ok) || !ok) {
      p.cancel("cancelled");
      return 0;
    }
  }

  const r = await applyRestore(input.config, chosen, targetName);
  await ensurePersonaScaffold(r.dir);
  p.note(
    `restored to ${r.dir}` +
      (r.alsoArchived ? `\nprevious '${targetName}' archived to ${r.alsoArchived.dir}` : ""),
    "Restored",
  );

  await maybeRestartHint(input.serviceControl, input.out);
  p.outro("done");
  return 0;
}

async function maybeImportOpenclawTelegram(args: {
  config: Config;
  openclawConfigPath?: string;
  out: WriteSink;
}): Promise<void> {
  const openclawJsonPath =
    args.openclawConfigPath ?? join(homedir(), ".openclaw", "openclaw.json");
  const tg = await sniffOpenClawTelegram(openclawJsonPath);
  if (tg) {
    await updateConfigToml(args.config.configPath, (toml) => {
      setIn(toml, ["channels", "telegram", "token"], tg.token);
      setIn(toml, ["channels", "telegram", "poll_timeout_s"], 30);
      setIn(
        toml,
        ["channels", "telegram", "allowed_user_ids"],
        tg.allowedUserIds,
      );
    });
    args.out.write(
      `\nimported telegram config from ${openclawJsonPath}:\n` +
        `  token: ${maskToken(tg.token)}\n` +
        `  allowed users: ${tg.allowedUserIds.length === 0 ? "(none — anyone)" : tg.allowedUserIds.join(", ")}\n` +
        `  written to ${args.config.configPath}\n`,
    );
  } else {
    args.out.write(
      `\n(no openclaw telegram config at ${openclawJsonPath}; skipping)\n`,
    );
  }
}

async function maybeRestartHint(
  serviceControl: ServiceControl | undefined,
  out: WriteSink,
): Promise<void> {
  const svc = serviceControl ?? defaultServiceControl();
  if (await svc.isActive()) {
    out.write(
      "\nphantombot is currently running. Restart to pick up the imported persona/config:\n" +
        "  systemctl --user restart phantombot\n",
    );
  }
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
      description:
        "Path to the OpenClaw agent directory to import. If omitted, an interactive TUI is shown (current persona / restore from archive / import from path / cancel).",
      required: false,
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
      source: args.path ? String(args.path) : undefined,
      as: args.as ? String(args.as) : undefined,
      overwrite: Boolean(args.overwrite),
      noTelegram: Boolean(args["no-telegram"]),
    });
    process.exitCode = code;
  },
});
