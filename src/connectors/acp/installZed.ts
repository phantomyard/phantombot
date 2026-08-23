/**
 * `phantombot acp install zed` backend — JSONC-safe Zed settings writer.
 *
 * Registers phantombot as an ACP agent server in Zed's settings.json by
 * merging in:
 *
 *   { "agent_servers": { "Phantombot": {
 *       "command": "<abs phantombot binary>", "args": ["acp"], "env": {} } } }
 *
 * Zed's settings.json is JSONC (comments + trailing commas). We use
 * Microsoft's `jsonc-parser` — the exact library Zed/VS Code use — so we can
 * PARSE tolerantly and EDIT surgically, preserving every other key, comment,
 * and the file's formatting.
 *
 * DATA-LOSS-PROOF PROCEDURE (non-negotiable):
 *   1. Read existing file.
 *   2. Parse with jsonc-parser (tolerant of comments + trailing commas).
 *   3. If parse FAILS ⇒ ABORT. Write nothing. Return an error result with the
 *      manual snippet to paste. NEVER "start fresh", NEVER overwrite.
 *   4. On success, merge agent_servers.Phantombot via jsonc-parser's
 *      modify/applyEdits so formatting + comments survive.
 *   5. Back up the original to settings.json.phantombot-bak, then write
 *      atomically (temp file + rename).
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

import { xdgConfigHome } from "../../config.ts";
import type { WriteSink } from "../../lib/io.ts";

export interface InstallZedOptions {
  /** Override the settings path (tests). Default: platform Zed settings. */
  settingsPath?: string;
  /** Absolute path to the phantombot binary Zed should spawn. */
  binaryPath: string;
  out?: WriteSink;
  err?: WriteSink;
}

export interface InstallZedResult {
  /** 0 success, 1 abort (unparseable file — nothing written). */
  code: number;
  /** Resolved settings path acted on. */
  settingsPath: string;
  /** Backup path, when a backup was made. */
  backupPath?: string;
}

/**
 * Absolute config override to bake into the registered `env` block.
 *
 * The installer runs as the REAL user, on a NATIVE phantombot install, so it
 * knows the real absolute config path — exactly the path config.ts::loadConfig
 * resolves by default. Baking it in pins Zed's spawned `phantombot acp` to the
 * real config.toml even if Zed (or a future snap/flatpak Zed) ever spawns it with
 * a redirected `$HOME`/`$XDG_*` — the same class of bug that breaks the
 * strict-snap VS Code. We honour `$XDG_CONFIG_HOME` here precisely because
 * config.ts does, so the override always agrees with the default resolution on a
 * normal box (and is therefore a no-op there, just an insurance policy against a
 * redirected child env).
 *
 * We deliberately DO NOT set `PHANTOMBOT_PERSONAS_DIR`: it is an absolute override
 * that wins over `personas_dir` in config.toml, so baking it in would silently
 * break any user with a custom persona root (the regression Kai flagged in
 * review). Pinning PHANTOMBOT_CONFIG alone is enough — loadConfig then resolves
 * `personas_dir` from that config, honouring default OR custom roots.
 */
export function phantombotEnvOverrides(): {
  PHANTOMBOT_CONFIG: string;
} {
  return {
    PHANTOMBOT_CONFIG: join(xdgConfigHome(), "phantombot", "config.toml"),
  };
}

/** The block phantombot owns under `agent_servers`. */
export function phantombotAgentServerBlock(binaryPath: string): {
  command: string;
  args: string[];
  env: Record<string, string>;
} {
  return { command: binaryPath, args: ["acp"], env: phantombotEnvOverrides() };
}

/**
 * Resolve the default Zed settings.json path.
 *
 * On macOS/Linux Zed reads its user settings from `~/.config/zed/settings.json`
 * (that's the file `⌘,` opens, even on macOS). The earlier
 * `~/Library/Application Support/Zed/settings.json` branch was wrong: the
 * registration landed in a file Zed never reads, so the agent silently never
 * appeared in Zed's External Agents list on Macs. On WINDOWS, Zed instead reads
 * `%APPDATA%\Zed\settings.json`, so `~/.config` there hits the same silent-miss
 * failure. We branch on win32 and honour XDG_CONFIG_HOME on the POSIX side.
 */
export function defaultZedSettingsPath(): string {
  if (process.platform === "win32") {
    const appData = process.env.APPDATA || join(homedir(), "AppData", "Roaming");
    return join(appData, "Zed", "settings.json");
  }
  const xdg = process.env.XDG_CONFIG_HOME || join(homedir(), ".config");
  return join(xdg, "zed", "settings.json");
}

/** The snippet a user pastes manually if we abort. */
export function manualSnippet(binaryPath: string): string {
  const block = {
    agent_servers: { Phantombot: phantombotAgentServerBlock(binaryPath) },
  };
  return JSON.stringify(block, null, 2);
}

export function installZed(options: InstallZedOptions): InstallZedResult {
  const out = options.out ?? process.stdout;
  const err = options.err ?? process.stderr;
  const settingsPath = options.settingsPath ?? defaultZedSettingsPath();
  const block = phantombotAgentServerBlock(options.binaryPath);

  // ── Read existing content (missing file ⇒ start from an empty object) ──
  let existing: string;
  let fileExisted = true;
  try {
    existing = readFileSync(settingsPath, "utf8");
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
        `phantombot acp install zed: ${settingsPath} is not parseable as JSONC — ` +
          `refusing to touch it to avoid data loss. Nothing was written.\n` +
          `Add this block manually:\n\n${manualSnippet(options.binaryPath)}\n`,
      );
      return { code: 1, settingsPath };
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
  mkdirSync(dirname(settingsPath), { recursive: true });

  let backupPath: string | undefined;
  if (fileExisted) {
    backupPath = `${settingsPath}.phantombot-bak`;
    writeFileSync(backupPath, existing, "utf8");
  }

  const tmpPath = `${settingsPath}.phantombot-tmp`;
  writeFileSync(tmpPath, updated, "utf8");
  renameSync(tmpPath, settingsPath);

  out.write(
    `phantombot acp install zed: registered "Phantombot" in ${settingsPath}` +
      (backupPath ? ` (backup: ${backupPath})` : " (new file)") +
      `\n`,
  );

  return { code: 0, settingsPath, backupPath };
}
