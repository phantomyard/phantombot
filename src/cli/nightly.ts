/**
 * `phantombot nightly` — runs the cognitive distillation pass.
 *
 * The pass is CHECKPOINTED: it is decomposed into five idempotent stages
 * (essence → promote → kb → compress → state), each run as its own
 * harness turn. After every completed stage phantombot writes
 * `.nightly-progress.json`. If a stage times out — or the box powers off
 * mid-run — the next invocation with `--resume` (or the startup catch-up,
 * or `phantombot doctor`) skips the finished stages and continues. A
 * timeout therefore costs at most one stage, never the whole night.
 *
 * Conversation key is `system:nightly:<YYYY-MM-DD>` so every stage is
 * isolated from Telegram chats and shares context across stages.
 *
 * If the persona ships a `nightly-prompt.md` override, that custom
 * prompt is run as a single monolithic turn (no checkpointing) — the
 * override owns the phase contract, so phantombot can't safely split it.
 *
 * Schedule: runs daily at 02:00 local via systemd timer. Manual
 * invocation works the same.
 */

import { defineCommand } from "citty";
import { existsSync } from "node:fs";
import { join } from "node:path";

import { type Config, loadConfig, personaDir } from "../config.ts";
import { buildHarnessChain } from "../harnesses/buildChain.ts";
import type { Harness } from "../harnesses/types.ts";
import { resolveHarnessBinsForConfig } from "../lib/harnessAvailability.ts";
import type { WriteSink } from "../lib/io.ts";
import { log } from "../lib/logger.ts";
import {
  buildNightlyPromptForPersona,
  buildNightlyStagePrompt,
  clearNightlyProgress,
  type NightlyStage,
  nightlyConversationKey,
  type NightlyProgress,
  pendingNightlyStages,
  saveNightlyProgress,
  saveNightlyState,
} from "../lib/nightly.ts";
import { openMemoryStore } from "../memory/store.ts";
import { runTurn } from "../orchestrator/turn.ts";

const NIGHTLY_SUFFIX =
  "You are operating in NIGHTLY MAINTENANCE MODE. " +
  "Skip pleasantries. Do work, write files, report briefly.";

// Per-stage timeouts. A single stage is far smaller than the old
// monolithic pass, so the hard cap can be tighter; idle stays at 5 min
// to tolerate long thinking between tool calls.
const STAGE_IDLE_TIMEOUT_MS = 5 * 60_000;
const STAGE_HARD_TIMEOUT_MS = 20 * 60_000;

export interface RunNightlyInput {
  config?: Config;
  persona?: string;
  /** Override "today" — useful for backfill or testing. ISO YYYY-MM-DD. */
  today?: string;
  /** Resume from `.nightly-progress.json` instead of starting fresh. */
  resume?: boolean;
  out?: WriteSink;
  err?: WriteSink;
}

interface TurnResult {
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
      // Nightly needs no MCP; running MCP-free stops an unauthenticated remote
      // connector from wedging the --print startup and killing a stage on the
      // idle timeout (essence "timed out with no output"). See HarnessRequest.mcpMode.
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
  ({ config } = await resolveHarnessBinsForConfig(config, { err }));

  const harnesses = buildHarnessChain(config, err);
  if (harnesses.length === 0) {
    err.write("no harnesses configured\n");
    return 2;
  }

  const today = input.today ?? new Date().toISOString().slice(0, 10);
  const conversation = nightlyConversationKey(today);
  const memory = await openMemoryStore(config.memoryDbPath);
  const runStartedAt = Date.now();

