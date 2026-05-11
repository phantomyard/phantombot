/**
 * Slash command dispatcher for chat channels.
 *
 * Sits BEFORE the LLM in the message loop. Catches in-band control commands
 * (`/stop`, `/reset`, `/status`, `/harness`, `/help`) and handles them in the
 * channel layer so they keep working even when the LLM is hung on a
 * subprocess tool call — that was the failure mode that motivated this
 * module: PhantomBot's old design routed every message through the harness,
 * so a stuck `gemini usage` subprocess would block `/stop` along with
 * everything else.
 *
 * The handler is intentionally pure-ish: it returns a result object and
 * mutates only what was passed in (memory store, harness chain, the active
 * turn's AbortController). The channel adapter is responsible for sending
 * the reply text back to the user.
 *
 * Recognized vs unknown:
 *   - `/stop`, `/reset`, `/status`, `/harness`, `/help` → handled here.
 *   - Any other `/foo` → returned as null, channel falls through to runTurn
 *     so the LLM can interpret it (some personas use `/remember`, etc.).
 */

import type { Config } from "../config.ts";
import type { Harness } from "../harnesses/types.ts";
import { formatElapsedSeconds, truncateLine } from "../lib/format.ts";
import { log } from "../lib/logger.ts";
import { runUpdateFlow } from "../lib/updateNotify.ts";
import type { MemoryStore } from "../memory/store.ts";
import { VERSION } from "../version.ts";

export interface ActiveTurnHandle {
  controller: AbortController;
  startTime: number;
  /**
   * Most recent progress note from the active harness — typically a tool
   * name like "tool_execution_start: BashTool" or a stderr line. Surfaced
   * by /status so the user can tell whether a long turn is genuinely
   * working or stuck. The channel adapter updates this as chunks arrive.
   */
  lastProgressNote?: string;
}

export interface SlashCommandContext {
  /** For logging / disambiguation only. */
  chatId: number;
  persona: string;
  /** Conversation key, e.g. "telegram:42". Used by /reset. */
  conversation: string;
  /** Memory store for /reset's deleteConversation call. */
  memory: MemoryStore;
  /**
   * The harness chain — mutable. /harness reorders this in place so the
   * channel adapter (which holds the same array reference) sees the new
   * primary on the next turn.
   */
  harnesses: Harness[];
  /** Wall-clock when the channel server started, for /status uptime. */
  startedAt: number;
  /** Currently running turn for this chat, if any. /stop aborts it. */
  activeTurn?: ActiveTurnHandle;
  /**
   * Full loaded config — currently used only by /update so it can hand
   * the telegram channel + chatId to runUpdateFlow. Optional so existing
   * tests can leave it out for commands that don't need it. The channel
   * adapter always provides it in production.
   */
  config?: Config;
}

export interface SlashCommandResult {
  /** Reply text to send back to the user. Always non-empty for handled commands. */
  reply: string;
  /**
   * Optional callback the channel layer awaits AFTER sending `reply`.
   *
   * Used by /update: the binary swap completes, we send the user
   * "installed vX.Y.Z, restarting…", and THEN trigger the systemctl
   * restart that SIGTERMs us. If we ran the restart synchronously
   * before returning, sendMessage would race the SIGTERM and the user
   * would never see the heads-up.
   */
  afterSend?: () => Promise<void>;
}

const HELP =
  `available commands:\n` +
  `/stop     — abort the current turn\n` +
  `/reset    — clear this chat's history\n` +
  `/status   — show harness, uptime, context usage\n` +
  `/harness  — list or switch the active harness (e.g. /harness pi)\n` +
  `/update   — install the latest phantombot release if newer than this build\n` +
  `/help     — this list`;

/**
 * Parse + dispatch a slash command.
 *
 * Returns null if `text` is not a slash command we own — caller falls
 * through to the LLM for that message. Returns a SlashCommandResult when
 * the command is handled (recognized or refused).
 */
