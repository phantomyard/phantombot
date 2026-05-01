/**
 * Read / mutate / write phantombot's config.toml.
 *
 * Uses smol-toml's parse + stringify which is a round-trip — comments and
 * blank lines do NOT survive. That's deliberate: phantombot's TUIs own
 * the config file and the old `phantombot config edit` command is gone,
 * so users shouldn't be hand-annotating it. If you really need to keep
 * a comment, edit the file by hand and accept that the next TUI write
 * will strip it.
 */

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { parse, stringify } from "smol-toml";

export type TomlObject = Record<string, unknown>;

export async function readConfigToml(path: string): Promise<TomlObject> {
  try {
    const content = await readFile(path, "utf8");
    return parse(content) as TomlObject;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw e;
  }
}

export async function writeConfigToml(
  path: string,
  data: TomlObject,
): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, stringify(data) + "\n", "utf8");
}

/**
 * Read, mutate, write — atomic from the caller's POV. The mutator can
 * shape the object however it likes; smol-toml will reject things that
 * aren't representable as TOML on stringify.
 */
export async function updateConfigToml(
  path: string,
  mutator: (current: TomlObject) => void | Promise<void>,
): Promise<void> {
  const current = await readConfigToml(path);
  await mutator(current);
  await writeConfigToml(path, current);
}

/**
 * Set a nested key path like ["channels", "telegram", "token"] = value.
 * Creates intermediate objects as needed.
 */
export function setIn(
  root: TomlObject,
  path: readonly string[],
  value: unknown,
): void {
  let cur: TomlObject = root;
  for (let i = 0; i < path.length - 1; i++) {
    const key = path[i]!;
    const next = cur[key];
    if (next && typeof next === "object" && !Array.isArray(next)) {
      cur = next as TomlObject;
    } else {
      const fresh: TomlObject = {};
      cur[key] = fresh;
      cur = fresh;
    }
  }
  cur[path[path.length - 1]!] = value;
}

/** Get a nested value. Returns undefined if any segment is missing. */
export function getIn(
  root: TomlObject,
  path: readonly string[],
): unknown {
  let cur: unknown = root;
  for (const key of path) {
    if (cur && typeof cur === "object" && !Array.isArray(cur)) {
      cur = (cur as TomlObject)[key];
    } else {
      return undefined;
    }
  }
  return cur;
}
