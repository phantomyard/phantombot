/**
 * Hold notices, relayed into the owner's open threads (#768).
 *
 * A judge or escort hold reaches the owner as a DM (`phantombot notify`). But
 * the owner is often working somewhere else when it happens — a group, the
 * TUI, an editor's ACP panel — and none of those heard about it. This is the
 * shared record that lets each of them pick the notice up:
 *
 *   - Whoever holds (the screen, in whatever process ran it) appends one line
 *     to `<personaDir>/hold-notices.jsonl` after the DM went out.
 *   - Every long-lived reader keeps a `HoldThreadRelay`: it notes which of its
 *     threads the owner was active in, and every poll hands back the new
 *     notices for each thread active in the last 60 minutes. The service
 *     sends them into Telegram and PhantomChat groups, the TUI prints a system
 *     line, ACP adds a line to the reply it streams.
 *
 * Opportunistic by design: a thread that is gone just fails to send, and that
 * failure is swallowed. Nothing here is written to `turns` — a relayed notice
 * is not part of the conversation and the model never reads it back as its own
 * reply. Owner DMs are never relayed into: they already got the full notice.
 * Groups only ever get a count ("details in my DM"), never what was held.
 *
 * Every word a reader shows is either this module's own or a notice phantombot
 * itself wrote; the record lives in the persona dir, which an escorted turn can
 * write, so readers that show more than a count (TUI, ACP) are the owner's own
 * local sessions, and each text is capped.
 */

import { appendFileSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export const HOLD_NOTICES_FILE = "hold-notices.jsonl";
/** A thread counts as open when the owner was active in it this recently. */
export const HOLD_RELAY_ACTIVE_WINDOW_MS = 60 * 60 * 1000;
/** Notices older than this are pruned on the next write. */
export const HOLD_NOTICE_KEEP_MS = 2 * 60 * 60 * 1000;
/** How often the long-lived readers poll the record. Bursts inside one poll coalesce. */
export const HOLD_RELAY_POLL_MS = 20 * 1000;
/** Cap on one notice's text as stored and as shown. */
export const HOLD_NOTICE_TEXT_CAP = 400;
/** Past this size the record is rewritten with only the recent lines. */
const HOLD_NOTICES_MAX_BYTES = 64 * 1024;

export type HoldNoticeSource = "judge" | "escort";

export interface HoldNotice {
  /** Epoch ms when the hold was announced. */
  at: number;
  source: HoldNoticeSource;
  /** How many held actions/requests this notice stands for. */
  count: number;
  /** The DM's text, capped. Shown only in the owner's own local sessions. */
  text: string;
}

function noticesPath(personaDir: string): string {
  return join(personaDir, HOLD_NOTICES_FILE);
}

function parseLine(line: string): HoldNotice | undefined {
  try {
    const v = JSON.parse(line) as Record<string, unknown>;
    if (
      typeof v.at !== "number" || !Number.isFinite(v.at) ||
      (v.source !== "judge" && v.source !== "escort") ||
      typeof v.count !== "number" || !(v.count >= 1) ||
      typeof v.text !== "string"
    ) {
      return undefined;
    }
    return {
      at: v.at,
      source: v.source,
      count: Math.min(Math.floor(v.count), 999),
      text: v.text.slice(0, HOLD_NOTICE_TEXT_CAP),
    };
  } catch {
    return undefined;
  }
}

/** Every well-formed notice newer than `sinceMs`, oldest first. Never throws. */
export function readHoldNotices(personaDir: string | undefined, sinceMs = 0): HoldNotice[] {
  if (!personaDir) return [];
  let text: string;
  try {
    text = readFileSync(noticesPath(personaDir), "utf8");
  } catch {
    return [];
  }
  const out: HoldNotice[] = [];
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    const n = parseLine(line);
    if (n && n.at > sinceMs) out.push(n);
  }
  return out.sort((a, b) => a.at - b.at);
}

/**
 * Append one notice. Best-effort and synchronous: a record that cannot be
 * written only means the open threads are not told; the DM already went out.
 */
