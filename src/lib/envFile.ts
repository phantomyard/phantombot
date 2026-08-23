/**
 * Tiny .env reader/writer for phantombot's secrets file.
 *
 * Lives at $XDG_CONFIG_HOME/phantombot/.env. Distinct from config.toml
 * (user-managed, may have comments) — secrets here are phantombot-managed
 * (set/cleared by `phantombot voice` and similar). Mode 600 on write.
 *
 * Format: standard shell-style `KEY=value`, one per line, no quoting
 * unless the value contains whitespace or `#` (then we wrap in double
 * quotes). Comments (`#`) and blank lines are preserved on read but not
 * surfaced in the parsed map; round-trip will lose them. Acceptable
 * because this file is phantombot-owned.
 */

import { existsSync } from "node:fs";
import {
  mkdir,
  readFile,
  rename,
  unlink,
  writeFile,
} from "node:fs/promises";
import { dirname, join } from "node:path";
import { xdgConfigHome } from "../config.ts";

export type EnvVars = Record<string, string>;

export function defaultEnvFilePath(): string {
  return (
    process.env.PHANTOMBOT_ENV_FILE ??
    join(xdgConfigHome(), "phantombot", ".env")
  );
}

export async function loadEnvFile(path: string): Promise<EnvVars> {
  if (!existsSync(path)) return {};
  const text = await readFile(path, "utf8");
  return parseEnv(text);
}

export async function saveEnvFile(
  path: string,
  vars: EnvVars,
): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const lines: string[] = [];
  for (const [k, v] of Object.entries(vars)) {
    if (!/^[A-Z_][A-Z0-9_]*$/i.test(k)) continue; // skip invalid keys silently
    lines.push(`${k}=${quote(v)}`);
  }
  // Write to a tempfile at mode 0o600 then atomically rename over the target.
  // Avoids the chmod race where a fresh file is briefly world-readable at
  // umask-default 0o644 between writeFile() and a follow-up chmod().
  const tmp = `${path}.tmp`;
  try {
    await writeFile(tmp, lines.join("\n") + "\n", {
      encoding: "utf8",
      mode: 0o600,
    });
    await rename(tmp, path);
  } catch (e) {
    try {
      await unlink(tmp);
    } catch {
      /* best-effort cleanup */
    }
    throw e;
  }
}

/**
 * Update a subset of variables in-place, preserving the rest. Useful when
 * `phantombot voice` only knows about the TTS keys but the env file may
 * contain unrelated user-set values.
 */
export async function updateEnvFile(
  path: string,
  patch: EnvVars,
): Promise<void> {
  const cur = await loadEnvFile(path);
  for (const [k, v] of Object.entries(patch)) {
    if (v === "") delete cur[k];
    else cur[k] = v;
  }
  await saveEnvFile(path, cur);
}

export function parseEnv(text: string): EnvVars {
  const out: EnvVars = {};
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    let val = line.slice(eq + 1).trim();
    if (val.startsWith('"') && val.endsWith('"') && val.length >= 2) {
      // Double-quoted: undo the escapes that quote() applies. Order matters:
      // unescape \\ → \ first, then \" → ", so a literal `\"` two-char value
      // (written as "\\\"") round-trips correctly without double-processing.
      val = val
        .slice(1, -1)
        .replace(/\\\\/g, "\\")
        .replace(/\\"/g, '"');
    } else if (val.startsWith("'") && val.endsWith("'") && val.length >= 2) {
      val = val.slice(1, -1);
    }
    out[key] = val;
  }
  return out;
}

function quote(v: string): string {
  if (v === "") return "";
  if (/[\s#"'\\]/.test(v)) {
    return `"${v.replace(/(["\\])/g, "\\$1")}"`;
  }
  return v;
}
