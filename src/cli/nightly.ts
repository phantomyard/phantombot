/**
 * `phantombot nightly` — the cognitive distillation pass.
 *
 * Every invocation is a SWEEP. Phantombot lists the daily files, diffs them
 * against the ledger in `memory/.nightly-state.json` (mtime, then content
 * hash), and processes every date that is new, that grew since it was
 * processed, or whose last pass didn't finish. Running it twice in a row
 * costs nothing; a box that was off for a week just sweeps a longer backlog
 * on the next run. That is why there is no `--resume`, no `--catch-up` and no
 * repair path in `doctor` — one owner, one code path.
 *
 * Per date: TWO harness turns run CONCURRENTLY (`distill` → drawers +
 * MEMORY.md, `kb` → kb/). They read the same daily file and write disjoint
 * targets, so there is no shared writer and no lock. Neither writes back to
 * the daily file — that keeps the ledger's hash stable. Once both join, the
 * driver refreshes the search index IN CODE (see refreshPersonaIndex), which
 * is both guaranteed and correctly ordered after the writes.
 *
 * Conversation key is `system:nightly:<YYYY-MM-DD>` so stages are isolated
 * from Telegram chats and share context per date.
 *
 * If the persona ships a `nightly-prompt.md` override, that custom prompt is
 * run as a single monolithic turn per date — the override owns the contract,
 * so phantombot can't safely split it.
 */

import { defineCommand } from "citty";
import { existsSync } from "node:fs";
import { join } from "node:path";

import { type Config, loadConfig, memoryIndexPath, personaDir } from "../config.ts";
import { buildHarnessChain } from "../harnesses/buildChain.ts";
import type { Harness } from "../harnesses/types.ts";
import { resolveHarnessBinsForConfig } from "../lib/harnessAvailability.ts";
import { refreshPersonaIndex } from "../lib/indexRefresh.ts";
import type { WriteSink } from "../lib/io.ts";
import { log } from "../lib/logger.ts";
import {
  buildNightlyPromptForPersona,
  buildNightlyStagePrompt,
  dateRecord,
  loadNightlyState,
  NIGHTLY_STAGES,
  type NightlyStage,
  nightlyConversationKey,
  type PendingDate,
  pendingForDate,
  STALE_RUN_MS,
  saveNightlyState,
  sweepDailyFiles,
} from "../lib/nightly.ts";
import { openMemoryStore } from "../memory/store.ts";
import { runTurn } from "../orchestrator/turn.ts";

const NIGHTLY_SUFFIX =
  "You are operating in NIGHTLY MAINTENANCE MODE. " +
  "Skip pleasantries. Do work, write files, report briefly.";

// Per-stage timeouts. A stage is one bounded job, so the hard cap can be
// tight; idle stays at 5 min to tolerate long thinking between tool calls.
const STAGE_IDLE_TIMEOUT_MS = 5 * 60_000;
const STAGE_HARD_TIMEOUT_MS = 20 * 60_000;

export interface RunNightlyInput {
  config?: Config;
  persona?: string;
  /** Process ONE specific date (YYYY-MM-DD), ledger state ignored. */
  today?: string;
  /**
   * Cap dates processed this run. Unset means NO cap: a sweep drains the whole
   * backlog in one pass. A months-deep first sweep is a long run, but it is a
   * one-off, the in-flight marker keeps the rollover trigger from starting a
   * second one on top of it, and a half-drained backlog that reappears every
   * night is worse than one long night. Set it only to bound a manual run.
   */
  maxDates?: number;
  /** Run even if another sweep holds the in-flight marker. */
  force?: boolean;
  out?: WriteSink;
  err?: WriteSink;
  /** Test seam — override the clock. */
  now?: Date;
  /** Test seam — run a stage without a real harness. */
  runStage?: (args: {
    persona: string;
    date: string;
    stage: NightlyStage | "override";
    prompt: string;
  }) => Promise<TurnResult>;
  /** Test seam — skip the real index refresh. */
  refreshIndex?: (personaDir: string) => Promise<void>;
}

export interface TurnResult {
  finalReply: string;
  errored?: string;
  durationMs: number;
}

