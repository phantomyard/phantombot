/**
 * Slash command dispatcher for chat channels.
 *
 * Sits BEFORE the LLM in the message loop. Catches in-band control commands
 * (`/start`, `/stop`, `/reset`, `/status`, `/harness`, `/help`) and handles them in the
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
 *   - `/start`, `/stop`, `/reset`, `/status`, `/harness`, `/help` → handled here.
 *   - Any other `/foo` → returned as null, channel falls through to runTurn
 *     so the LLM can interpret it (some personas use `/remember`, etc.).
 */

import { memoryIndexPath, type Config } from "../config.ts";
import type { Harness } from "../harnesses/types.ts";
import { formatElapsedSeconds, truncateLine } from "../lib/format.ts";
import { log } from "../lib/logger.ts";
import { MemoryIndex } from "../lib/memoryIndex.ts";
import { defaultServiceControl, selfRestart } from "../lib/platform.ts";
import type { ServiceControl } from "../lib/systemd.ts";
import { runUpdateFlow } from "../lib/updateNotify.ts";
import {
  applyCoderSwapRequest,
  normalizeCoderSwapRequest,
} from "../lib/coderSwap.ts";
import {
  applyChattinessRequest,
  normalizeChattinessRequest,
} from "../lib/chattiness.ts";
import { setIn, updateConfigToml } from "../lib/configWriter.ts";
import type { MemoryStore } from "../memory/store.ts";
import { DEFAULT_HISTORY_LIMIT } from "../orchestrator/turn.ts";
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
  /** For logging / disambiguation only. The channel-neutral string
   *  conversation id (e.g. Telegram's stringified chat id). */
  chatId: string;
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
  /**
   * ServiceControl override for /restart's afterSend. Production
   * callers leave this undefined and /restart picks up
   * `defaultServiceControl()`; tests inject a stub so a `bun test` run
   * never invokes the host's real systemctl restart on the developer's
   * own phantombot.service. Matches the override seam already used by
   * runUpdateFlow.
   */
  serviceControl?: ServiceControl;
  /**
   * This bot's own @username (from startup getMe). Used to validate the
   * `/cmd@BotName` suffix in groups: a command explicitly targeted at a
   * different bot must NOT be handled here. Undefined if getMe failed or
   * in contexts (DMs, tests) where targeting is irrelevant.
   */
  botUsername?: string;
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

/**
 * The canonical list of slash commands phantombot actually implements.
 *
 * Single source of truth for two consumers:
 *   1. {@link HELP} — the `/help` reply text (derived below).
 *   2. The Telegram `setMyCommands` registration at channel startup,
 *      which OVERWRITES whatever is in the bot's command menu — including
 *      "ghost" commands a human added in BotFather (e.g. `/activation`)
 *      that phantombot has no handler for. Without this, the `/` typeahead
 *      in Telegram advertises commands that silently fall through to the
 *      LLM, which is exactly the confusing behaviour we want to kill.
 *
 * `command` is the bare name (no leading slash) per the Bot API. Keep
 * descriptions short — Telegram renders them inline in the menu and caps
 * them at 256 chars.
 */
export const TELEGRAM_BOT_COMMANDS: Array<{
  command: string;
  description: string;
}> = [
  { command: "start", description: "Show this command list" },
  { command: "stop", description: "Abort the current turn" },
  { command: "reset", description: "Clear this chat's history" },
  { command: "status", description: "Show harness, uptime, context usage" },
  { command: "harness", description: "List or switch the active harness" },
  { command: "update", description: "Install the latest phantombot release" },
  { command: "restart", description: "Restart the phantombot service" },
  {
    command: "coder",
    description: "Force the coding brain on for this chat (off | default to revert)",
  },
  {
    command: "chattiness",
    description: "Show/hide progress bubbles here (on | off | <on|off> default)",
  },
  { command: "help", description: "Show this command list" },
];

const HELP =
  `available commands:\n` +
  TELEGRAM_BOT_COMMANDS.map((c) => `/${c.command} — ${c.description}`).join(
    "\n",
  );

/**
 * Extract the `@BotName` target from a slash command head, if present.
 *
 *   "/status@kai_agh_bot foo" → "kai_agh_bot"
 *   "/status foo"             → undefined
 *   "/status@"                → undefined (empty target)
 *
 * Telegram lets a user disambiguate which bot a command is for by
 * appending `@<bot-username>`. Exported for the channel's group gate and
 * for testing.
 */
export function slashCommandTarget(text: string): string | undefined {
  const head = text.trim().split(/\s+/)[0] ?? "";
  const at = head.indexOf("@");
  if (at < 0) return undefined;
  const target = head.slice(at + 1);
  return target.length > 0 ? target : undefined;
}

