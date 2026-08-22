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
 *   phantombot memory capture "<text>" --tag <tag> [--tag <tag> ...]
 *                              append a tagged line to today's daily file
 *                              and record the capture in capture_log
 *   phantombot memory drawers [--kind <k>] [--limit N] [--sync] [--json]
 *                              show the RANKED drawer rows the threat judge is
 *                              briefed from, and optionally project the
 *                              markdown drawers into rows first
 */

import { defineCommand } from "citty";
import { existsSync } from "node:fs";
import { appendFile, mkdir, writeFile } from "node:fs/promises";
import { isAbsolute, join, relative, resolve } from "node:path";

import {
  type Config,
  loadConfig,
  memoryIndexPath,
  personaDir,
} from "../config.ts";
import { defaultEmbedder, runEmbedJob } from "../lib/embedJob.ts";
import { geminiEmbed } from "../lib/geminiEmbed.ts";
import { TAG_TO_DRAWER } from "../lib/heartbeat.ts";
import type { WriteSink } from "../lib/io.ts";
import { log } from "../lib/logger.ts";
import { MemoryIndex, type Scope } from "../lib/memoryIndex.ts";
import { openMemoryStore } from "../memory/store.ts";
import {
  DRAWER_KINDS,
  isDrawerKind,
  scoreEntry,
  type DrawerKind,
} from "../memory/drawers.ts";
import { describeIngest } from "../memory/drawerIngest.ts";
import { openDrawerStore, syncDrawers } from "../memory/drawerSync.ts";
import {
  describeRoundTrip,
  verifyDrawerRoundTrip,
} from "../memory/drawerExport.ts";
import { describeRetirement, retireDrawers } from "../memory/drawerRetire.ts";
import {
  backupMemoryDb,
  checkIntegrity,
  listRestorePoints,
  restoreMemoryDb,
} from "../memory/dbBackup.ts";
import { flushDueConversationTurns } from "../orchestrator/turnIndexer.ts";

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
  // Config of the persona being acted on, not the default (#436).
  const config = input.config ?? (await loadConfig(input.persona));
  const { persona, dir } = resolvePersonaDir(config, input.persona);

  if (!existsSync(dir)) {
    err.write(`persona '${persona}' not found at ${dir}\n`);
    return 2;
  }

  const ix = await MemoryIndex.open(input.indexPath ?? memoryIndexPath(persona));
  try {
    await ix.refreshStale(dir);

    // If embeddings are configured AND there are stored vectors, do a
    // hybrid search. Otherwise fall back to FTS-only.
    let queryVec: Float32Array | undefined;
    if (
      config.embeddings.provider === "gemini" &&
      config.embeddings.gemini?.apiKey &&
      ix.embeddingCount() > 0
    ) {
      const r = await geminiEmbed(
        config.embeddings.gemini.apiKey,
        input.query,
        {
          model: config.embeddings.gemini.model,
          dims: config.embeddings.gemini.dims,
        },
      );
      if (r.ok) queryVec = r.values;
      else err.write(`(query embed failed: ${r.error}; falling back to FTS-only)\n`);
    }

    // No-embeddings path gets OKF link-graph expansion when enabled, matching
    // turn-time auto-retrieval; the hybrid (Gemini) path is unchanged.
    const ge = config.retrieval?.graphExpansion;
    const hits = queryVec
      ? ix.hybridSearch(input.query, queryVec, {
          scope: input.scope,
          limit: input.limit,
        })
      : ge?.enabled
        ? ix.searchExpanded(input.query, {
            scope: input.scope,
            limit: input.limit,
            hops: ge?.hops,
            maxAdd: ge?.maxAdd,
          })
        : ix.search(input.query, {
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
  // Config of the persona being acted on, not the default (#436).
  const config = input.config ?? (await loadConfig(input.persona));
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
  // Config of the persona being acted on, not the default (#436).
  const config = input.config ?? (await loadConfig(input.persona));
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
  // Config of the persona being acted on, not the default (#436).
  const config = input.config ?? (await loadConfig(input.persona));
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

export interface RunIndexInputV2 extends RunIndexInput {
  /** Skip the embedding pass even when a provider is configured. */
  noEmbed?: boolean;
  /**
   * Force-flush unindexed conversation turn tails across ALL conversations
   * instead of (re)building the notes/KB index. This is the operator
   * backfill path for the time-based turn flush — drains tails that are
   * below the turn-index batch and haven't aged into the heartbeat window yet.
   */
  flushTurns?: boolean;
}

export async function runMemoryIndex(
  input: RunIndexInputV2,
): Promise<number> {
  const out = input.out ?? process.stdout;
  const err = input.err ?? process.stderr;
  // Config of the persona being acted on, not the default (#436).
  const config = input.config ?? (await loadConfig(input.persona));
  const { persona, dir } = resolvePersonaDir(config, input.persona);

  if (!existsSync(dir)) {
    err.write(`persona '${persona}' not found at ${dir}\n`);
    return 2;
  }

  // `--turns`: force-flush conversation turn tails instead of the notes/KB
  // index. Separate path — the FTS/embed work below is for memory/ + kb/
  // files, which never touches the raw-turn index.
  if (input.flushTurns) {
    const turnIndexing = config.retrieval?.turnIndexing;
    if (!config.retrieval?.enabled || !turnIndexing?.enabled) {
      out.write(`turn indexing is disabled in config; nothing to flush\n`);
      return 0;
    }
    const store = await openMemoryStore(config.memoryDbPath);
    try {
      const r = await flushDueConversationTurns({
        config,
        persona,
        memory: store,
        settings: turnIndexing,
        force: true,
      });
      out.write(
        `turn flush for '${persona}': ` +
          `${r.triggered}/${r.conversations} conversation(s) flushed, ` +
          `${r.indexed} turn(s) indexed` +
          (r.embedded > 0 ? `, ${r.embedded} embedded` : "") +
          (r.embeddingFailures > 0
            ? `, ${r.embeddingFailures} embed failure(s)`
            : "") +
          // The repair pass is the only thing that can reach turns stranded
          // behind the cursor by an earlier embed failure, so say so out loud
          // when it does — otherwise a silent self-heal looks like a no-op run.
          (r.repaired > 0 ? `, ${r.repaired} re-embedded (repair)` : "") +
          (r.repairFailures > 0
            ? `, ${r.repairFailures} repair failure(s)`
            : "") +
          `\n`,
      );
    } finally {
      await store.close();
    }
    return 0;
  }

  const ix = await MemoryIndex.open(input.indexPath ?? memoryIndexPath(persona));
  try {
    const ftsResult = input.rebuild
      ? { ...(await ix.rebuild(dir)), removed: 0 }
      : await ix.refreshStale(dir);
    out.write(
      `${input.rebuild ? "rebuilt" : "refreshed"} FTS index for '${persona}': ` +
        `${ftsResult.indexed} file(s) (re)indexed` +
        (ftsResult.removed > 0 ? `, ${ftsResult.removed} removed` : "") +
        `\n`,
    );

    if (input.noEmbed) {
      out.write(`(skipping embedding pass; --no-embed)\n`);
      return 0;
    }
    const embedder = defaultEmbedder(config);
    if (!embedder) {
      out.write(
        `(embeddings provider is "${config.embeddings.provider}"; ` +
          `run \`phantombot embedding\` to set up Gemini)\n`,
      );
      return 0;
    }

    out.write(`embedding…\n`);
    const r = await runEmbedJob({
      personaDir: dir,
      index: ix,
      embedder,
      force: input.rebuild,
    });
    out.write(
      `embedded ${r.embedded}, skipped ${r.skipped} (sha match), ` +
        `failed ${r.failed} of ${r.totalNotes} notes\n`,
    );
    if (r.failed > 0) {
      for (const e of r.errors.slice(0, 5)) {
        err.write(`  ${e.path}#${e.chunkIdx}: ${e.error}\n`);
      }
      if (r.errors.length > 5) {
        err.write(`  ...and ${r.errors.length - 5} more\n`);
      }
    }
  } finally {
    ix.close();
  }
  return 0;
}

export interface RunCaptureInput extends RunMemoryInput {
  text: string;
  tags: string[];
  persona?: string;
  /** Conversation key the capture belongs to. Default: cli:default. */
  conversation?: string;
  /** Override "today" for testing. ISO date YYYY-MM-DD. */
  date?: string;
  /** Override "now" for the line timestamp (testing). */
  now?: Date;
  /**
   * Skip the index-on-write step (tests, or callers that index themselves).
   * Default false: every capture is indexed so it's recall-able immediately,
   * without waiting for the 30-min heartbeat or the nightly pass.
   */
  skipIndex?: boolean;
  /** Override the index path (testing). */
  indexPath?: string;
}

/**
 * `phantombot memory capture` — append one tagged line per tag to today's
 * daily file and record the capture in `capture_log`.
 *
 * Gives the capture protocol the same observable shape every other
 * harness-facing tool has: a command, a log line, an exit code. The line
 * leads with the tag (`- [decision] … · 09:34Z`) so the heartbeat
 * promotion regex matches and the timestamp lands at the end where it
 * won't break the `[a-z]+` tag capture.
 */
export async function runMemoryCapture(
  input: RunCaptureInput,
): Promise<number> {
  const out = input.out ?? process.stdout;
  const err = input.err ?? process.stderr;
  // Config of the persona being acted on, not the default (#436).
  const config = input.config ?? (await loadConfig(input.persona));
  const { persona, dir } = resolvePersonaDir(config, input.persona);

  if (!existsSync(dir)) {
    err.write(`persona '${persona}' not found at ${dir}\n`);
    return 2;
  }

  const text = input.text.trim();
  if (text.length === 0) {
    err.write("memory capture: empty text\n");
    return 2;
  }

  const tags = input.tags.map((t) => t.trim().toLowerCase()).filter(Boolean);
  if (tags.length === 0) {
    err.write("memory capture: at least one --tag is required\n");
    return 2;
  }
  for (const tag of tags) {
    if (!TAG_TO_DRAWER[tag]) {
      err.write(
        `memory capture: unknown tag '${tag}'. ` +
          `Valid tags: ${Object.keys(TAG_TO_DRAWER).sort().join(", ")}\n`,
      );
      return 2;
    }
  }

  const now = input.now ?? new Date();
  const date = input.date ?? now.toISOString().slice(0, 10);
  const memDir = join(dir, "memory");
  await mkdir(memDir, { recursive: true });
  const dailyPath = join(memDir, `${date}.md`);

  // Create today's daily file with a one-line header if it doesn't exist.
  if (!existsSync(dailyPath)) {
    await Bun.write(dailyPath, `# ${date}\n`);
  }

  // HH:MMZ — appended at the END of the line so the heartbeat tag regex
  // (/^\s*-?\s*\[([a-z]+)\]\s+(.+)$/i) still matches.
  const stamp = `${now.toISOString().slice(11, 16)}Z`;
  let block = "";
  for (const tag of tags) {
    block += `- [${tag}] ${text} · ${stamp}\n`;
  }
  await appendFile(dailyPath, block, "utf8");

  // Record the capture so the nudge counter and `doctor` can see it.
  const conversation = input.conversation ?? "cli:default";
  const store = await openMemoryStore(config.memoryDbPath);
  try {
    await store.appendCapture({ persona, conversation, tags });
  } finally {
    await store.close();
  }

  // Index-on-write: make this capture recall-able NOW, not after the next
  // heartbeat/nightly. Broadened scope — this fires for EVERY capture
  // (decision, person, lesson, commitment), not just the security path —
  // which is the more correct behaviour: same-session recall for all notes.
  //
  // Inline, not detached: runMemoryCapture is usually a one-shot CLI process
  // that exits the moment it returns, so a fire-and-forget background task
  // would be killed before it finished. It stays cheap because the refresh is
  // incremental (only the changed daily file is touched) and embedding is
  // content-hashed (only the one new chunk hits the network). Best-effort:
  // an indexing failure NEVER fails the capture — the write already
  // succeeded, and the heartbeat/nightly remain the backstop.
  if (!input.skipIndex) {
    await indexAfterCapture(config, persona, dir, input.indexPath);
  }

  out.write(
    `memory capture: tags=${tags.join(",")} conv=${conversation} ` +
      `persona=${persona} ok\n`,
  );
  return 0;
}

/**
 * Incrementally index a persona's memory dir right after a capture write.
 * Refreshes the FTS index (instant, local — keyword recall works the same
 * second) and, when embeddings are configured, embeds the new chunk
 * (semantic recall). Never throws: any failure is logged and swallowed so
 * the capture's success is unaffected. Exported for testing.
 */
export async function indexAfterCapture(
  config: Config,
  persona: string,
  dir: string,
  indexPathOverride?: string,
): Promise<void> {
  let ix: MemoryIndex | undefined;
  try {
    ix = await MemoryIndex.open(indexPathOverride ?? memoryIndexPath(persona));
    // FTS first — local, fast, gives immediate keyword recall.
    await ix.refreshStale(dir);
    // Then the vector embed for the new chunk(s), if embeddings are set up.
    // sha-skip means unchanged chunks cost nothing; a missing key just means
    // FTS-only recall until the heartbeat runs the full job.
    const embedder = defaultEmbedder(config);
    if (embedder) {
      await runEmbedJob({ personaDir: dir, index: ix, embedder });
    }
  } catch (e) {
    log.warn(`memory capture: index-on-write failed (non-fatal): ${(e as Error).message}`);
  } finally {
    ix?.close();
  }
}

// ---------------------------------------------------------------------------
/**
 * Show the ranked drawer rows — the projection the threat judge actually reads.
 *
 * This is the operator's answer to "is #410 live on this box, or is the table
 * still empty?", which for two PRs had no answer short of opening SQLite by
 * hand. `--sync` runs the same markdown→rows projection the heartbeat runs, so
 * a fresh box does not have to wait up to 30 minutes to find out.
 */
export async function runMemoryDrawers(input: {
  /** Persona whose drawers to act on. Defaults to the active persona. */
  persona?: string;
  kind?: string;
  limit?: number;
  sync?: boolean;
  force?: boolean;
  /** File one entry into a drawer. Requires --kind. */
  file?: string;
  /** Render drawers back to markdown: a directory, or `-` for stdout. */
  export?: string;
  /** Archive and remove any markdown drawer whose content is proven filed. */
  retire?: boolean;
  json?: boolean;
  out?: WriteSink;
}): Promise<number> {
  const sink = input.out ?? process.stdout;
  const write = (t: string) => sink.write(t);
  // Acts on ONE persona's store, so load that persona's config (#436).
  const config = await loadConfig(input.persona);
  const { persona, dir } = resolvePersonaDir(config, input.persona);

  if (input.kind !== undefined && !isDrawerKind(input.kind)) {
    write(
      `unknown drawer '${input.kind}' (expected: ${DRAWER_KINDS.join(", ")})\n`,
    );
    return 1;
  }
  const kinds: readonly DrawerKind[] = input.kind
    ? [input.kind as DrawerKind]
    : DRAWER_KINDS;

  if (input.file !== undefined && input.kind === undefined) {
    write("--file needs --kind (which drawer the entry belongs in)\n");
    return 1;
  }

  const { store, db, close } = await openDrawerStore(config.memoryDbPath);
  try {
    if (input.file !== undefined) {
      const entry = store.file({
        persona,
        kind: kinds[0]!,
        content: input.file,
        // `self`: the persona filed it. The principal's own assertions are
        // filed by the code paths that can prove who is speaking, never by a
        // CLI flag anyone in a nightly turn could pass.
        source: "self",
        origin: "cli",
      });
      write(`filed ${entry.kind} ${entry.id}\n`);
      return 0;
    }

    if (input.export !== undefined) {
      for (const kind of kinds) {
        const trip = verifyDrawerRoundTrip(store, persona, kind);
        if (input.export === "-") {
          write(trip.markdown);
          continue;
        }
        await mkdir(input.export, { recursive: true });
        const dest = join(input.export, `${kind}.md`);
        await writeFile(dest, trip.markdown, "utf8");
        write(`${dest}: ${describeRoundTrip(trip)}\n`);
      }
      return 0;
    }

    if (input.retire) {
      const results = await retireDrawers({
        store,
        db,
        personaDir: dir,
        persona,
        kinds,
      });
      for (const r of results) write(`${describeRetirement(r)}\n`);
      // A held drawer is a FAILED retirement, not a quiet skip: it means the
      // markdown still holds something the table does not, which is the one
      // outcome an operator must not scroll past.
      return results.some((r) => r.status === "held") ? 1 : 0;
    }

    if (input.sync || input.force) {
      const result = await syncDrawers({
        store,
        db,
        personaDir: dir,
        persona,
        force: input.force,
      });
      if (!input.json) {
        for (const r of result.ingested) write(`${describeIngest(r)}\n`);
        if (result.unchanged.length > 0) {
          write(`unchanged: ${result.unchanged.join(", ")}\n`);
        }
        if (result.missing.length > 0) {
          write(`no file: ${result.missing.join(", ")}\n`);
        }
        write("\n");
      }
    }

    const now = new Date();
    const payload = kinds.map((kind) => ({
      kind,
      entries: store.ranked(persona, kind, { limit: input.limit }).map((e) => ({
        id: e.id,
        content: e.content,
        score: Number(scoreEntry(e, now).toFixed(4)),
        weight: e.weight,
        source: e.source,
        assertedAt: e.assertedAt.toISOString(),
        lastReaffirmedAt: e.lastReaffirmedAt.toISOString(),
      })),
      // Total INCLUDING superseded/dormant rows: "12 of 1411 shown" is the
      // number that tells an operator the projection ran, where a ranked count
      // alone cannot distinguish an empty table from a fully decayed drawer.
      total: store.list(persona, kind).length,
    }));

    if (input.json) {
      write(`${JSON.stringify({ persona, drawers: payload }, null, 2)}\n`);
      return 0;
    }
    for (const drawer of payload) {
      write(
        `## ${drawer.kind} — ${drawer.entries.length} injectable of ${drawer.total} filed\n`,
      );
      for (const e of drawer.entries) {
        write(`  [${e.score.toFixed(3)}] ${e.content.replace(/\s*\n\s*/g, " ")}\n`);
      }
      write("\n");
    }
    return 0;
  } finally {
    close();
  }
}

// ---------------------------------------------------------------------------
/**
 * Restore points for the memory database (#417).
 *
 * `--list` is the first thing an operator runs after `doctor` says the
 * database is unhealthy, so it prints the integrity verdict of EACH point, not
 * just the filenames: "which of these can I actually restore from" is the only
 * question being asked, and answering it with a directory listing would leave
 * them to find out by trying.
 */
export async function runMemoryBackup(input: {
  /** Persona whose database to back up. Defaults to the active persona. */
  persona?: string;
  list?: boolean;
  keep?: number;
  out?: WriteSink;
}): Promise<number> {
  const sink = input.out ?? process.stdout;
  const write = (t: string) => sink.write(t);
  // Acts on ONE persona's store, so load that persona's config (#436).
  const config = await loadConfig(input.persona);

  if (input.list) {
    const health = checkIntegrity(config.memoryDbPath);
    write(
      `live: ${config.memoryDbPath} — ${health.ok ? "ok" : `UNHEALTHY (${health.detail})`}\n`,
    );
    const points = await listRestorePoints(config.memoryDbPath);
    if (points.length === 0) {
      write("no restore points yet — the nightly takes one per sweep\n");
      return 0;
    }
    for (const p of points) {
      const v = checkIntegrity(p.path);
      write(
        `${p.takenAt.toISOString()}  ${Math.round(p.bytes / 1024)} KB  ` +
          `${v.ok ? "ok" : `UNHEALTHY (${v.detail})`}  ${p.path}\n`,
      );
    }
    return 0;
  }

  const result = await backupMemoryDb({
    dbPath: config.memoryDbPath,
    keep: input.keep,
  });
  switch (result.status) {
    case "taken":
      write(
        `snapshot ${result.path} (${Math.round((result.bytes ?? 0) / 1024)} KB)` +
          (result.pruned.length > 0
            ? `, ${result.pruned.length} rotated out`
            : "") +
          `\n`,
      );
      return 0;
    case "skipped":
      write(`no memory database at ${config.memoryDbPath}\n`);
      return 1;
    case "refused":
      write(
        `REFUSED: ${config.memoryDbPath} fails its integrity check ` +
          `(${result.integrity.detail}).\n` +
          `Existing restore points were left untouched — recover with ` +
          `'phantombot memory restore --list'.\n`,
      );
      return 1;
  }
}

// ---------------------------------------------------------------------------
/**
 * Put a restore point back over the live memory database.
 *
 * Refuses without `--yes`. Phantombot holds the database open for its whole
 * life, so swapping the file under a running daemon leaves it writing into a
 * deleted inode — the restore appears to work and every turn after it is lost
 * on the next restart. The confirmation exists to make the operator stop the
 * service first, and the message says so rather than just demanding a flag.
 */
export async function runMemoryRestore(input: {
  /** Persona whose database to restore. Defaults to the active persona. */
  persona?: string;
  from?: string;
  list?: boolean;
  yes?: boolean;
  out?: WriteSink;
}): Promise<number> {
  const sink = input.out ?? process.stdout;
  const write = (t: string) => sink.write(t);
  if (input.list || !input.from) {
    if (!input.list) {
      write("--from <restore point> is required. Available points:\n");
    }
    return await runMemoryBackup({ list: true, out: sink, persona: input.persona });
  }
  // Acts on ONE persona's store, so load that persona's config (#436).
  const config = await loadConfig(input.persona);
  if (!input.yes) {
    write(
      `This replaces ${config.memoryDbPath} with ${input.from}.\n` +
        `Stop phantombot first ('phantombot stop'), then re-run with --yes.\n` +
        `The current database is moved aside, not deleted.\n`,
    );
    return 1;
  }
  try {
    const r = await restoreMemoryDb({
      dbPath: config.memoryDbPath,
      from: input.from,
    });
    write(
      `restored ${config.memoryDbPath} from ${r.restoredFrom} ` +
        `(${Math.round(r.bytes / 1024)} KB)\n` +
        (r.previousAt ? `previous database kept at ${r.previousAt}\n` : "") +
        `start phantombot again with 'phantombot start'\n`,
    );
    return 0;
  } catch (e) {
    write(`restore failed: ${(e as Error).message}\n`);
    return 1;
  }
}

// Citty subcommand wiring
// ---------------------------------------------------------------------------

const searchCmd = defineCommand({
  meta: { name: "search", description: "Search memory/ and kb/: hybrid BM25+vector when Gemini embeddings are set, else OKF field-weighted BM25 with link-graph expansion." },
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
  meta: { name: "index", description: "Refresh FTS5 + embeddings (incremental by default; --rebuild for from-scratch; --no-embed to skip the vector pass)." },
  args: {
    persona: { type: "string", description: "Persona name." },
    rebuild: { type: "boolean", description: "Drop and re-index from scratch.", default: false },
    "no-embed": { type: "boolean", description: "Skip embedding pass (FTS only).", default: false },
    turns: { type: "boolean", description: "Force-flush unindexed conversation turn tails (all conversations) instead of the notes/KB index.", default: false },
  },
  async run({ args }) {
    process.exitCode = await runMemoryIndex({
      persona: args.persona ? String(args.persona) : undefined,
      rebuild: Boolean(args.rebuild),
      noEmbed: Boolean(args["no-embed"]),
      flushTurns: Boolean(args.turns),
    });
  },
});

const captureCmd = defineCommand({
  meta: {
    name: "capture",
    description:
      "Append a tagged line to today's daily file and record the capture (decision | lesson | person | commitment | norm).",
  },
  args: {
    text: {
      type: "positional",
      description: "The thing worth keeping.",
      required: true,
    },
    tag: {
      type: "string",
      description:
        "Tag (decision | lesson | person | commitment | norm). Repeatable for multi-tag. " +
        "`norm` records what is ROUTINE in the owner's world — it briefs the threat judge so it doesn't cry wolf on normal operations.",
      required: true,
    },
    persona: { type: "string", description: "Persona name." },
    conversation: {
      type: "string",
      description: "Conversation key this capture belongs to (default cli:default).",
    },
  },
  async run({ args }) {
    // citty collapses repeated --tag into a string OR string[]; normalise.
    const rawTag = args.tag as unknown;
    const tags = Array.isArray(rawTag)
      ? rawTag.map(String)
      : [String(rawTag)];
    process.exitCode = await runMemoryCapture({
      text: String(args.text),
      tags,
      persona: args.persona ? String(args.persona) : undefined,
      conversation: args.conversation ? String(args.conversation) : undefined,
    });
  },
});

const backupCmd = defineCommand({
  meta: {
    name: "backup",
    description:
      "Take a verified snapshot of the memory database, or --list the restore points that exist.",
  },
  args: {
    list: {
      type: "boolean",
      description: "List restore points with each one's integrity verdict.",
      default: false,
    },
    keep: { type: "string", description: "How many restore points to keep." },
  },
  async run({ args }) {
    const keep = Number(args.keep);
    process.exitCode = await runMemoryBackup({
      list: Boolean(args.list),
      keep: Number.isFinite(keep) && keep > 0 ? Math.floor(keep) : undefined,
    });
  },
});

const restoreCmd = defineCommand({
  meta: {
    name: "restore",
    description:
      "Restore the memory database from a snapshot (stop phantombot first).",
  },
  args: {
    from: { type: "string", description: "Restore point to restore from." },
    list: {
      type: "boolean",
      description: "List restore points instead of restoring.",
      default: false,
    },
    yes: {
      type: "boolean",
      description: "Confirm the swap. Without it, nothing is written.",
      default: false,
    },
  },
  async run({ args }) {
    process.exitCode = await runMemoryRestore({
      from: args.from ? String(args.from) : undefined,
      list: Boolean(args.list),
      yes: Boolean(args.yes),
    });
  },
});

const drawersCmd = defineCommand({
  meta: {
    name: "drawers",
    description:
      "Show the ranked drawer rows the threat judge is briefed from (--sync to project the markdown drawers into rows first).",
  },
  args: {
    persona: { type: "string", description: "Persona name." },
    kind: {
      type: "string",
      description: `One drawer (${DRAWER_KINDS.join(" | ")}). Default: all five.`,
    },
    limit: { type: "string", description: "Max entries per drawer." },
    sync: {
      type: "boolean",
      description: "Project the markdown drawers into rows before listing.",
      default: false,
    },
    force: {
      type: "boolean",
      description: "Re-ingest even when a drawer's content hash is unchanged.",
      default: false,
    },
    file: {
      type: "string",
      description:
        "File one entry into the drawer named by --kind. Idempotent: re-filing the same text reaffirms it.",
    },
    export: {
      type: "string",
      description:
        "Render the drawer(s) back to markdown into this directory, or '-' for stdout.",
    },
    retire: {
      type: "boolean",
      description:
        "Archive and remove the markdown drawer file(s) whose content is proven filed and re-renderable.",
      default: false,
    },
    json: { type: "boolean", description: "JSON output.", default: false },
  },
  async run({ args }) {
    const limit = Number(args.limit);
    process.exitCode = await runMemoryDrawers({
      persona: args.persona ? String(args.persona) : undefined,
      kind: args.kind ? String(args.kind) : undefined,
      limit: Number.isFinite(limit) && limit > 0 ? Math.floor(limit) : undefined,
      sync: Boolean(args.sync),
      force: Boolean(args.force),
      file: args.file === undefined ? undefined : String(args.file),
      export: args.export === undefined ? undefined : String(args.export),
      retire: Boolean(args.retire),
      json: Boolean(args.json),
    });
  },
});

export default defineCommand({
  meta: {
    name: "memory",
    description:
      "Memory tools the harness can call from its Bash loop (search, get, list, today, index, capture, drawers).",
  },
  subCommands: {
    search: searchCmd,
    get: getCmd,
    list: listCmd,
    today: todayCmd,
    index: indexCmd,
    capture: captureCmd,
    drawers: drawersCmd,
    backup: backupCmd,
    restore: restoreCmd,
  },
});
