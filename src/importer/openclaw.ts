/**
 * OpenClaw → phantombot persona importer.
 *
 * Walks an OpenClaw agent directory and copies the markdown files
 * phantombot's persona loader knows about (BOOT.md / SOUL.md /
 * IDENTITY.md / MEMORY.md / tools.md / AGENTS.md), plus any other
 * top-level .md files (free agent context the harness can `Read`).
 *
 * Skipped explicitly:
 *   - SQLite files (*.sqlite, *.sqlite-*, *.db)
 *   - JSONL transcripts (conversation history; not portable in v1)
 *   - dotfiles (.env, .git, etc.)
 *   - subdirectories (node_modules, .git, anything else)
 *
 * Conversation history is intentionally NOT imported in v1 — phantombot
 * has no transcript-import path yet. A future `phantombot import-history`
 * command can land once the OpenClaw transcript format is documented.
 */

import { copyFile, mkdir, readdir, stat } from "node:fs/promises";
import { basename, extname, join } from "node:path";

const RECOGNIZED_FILES: ReadonlySet<string> = new Set([
  "BOOT.md",
  "SOUL.md",
  "IDENTITY.md",
  "MEMORY.md",
  "tools.md",
  "AGENTS.md",
]);

const IDENTITY_FILES: readonly string[] = ["BOOT.md", "SOUL.md", "IDENTITY.md"];

const SKIP_DIRS: ReadonlySet<string> = new Set([
  "node_modules",
  ".git",
  "dist",
  "build",
  "target",
]);

const SKIP_EXTENSIONS: ReadonlySet<string> = new Set([
  ".sqlite",
  ".sqlite-journal",
  ".sqlite-wal",
  ".sqlite-shm",
  ".db",
  ".jsonl",
]);

const VALID_NAME = /^[a-zA-Z0-9_-]+$/;

export interface ImportPersonaInput {
  /** Path to the OpenClaw (or phantombot-shaped) agent directory. */
  source: string;
  /** Personas root directory (typically config.personasDir). */
  personasDir: string;
  /** Override target persona name. Defaults to basename(source). */
  as?: string;
  /** Replace an existing persona of the same name. */
  overwrite?: boolean;
}

export interface ImportPersonaResult {
  /** Final persona name. */
  name: string;
  /** Directory the files were copied into. */
  targetDir: string;
  /** Filenames copied, in source-listing order. */
  copied: string[];
  /** Entries skipped (with a reason annotation). */
  skipped: string[];
}

export async function importPersona(
  input: ImportPersonaInput,
): Promise<ImportPersonaResult> {
  let srcStat;
  try {
    srcStat = await stat(input.source);
  } catch {
    throw new Error(`source path does not exist: ${input.source}`);
  }
  if (!srcStat.isDirectory()) {
    throw new Error(`source path is not a directory: ${input.source}`);
  }

  const entries = await readdir(input.source, { withFileTypes: true });

  const hasIdentity = entries.some(
    (e) => e.isFile() && IDENTITY_FILES.includes(e.name),
  );
  if (!hasIdentity) {
    throw new Error(
      `no identity file in source (expected one of: ${IDENTITY_FILES.join(", ")}): ${input.source}`,
    );
  }

  const name = input.as ?? basename(input.source);
  if (!VALID_NAME.test(name)) {
    throw new Error(
      `invalid persona name '${name}' — use letters, digits, '-', or '_'`,
    );
  }

  const targetDir = join(input.personasDir, name);
  if (await dirExists(targetDir)) {
    if (!input.overwrite) {
      throw new Error(
        `persona '${name}' already exists at ${targetDir} (use --overwrite to replace)`,
      );
    }
  }

  await mkdir(targetDir, { recursive: true });

  const copied: string[] = [];
  const skipped: string[] = [];

  for (const e of entries) {
    if (e.isDirectory()) {
      const reason = SKIP_DIRS.has(e.name)
        ? "(non-portable directory)"
        : "(phantombot only imports top-level files)";
      skipped.push(`${e.name}/ ${reason}`);
      continue;
    }
    if (!e.isFile()) {
      skipped.push(`${e.name} (not a regular file)`);
      continue;
    }
    if (e.name.startsWith(".")) {
      skipped.push(`${e.name} (dotfile)`);
      continue;
    }
    const ext = extname(e.name).toLowerCase();
    if (SKIP_EXTENSIONS.has(ext)) {
      skipped.push(`${e.name} (non-portable: ${ext})`);
      continue;
    }
    if (RECOGNIZED_FILES.has(e.name) || ext === ".md") {
      await copyFile(join(input.source, e.name), join(targetDir, e.name));
      copied.push(e.name);
    } else {
      skipped.push(`${e.name} (not markdown)`);
    }
  }

  return { name, targetDir, copied, skipped };
}

async function dirExists(path: string): Promise<boolean> {
  try {
    const s = await stat(path);
    return s.isDirectory();
  } catch {
    return false;
  }
}
