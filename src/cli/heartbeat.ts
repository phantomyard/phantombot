/**
 * `phantombot heartbeat` — short, mechanical maintenance pass.
 *
 * Runs every 30 minutes via systemd timer (installed by `phantombot install`).
 * No LLM call. See src/lib/heartbeat.ts for the memory work it does.
 *
 * It is also the clock the nightly hangs off: when the calendar day changes
 * between two fires, yesterday's daily file has closed, so the heartbeat spawns
 * a detached nightly sweep. That (plus the startup sweep in `run`) is why there
 * is no phantombot-nightly.timer any more.
 */

import { defineCommand } from "citty";
import { existsSync } from "node:fs";

import {
  documentChunkChars,
  type Config,
  memoryIndexPath,
  personaDir,
  loadConfigForPersona,
  resolvePersona,
  servedPersonasOf,
} from "../config.ts";
import { isPhantombotBinary } from "../lib/binaryIdentity.ts";
import { defaultEmbedder, runEmbedJob } from "../lib/embedJob.ts";
import { runHeartbeat } from "../lib/heartbeat.ts";
import { MemoryIndex } from "../lib/memoryIndex.ts";
import type { WriteSink } from "../lib/io.ts";
import { log } from "../lib/logger.ts";
import {
  dayRolledOver,
  type NightlyTriggerReason,
  spawnNightlySweep,
} from "../lib/nightlyTrigger.ts";
import {
  rotateServiceLogs,
  type RotateLogDirResult,
} from "../lib/logRotate.ts";
import { currentPlatform } from "../lib/platform.ts";
import { openMemoryStore } from "../memory/store.ts";
import { flushDueConversationTurns } from "../orchestrator/turnIndexer.ts";
import {
  BunSystemctlRunner,
  buildSystemctlEnv,
  ensureSystemdUnitsCurrent,
  ensureUserSystemdEnv,
} from "../lib/systemd.ts";
import {
  BunSchtasksRunner,
  ensureTasksCurrent,
} from "../lib/taskScheduler.ts";
import {
  loadPersonaHeartbeatLastFired,
  recordHeartbeatFired,
} from "../lib/timerHealth.ts";
import { VERSION } from "../version.ts";

// Delegates to the shared resolver in config.ts so the memory-index path
// stays consistent everywhere (~/.local/share/phantombot on every platform,
// or the XDG_DATA_HOME override) rather than re-deriving it with a literal.
function indexPath(persona: string): string {
  return memoryIndexPath(persona);
}

export interface RunHeartbeatCliInput {
  config?: Config;
  persona?: string;
  out?: WriteSink;
  err?: WriteSink;
  /**
   * Test seam for the in-process systemd self-heal. Pass `false` to
   * skip (the production default off Linux, and what tests use to keep
   * real systemctl out of the path). Pass a function to substitute a
   * fake that performs the heal and returns whatever the call should
   * have logged. Production passes undefined → we probe for a user
   * systemd bus and only run if available.
   */
  healSystemd?: false | (() => Promise<void>);
  /**
   * Test seam for the fresh-note embed pass. Pass `false` to skip it
   * entirely (keeps the real Gemini embedder out of the path — this is
   * effectively what a `provider: "none"` config already does, but the
   * flag is explicit). Pass a function to substitute a fake that returns
   * the embed counts the pass should have produced (or `null` to model
   * "no embedder configured"). Production passes undefined → we build the
   * real embedder from config and run runEmbedJob against the note index.
   */
  embedNotes?: false | (() => Promise<EmbedNotesResult | null>);
  /**
   * Test seam for the day-rollover nightly trigger. Pass `false` to skip the
   * check entirely, or a function to capture the spawn without forking a real
   * process. Production passes undefined → {@link spawnNightlySweep}.
   */
  triggerNightly?:
    | false
    | ((persona: string, reason: NightlyTriggerReason) => void);
  /**
   * Test seam for the service-log rotation pass. Pass `false` to skip it, or
   * a function to substitute a fake. Production passes undefined → rotate the
   * host's service log directory (null on Linux, where journald owns it).
   */
  rotateLogs?: false | (() => Promise<RotateLogDirResult | null>);
}