  try {
    // A persona-provided override owns the whole phase contract; we
    // can't safely chunk it, so run it as one monolithic turn.
    if (existsSync(join(dir, "nightly-prompt.md"))) {
      out.write(
        `nightly: persona='${persona}' date=${today} conversation=${conversation} (override prompt — monolithic, no checkpointing)\n`,
      );
      const prompt = await buildNightlyPromptForPersona(dir, persona, today);
      const r = await runNightlyTurn({
        persona,
        conversation,
        userMessage: prompt,
        agentDir: dir,
        harnesses,
        memory,
      });
      if (r.errored) log.error("nightly: override turn failed", { error: r.errored });
      await saveNightlyState(dir, {
        last_run: new Date().toISOString(),
        last_status: r.errored ? "error" : "ok",
        ...(r.errored ? { errors: [r.errored] } : {}),
      });
      out.write(
        `nightly ${r.errored ? "FAILED" : "ok"}: ${r.durationMs}ms` +
          (r.errored ? ` — ${r.errored}` : "") +
          `\n`,
      );
      return r.errored ? 1 : 0;
    }

    // Checkpointed path: run each pending stage, checkpoint after each.
    const stages = await pendingNightlyStages(dir, today, input.resume ?? false);
    const allStages: NightlyStage[] = [
      "essence",
      "promote",
      "kb",
      "compress",
      "state",
    ];
    const completed = allStages.filter((s) => !stages.includes(s));

    out.write(
      `nightly: persona='${persona}' date=${today} conversation=${conversation}\n`,
    );
    if (stages.length === 0) {
      out.write("nightly: all stages already complete for today — nothing to do\n");
      return 0;
    }
    if (completed.length > 0) {
      out.write(
        `nightly: resuming — ${completed.length} stage(s) already done [${completed.join(", ")}], ${stages.length} remaining\n`,
      );
    }

    const progress: NightlyProgress = {
      date: today,
      started_at: new Date(runStartedAt).toISOString(),
      updated_at: new Date().toISOString(),
      completed_stages: [...completed],
      status: "in_progress",
    };
    await saveNightlyProgress(dir, progress);

    for (const stage of stages) {
      out.write(`nightly: stage '${stage}' starting\n`);
      const prompt = buildNightlyStagePrompt(persona, today, stage);
      const r = await runNightlyTurn({
        persona,
        conversation,
        userMessage: prompt,
        agentDir: dir,
        harnesses,
        memory,
      });

      if (r.errored) {
        // Checkpoint stays at the last good stage; status -> partial so
        // resume / doctor pick up exactly here next time.
        progress.status = "partial";
        progress.last_error = `stage '${stage}': ${r.errored}`;
        progress.updated_at = new Date().toISOString();
        await saveNightlyProgress(dir, progress);
        await saveNightlyState(dir, {
          last_run: new Date().toISOString(),
          last_status: "partial",
          errors: [`stage '${stage}': ${r.errored}`],
        });
        log.error("nightly: stage failed — checkpoint saved", {
          persona,
          date: today,
          stage,
          error: r.errored,
          completed: progress.completed_stages,
        });
        out.write(
          `nightly PARTIAL: stage '${stage}' failed after ${r.durationMs}ms — ${r.errored}\n` +
            `nightly: ${progress.completed_stages.length}/${allStages.length} stages done; rerun with --resume to continue\n`,
        );
        return 1;
      }

      progress.completed_stages.push(stage);
      progress.updated_at = new Date().toISOString();
      await saveNightlyProgress(dir, progress);
      out.write(`nightly: stage '${stage}' ok (${r.durationMs}ms)\n`);
    }

    // Every stage done — clear the checkpoint and stamp success.
    progress.status = "complete";
    await clearNightlyProgress(dir);
    await saveNightlyState(dir, {
      last_run: new Date().toISOString(),
      last_status: "ok",
    });
    const totalMs = Date.now() - runStartedAt;
    out.write(`nightly ok: ${allStages.length} stages, ${totalMs}ms total\n`);
    log.info("nightly: complete", {
      persona,
      date: today,
      durationMs: totalMs,
      stages: allStages.length,
    });
    return 0;
  } finally {
    await memory.close();
  }
}

export default defineCommand({
  meta: {
    name: "nightly",
    description:
      "Run the cognitive distillation pass — promote, KB-feed, compress. Checkpointed into resumable stages; isolated conversation; manual or via the systemd timer.",
  },
  args: {
    persona: {
      type: "string",
      description: "Persona name (default: configured default).",
    },
    date: {
      type: "string",
      description: "Override today's date (YYYY-MM-DD); useful for backfill.",
    },
    resume: {
      type: "boolean",
      description:
        "Resume from .nightly-progress.json — skip stages already completed today.",
      default: false,
    },
  },
  async run({ args }) {
    process.exitCode = await runNightly({
      persona: args.persona ? String(args.persona) : undefined,
      today: args.date ? String(args.date) : undefined,
      resume: Boolean(args.resume),
    });
  },
});
