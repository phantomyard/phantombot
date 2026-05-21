/**
 * `phantombot heartbeat` — short, mechanical maintenance pass.
 *
 * Runs every 30 minutes via systemd timer (installed by `phantombot install`).
 * No LLM call. See src/lib/heartbeat.ts for what it does.
 */

import { defineCommand } from "citty";
import { existsSync } from "node:fs";
import { basename, join } from "node:path";

import { type Config, loadConfig, personaDir } from "../config.ts";
import { runHeartbeat } from "../lib/heartbeat.ts";
import type { WriteSink } from "../lib/io.ts";
import { log } from "../lib/logger.ts";
import { currentPlatform } from "../lib/platform.ts";
import {
  BunSystemctlRunner,
  buildSystemctlEnv,
  ensureSystemdUnitsCurrent,
  ensureUserSystemdEnv,
} from "../lib/systemd.ts";
import { recordHeartbeatFired } from "../lib/timerHealth.ts";
import { VERSION } from "../version.ts";

function indexPath(persona: string): string {
  return join(
    process.env.XDG_DATA_HOME || join(process.env.HOME ?? "", ".local/share"),
    "phantombot",
    "memory-index",
    `${persona}.sqlite`,
  );
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
    // newer version is out. See src/lib/updateNotify.ts.
    config,
    currentVersion: VERSION,
  });

  // Self-heal systemd units on the heartbeat's regular cadence. This
  // is the long-uptime cure for the broken-symlink class of bug — a
  // box that never restarts still gets a re-check every 30 minutes,
  // and any drift is fixed in-place without operator action. Wrapped
  // in try/catch so a transient systemctl failure doesn't break the
  // primary heartbeat work.
  if (input.healSystemd !== false) {
    try {
      if (input.healSystemd) {
        await input.healSystemd();
      } else {
        await defaultHealSystemd();
      }
    } catch (e) {
      log.warn("heartbeat: systemd self-heal threw unexpectedly", {
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
 * Production self-heal: idempotently ensure all phantombot systemd
 * units are present and timers are armed. Silent on healthy boxes,
 * logs a notice on repair. Skips on macOS and on Linux hosts where
 * the user-systemd bus isn't reachable (e.g. SSH without lingering).
 */
async function defaultHealSystemd(): Promise<void> {
  if (currentPlatform() !== "linux") return;
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