/** Outcome of the heartbeat's incremental note-embed pass. */
export interface EmbedNotesResult {
  embeddedChunks?: number;
  skippedChunks?: number;
  failedChunks?: number;
  /** Backward-compatible adapter fields for existing heartbeat callers. */
  embedded: number;
  skipped: number;
  failed: number;
}

export async function runHeartbeatCli(
  input: RunHeartbeatCliInput = {},
): Promise<number> {
  const out = input.out ?? process.stdout;
  const err = input.err ?? process.stderr;
  // Resolve the TARGET persona first, then load ITS effective config
  // (phantombot#439): the heartbeat's retrieval/embedding and update-notify
  // settings are persona-scoped, and loading the default layer first would
  // silently run every persona's heartbeat on the default persona's settings.
  const { config, persona } = input.config
    ? {
        config: input.config,
        persona: resolvePersona(input.persona, input.config),
      }
    : await loadConfigForPersona(input.persona);
  const dir = personaDir(config, persona);

  if (!existsSync(dir)) {
    err.write(`persona '${persona}' not found at ${dir}\n`);
    return 2;
  }

  const r = await runHeartbeat({
    personaDir: dir,
    indexPath: indexPath(persona),
    // Drawer rows (#410) live in the shared memory database, keyed by persona.
    memoryDbPath: config.memoryDbPath,
    persona,
    // Pass config + version so the heartbeat can hit GitHub for new
    // releases and dispatch a one-time Telegram notification when a
    // newer version has aged past the auto-notify delay. See
    // src/lib/updateNotify.ts.
    config,
    currentVersion: VERSION,
  });

  // Drain sub-threshold conversation turn tails on the heartbeat's regular
  // cadence. The live service only flushes a conversation when a new message
  // crosses the turn-index batch, so a quiet conversation stuck below it
  // would stay unembedded for days — recent chat goes invisible to
  // recall. This time-based sweep (flushAfterHours) closes that gap for every
  // conversation, mechanically, with no LLM call. Wrapped in try/catch so a
  // turn-flush hiccup never breaks the primary heartbeat work.
  try {
    const turnIndexing = config.retrieval?.turnIndexing;
    if (config.retrieval?.enabled && turnIndexing?.enabled) {
      const store = await openMemoryStore(config.memoryDbPath);
      try {
        const flush = await flushDueConversationTurns({
          config,
          persona,
          memory: store,
          settings: turnIndexing,
        });
        if (flush.triggered > 0 || flush.repaired > 0) {
          log.info("heartbeat: flushed conversation turn tails", { ...flush });
        }
      } finally {
        await store.close();
      }
    }
  } catch (e) {
    log.warn("heartbeat: turn-flush sweep threw unexpectedly", {
      error: (e as Error).message,
    });
  }

  // Embed newly-written notes on the heartbeat's regular cadence so a
  // `memory capture`, a fresh KB note, or a drawer promotion becomes
  // *semantically* recallable within ~30 min instead of waiting for the
  // nightly `memory index --rebuild` (a full day of lag). runHeartbeat has
  // already refreshed the FTS index above, so the `files` table is current;
  // this incremental pass embeds only chunks whose text_sha changed (new or
  // edited notes) and skips everything else — no API call for unchanged
  // content. The nightly rebuild still runs for full consistency (deletions,
  // model/dim changes, drift repair). Wrapped in try/catch: an embed hiccup
  // must never break the primary heartbeat work.
  let noteEmbedLine = "";
  if (input.embedNotes !== false) {
    try {
      const e = input.embedNotes
        ? await input.embedNotes()
        : await defaultEmbedNotes(config, dir, persona);
      const embeddedChunks = e?.embeddedChunks ?? e?.embedded ?? 0;
      const skippedChunks = e?.skippedChunks ?? e?.skipped ?? 0;
      const failedChunks = e?.failedChunks ?? e?.failed ?? 0;
      if (e && (embeddedChunks > 0 || failedChunks > 0)) {
        noteEmbedLine = `, embedded ${embeddedChunks} chunks`;
        log.info("heartbeat: embedded fresh notes", {
          embeddedChunks,
          skippedChunks,
          failedChunks,
        });
      }
    } catch (e) {
      log.warn("heartbeat: note-embed pass threw unexpectedly", {
        error: (e as Error).message,
      });
    }
  }

  // Self-heal the service-manager units on the heartbeat's regular cadence.
  // This is the long-uptime cure for the drifted-unit class of bug (a broken
  // symlink on Linux, a moved binary on Windows) — a box that never restarts
  // still gets a re-check every 30 minutes, and any drift is fixed in-place
  // without operator action. Wrapped in try/catch so a transient failure
  // doesn't break the primary heartbeat work.
  if (input.healSystemd !== false) {
    try {
      if (input.healSystemd) {
        await input.healSystemd();
      } else {
        await defaultHealService(config, persona);
      }
    } catch (e) {
      log.warn("heartbeat: service self-heal threw unexpectedly", {
        error: (e as Error).message,
      });
    }
  }

  // Cap the service logs on the same cadence. launchd and the Windows task
  // wrapper append to plain files forever — one macOS box reached ~700 MB
  // before anyone noticed (#428). The heartbeat is already the host
  // maintenance pass (it heals systemd units and scheduled tasks above), so
  // rotation needs no new timer and inherits the same platform dispatch.
  // Wrapped in try/catch: a rotation hiccup must never break the primary
  // heartbeat work.
  if (input.rotateLogs !== false) {
    try {
      const r = input.rotateLogs
        ? await input.rotateLogs()
        : await rotateServiceLogs();
      if (r && r.rotated.length > 0) {
        log.info("heartbeat: rotated service logs", {
          dir: r.dir,
          rotated: r.rotated.map((f) => `${f.file}: ${f.bytes}`),
        });
      }
      // A log that is over the cap and could NOT be rotated is the case this
      // whole pass exists to prevent, so it warns rather than staying silent.
      if (r && r.skipped.length > 0) {
        log.warn("heartbeat: service logs could not be rotated", {
          dir: r.dir,
          skipped: r.skipped.map((f) => `${f.file}: ${f.reason}`),
        });
      }
    } catch (e) {
      log.warn("heartbeat: log rotation threw unexpectedly", {
        error: (e as Error).message,
      });
    }
  }

  // Day-rollover trigger — this is what replaced the 02:00 nightly timer.
  // The heartbeat already fires every 30 min and already knows what day it is,
  // so it is the natural place to notice that the calendar day changed since
  // the last fire: the moment it does, yesterday's daily file is closed and
  // can be distilled. Read the PREVIOUS marker before recordHeartbeatFired()
  // overwrites it. Worst-case latency is one heartbeat interval, and firing
  // redundantly is free — the sweep is ledger-driven and no-ops when nothing
  // is pending. Wrapped in try/catch: a spawn failure must not fail the
  // heartbeat, and the next startup sweeps the same backlog anyway.
  let rolloverLine = "";
  if (input.triggerNightly !== false) {
    try {
      // PER-PERSONA marker (#486): every persona's heartbeat instance tracks
      // its own last fire, so one persona firing first after midnight can't
      // consume the rollover and starve the others of their nightly sweep.
      const prev = loadPersonaHeartbeatLastFired(persona, {
        isDefault: persona === config.defaultPersona,
      }).iso;
      if (dayRolledOver(prev)) {
        (input.triggerNightly ?? spawnNightlySweep)(persona, "rollover");
        rolloverLine = ", day rolled over → nightly sweep";
        log.info("heartbeat: day rolled over, spawned nightly sweep", {
          persona,
          previousFire: prev,
        });
      }
    } catch (e) {
      log.warn("heartbeat: rollover check threw unexpectedly", {
        error: (e as Error).message,
      });
    }
  }

  // Record the fire AFTER the primary work succeeded. Doctor uses
  // this marker's mtime to flag a dead heartbeat timer. Per-persona
  // (#486): each instance's marker backs doctor's per-persona
  // maintenance report.
  await recordHeartbeatFired(persona);

  const updateLine =
    r.updateCheck?.status === "notified"
      ? `, notified update ${r.updateCheck.latestVersion}`
      : r.updateCheck?.status === "release_check_failed"
        ? `, update-check failed (${r.updateCheck.error})`
        : "";
  out.write(
    `heartbeat ok: promoted ${r.promoted.length}, ` +
      `stale ${r.staleRecent.length}, ` +
      `indexed ${r.indexedFiles}${noteEmbedLine}${updateLine}${rolloverLine}\n`,
  );
  return 0;
}

