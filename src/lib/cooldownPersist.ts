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

import { hostLocationEnv } from "./engineScope.ts";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { xdgDataHome } from "../config.ts";
import { writeFileAtomic } from "./io.ts";
import { log } from "./logger.ts";
import type { CooldownPersistence, HarnessCooldownState } from "./cooldown.ts";

export function cooldownPath(): string {
  return (
    hostLocationEnv("PHANTOMBOT_COOLDOWN_STATE") ??
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
 *
 * Fire-and-forget is NOT the same as unordered, though, and the first cut of
 * this file conflated the two. `writeFileAtomic` is write-temp-then-rename;
 * two saves in flight at once are two temp files racing to rename over the
 * same path, and the rename order is not the call order. Two rapid failures
 * — which is precisely what a chain fall-through produces, one markFailure
 * per harness — could therefore leave the EARLIER snapshot on disk and lose
 * the later window. Self-healing after one extra probe, but silent and
 * genuinely wrong.
 *
 * So: serialise. Each save chains onto the previous one's settlement, and
 * because only the newest snapshot has any value, a save that arrives while
 * another is in flight simply REPLACES any queued-but-unwritten snapshot
 * rather than queueing behind it. A burst of N saves costs at most two
 * writes, and the last one always wins.
 */
export function fileCooldownPersistence(
  path: string = cooldownPath(),
): CooldownPersistence {
  // The tail of the write chain. Never rejects (every link catches), so a
  // failed write cannot poison the ones after it.
  let tail: Promise<void> = Promise.resolve();
  // Newest snapshot not yet handed to a write. `undefined` = nothing pending.
  let pending: string | undefined;
  let draining = false;

  const drain = (): void => {
    if (draining) return;
    draining = true;
    tail = tail.then(async () => {
      try {
        while (pending !== undefined) {
          const body = pending;
          pending = undefined;
          try {
            await writeFileAtomic(path, body);
          } catch (e) {
            log.debug("cooldown: failed to persist state", {
              path,
              error: (e as Error).message,
            });
          }
        }
      } finally {
        draining = false;
      }
    });
  };

  return {
    save(entries) {
      pending = JSON.stringify(entries, null, 2) + "\n";
      drain();
    },
    /**
     * Test/shutdown hook: resolve once every queued write has settled. Nothing
     * on the turn path awaits this — it exists so a test can assert on the
     * file without polling, and so a future graceful shutdown can flush.
     */
    settled(): Promise<void> {
      return tail;
    },
  };
}
