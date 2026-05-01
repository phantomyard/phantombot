/**
 * `phantombot memory` — tools for the harness's own use.
 *
 * Subcommands the harness can call from its Bash tool:
 *
 *   phantombot memory search "<query>" [--scope memory|kb|all] [--limit N]
 *                              JSON to stdout: hits with path, snippet, score
 *   phantombot memory get <path>
 *                              cat a persona-relative file (validates path
 *                              is inside personasDir/<persona>/)
 *   phantombot memory list <subdir>
 *                              list files in a persona-relative subdir
 *   phantombot memory today
 *                              print today's daily-file path (creates the
 *                              directory if missing — returns the path
 *                              unconditionally so the harness can write to it)
 *   phantombot memory index [--rebuild]
 *                              rebuild the FTS5 index (incremental by default)
 */

import { defineCommand } from "citty";
import { existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { isAbsolute, join, relative, resolve } from "node:path";

import { type Config, loadConfig, personaDir } from "../config.ts";
import type { WriteSink } from "../lib/io.ts";
import { MemoryIndex, type Scope } from "../lib/memoryIndex.ts";

function indexPath(_config: Config, persona: string): string {
  // One index file per persona — easier to rebuild a single persona without
  // touching others, and easier to reason about scope.
  return join(
    process.env.XDG_DATA_HOME || join(process.env.HOME ?? "", ".local/share"),
    "phantombot",
    "memory-index",
    `${persona}.sqlite`,
  );
}

function resolvePersonaDir(config: Config, persona?: string): {
  persona: string;
  dir: string;
} {
  const name = persona ?? config.defaultPersona;
  return { persona: name, dir: personaDir(config, name) };
}

/**
 * Validate that `relPath` resolves to a file/dir INSIDE the persona dir.
 * Refuses absolute paths and `..` traversals so the harness can't
 * accidentally read/write outside the agent's workspace.
 */
function safeJoin(personaDir: string, relPath: string): string | null {
  if (isAbsolute(relPath)) return null;
  const candidate = resolve(personaDir, relPath);
  const r = relative(personaDir, candidate);
  if (r.startsWith("..") || isAbsolute(r)) return null;
  return candidate;
}

export interface RunMemoryInput {
  config?: Config;
  out?: WriteSink;
  err?: WriteSink;
}

export interface RunSearchInput extends RunMemoryInput {
  query: string;
  persona?: string;
  scope?: Scope | "all";
  limit?: number;
  /** Override the index path for testing. */
  indexPath?: string;
}

export async function runMemorySearch(
  input: RunSearchInput,
): Promise<number> {
  const out = input.out ?? process.stdout;
  const err = input.err ?? process.stderr;
  const config = input.config ?? (await loadConfig());
  const { persona, dir } = resolvePersonaDir(config, input.persona);

  if (!existsSync(dir)) {
    err.write(`persona '${persona}' not found at ${dir}\n`);
    return 2;
  }

  const ix = await MemoryIndex.open(input.indexPath ?? indexPath(config, persona));
  try {
    await ix.refreshStale(dir);
    const hits = ix.search(input.query, {
      scope: input.scope,
      limit: input.limit,
    });
    out.write(JSON.stringify({ persona, query: input.query, results: hits }, null, 2));
    out.write("\n");
  } finally {
    ix.close();
  }
  return 0;
}

export interface RunGetInput extends RunMemoryInput {
  path: string;
  persona?: string;
}

export async function runMemoryGet(input: RunGetInput): Promise<number> {
  const out = input.out ?? process.stdout;
  const err = input.err ?? process.stderr;
  const config = input.config ?? (await loadConfig());
  const { dir } = resolvePersonaDir(config, input.persona);

  const target = safeJoin(dir, input.path);
  if (!target) {
    err.write(`refusing path outside persona dir: ${input.path}\n`);
    return 2;
  }
  if (!existsSync(target)) {
    err.write(`not found: ${relative(dir, target)}\n`);
    return 1;
  }
  const file = Bun.file(target);
  out.write(await file.text());
  return 0;
}

export interface RunListInput extends RunMemoryInput {
  path: string;
  persona?: string;
}

export async function runMemoryList(input: RunListInput): Promise<number> {
  const out = input.out ?? process.stdout;
  const err = input.err ?? process.stderr;
  const config = input.config ?? (await loadConfig());
  const { dir } = resolvePersonaDir(config, input.persona);

  const target = safeJoin(dir, input.path);
  if (!target) {
    err.write(`refusing path outside persona dir: ${input.path}\n`);
    return 2;
  }
  if (!existsSync(target)) {
    err.write(`not found: ${relative(dir, target)}\n`);
    return 1;
  }
  const { readdir } = await import("node:fs/promises");
  const entries = await readdir(target, { withFileTypes: true });
  for (const e of entries) {
    if (e.name.startsWith(".")) continue;
    out.write(`${e.isDirectory() ? "d" : "f"}  ${e.name}\n`);
  }
  return 0;
}

export interface RunTodayInput extends RunMemoryInput {
  persona?: string;
  /** Override "today" for testing. ISO date YYYY-MM-DD. */
  date?: string;
}

export async function runMemoryToday(
  input: RunTodayInput,
): Promise<number> {
  const out = input.out ?? process.stdout;
  const err = input.err ?? process.stderr;
  const config = input.config ?? (await loadConfig());
  const { persona, dir } = resolvePersonaDir(config, input.persona);

  if (!existsSync(dir)) {
    err.write(`persona '${persona}' not found at ${dir}\n`);
    return 2;
  }

  const date = input.date ?? new Date().toISOString().slice(0, 10);
  const memDir = join(dir, "memory");
  await mkdir(memDir, { recursive: true });
  const path = join(memDir, `${date}.md`);
  out.write(path);
  out.write("\n");
  return 0;
}

export interface RunIndexInput extends RunMemoryInput {
  persona?: string;
  rebuild?: boolean;
  indexPath?: string;
}

export async function runMemoryIndex(
  input: RunIndexInput,
): Promise<number> {
  const out = input.out ?? process.stdout;
  const err = input.err ?? process.stderr;
  const config = input.config ?? (await loadConfig());
  const { persona, dir } = resolvePersonaDir(config, input.persona);

  if (!existsSync(dir)) {
    err.write(`persona '${persona}' not found at ${dir}\n`);
    return 2;
  }

  const ix = await MemoryIndex.open(input.indexPath ?? indexPath(config, persona));
  try {
    const r = input.rebuild
      ? { ...(await ix.rebuild(dir)), removed: 0 }
      : await ix.refreshStale(dir);
    out.write(
      `${input.rebuild ? "rebuilt" : "refreshed"} index for '${persona}': ` +
        `${r.indexed} file(s) (re)indexed` +
        (r.removed > 0 ? `, ${r.removed} removed` : "") +
        `\n`,
    );
  } finally {
    ix.close();
  }
  return 0;
}

// ---------------------------------------------------------------------------
// Citty subcommand wiring
// ---------------------------------------------------------------------------

const searchCmd = defineCommand({
  meta: { name: "search", description: "Hybrid (FTS5 today; +vec in phase 25) search across memory/ and kb/." },
  args: {
    query: {
      type: "positional",
      description: "What to search for.",
      required: true,
    },
    persona: { type: "string", description: "Persona name (default: configured default)." },
    scope: {
      type: "string",
      description: "memory | kb | all (default: all)",
      default: "all",
    },
    limit: { type: "string", description: "max results (default 5)", default: "5" },
  },
  async run({ args }) {
    const limit = Number(args.limit);
    process.exitCode = await runMemorySearch({
      query: String(args.query),
      persona: args.persona ? String(args.persona) : undefined,
      scope: (String(args.scope) as Scope | "all") ?? "all",
      limit: Number.isFinite(limit) && limit > 0 ? Math.floor(limit) : 5,
    });
  },
});

const getCmd = defineCommand({
  meta: { name: "get", description: "Cat a persona-relative file." },
  args: {
    path: { type: "positional", description: "Persona-relative path.", required: true },
    persona: { type: "string", description: "Persona name." },
  },
  async run({ args }) {
    process.exitCode = await runMemoryGet({
      path: String(args.path),
      persona: args.persona ? String(args.persona) : undefined,
    });
  },
});

const listCmd = defineCommand({
  meta: { name: "list", description: "List files in a persona-relative subdir." },
  args: {
    path: { type: "positional", description: "Persona-relative subdir.", required: true },
    persona: { type: "string", description: "Persona name." },
  },
  async run({ args }) {
    process.exitCode = await runMemoryList({
      path: String(args.path),
      persona: args.persona ? String(args.persona) : undefined,
    });
  },
});

const todayCmd = defineCommand({
  meta: { name: "today", description: "Print today's daily-file path (creates memory/ if absent)." },
  args: {
    persona: { type: "string", description: "Persona name." },
  },
  async run({ args }) {
    process.exitCode = await runMemoryToday({
      persona: args.persona ? String(args.persona) : undefined,
    });
  },
});

const indexCmd = defineCommand({
  meta: { name: "index", description: "Refresh the FTS5 index (incremental by default; --rebuild for from-scratch)." },
  args: {
    persona: { type: "string", description: "Persona name." },
    rebuild: { type: "boolean", description: "Drop and re-index from scratch.", default: false },
  },
  async run({ args }) {
    process.exitCode = await runMemoryIndex({
      persona: args.persona ? String(args.persona) : undefined,
      rebuild: Boolean(args.rebuild),
    });
  },
});

export default defineCommand({
  meta: {
    name: "memory",
    description:
      "Memory tools the harness can call from its Bash loop (search, get, list, today, index).",
  },
  subCommands: {
    search: searchCmd,
    get: getCmd,
    list: listCmd,
    today: todayCmd,
    index: indexCmd,
  },
});