/**
 * Production note-embed pass: build the configured embedder and run an
 * incremental embed job over the note index. Returns `null` when no
 * embedder is configured (e.g. `embeddings.provider: "none"` or missing
 * provider credentials) so the caller prints no embed line. Owns the MemoryIndex
 * handle it opens and closes it in a finally.
 */
async function defaultEmbedNotes(
  config: Config,
  dir: string,
  persona: string,
): Promise<EmbedNotesResult | null> {
  const embedder = defaultEmbedder(config);
  if (!embedder) return null;
  const ix = await MemoryIndex.open(indexPath(persona));
  try {
    const e = await runEmbedJob({
      personaDir: dir,
      index: ix,
      embedder,
      maxChunkChars: documentChunkChars(config)!,
    });
    return {
      embedded: e.embeddedChunks,
      skipped: e.skippedChunks,
      failed: e.failedChunks,
      embeddedChunks: e.embeddedChunks,
      skippedChunks: e.skippedChunks,
      failedChunks: e.failedChunks,
    };
  } finally {
    ix.close();
  }
}

/**
 * Production self-heal, dispatched to the host's service-manager backend.
 * Silent on healthy boxes; logs a notice only on repair. A no-op on any
 * platform without a backend.
 */
async function defaultHealService(
  config: Config,
  persona?: string,
): Promise<void> {
  switch (currentPlatform()) {
    case "linux":
      return defaultHealSystemd(config);
    case "windows":
      return defaultHealTaskScheduler(persona);
    default:
      return; // macOS (launchd self-heals via KeepAlive) and unsupported hosts
  }
}