export async function handleSlashCommand(
  text: string,
  ctx: SlashCommandContext,
): Promise<SlashCommandResult | null> {
  const trimmed = text.trim();
  if (!trimmed.startsWith("/")) return null;

  // Telegram convention in groups: `/cmd@BotName arg1 arg2`. Strip the
  // @suffix so the command matches whether the bot was @-mentioned or not.
  const parts = trimmed.split(/\s+/);
  const head = parts[0]!;
  const cmd = head.split("@")[0]!.toLowerCase();
  const arg = parts.slice(1).join(" ").trim();

  switch (cmd) {
    case "/stop":
      return handleStop(ctx);
    case "/reset":
      return handleReset(ctx);
    case "/status":
      return await handleStatus(ctx);
    case "/harness":
      return await handleHarness(arg, ctx);
    case "/update":
      return await handleUpdate(ctx);
    case "/help":
      return { reply: HELP };
    default:
      return null;
  }
}

/**
 * /update — idempotent self-update.
 *
 * Three outcomes the user sees:
 *   1. "already on vX.Y.Z — nothing to do" (we're current)
 *   2. "installed vX.Y.Z (was vA.B.C). Restarting now…" then, post-restart,
 *      a separate "✅ Updated to vX.Y.Z" / "⚠️ Update didn't take" message
 *   3. an error string explaining why the check or install failed
 *
 * The restart is fired via `afterSend` so the channel layer sends the
 * heads-up message FIRST, then SIGTERMs us — without afterSend, the
 * `systemctl restart` would race the sendMessage call.
 */
async function handleUpdate(
  ctx: SlashCommandContext,
): Promise<SlashCommandResult> {
  if (!ctx.config) {
    // Defensive — production channel always provides this. If a future
    // caller forgets, fail loud rather than silently no-op.
    return {
      reply: "update unavailable: channel didn't pass config to the dispatcher",
    };
  }
  log.info("commands: /update invoked", {
    chatId: ctx.chatId,
    currentVersion: VERSION,
  });
  const r = await runUpdateFlow({
    config: ctx.config,
    currentVersion: VERSION,
    chatId: ctx.chatId,
  });
  return { reply: r.reply, afterSend: r.restart };
}

function handleStop(ctx: SlashCommandContext): SlashCommandResult {
  if (!ctx.activeTurn) {
    return { reply: "no active turn to stop" };
  }
  const elapsedS = ((Date.now() - ctx.activeTurn.startTime) / 1000).toFixed(1);
  ctx.activeTurn.controller.abort("stop");
  log.info("commands: /stop fired", { chatId: ctx.chatId, elapsedS });
  return { reply: `stopped (was running ${elapsedS}s)` };
}

async function handleReset(
  ctx: SlashCommandContext,
): Promise<SlashCommandResult> {
  // If a turn is in flight, abort it FIRST. Otherwise the user types
  // /reset expecting a clean slate, the in-flight turn finishes a few
  // seconds later, and `runTurn`'s on-success persist quietly appends
  // the now-irrelevant user/assistant pair to the just-cleared
  // conversation — defeating the reset.
  let stoppedNote = "";
  if (ctx.activeTurn) {
    const elapsedS = (
      (Date.now() - ctx.activeTurn.startTime) / 1000
    ).toFixed(1);
    ctx.activeTurn.controller.abort("reset");
    stoppedNote = ` (and stopped an in-flight turn that was ${elapsedS}s in)`;
  }

  const removed = await ctx.memory.deleteConversation(
    ctx.persona,
    ctx.conversation,
  );
  log.info("commands: /reset", {
    chatId: ctx.chatId,
    persona: ctx.persona,
    conversation: ctx.conversation,
    deletedTurns: removed,
    abortedActiveTurn: Boolean(ctx.activeTurn),
  });
  const noun = removed === 1 ? "turn" : "turns";
  return {
    reply: `reset: cleared ${removed} ${noun} from this chat${stoppedNote}`,
  };
}