/** Run one harness turn for the nightly conversation. */
async function runNightlyTurn(opts: {
  persona: string;
  conversation: string;
  userMessage: string;
  agentDir: string;
  harnesses: Harness[];
  memory: Awaited<ReturnType<typeof openMemoryStore>>;
}): Promise<TurnResult> {
  const startedAt = Date.now();
  let finalReply = "";
  let errored: string | undefined;
  try {
    for await (const chunk of runTurn({
      persona: opts.persona,
      conversation: opts.conversation,
      userMessage: opts.userMessage,
      agentDir: opts.agentDir,
      harnesses: opts.harnesses,
      memory: opts.memory,
      idleTimeoutMs: STAGE_IDLE_TIMEOUT_MS,
      hardTimeoutMs: STAGE_HARD_TIMEOUT_MS,
      systemPromptSuffix: NIGHTLY_SUFFIX,
      // Machine-driven, not a chat surface: the "user" message is one the
      // nightly wrote itself. Without this, new nightly rows would land
      // `channel` while the migration retro-tags historical `system:%` rows
      // `internal` — the same column disagreeing with itself either side of
      // an upgrade.
      origin: "internal",
      // Nightly needs no MCP; running MCP-free stops an unauthenticated remote
      // connector from wedging the --print startup and killing a stage on the
      // idle timeout. See HarnessRequest.mcpMode.
      mcpMode: "none",
    })) {
      if (chunk.type === "text") finalReply += chunk.text;
      if (chunk.type === "done") finalReply = chunk.finalText;
      if (chunk.type === "error") errored = chunk.error;
    }
  } catch (e) {
    errored = (e as Error).message;
  }
  return { finalReply, errored, durationMs: Date.now() - startedAt };
}