/**
 * Idempotently ensure all phantombot systemd units are present and timers are
 * armed — including one heartbeat instance per served persona (#486). Skips on
 * Linux hosts where the user-systemd bus isn't reachable (e.g. SSH without
 * lingering).
 */
async function defaultHealSystemd(config: Config): Promise<void> {
  const binPath = process.execPath;
  if (!isPhantombotBinary(binPath)) return;
  const sysEnv = ensureUserSystemdEnv();
  if (!sysEnv.ready) return;
  const systemctl = new BunSystemctlRunner(buildSystemctlEnv(sysEnv));
  const r = await ensureSystemdUnitsCurrent({
    binPath,
    systemctl,
    personas: servedPersonasOf(config),
  });
  if (
    r.rewrote.length > 0 ||
    r.repairedTimers.length > 0 ||
    r.disabledInstances.length > 0
  ) {
    log.info("heartbeat: healed systemd units", {
      rewrote: r.rewrote,
      repairedTimers: r.repairedTimers,
      disabledInstances: r.disabledInstances,
    });
  }
}

/**
 * Windows analogue of `defaultHealSystemd`: re-register any of the four
 * scheduled tasks that drifted from the current binary path (the moved- or
 * updated-binary case). Only fires when we ARE the compiled binary
 * (`phantombot.exe`), so a dev `bun src/index.ts` run never rewrites tasks.
 */
async function defaultHealTaskScheduler(persona?: string): Promise<void> {
  const binPath = process.execPath;
  if (!isPhantombotBinary(binPath)) return;
  const r = await ensureTasksCurrent({
    binPath,
    persona,
    schtasks: new BunSchtasksRunner(),
  });
  if (r.rewrote.length > 0) {
    log.info("heartbeat: healed scheduled tasks", { rewrote: r.rewrote });
  }
}

export default defineCommand({
  meta: {
    name: "heartbeat",
    description:
      "Mechanical 30-min maintenance: promote tagged daily-file lines to drawers, scan ## Recent for staleness, refresh FTS index, flush due conversation-turn tails, embed newly-written notes, and fire the nightly sweep when the calendar day has rolled over. No LLM call.",
  },
  args: {
    persona: {
      type: "string",
      description: "Persona name (default: PHANTOMBOT_PERSONA env, then the configured default persona).",
    },
  },
  async run({ args }) {
    process.exitCode = await runHeartbeatCli({
      persona: args.persona ? String(args.persona) : undefined,
    });
  },
});
