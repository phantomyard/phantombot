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
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
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
  await writeFile(path, lines.join("\n") + "\n", "utf8");
  // Best-effort permission lock — secrets file should not be world-readable.
  try {
    await chmod(path, 0o600);
  } catch {
    /* fine on filesystems that don't support chmod (e.g. some FUSE) */
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
    if (
      (val.startsWith('"') && val.endsWith('"')) ||
      (val.startsWith("'") && val.endsWith("'"))
    ) {
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