async function handleStatus(
  ctx: SlashCommandContext,
): Promise<SlashCommandResult> {
  const uptimeS = Math.floor((Date.now() - ctx.startedAt) / 1000);
  const primary = ctx.harnesses[0]?.id ?? "(none)";
  const chain = ctx.harnesses.map((h) => h.id).join(" → ") || "(none)";

  // Rough context estimate: total chars across the last 20 turns, divided
  // by 4 (the standard chars-per-token heuristic). Doesn't include the
  // system prompt, which is ~stable across turns. Off by ~10-30% from a
  // real tokenizer reading — fine for "is the context filling up" UX.
  const recent = await ctx.memory.recentTurns(
    ctx.persona,
    ctx.conversation,
    20,
  );
  const historyChars = recent.reduce((a, t) => a + t.text.length, 0);
  const approxTokens = Math.round(historyChars / 4);
  const windowTokens = nominalContextWindow(primary);
  const pct = Math.min(
    100,
    Math.max(0, Math.round((approxTokens / windowTokens) * 100)),
  );

  const active = ctx.activeTurn
    ? `yes (${((Date.now() - ctx.activeTurn.startTime) / 1000).toFixed(1)}s)`
    : "no";

  // If a turn is in flight AND we've captured a progress note, append a
  // "running:" line so the user can see what the harness is currently
  // doing — important for the "is it stuck or just busy?" question that
  // long Telegram-from-Claude turns provoke.
  const runningLine =
    ctx.activeTurn?.lastProgressNote
      ? `\nrunning: ${truncateLine(ctx.activeTurn.lastProgressNote, 120)}`
      : "";

  return {
    reply:
      `harness: ${primary}\n` +
      `chain:   ${chain}\n` +
      `uptime:  ${formatElapsedSeconds(uptimeS)}\n` +
      `context: ~${pct}% (≈${approxTokens.toLocaleString()} / ${windowTokens.toLocaleString()} tokens, last 20 turns)\n` +
      `active:  ${active}` +
      runningLine,
  };
}

async function handleHarness(
  arg: string,
  ctx: SlashCommandContext,
): Promise<SlashCommandResult> {
  if (ctx.harnesses.length === 0) {
    return { reply: "no harnesses configured" };
  }

  if (!arg) {
    // No arg → list current chain with availability.
    const lines: string[] = [];
    for (let i = 0; i < ctx.harnesses.length; i++) {
      const h = ctx.harnesses[i]!;
      const ok = await h.available();
      const marker = i === 0 ? "→" : " ";
      const suffix = ok ? "" : " (unavailable)";
      lines.push(`${marker} ${h.id}${suffix}`);
    }
    return {
      reply:
        `current chain (→ = primary):\n${lines.join("\n")}\n\n` +
        `use /harness <id> to switch primary`,
    };
  }

  const wanted = arg.toLowerCase();
  const idx = ctx.harnesses.findIndex((h) => h.id === wanted);
  if (idx < 0) {
    const ids = ctx.harnesses.map((h) => h.id).join(", ");
    return { reply: `unknown harness '${wanted}' — available: ${ids}` };
  }
  if (idx === 0) {
    return { reply: `${wanted} is already primary` };
  }
  const ok = await ctx.harnesses[idx]!.available();
  if (!ok) {
    return {
      reply: `${wanted} is configured but its binary isn't available — refusing to switch`,
    };
  }
  // Splice → unshift mutates in place so the channel adapter's reference to
  // this same array sees the new ordering on the next turn.
  const [picked] = ctx.harnesses.splice(idx, 1);
  ctx.harnesses.unshift(picked!);
  log.info("commands: /harness switched", {
    chatId: ctx.chatId,
    primary: wanted,
  });
  return { reply: `switched to ${wanted}` };
}

/**
 * Rough context-window sizes per harness CLI for /status. Off by
 * ±50% is fine for a percentage display — the user only needs to know
 * "is context filling up." Wired here rather than on the Harness type
 * because it's a UX number, not a behaviour-affecting one.
 */
export function nominalContextWindow(harnessId: string): number {
  switch (harnessId) {
    case "claude":
      return 200_000;
    case "gemini":
      return 1_000_000;
    case "pi":
      return 64_000;
    default:
      return 128_000;
  }
}