/**
 * Parse + dispatch a slash command.
 *
 * Returns null if `text` is not a slash command we own — caller falls
 * through to the LLM for that message. Returns a SlashCommandResult when
 * the command is handled (recognized or refused).
 *
 * Group targeting: a `/cmd@BotName` whose `@BotName` names a *different*
 * bot than this one returns null (we don't own it). Without this check a
 * state-changing command like `/reset@otherbot` would be executed by
 * every bot in the group, not just the addressed one. The check is only
 * applied when `ctx.botUsername` is known; otherwise we keep the legacy
 * behavior of stripping the suffix and handling the command.
 */
export async function handleSlashCommand(
  text: string,
  ctx: SlashCommandContext,
): Promise<SlashCommandResult | null> {
  const trimmed = text.trim();
  if (!trimmed.startsWith("/")) return null;

  // Telegram convention in groups: `/cmd@BotName arg1 arg2`. If the
  // @suffix names a different bot, this command isn't ours — fall through.
  const target = slashCommandTarget(trimmed);
  if (
    target &&
    ctx.botUsername &&
    target.toLowerCase() !== ctx.botUsername.toLowerCase()
  ) {
    return null;
  }

  // Strip the @suffix so the command matches whether the bot was
  // @-mentioned or not.
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
    case "/restart":
      return handleRestart(ctx);
    case "/coder":
      // Bare `/coder` forces on; `/coder off|default` is also accepted.
      return await handleCoderSwap(arg || "on", ctx);
    case "/chattiness":
      return await handleChattiness(arg, ctx);
    case "/start":
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
    persona: ctx.persona,
    currentVersion: VERSION,
  });
  const r = await runUpdateFlow({
    config: ctx.config,
    currentVersion: VERSION,
    // Telegram-only numeric id, kept for the Telegram post-restart path. For a
    // PhantomChat conversation `ctx.chatId` is a hex pubkey → NaN here, which is
    // exactly why `conversation` below is the authoritative router: it carries
    // the channel-neutral key ("telegram:42" / "phantomchat:<hex>") so the
    // confirmation lands back where `/update` was typed, not on Telegram.
    chatId: Number(ctx.chatId),
    conversation: ctx.conversation,
    persona: ctx.persona,
  });
  return { reply: r.reply, afterSend: r.restart };
}

/**
 * /restart — restart the phantombot service.
 *
 * Sends "restarting…" to the user, then triggers an IN-PROCESS restart via
 * `selfRestart`: on Linux/macOS the supervisor bounces us (systemctl --user /
 * launchctl); on Windows we exit cleanly and the always-on task's keep-alive
 * trigger relaunches us (calling schtasks End/Run from our own task tree would
 * race the relaunch — see selfRestart). The restart is fired via `afterSend`
 * so the channel layer sends the heads-up message FIRST, then we go down.
 */
function handleRestart(ctx: SlashCommandContext): SlashCommandResult {
  const svc = ctx.serviceControl ?? defaultServiceControl();

  const afterSend = async (): Promise<void> => {
    const r = await selfRestart({ serviceControl: svc });
    if (!r.ok) {
      log.error("commands: /restart failed", {
        chatId: ctx.chatId,
        stderr: r.stderr,
      });
    }
  };

  return { reply: "restarting…", afterSend };
}

/**
 * /coder [on|off|default] — per-conversation manual override of the
 * coding-brain auto-swap.
 *
 * Normally the Pi harness decides per turn, via a free CRS-style score over the
 * user message, whether to swap its primary model to the configured coding model
 * (a "probable coding job"). This override pins that decision for THIS chat:
 *   - on      → always use the coding brain here (skip scoring)
 *   - off     → never auto-swap here (stay on the primary)
 *   - default → clear the override; defer to the scorer again
 *
 * Persistent (no idle expiry). `/coder` with no arg forces on; use `/coder off`
 * to disable the swap for this chat.
 */
async function handleCoderSwap(
  arg: string,
  ctx: SlashCommandContext,
): Promise<SlashCommandResult> {
  const request = normalizeCoderSwapRequest(arg.toLowerCase());
  if (!request) {
    return {
      reply:
        "usage: /coder on|off|default\n" +
        "  on      — always use the coding brain in this chat\n" +
        "  off     — never auto-swap here (stay on the primary)\n" +
        "  default — let the scorer decide each turn",
    };
  }

  await applyCoderSwapRequest({
    persona: ctx.persona,
    conversation: ctx.conversation,
    request,
  });
  log.info("commands: /coder", {
    chatId: ctx.chatId,
    persona: ctx.persona,
    conversation: ctx.conversation,
    request,
  });

  const reply =
    request === "on"
      ? "coding brain: forced ON for this chat — every turn uses the coding model"
      : request === "off"
        ? "coding brain: forced OFF for this chat — no auto-swap, stays on the primary"
        : "coding brain: reset to auto — the scorer decides each turn";
  return { reply };
}

