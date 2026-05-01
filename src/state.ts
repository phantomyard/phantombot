/**
 * Phantombot-managed runtime state. Lives at $XDG_DATA_HOME/phantombot/state.json.
 *
 * Distinct from config.toml: config.toml is user-owned and hand-edited,
 * state.json is phantombot-owned and mutated by commands like
 * `set-default-persona`. Splitting them lets us avoid round-tripping the
 * user's TOML (which would lose comments) when phantombot updates a setting.
 *
 * Resolution priority for any value that lives in both: env > state > toml > default.
 */

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { xdgDataHome } from "./config.ts";

export interface State {
  default_persona?: string;
}

export function statePath(): string {
  return (
    process.env.PHANTOMBOT_STATE ??
    join(xdgDataHome(), "phantombot", "state.json")
  );
}

export async function loadState(): Promise<State> {
  try {
    const content = await readFile(statePath(), "utf8");
    const parsed = JSON.parse(content);
    return typeof parsed === "object" && parsed !== null ? parsed : {};
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw e;
  }
}

export async function saveState(state: State): Promise<string> {
  const path = statePath();
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(state, null, 2) + "\n", "utf8");
  return path;
}