export function publishHoldNotice(
  personaDir: string | undefined,
  notice: { source: HoldNoticeSource; count: number; text: string },
  now = Date.now(),
): boolean {
  if (!personaDir) return false;
  try {
    mkdirSync(personaDir, { recursive: true });
    const path = noticesPath(personaDir);
    const line = JSON.stringify({
      at: now,
      source: notice.source,
      count: Math.max(1, Math.floor(notice.count)),
      text: notice.text.replace(/\s+/g, " ").trim().slice(0, HOLD_NOTICE_TEXT_CAP),
    });
    let size = 0;
    try {
      size = statSync(path).size;
    } catch {
      size = 0;
    }
    if (size > HOLD_NOTICES_MAX_BYTES) {
      const keep = readHoldNotices(personaDir, now - HOLD_NOTICE_KEEP_MS).map((n) => JSON.stringify(n));
      const tmp = `${path}.${process.pid}.tmp`;
      writeFileSync(tmp, [...keep, line].join("\n") + "\n", { mode: 0o600 });
      renameSync(tmp, path);
    } else {
      appendFileSync(path, line + "\n", { mode: 0o600 });
    }
    return true;
  } catch {
    return false;
  }
}

/** The one line a group gets: a count, never what was held. */
export function groupHoldLine(count: number): string {
  return count === 1
    ? "🔒 I held 1 action. Details in my DM."
    : `🔒 I held ${count} actions. Details in my DM.`;
}

/** The line the owner's own local session (TUI, ACP) shows. */
export function privateHoldLine(notices: readonly HoldNotice[]): string {
  const latest = notices[notices.length - 1];
  if (!latest) return "";
  const more = notices.length - 1;
  return more > 0 ? `${latest.text} (+${more} more, see DM)` : latest.text;
}

/** Total held items across notices. */
export function holdCount(notices: readonly HoldNotice[]): number {
  return notices.reduce((n, x) => n + x.count, 0);
}

/**
 * One reader's view: which of its threads are open, and which notices each
 * has already been handed. In memory only — a restart starts a fresh cursor,
 * so notices from before it are never replayed (the DM carried them).
 */
export class HoldThreadRelay {
  private readonly lastActive = new Map<string, number>();
  private cursor: number;
  private readonly windowMs: number;

  constructor(
    private readonly personaDir: string | undefined,
    opts: { startedAt?: number; windowMs?: number } = {},
  ) {
    this.cursor = opts.startedAt ?? Date.now();
    this.windowMs = opts.windowMs ?? HOLD_RELAY_ACTIVE_WINDOW_MS;
  }

  /** The owner was active in this thread just now. */
  touch(thread: string, now = Date.now()): void {
    this.lastActive.set(thread, now);
  }

  /**
   * The notices that arrived since the last poll, per open thread. Advances
   * the cursor whether or not any thread is open: a notice nobody had a
   * thread for is not held back for a thread that opens later. Threads idle
   * past the window are dropped. Never throws.
   */
  due(now = Date.now()): Array<{ thread: string; notices: HoldNotice[] }> {
    const fresh = readHoldNotices(this.personaDir, this.cursor).filter((n) => n.at <= now);
    for (const [thread, at] of this.lastActive) {
      if (now - at > this.windowMs) this.lastActive.delete(thread);
    }
    if (fresh.length === 0) return [];
    this.cursor = fresh[fresh.length - 1]!.at;
    return [...this.lastActive.keys()].map((thread) => ({ thread, notices: fresh }));
  }
}

/**
 * Poll a relay on a timer and hand each due thread to `deliver`. Delivery
 * failures are swallowed (the thread may be gone). The timer is unref'd so it
 * never keeps a process alive. Returns a stop function.
 */
export function startHoldRelay(
  relay: HoldThreadRelay,
  deliver: (thread: string, notices: HoldNotice[]) => Promise<unknown> | unknown,
  intervalMs = HOLD_RELAY_POLL_MS,
): () => void {
  let busy = false;
  const tick = async () => {
    if (busy) return;
    busy = true;
    try {
      for (const { thread, notices } of relay.due()) {
        try {
          await deliver(thread, notices);
        } catch {
          // Opportunistic: a closed or unreachable thread just misses it.
        }
      }
    } catch {
      // never let the poller throw
    } finally {
      busy = false;
    }
  };
  const timer = setInterval(() => void tick(), intervalMs);
  (timer as { unref?: () => void }).unref?.();
  return () => clearInterval(timer);
}