/**
 * /chattiness [on|off|default] — per-conversation toggle for the interim
 * "progress narration" bubbles ("checking your calendar…") that stream while a
 * turn runs. Scoped to Telegram + PhantomChat; the final reply and error paths
 * are never affected.
 *
 *   on              → show interim bubbles in this chat
 *   off             → quiet: no interim bubbles, just the final reply
 *   default         → clear this chat's override; defer to the config default
 *   <on|off> default → ALSO write `chattiness` in config.toml as the standing
 *                       default (and clear this chat's override so it follows it)
 *
 * Persistent (no idle expiry). The per-conversation override wins over the
 * config default; absent an override, `config.chattiness` decides.
 */
async function handleChattiness(
  arg: string,
  ctx: SlashCommandContext,
): Promise<SlashCommandResult> {
  const usage =
    "usage: /chattiness on|off|default\n" +
    "  on              — show progress bubbles in this chat\n" +
    "  off             — quiet: just the final reply, no interim bubbles\n" +
    "  default         — clear this chat's setting; use the standing default\n" +
    "  <on|off> default — also make on/off the standing default everywhere";

  const tokens = arg.toLowerCase().split(/\s+/).filter((t) => t.length > 0);
  // Bare `/chattiness` → show the options rather than silently clearing.
  if (tokens.length === 0) return { reply: usage };
  const setDefault = tokens.length > 1 && tokens[tokens.length - 1] === "default";
  // With the trailing "default" modifier, the leading token is the value to
  // persist globally; without it, the whole (single) token is the request.
  const head = setDefault ? tokens[0]! : (tokens[0] ?? "");
  const request = normalizeChattinessRequest(head);

  // `<on|off> default` must resolve to a concrete on/off to write to config.
  if (setDefault && request !== "on" && request !== "off") {
    return { reply: usage };
  }
  if (!setDefault && !request) {
    return { reply: usage };
  }

  // Writing the standing default: flip config.toml, then clear this chat's
  // per-conversation override so it follows the new default (consistent with
  // what the user just asked for right here).
  if (setDefault) {
    const enable = request === "on";
    if (!ctx.config) {
      return {
        reply:
          "can't set the default: channel didn't pass config to the dispatcher",
      };
    }
    await updateConfigToml(ctx.config.configPath, (c) => {
      setIn(c, ["chattiness"], enable);
    });
    // Keep the live Config in sync with what we just wrote to disk. Without
    // this, the running process keeps resolving against the old default until
    // a restart/reload — and since we also clear this chat's override below,
    // this chat (and every override-less chat) would silently keep the old
    // behavior despite the reply saying the default changed.
    ctx.config.chattiness = enable;
    await applyChattinessRequest({
      persona: ctx.persona,
      conversation: ctx.conversation,
      request: "default",
    });
    log.info("commands: /chattiness set default", {
      chatId: ctx.chatId,
      persona: ctx.persona,
      conversation: ctx.conversation,
      enable,
    });
    return {
      reply: enable
        ? "chattiness default: ON everywhere — new chats show progress bubbles (this chat follows the default now)"
        : "chattiness default: OFF everywhere — new chats stay quiet (this chat follows the default now)",
    };
  }

  // Per-conversation sticky toggle (or clear).
  await applyChattinessRequest({
    persona: ctx.persona,
    conversation: ctx.conversation,
    request: request!,
  });
  log.info("commands: /chattiness", {
    chatId: ctx.chatId,
    persona: ctx.persona,
    conversation: ctx.conversation,
    request,
  });

  const reply =
    request === "on"
      ? "chattiness: ON for this chat — you'll see progress bubbles while I work"
      : request === "off"
        ? "chattiness: OFF for this chat — I'll work quietly and just send the final reply"
        : "chattiness: reset to the standing default for this chat";
  return { reply };
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
  let removedIndexedTurns = false;
  if (ctx.config?.retrieval?.turnIndexing.enabled) {
    let ix: MemoryIndex | undefined;
    try {
      ix = await MemoryIndex.open(memoryIndexPath(ctx.persona));
      ix.deleteConversationTurns(ctx.persona, ctx.conversation);
      removedIndexedTurns = true;
    } catch (e) {
      log.warn("commands: /reset failed to clear turn index", {
        chatId: ctx.chatId,
        persona: ctx.persona,
        conversation: ctx.conversation,
        error: (e as Error).message,
      });
    } finally {
      ix?.close();
    }
  }
  log.info("commands: /reset", {
    chatId: ctx.chatId,
    persona: ctx.persona,
    conversation: ctx.conversation,
    deletedTurns: removed,
    removedIndexedTurns,
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

  // Rough context estimate: total chars across the rolling history turns, divided
  // by 4 (the standard chars-per-token heuristic). Doesn't include the
  // system prompt, which is ~stable across turns. Off by ~10-30% from a
  // real tokenizer reading — fine for "is the context filling up" UX.
  const recent = await ctx.memory.recentTurns(
    ctx.persona,
    ctx.conversation,
    DEFAULT_HISTORY_LIMIT,
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
      `context: ~${pct}% (≈${approxTokens.toLocaleString()} / ${windowTokens.toLocaleString()} tokens, last ${DEFAULT_HISTORY_LIMIT} turns)\n` +
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
