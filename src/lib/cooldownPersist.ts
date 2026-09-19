/**
 * File-backed persistence for the harness cooldown store.
 *
 * Kept OUT of cooldown.ts so the store itself stays a pure, fs-free data
 * structure that tests can drive with an injected clock — this module is the
 * only place the cooldown touches disk.
 *
 * Scope is the HOST, not the persona — the same scope the in-memory store has
 * always had, since a host that serves several personas serves them from one
 * process and one `cooldownStore`. That is right when the personas share a
 * provider account (the usual case) and conservative when they do not: the
 * worst outcome is a persona preferring its fallback for a window its own
 * quota did not need. Splitting it per persona is a change to the in-memory
 * store's scope, not to this file, and belongs in its own PR.
 *
 * Not state.json: that file is phantombot's user-visible configuration state
 * (default persona, harness bins), it is audit-logged on write, and the test
 * suite guards it against live writes. A cooldown window is neither
 * configuration nor durable truth — it is a short-lived operational hint that
 * is rewritten on every harness failure and is correct to lose. Its own file
 * keeps a high-frequency write off the file whose corruption bricks startup.
 */

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { xdgDataHome } from "../config.ts";
import { writeFileAtomic } from "./io.ts";
import { log } from "./logger.ts";
import type { CooldownPersistence, HarnessCooldownState } from "./cooldown.ts";

export function cooldownPath(): string {
  return (
    process.env.PHANTOMBOT_COOLDOWN_STATE ??
    join(xdgDataHome(), "phantombot", "harness-cooldown.json")
  );
}

/**
 * Read persisted windows. Any failure — missing file, torn JSON, wrong shape —
 * resolves to "nothing persisted". A cooldown we cannot read is a cooldown we
 * do not have, which degrades to today's behaviour (try the harness) rather
 * than to a failed startup.
 */
export async function loadCooldownState(
  path: string = cooldownPath(),
): Promise<Record<string, HarnessCooldownState>> {
  try {
    const parsed: unknown = JSON.parse(await readFile(path, "utf8"));
    if (typeof parsed !== "object" || parsed === null) return {};
    const out: Record<string, HarnessCooldownState> = {};
    for (const [id, value] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof value !== "object" || value === null) continue;
      const v = value as Partial<HarnessCooldownState>;
      if (typeof v.cooldownUntilMs !== "number" || !Number.isFinite(v.cooldownUntilMs)) {
        continue;
      }
      out[id] = {
        cooldownUntilMs: v.cooldownUntilMs,
        consecutiveFailures:
          typeof v.consecutiveFailures === "number" && v.consecutiveFailures > 0
            ? v.consecutiveFailures
            : 1,
      };
    }
    return out;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") {
      log.warn("cooldown: unreadable state file — starting with none", {
        path,
        error: (e as Error).message,
      });
    }
    return {};
  }
}

/**
 * Build the sink. `save` is synchronous by contract (the store calls it from
 * markFailure/markSuccess, which are sync and on the turn path), so the write
 * is fire-and-forget: we never await it and we never let it reject. Losing a
 * write costs one re-probe after a restart; blocking a turn on a disk write
 * would cost the user their reply.
 */
export function fileCooldownPersistence(
  path: string = cooldownPath(),
): CooldownPersistence {
  return {
    save(entries) {
      void writeFileAtomic(path, JSON.stringify(entries, null, 2) + "\n").catch(
        (e: Error) => {
          log.debug("cooldown: failed to persist state", {
            path,
            error: e.message,
          });
        },
      );
    },
  };
}
