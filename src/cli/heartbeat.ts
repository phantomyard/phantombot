/**
 * `phantombot heartbeat` — short, mechanical maintenance pass.
 *
 * Runs every 30 minutes via systemd timer (installed by `phantombot install`).
 * No LLM call. See src/lib/heartbeat.ts for what it does.
 */

import { defineCommand } from "citty";
import { existsSync } from "node:fs";
import { basename } from "node:path";

import { type Config, loadConfig, memoryIndexPath, personaDir } from "../config.ts";
import { runHeartbeat } from "../lib/heartbeat.ts";
import type { WriteSink } from "../lib/io.ts";
import { log } from "../lib/logger.ts";
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
import { recordHeartbeatFired } from "../lib/timerHealth.ts";
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
}

export async function runHeartbeatCli(
  input: RunHeartbeatCliInput = {},
): Promise<number> {
  const out = input.out ?? process.stdout;
  const err = input.err ?? process.stderr;
  const config = input.config ?? (await loadConfig());
  const persona = input.persona ?? config.defaultPersona;
  const dir = personaDir(config, persona);

  if (!existsSync(dir)) {
    err.write(`persona '${persona}' not found at ${dir}\n`);
    return 2;
  }

  const r = await runHeartbeat({
    personaDir: dir,
    indexPath: indexPath(persona),
    // Pass config + version so the heartbeat can hit GitHub for new
    // releases and dispatch a one-time Telegram notification when a
    // newer version has aged past the auto-notify delay. See
    // src/lib/updateNotify.ts.
    config,
    currentVersion: VERSION,
  });

  // Drain sub-threshold conversation turn tails on the heartbeat's regular
  // cadence. The live service only flushes a conversation when a new message
  // crosses the 20-turn batch, so a quiet conversation stuck below it (e.g.
  // 19 turns) would stay unembedded for days — recent chat goes invisible to
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
        if (flush.triggered > 0) {
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
        await defaultHealService();
      }
    } catch (e) {
      log.warn("heartbeat: service self-heal threw unexpectedly", {
        error: (e as Error).message,
      });
    }
  }

  // Record the fire AFTER the primary work succeeded. Doctor uses
  // this marker's mtime to flag a dead heartbeat timer.
  await recordHeartbeatFired();

  const updateLine =
    r.updateCheck?.status === "notified"
      ? `, notified update ${r.updateCheck.latestVersion}`
      : r.updateCheck?.status === "release_check_failed"
        ? `, update-check failed (${r.updateCheck.error})`
        : "";
  out.write(
    `heartbeat ok: promoted ${r.promoted.length}, ` +
      `stale ${r.staleRecent.length}, ` +
      `indexed ${r.indexedFiles}${updateLine}\n`,
  );
  return 0;
}

/**
 * Production self-heal, dispatched to the host's service-manager backend.
 * Silent on healthy boxes; logs a notice only on repair. A no-op on any
 * platform without a backend.
 */
async function defaultHealService(): Promise<void> {
  switch (currentPlatform()) {
    case "linux":
      return defaultHealSystemd();
    case "windows":
      return defaultHealTaskScheduler();
    default:
      return; // macOS (launchd self-heals via KeepAlive) and unsupported hosts
  }
}

/**
 * Idempotently ensure all phantombot systemd units are present and timers are
 * armed. Skips on Linux hosts where the user-systemd bus isn't reachable (e.g.
 * SSH without lingering).
 */
async function defaultHealSystemd(): Promise<void> {
  const binPath = process.execPath;
  if (basename(binPath) !== "phantombot") return;
  const sysEnv = ensureUserSystemdEnv();
  if (!sysEnv.ready) return;
  const systemctl = new BunSystemctlRunner(buildSystemctlEnv(sysEnv));
  const r = await ensureSystemdUnitsCurrent({ binPath, systemctl });
  if (r.rewrote.length > 0 || r.repairedTimers.length > 0) {
    log.info("heartbeat: healed systemd units", {
      rewrote: r.rewrote,
      repairedTimers: r.repairedTimers,
    });
  }
}

/**
 * Windows analogue of `defaultHealSystemd`: re-register any of the four
 * scheduled tasks that drifted from the current binary path (the moved- or
 * updated-binary case). Only fires when we ARE the compiled binary
 * (`phantombot.exe`), so a dev `bun src/index.ts` run never rewrites tasks.
 */
async function defaultHealTaskScheduler(): Promise<void> {
  const binPath = process.execPath;
  if (!basename(binPath).startsWith("phantombot")) return;
  const r = await ensureTasksCurrent({
    binPath,
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
      "Mechanical 30-min maintenance: promote tagged daily-file lines to drawers, scan ## Recent for staleness, refresh FTS index. No LLM call.",
  },
  args: {
    persona: {
      type: "string",
      description: "Persona name (default: configured default).",
    },
  },
  async run({ args }) {
    process.exitCode = await runHeartbeatCli({
      persona: args.persona ? String(args.persona) : undefined,
    });
  },
});
