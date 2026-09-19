/**
 * Persisted counters — one small store, many feeds (issue #585).
 *
 * Some facts are only visible as "how many times did X happen", and the
 * two feeds that motivated this store both go blind exactly when you
 * start relying on the fix that spawned them:
 *
 *   - Narration drops (#580/#587): the #580 evidence came from re-scoring
 *     ~14,800 stored turn pairs offline. Once the gate is live a leak is
 *     suppressed BEFORE it reaches the turns table, so re-scoring stored
 *     turns can only ever measure the pre-gate era. The counter is the
 *     only post-gate signal — and the natural acceptance criterion for
 *     the enforcement gate specced in #580.
 *   - Exhausted delivery ladders (#542/#584): when the 8s/20s/45s ladder
 *     runs out with the wrap stored nowhere and no P2P ack, a reply the
 *     user is waiting for is genuinely gone. That was previously visible
 *     only as an ERROR log line — evidence, not a queryable number.
 *
 * Shape is deliberately boring: a single JSON file of flat
 * `key -> count` entries in XDG state home, appended by anyone who has a
 * fact worth keeping. Keys are namespaced by feed so one query answers
 * "did the gate fire this week, and did we lose anything?":
 *
 *   narration.drop.<expected>.<actual>   wrong-language lines the gate dropped
 *   narration.idle-release.<expected>    held text flushed by the 500ms idle race
 *   narration.shape-rejection.<expected> held text released at a tool boundary
 *                                        because the shape test rejected it
 *   narration.sending-keep.<expected>    held text kept because the boundary
 *                                        tool transmits content (#587 carve-out)
 *   delivery.lost.<label>                wraps lost after the whole retry ladder
 *
 * Best-effort by contract, like the audit log: a failed read or write is
 * logged and swallowed — counting must never break or slow a turn. Bumps
 * are serialised through an internal promise chain so concurrent
 * increments cannot lose each other's updates, and the write itself is
 * temp-file + rename so a crash mid-write cannot corrupt the store.
 * Serialisation is per-process: two phantombot processes sharing this XDG
 * state path would race last-writer-wins through the rename, which is fine
 * under the single-process assumption (personas have separate accounts and
 * homes) but would silently lose counts in an embedded multi-process setup.
 */

import { existsSync, readFileSync } from "node:fs";
import { mkdir, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import { xdgStateHome } from "../config.ts";
import { log } from "./logger.ts";

export function countersFilePath(): string {
  return join(xdgStateHome(), "phantombot", "counters.json");
}

/** One more unit on each named key. Fire-and-forget; never throws. */
export function bumpCounters(bumps: Record<string, number>): void {
  // Serialise read-modify-write cycles: two bumps racing the same file
  // would otherwise read the same baseline and one update would vanish.
  chain = chain.then(() => applyBumps(bumps)).catch(() => undefined);
}

/** Snapshot of every counter, for tests and future surfacing (doctor, CLI). */
export async function readCounters(): Promise<Record<string, number>> {
  await chain.catch(() => undefined);
  return parseFile(countersFilePath());
}

let chain: Promise<unknown> = Promise.resolve();

async function applyBumps(bumps: Record<string, number>): Promise<void> {
  const path = countersFilePath();
  const current = await parseFile(path);
  for (const [key, by] of Object.entries(bumps)) {
    if (!Number.isFinite(by) || by <= 0) continue;
    current[key] = (current[key] ?? 0) + by;
  }
  await mkdir(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(tmp, `${JSON.stringify(current, null, 2)}\n`, "utf8");
  await rename(tmp, path);
}

async function parseFile(path: string): Promise<Record<string, number>> {
  if (!existsSync(path)) return {};
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
    if (typeof parsed !== "object" || parsed === null) return {};
    const out: Record<string, number> = {};
    for (const [k, v] of Object.entries(parsed)) {
      if (typeof v === "number" && Number.isFinite(v)) out[k] = v;
    }
    return out;
  } catch (e) {
    // Corrupt store — start a fresh one rather than wedge every future
    // bump on a file we can no longer parse. The counts are lost; the
    // feeds keep working.
    log.warn("counters: unreadable store, starting fresh", {
      path,
      error: (e as Error).message,
    });
    return {};
  }
}