export async function runNightly(input: RunNightlyInput = {}): Promise<number> {
  const out = input.out ?? process.stdout;
  const err = input.err ?? process.stderr;
  const now = input.now ?? new Date();

  let config = input.config ?? (await loadConfig());
  const persona = input.persona ?? config.defaultPersona;
  const dir = personaDir(config, persona);
  if (!existsSync(dir)) {
    err.write(`persona '${persona}' not found at ${dir}\n`);
    return 2;
  }

  // Resolve harness binaries against the live filesystem the same way the
  // long-running `run` daemon does. Without this the nightly oneshot relied
  // solely on the systemd unit's narrow Environment=PATH and a PATH-relative
  // `pi` could fail with `exit 127` every night (issue #181 §1).
  if (!input.runStage) {
    ({ config } = await resolveHarnessBinsForConfig(config, { err }));
  }

  const harnesses = input.runStage ? [] : buildHarnessChain(config, err);
  if (!input.runStage && harnesses.length === 0) {
    err.write("no harnesses configured\n");
    return 2;
  }

  const state = await loadNightlyState(dir);

  // Single-sweep lock. A long backlog can outlive the gap to the next timer
  // fire; two sweeps on the same dates would double-file drawers. A marker
  // older than STALE_RUN_MS is a crashed run, not a live one, so it's taken
  // over rather than obeyed.
  if (state.current && !input.force) {
    const beat = Date.parse(state.current.updated_at ?? state.current.started_at);
    const alive = !Number.isNaN(beat) && now.getTime() - beat <= STALE_RUN_MS;
    if (alive) {
      out.write(
        `nightly: a sweep is already in flight (on ${state.current.date}, ` +
          `started ${state.current.started_at}) — skipping. Use --force to override.\n`,
      );
      return 0;
    }
    out.write(
      `nightly: taking over a stalled sweep (last beat ${state.current.updated_at}) \n`,
    );
  }

  // Which dates to process. `--date` is an explicit override for one day
  // (backfill / debugging); otherwise sweep everything unprocessed or changed.
  let queue: PendingDate[];
  if (input.today) {
    const one = await pendingForDate(dir, input.today);
    if (!one) {
      err.write(`no daily file for ${input.today} — nothing to process\n`);
      return 2;
    }
    queue = [one];
  } else {
    const sweep = await sweepDailyFiles(
      dir,
      state,
      now.toISOString().slice(0, 10),
    );
    // Files that were touched but not changed: refresh the ledger's mtime so
    // the next sweep takes the cheap stat-only path again. No turns spent.
    if (sweep.touched.length > 0) {
      const patch: Record<string, ReturnType<typeof dateRecord>> = {};
      for (const t of sweep.touched) {
        const prev = state.processed?.[t.date];
        if (prev) patch[t.date] = { ...prev, mtime_ms: t.mtime_ms, size: t.size };
      }
      await saveNightlyState(dir, { processed: patch });
    }
    queue = sweep.pending;
  }

  // No cap by default — the sweep drains the whole backlog. `--max-dates`
  // bounds a manual run; anything it leaves behind stays pending in the ledger.
  const cap = input.maxDates;
  const deferred =
    cap !== undefined && cap > 0 ? Math.max(0, queue.length - cap) : 0;
  if (deferred > 0) queue = queue.slice(0, cap);

  if (queue.length === 0) {
    out.write(`nightly: persona='${persona}' — nothing pending\n`);
    await saveNightlyState(dir, {
      last_run: now.toISOString(),
      last_status: "ok",
      current: null,
    });
    return 0;
  }

  out.write(
    `nightly: persona='${persona}' — ${queue.length} date(s) to process ` +
      `[${queue.map((q) => `${q.date}:${q.reason}`).join(", ")}]` +
      (deferred > 0 ? ` (+${deferred} deferred to the next run)` : "") +
      `\n`,
  );

  const monolithic = existsSync(join(dir, "nightly-prompt.md"));
  const memory = input.runStage ? null : await openMemoryStore(config.memoryDbPath);
  const startedAt = new Date().toISOString();
  const errors: string[] = [];

  try {
    for (const [i, pending] of queue.entries()) {
      const conversation = nightlyConversationKey(pending.date);
      await saveNightlyState(dir, {
        current: {
          date: pending.date,
          index: i + 1,
          total: queue.length,
          started_at: startedAt,
          updated_at: new Date().toISOString(),
          pid: process.pid,
        },
      });

      const runOne = async (
        stage: NightlyStage | "override",
        prompt: string,
      ): Promise<TurnResult> =>
        input.runStage
          ? await input.runStage({ persona, date: pending.date, stage, prompt })
          : await runNightlyTurn({
              persona,
              conversation,
              userMessage: prompt,
              agentDir: dir,
              harnesses,
              memory: memory!,
            });

      const stagesDone: NightlyStage[] = [];
      let dateError: string | undefined;
      const t0 = Date.now();

      if (monolithic) {
        const prompt = await buildNightlyPromptForPersona(
          dir,
          persona,
          pending.date,
        );
        const r = await runOne("override", prompt);
        if (r.errored) dateError = `override: ${r.errored}`;
        else stagesDone.push(...NIGHTLY_STAGES);
      } else {
        // The two stages write to disjoint targets (drawers+MEMORY.md vs kb/),
        // so they run concurrently. Nothing between them needs ordering — the
        // one thing that did, the index refresh, now happens after the join.
        const results = await Promise.all(
          NIGHTLY_STAGES.map(async (stage) => ({
            stage,
            r: await runOne(
              stage,
              buildNightlyStagePrompt(persona, pending.date, stage),
            ),
          })),
        );
        for (const { stage, r } of results) {
          if (r.errored) {
            const msg = `stage '${stage}' (${pending.date}): ${r.errored}`;
            dateError ??= msg;
            errors.push(msg);
            log.error("nightly: stage failed", {
              persona,
              date: pending.date,
              stage,
              error: r.errored,
            });
          } else {
            stagesDone.push(stage);
          }
        }
      }

      // Index refresh in code — guaranteed, once, after both stages joined.
      // A failure here is reported but never marks the date unprocessed: the
      // distillation itself succeeded and the next refresh picks the files up.
      if (input.refreshIndex) {
        await input.refreshIndex(dir);
      } else {
        const ix = await refreshPersonaIndex({
          config,
          personaDir: dir,
          indexPath: memoryIndexPath(persona),
        });
        if (ix.error) err.write(`nightly: index refresh failed — ${ix.error}\n`);
      }

      await saveNightlyState(dir, {
        processed: {
          [pending.date]: dateRecord(pending, stagesDone, dateError),
        },
      });
      if (dateError) {
        if (!errors.includes(dateError)) errors.push(dateError);
        out.write(
          `nightly: ${pending.date} PARTIAL (${stagesDone.length}/${NIGHTLY_STAGES.length} stages, ` +
            `${Date.now() - t0}ms) — ${dateError}\n`,
        );
      } else {
        out.write(`nightly: ${pending.date} ok (${Date.now() - t0}ms)\n`);
      }
    }
  } finally {
    await memory?.close();
  }

  const failed = errors.length > 0;
  await saveNightlyState(dir, {
    last_run: new Date().toISOString(),
    last_status: failed ? "partial" : "ok",
    ...(failed ? { errors } : { errors: [] }),
    current: null,
  });
  out.write(
    `nightly ${failed ? "FINISHED WITH ERRORS" : "ok"}: ${queue.length} date(s)` +
      (deferred > 0 ? `, ${deferred} deferred` : "") +
      `\n`,
  );
  log.info("nightly: sweep complete", {
    persona,
    dates: queue.length,
    deferred,
    errors: errors.length,
  });
  return failed ? 1 : 0;
}

export default defineCommand({
  meta: {
    name: "nightly",
    description:
      "Run the cognitive distillation sweep — every unprocessed or changed daily file is distilled into the drawers, MEMORY.md and the KB. Idempotent: re-running with nothing pending does nothing.",
  },
  args: {
    persona: {
      type: "string",
      description: "Persona name (default: configured default).",
    },
    date: {
      type: "string",
      description:
        "Process only this date (YYYY-MM-DD), regardless of ledger state.",
    },
    "max-dates": {
      type: "string",
      description:
        "Cap dates processed this run (default: no cap — drain the backlog).",
    },
    force: {
      type: "boolean",
      description: "Run even if another sweep holds the in-flight marker.",
      default: false,
    },
  },
  async run({ args }) {
    const max = args["max-dates"] ? Number(args["max-dates"]) : undefined;
    process.exitCode = await runNightly({
      persona: args.persona ? String(args.persona) : undefined,
      today: args.date ? String(args.date) : undefined,
      maxDates: Number.isFinite(max) ? max : undefined,
      force: Boolean(args.force),
    });
  },
});
