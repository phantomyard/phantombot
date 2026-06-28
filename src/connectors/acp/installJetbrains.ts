/**
 * `phantombot acp install jetbrains` backend — JSON-safe JetBrains ACP writer.
 *
 * Registers phantombot as an ACP agent server in the JetBrains AI Assistant
 * config (`~/.jetbrains/acp.json`, shared across every JetBrains IDE — Rider,
 * IntelliJ IDEA, WebStorm, PyCharm, GoLand, …) by merging in:
 *
 *   { "agent_servers": { "Phantombot": {
 *       "command": "<abs phantombot binary>", "args": ["acp"], "env": {…} } } }
 *
 * JetBrains 2026.1+ AI Assistant speaks ACP NATIVELY: there is no Kotlin/Gradle
 * plugin to ship — registration is purely this config merge, exactly like Zed.
 * The file is plain JSON, but JetBrains tolerates the JSONC superset and may
 * carry sibling keys (e.g. `default_mcp_settings`), so we reuse the same
 * jsonc-parser machinery as the Zed installer to PARSE tolerantly and EDIT
 * surgically — preserving every other key, comment, and the file's formatting.
 *
 * DATA-LOSS-PROOF PROCEDURE (identical to installZed, non-negotiable):
 *   1. Read existing file.
 *   2. Parse with jsonc-parser (tolerant of comments + trailing commas).
 *   3. If parse FAILS ⇒ ABORT. Write nothing. Return an error result with the
 *      manual snippet to paste. NEVER "start fresh", NEVER overwrite.
 *   4. On success, merge agent_servers.Phantombot via jsonc-parser's
 *      modify/applyEdits so formatting + sibling keys survive.
 *   5. Back up the original to acp.json.phantombot-bak, then write atomically
 *      (temp file + rename).
 */

import {
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { applyEdits, modify, parse, type ParseError } from "jsonc-parser";

import type { WriteSink } from "../../lib/io.ts";
import { phantombotAgentServerBlock } from "./installZed.ts";

export interface InstallJetbrainsOptions {
  /** Override the config path (tests). Default: ~/.jetbrains/acp.json. */
  configPath?: string;
  /** Absolute path to the phantombot binary JetBrains should spawn. */
  binaryPath: string;
  out?: WriteSink;
  err?: WriteSink;
}

export interface InstallJetbrainsResult {
  /** 0 success, 1 abort (unparseable file — nothing written). */
  code: number;
  /** Resolved config path acted on. */
  configPath: string;
  /** Backup path, when a backup was made. */
  backupPath?: string;
}

/**
 * Resolve the default JetBrains ACP config path.
 *
 * JetBrains AI Assistant reads external ACP agents from a single per-user file,
 * `~/.jetbrains/acp.json`, shared across every installed JetBrains IDE. It is
 * NOT under `$XDG_CONFIG_HOME` — JetBrains hardcodes `~/.jetbrains/` — so we
 * resolve it straight off the home dir.
 */
export function defaultJetbrainsConfigPath(): string {
  return join(homedir(), ".jetbrains", "acp.json");
}

/** The snippet a user pastes manually if we abort. */
export function manualSnippet(binaryPath: string): string {
  const block = {
    agent_servers: { Phantombot: phantombotAgentServerBlock(binaryPath) },
  };
  return JSON.stringify(block, null, 2);
}

export function installJetbrains(
  options: InstallJetbrainsOptions,
): InstallJetbrainsResult {
  const out = options.out ?? process.stdout;
  const err = options.err ?? process.stderr;
  const configPath = options.configPath ?? defaultJetbrainsConfigPath();
  const block = phantombotAgentServerBlock(options.binaryPath);

  // ── Read existing content (missing file ⇒ start from an empty object) ──
  let existing: string;
  let fileExisted = true;
  try {
    existing = readFileSync(configPath, "utf8");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") {
      existing = "{}";
      fileExisted = false;
    } else {
      throw e;
    }
  }

  // ── Parse tolerantly. ANY structural error ⇒ ABORT, write nothing. ──
  if (fileExisted) {
    const errors: ParseError[] = [];
    parse(existing, errors, {
      allowTrailingComma: true,
      disallowComments: false,
    });
    if (errors.length > 0) {
      err.write(
        `phantombot acp install jetbrains: ${configPath} is not parseable as JSON — ` +
          `refusing to touch it to avoid data loss. Nothing was written.\n` +
          `Add this block manually:\n\n${manualSnippet(options.binaryPath)}\n`,
      );
      return { code: 1, configPath };
    }
  }

  // ── Surgical edit — preserves comments + formatting of every other key ──
  const formatting = {
    formattingOptions: { tabSize: 2, insertSpaces: true, eol: "\n" },
  };
  const edits = modify(
    existing,
    ["agent_servers", "Phantombot"],
    block,
    formatting,
  );
  const updated = applyEdits(existing, edits);

  // ── Atomic write: backup original, write temp, rename into place. ──
  mkdirSync(dirname(configPath), { recursive: true });

  let backupPath: string | undefined;
  if (fileExisted) {
    backupPath = `${configPath}.phantombot-bak`;
    writeFileSync(backupPath, existing, "utf8");
  }

  const tmpPath = `${configPath}.phantombot-tmp`;
  writeFileSync(tmpPath, updated, "utf8");
  renameSync(tmpPath, configPath);

  out.write(
    `phantombot acp install jetbrains: registered "Phantombot" in ${configPath}` +
      (backupPath ? ` (backup: ${backupPath})` : " (new file)") +
      `\n`,
  );

  return { code: 0, configPath, backupPath };
}
