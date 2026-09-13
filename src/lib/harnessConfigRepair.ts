/**
 * `phantombot doctor`'s WRITER for the legacy-`pi` reconcile.
 *
 * The decision lives in lib/harnessReconcile.ts (pure, shared with loadConfig's
 * read-time mapping). This file only walks the config files that can carry a
 * harness chain — the host's global config.toml and every persona's own
 * config.toml — runs that decision on each, and, when repair is on, writes the
 * result.
 *
 * Safety rules (spec §5):
 *   - A file with zero changes is not touched and not reported. A claude-only
 *     or codex-only config is the normal case and produces no output at all.
 *   - Before any write the ORIGINAL bytes are copied to
 *     `config.toml.bak-<timestamp>`, then the new document is written to a temp
 *     file and renamed over the original, so a crash mid-write can never leave
 *     a truncated config.
 *   - The reconcile output contains no legacy ids, so the second run finds
 *     nothing to change and the file stays byte-identical.
 *   - An unparseable file is reported and left alone; repair never guesses.
 */

import { copyFile, readdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { parse, stringify } from "smol-toml";
import type { TomlObject } from "./configWriter.ts";
import {
  reconcileHarnessToml,
  type ReconcileChange,
} from "./harnessReconcile.ts";

export interface HarnessConfigFile {
  path: string;
  /** Persona owning this file; undefined = the host's global config.toml. */
  persona?: string;
}

export interface HarnessConfigFileResult {
  path: string;
  persona?: string;
  changes: ReconcileChange[];
  /** True when repair wrote the reconciled document. */
  written: boolean;
  backupPath?: string;
  error?: string;
}

/** The global config plus every persona's own config.toml that exists. */
export async function listHarnessConfigFiles(
  globalPath: string,
  personasDir: string,
): Promise<HarnessConfigFile[]> {
  const out: HarnessConfigFile[] = [{ path: globalPath }];
  let names: string[] = [];
  try {
    names = (await readdir(personasDir, { withFileTypes: true }))
      .filter((e) => e.isDirectory())
      .map((e) => e.name)
      .sort();
  } catch {
    // No personas dir yet — only the global file.
  }
  for (const name of names) {
    out.push({ path: join(personasDir, name, "config.toml"), persona: name });
  }
  return out;
}

export interface ReconcileHarnessConfigFilesInput {
  files: readonly HarnessConfigFile[];
  /**
   * Effective routing presence for the chain owned by `persona` (undefined =
   * the host's own chain). Must be the SAME resolved routing loadConfig sees,
   * or doctor and startup could map one entry two ways.
   */
  routingConfigured(persona: string | undefined): boolean;
  /** Live probe result — doctor always knows, unlike read time. */
  hostPiInstalled: boolean;
  repair: boolean;
  now?: Date;
}

export async function reconcileHarnessConfigFiles(
  input: ReconcileHarnessConfigFilesInput,
): Promise<HarnessConfigFileResult[]> {
  const results: HarnessConfigFileResult[] = [];
  for (const file of input.files) {
    let raw: string;
    try {
      raw = await readFile(file.path, "utf8");
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") continue;
      results.push({
        ...file,
        changes: [],
        written: false,
        error: `unreadable: ${(e as Error).message}`,
      });
      continue;
    }

    let toml: TomlObject;
    try {
      toml = parse(raw) as TomlObject;
    } catch (e) {
      results.push({
        ...file,
        changes: [],
        written: false,
        error: `unparseable config.toml, left untouched: ${(e as Error).message}`,
      });
      continue;
    }

    const { toml: next, changes } = reconcileHarnessToml(toml, {
      // A persona file's own `[harnesses].chain` belongs to that persona; a
      // `[harnesses.personas.<name>]` chain in the global file to <name>.
      routingConfigured: (chainPersona) =>
        input.routingConfigured(chainPersona ?? file.persona),
      hostPiInstalled: input.hostPiInstalled,
    });
    if (changes.length === 0) continue;

    const result: HarnessConfigFileResult = { ...file, changes, written: false };
    if (input.repair) {
      try {
        const stamp = (input.now ?? new Date()).toISOString().replace(/[:.]/g, "-");
        const backupPath = `${file.path}.bak-${stamp}`;
        await copyFile(file.path, backupPath);
        const tmp = `${file.path}.${process.pid}.tmp`;
        await writeFile(tmp, stringify(next) + "\n", "utf8");
        await rename(tmp, file.path);
        result.written = true;
        result.backupPath = backupPath;
      } catch (e) {
        result.error = `write failed, config unchanged: ${(e as Error).message}`;
      }
    }
    results.push(result);
  }
  return results;
}
