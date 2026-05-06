/**
 * Self-load `~/.env` and `~/.config/phantombot/.env` into process.env at
 * startup.
 *
 * Why: launchd has no equivalent of systemd's `EnvironmentFile=` plist
 * key, so on macOS phantombot has to source these files itself before
 * any subcommand reads `process.env.X`. On Linux the systemd unit
 * already sources both files, so this is a (cheap) no-op there — the
 * `existing-wins` policy below means anything systemd already set keeps
 * its value.
 *
 * Existing-wins ordering matters:
 *   - Variables explicitly exported in the parent shell (e.g. `GITHUB_TOKEN=foo phantombot ask …`)
 *     must win over what's persisted in the file.
 *   - On Linux, EnvironmentFile= already pre-populates process.env before
 *     the binary starts, so systemd's values also win — meaning the file
 *     read here is effectively a fallback for fresh invocations from a
 *     plain shell.
 */

import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import { defaultEnvFilePath, loadEnvFile } from "./envFile.ts";

/** Files to source, in priority order (later entries override earlier ones in process.env). */
function envFilesToLoad(): string[] {
  const userEnv = join(homedir(), ".env");
  return [userEnv, defaultEnvFilePath()];
}

export interface PreloadOptions {
  /** Override the file list — tests use this to point at fixture files. */
  files?: readonly string[];
  /** Override the env target — defaults to process.env. Tests inject a mutable map. */
  env?: NodeJS.ProcessEnv;
}

/**
 * Read each .env file in turn and copy missing keys into env. Existing
 * values are not overwritten. Silent on missing files (a fresh install
 * has neither .env yet).
 *
 * Returns the names of variables we set, so tests can assert on the
 * effect without intercepting process.env writes.
 */
export async function preloadEnvFiles(
  opts: PreloadOptions = {},
): Promise<{ loaded: string[] }> {
  const env = opts.env ?? process.env;
  const files = opts.files ?? envFilesToLoad();
  const loaded: string[] = [];

  for (const path of files) {
    if (!existsSync(path)) continue;
    let vars: Record<string, string>;
    try {
      vars = await loadEnvFile(path);
    } catch {
      // A malformed .env shouldn't crash startup. The follow-up `phantombot
      // env` commands will surface the parse error in a more useful way.
      continue;
    }
    for (const [k, v] of Object.entries(vars)) {
      if (env[k] === undefined) {
        env[k] = v;
        loaded.push(k);
      }
    }
  }

  return { loaded };
}
