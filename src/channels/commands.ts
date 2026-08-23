/**
 * Slash command dispatcher for chat channels.
 *
 * Sits BEFORE the LLM in the message loop. Catches in-band control commands
 * (`/start`, `/stop`, `/reset`, `/status`, `/harness`, `/help`) and handles them in the
 * channel layer so they keep working even when the LLM is hung on a
 * subprocess tool call — that was the failure mode that motivated this
 * module: PhantomBot's old design routed every message through the harness,
 * so a stuck child subprocess would block `/stop` along with
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

import { stopNoteText } from "./core/backlog.ts";
import { type Config } from "../config.ts";
import { DEFAULT_UPDATE_CHANNEL } from "../lib/githubReleases.ts";
import type { Harness } from "../harnesses/types.ts";
import { formatElapsedSeconds, truncateLine } from "../lib/format.ts";
import { log } from "../lib/logger.ts";
import { defaultServiceControl, selfRestart } from "../lib/platform.ts";
import type { ServiceControl } from "../lib/systemd.ts";
import { runUpdateFlow } from "../lib/updateNotify.ts";
import { runFixSigning } from "../cli/fix-signing.ts";
import type { WriteSink } from "../lib/io.ts";
import {
  applyCoderSwapRequest,
  normalizeCoderSwapRequest,
} from "../lib/coderSwap.ts";
import {
  applyChattinessRequest,
  normalizeChattinessRequest,
} from "../lib/chattiness.ts";
import { setIn, updateConfigToml } from "../lib/configWriter.ts";
import {
  applyModelRequest,
  formatModelShow,
  parseModelRequest,
} from "../lib/modelCommand.ts";
import { listPiModels } from "../lib/piModels.ts";
import type { MemoryStore } from "../memory/store.ts";
import { DEFAULT_HISTORY_LIMIT } from "../orchestrator/turn.ts";
import { VERSION } from "../version.ts";
import { gatherStatusProbes } from "./statusProbes.ts";

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
  /** Memory store for /reset's context-watermark advance and /stop's note. */
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
   * Every persona this daemon actually started — Telegram listeners AND
   * PhantomChat identities, deduped (phantombot#439). `/status` reports this
   * verbatim: reconstructing the roster from `default_persona` +
   * `autostart_personas` would omit legacy `[channels.telegram.personas.*]`
   * listeners and any PhantomChat persona, so a multi-persona process could
   * report itself as single-persona. Absent (tests, embedded callers) means
   * "unknown" and the roster line is derived from config as a fallback.
   */
  runningPersonas?: string[];
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
  /**
   * Discard this conversation's pending backlog — every message the user
   * queued behind the running turn that has not started executing yet — and
   * return how many were dropped. Wired in by each channel from its
   * `ConversationBacklog` (src/channels/core/backlog.ts); see `handleStop`.
   *
   * Optional so tests and any future embedder can omit it: without it `/stop`
   * degrades to its historical behaviour of aborting only the active turn.
   */
  flushBacklog?: () => number;
  /**
   * This persona's PhantomChat identity as an `npub…` (bech32 public key) —
   * the shareable address a user pastes into the PWA to DM this bot. Shown on
   * a `phantomchat:` line in /status so the operator can read the bot's own
   * npub without digging through phantomchat.json.
   *
   * Optional: undefined when the persona has no PhantomChat identity
   * configured (no phantomchat.json / nsec), or in tests that don't set it —
   * the /status line is simply omitted in that case.
   */
  phantomchatNpub?: string;
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
  {
    command: "stop",
    description: "Abort the current turn and drop anything queued behind it",
  },
  {
    command: "reset",
    description:
      "Start a fresh context window here (history is kept and stays searchable)",
  },
  { command: "status", description: "Show harness, uptime, context usage" },
  { command: "harness", description: "List or switch the active harness" },
  {
    command: "update",
    description:
      "Install the latest phantombot release (resign — macOS-only: re-sign the current binary in place, no update/restart)",
  },
  { command: "restart", description: "Restart the phantombot service" },
  {
    command: "coder",
    description: "Force the coding brain on for this chat (off | default to revert)",
  },
  {
    command: "chattiness",
    description: "Show/hide progress bubbles here (on | off | <on|off> default)",
  },
  {
    command: "model",
    description: "Show or switch the active harness model (list | <slug> | coding|image <slug> | clear)",
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
      return await handleStop(ctx);
    case "/reset":
      return handleReset(ctx);
    case "/status":
      return await handleStatus(ctx);
    case "/harness":
      return await handleHarness(arg, ctx);
    case "/update":
      // `/update resign` re-signs the CURRENT on-disk binary in place — no
      // download, no reinstall, no restart, no version change. It runs the
      // exact same signing routine /update applies post-swap, so it's a
      // faithful dogfood of the re-sign path and doubles as a manual repair
      // button when a macOS update breaks the signature. macOS-only; a no-op
      // elsewhere. Bare `/update` is the full self-update.
      {
        const refused = lifecycleRefusal(ctx, "/update");
        if (refused) return refused;
      }
      if (arg.toLowerCase() === "resign") return await handleUpdateResign(ctx);
      return await handleUpdate(ctx);
    case "/restart": {
      const refused = lifecycleRefusal(ctx, "/restart");
      if (refused) return refused;
      return handleRestart(ctx);
    }
    case "/coder":
      // Bare `/coder` forces on; `/coder off|default` is also accepted.
      return await handleCoderSwap(arg || "on", ctx);
    case "/chattiness":
      return await handleChattiness(arg, ctx);
    case "/model":
      return await handleModel(arg, ctx);
    case "/start":
    case "/help":
      return { reply: HELP };
    default:
      return null;
  }
}

/**
 * Lifecycle commands act on the PROCESS, not on a persona (phantombot#439).
 *
 * One phantombot serves every persona on the host, so `/update` and `/restart`
 * swap the binary and bounce the service for ALL of them. Typed at a
 * non-default persona they read like a per-persona action and are not one:
 * every other persona is taken down with no warning in its own chat, and two
 * personas racing an update would have two turns swapping the same binary.
 *
 * So they are answered — never silently ignored — only in the default
 * persona's chats, and the refusal names where to go instead.
 *
 * `/stop` is deliberately NOT gated: it aborts the current turn in the current
 * conversation, which is per-chat and harms nobody else.
 */
function lifecycleRefusal(
  ctx: SlashCommandContext,
  command: string,
): SlashCommandResult | undefined {
  const owner = ctx.config?.defaultPersona;
  // No config (tests, embedders) → no gate. The check must never be the
  // reason a lifecycle command stops working on a single-persona box.
  if (!owner || owner === ctx.persona) return undefined;
  log.info("commands: lifecycle command refused on non-default persona", {
    command,
    persona: ctx.persona,
    defaultPersona: owner,
  });
  return {
    reply:
      `${command} runs the whole phantombot process — every persona on this host shares it — ` +
      `so it is only accepted by the default persona.\n` +
      `Ask ${owner} to run ${command}.`,
  };
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
 * /update resign — re-sign the current binary in place, nothing else.
 *
 * This is deliberately NOT part of the self-update: it does NOT fetch a
 * release, reinstall, restart, or change the version. It re-runs the SAME
 * signing routine `/update` applies automatically after a binary swap
 * (`runFixSigning` → `fixSigning`), against the binary already on disk. Two
 * uses: (1) dogfooding the re-sign path without the fetch/install/restart
 * dance — the devloop that motivated it — and (2) a manual repair button when
 * a macOS update invalidates the signature and Andrew wants to re-sign without
 * a full update.
 *
 * macOS-only in effect. On Linux/Windows `runFixSigning` returns its friendly
 * "nothing to do" no-op (exit 0) — there's no TCC nagging to fix. We reuse
 * that command's exact platform guard, binary check, and user-facing prose by
 * capturing its output sinks into the chat reply, so the message the user sees
 * is identical to `phantombot fix-signing`.
 */
async function handleUpdateResign(
  ctx: SlashCommandContext,
): Promise<SlashCommandResult> {
  log.info("commands: /update resign invoked", {
    chatId: ctx.chatId,
    persona: ctx.persona,
    platform: process.platform,
  });
  const chunks: string[] = [];
  const sink: WriteSink = {
    write: (chunk: string | Uint8Array): boolean => {
      chunks.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString());
      return true;
    },
  };
  const code = await runFixSigning({ persona: ctx.persona, out: sink, err: sink });
  const reply =
    chunks.join("").trim() ||
    (code === 0 ? "resign complete" : "resign failed");
  return { reply };
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

  // The swap subsystem is skipped entirely when there is no DISTINCT coding
  // model (unset, or the same as the primary) — an override would be a silent
  // no-op, so say so instead of pretending it took effect.
  const routing = ctx.config?.harnesses?.pi?.routing;
  if (!routing?.codingModel || routing.codingModel === routing.primaryModel) {
    return {
      reply:
        "coding brain: inactive — no coding model configured (or it matches the primary). " +
        "Set one with /model coding <slug> or the `phantombot harness` wizard.",
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

/**
 * /stop — break-glass panic button. "Kill everything, and make sure you know
 * you were killed."
 *
 * Three things happen, in this order (GitHub #301):
 *   1. The pending backlog is flushed, so messages the user queued behind the
 *      running turn never execute. Flushing FIRST matters: aborting the active
 *      turn lets the serial chain advance, and if the backlog were still live
 *      the next queued message would start running before we got to drop it.
 *   2. The active turn is aborted.
 *   3. An agent-facing note is appended to the conversation history, so the
 *      NEXT turn reads "you were stopped, don't resume" instead of inferring
 *      from a truncated history that it should pick the work back up.
 *
 * This is the loud sibling of a plain interrupt (a new ordinary message while a
 * turn runs), which performs steps 1 and 2 SILENTLY and writes no note — there
 * the user's follow-up message is itself the context the agent needs.
 */
async function handleStop(
  ctx: SlashCommandContext,
): Promise<SlashCommandResult> {
  const dropped = ctx.flushBacklog?.() ?? 0;
  const hadActive = Boolean(ctx.activeTurn);

  // Nothing running and nothing queued — genuinely a no-op. Say so and skip
  // the history note: writing "you were stopped" when nothing was stopped
  // would just be a confusing lie in the agent's context window.
  if (!hadActive && dropped === 0) {
    return { reply: "no active turn to stop" };
  }

  let elapsedS = "0.0";
  if (ctx.activeTurn) {
    elapsedS = ((Date.now() - ctx.activeTurn.startTime) / 1000).toFixed(1);
    ctx.activeTurn.controller.abort("stop");
  }

  // Best-effort: a failed history write must not swallow the acknowledgement
  // for a command whose entire job — aborting and flushing — has already
  // succeeded by this point.
  try {
    await ctx.memory.appendTurn({
      persona: ctx.persona,
      conversation: ctx.conversation,
      role: "user",
      text: stopNoteText(dropped),
      // Control-plane bookkeeping, not something worth retrieving later.
      embeddable: false,
    });
  } catch (e) {
    log.warn("commands: /stop failed to append the agent-facing note", {
      chatId: ctx.chatId,
      conversation: ctx.conversation,
      error: (e as Error).message,
    });
  }

  log.info("commands: /stop fired", {
    chatId: ctx.chatId,
    elapsedS,
    abortedActiveTurn: hadActive,
    droppedQueued: dropped,
  });

  const activePart = hadActive
    ? `stopped (was running ${elapsedS}s)`
    : "stopped";
  const backlogPart =
    dropped > 0
      ? ` — dropped ${dropped} queued message${dropped === 1 ? "" : "s"}`
      : "";
  return { reply: `${activePart}${backlogPart}` };
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

  // /reset clears the LIVE CONTEXT WINDOW — it does not destroy the record.
  // It used to delete the turn rows AND their embeddings, which made a
  // routine "clear this chat" command silently unrecoverable: one /reset on a
  // long-running DM took 4,009 turns and every vector with it, and nothing
  // else in the system had a durable copy. Now it advances a per-conversation
  // watermark: nothing is replayed into the prompt, while the turns, the
  // index, and durable facts all survive and stay retrievable.
  const dropped = await ctx.memory.resetConversationContext(
    ctx.persona,
    ctx.conversation,
  );
  log.info("commands: /reset", {
    chatId: ctx.chatId,
    persona: ctx.persona,
    conversation: ctx.conversation,
    droppedFromWindow: dropped,
    abortedActiveTurn: Boolean(ctx.activeTurn),
  });
  const noun = dropped === 1 ? "turn" : "turns";
  return {
    reply: `reset: cleared ${dropped} ${noun} from this chat's context — history kept, still searchable${stoppedNote}`,
  };
}

/** Format the harness chain with availability annotations.
 * Shared by /status and /harness so the output stays consistent. */
async function formatHarnessChain(harnesses: Harness[]): Promise<string> {
  if (harnesses.length === 0) return "(none)";
  const parts = await Promise.all(
    harnesses.map(async (h, i) => {
      const ok = await h.available();
      const marker = i === 0 ? "→" : " ";
      const suffix = ok ? "" : " (unavailable)";
      return `${marker} ${h.id}${suffix}`;
    }),
  );
  return parts.join("\n");
}

async function handleStatus(
  ctx: SlashCommandContext,
): Promise<SlashCommandResult> {
  const uptimeS = Math.floor((Date.now() - ctx.startedAt) / 1000);
  const primary = ctx.harnesses[0]?.id ?? "(none)";
  const chain = await formatHarnessChain(ctx.harnesses);

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

  // Per-harness configured model(s) (issue #313) — the operator's "what
  // brain am I actually running?" answer. Harnesses without modelInfo
  // (test stubs, third-party) are simply omitted from the line.
  const modelParts = ctx.harnesses
    .map((h) => {
      const mi = h.modelInfo?.();
      if (!mi) return undefined;
      return `${h.id}: ${mi.model}${mi.provider ? ` (${mi.provider})` : ""}`;
    })
    .filter((p): p is string => p !== undefined);
  const modelsLine =
    modelParts.length > 0 ? `models:  ${modelParts.join(" | ")}\n` : "";

  // If a turn is in flight AND we've captured a progress note, append a
  // "running:" line so the user can see what the harness is currently
  // doing — important for the "is it stuck or just busy?" question that
  // long Telegram-from-Claude turns provoke.
  const runningLine =
    ctx.activeTurn?.lastProgressNote
      ? `\nrunning: ${truncateLine(ctx.activeTurn.lastProgressNote, 120)}`
      : "";

  // The persona's own PhantomChat address (npub…), when it has one. Kept on
  // its own line so it's easy to copy into the PWA / an allowlist.
  const npubLine = ctx.phantomchatNpub
    ? `phantomchat: ${ctx.phantomchatNpub}\n`
    : "";

  // Live subsystem health probes — fresh on every /status (it's a
  // troubleshooting tool). Each line is omitted when its subsystem isn't
  // configured. See statusProbes.ts.
  const probes = await gatherStatusProbes(ctx.config, ctx.persona);
  const probeLines =
    (probes.telegram ? `telegram: ${probes.telegram}\n` : "") +
    (probes.acp ? `acp:     ${probes.acp}\n` : "") +
    (probes.memory ? `memory:  ${probes.memory}\n` : "") +
    (probes.voice ? `voice:   ${probes.voice}\n` : "") +
    (probes.dreaming ? `dreaming: ${probes.dreaming}\n` : "");

  // Release ring this HOST follows (#432). Host-level, not per-persona: every
  // persona on a box runs the same binary, so one line, no repetition.
  const channelLine = `channel: ${ctx.config?.updateChannel ?? DEFAULT_UPDATE_CHANNEL}\n`;

  // Who else is running in this process (phantombot#439). The point is the
  // "who is in the preview cohort?" question: from any one persona's chat you
  // can see the whole set the daemon started, which persona is the default
  // (the one that owns /update and /restart), and which is answering here.
  const personaLine = formatPersonaRoster(ctx);

  return {
    reply:
      `phantom: ${ctx.persona} (pid ${process.pid}, v${VERSION})\n` +
      npubLine +
      channelLine +
      personaLine +
      `harness: ${primary}\n` +
      `chain:   ${chain}\n` +
      modelsLine +
      `uptime:  ${formatElapsedSeconds(uptimeS)}\n` +
      `context: ~${pct}% (≈${approxTokens.toLocaleString()} / ${windowTokens.toLocaleString()} tokens, last ${DEFAULT_HISTORY_LIMIT} turns)\n` +
      probeLines +
      `active:  ${active}` +
      runningLine,
  };
}

/**
 * "personas: robbie* (you), lena, kai" — the personas this process started.
 *
 * `*` marks the host default; "(you)" marks the persona answering. Omitted
 * entirely on a single-persona host, where the line would say nothing the
 * first line of /status has not already said.
 */
function formatPersonaRoster(ctx: SlashCommandContext): string {
  const config = ctx.config;
  if (!config) return "";
  // What the daemon ACTUALLY started, when it told us (phantombot#439). The
  // config-derived list below is a fallback for embedded callers and tests: it
  // can under-report, because a legacy `[channels.telegram.personas.*]` entry
  // and a PhantomChat-only persona both start without appearing in
  // `autostart_personas`.
  const roster = (
    ctx.runningPersonas && ctx.runningPersonas.length > 0
      ? ctx.runningPersonas
      : [config.defaultPersona, ...(config.autostartPersonas ?? [])]
  ).filter((name, i, all) => all.indexOf(name) === i);
  if (roster.length < 2) return "";
  const rendered = roster.map((name) => {
    const marks =
      (name === config.defaultPersona ? "*" : "") +
      (name === ctx.persona ? " (you)" : "");
    return `${name}${marks}`;
  });
  return `personas: ${rendered.join(", ")}  (* = default: owns /update, /restart)\n`;
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
    const chainLines = await formatHarnessChain(ctx.harnesses);
    return {
      reply:
        `current chain (→ = primary):\n${chainLines}\n\n` +
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
 * /model — view, list, and flip the primary harness's model (issue #313).
 *
 * Every write persists to BOTH config.toml and ~/.env (env wins at startup,
 * so a TOML-only write would be silently ignored on wizard-configured
 * installs), syncs the in-memory Config, then restarts — all four harnesses
 * bake their model config at construction, so nothing short of a bounce
 * activates the new model. Same afterSend dance as /restart: the user reads
 * the confirmation first, THEN we go down.
 */
const MODEL_USAGE =
  "usage: /model [list [filter] | <slug> | primary <slug> | coding <slug> | image <slug> | clear]\n" +
  "  /model            — show the primary harness's current model\n" +
  "  /model list       — list models the primary harness can run (pi only)\n" +
  "  /model <slug>     — switch the primary model (restarts phantombot)\n" +
  "  /model coding <slug> / image <slug> — pi capability-routing delegates\n" +
  "  /model clear      — revert codex to its CLI default";

async function handleModel(
  arg: string,
  ctx: SlashCommandContext,
): Promise<SlashCommandResult> {
  const req = parseModelRequest(arg);
  if (req.kind === "usage") return { reply: MODEL_USAGE };

  const primary = ctx.harnesses[0];
  if (!primary) return { reply: "no harnesses configured" };

  if (req.kind === "show") {
    return { reply: formatModelShow(primary.id, primary.modelInfo?.()) };
  }
  if (req.kind === "list") {
    return await handleModelList(req.filter, primary, ctx);
  }

  // set / clear — needs config for the two-store write.
  if (!ctx.config) {
    return {
      reply: "can't change models: channel didn't pass config to the dispatcher",
    };
  }
  // Persona-scoped write: /model must change the models of the persona whose
  // chat this is, not the host's (phantombot#441).
  const result = await applyModelRequest(
    req,
    primary.id,
    ctx.config,
    undefined,
    ctx.persona,
  );
  if (!result.ok) return { reply: result.error };

  log.info("commands: /model applied", {
    chatId: ctx.chatId,
    persona: ctx.persona,
    harness: primary.id,
    request: req,
  });

  const svc = ctx.serviceControl ?? defaultServiceControl();
  const afterSend = async (): Promise<void> => {
    const r = await selfRestart({ serviceControl: svc });
    if (!r.ok) {
      log.error("commands: /model restart failed", {
        chatId: ctx.chatId,
        stderr: r.stderr,
      });
    }
  };
  return { reply: `${result.summary} — restarting…`, afterSend };
}

/**
 * `/model list` — pi is the only harness with a programmatic model catalog
 * (`pi --list-models`, reused from lib/piModels.ts). The others get guidance
 * text: claude is alias-based, codex pins or uses its default.
 */
async function handleModelList(
  filter: string | undefined,
  primary: Harness,
  ctx: SlashCommandContext,
): Promise<SlashCommandResult> {
  switch (primary.id) {
    case "pi": {
      const bin = ctx.config?.harnesses.pi.bin ?? "pi";
      const provider = primary.modelInfo?.().provider;
      let models = await listPiModels(bin);
      if (provider) models = models.filter((m) => m.provider === provider);
      if (filter) {
        const needle = filter.toLowerCase();
        models = models.filter((m) =>
          `${m.provider}/${m.model}`.toLowerCase().includes(needle),
        );
      }
      if (models.length === 0) {
        return {
          reply:
            "no models found" +
            (provider ? ` for provider '${provider}'` : "") +
            " — is the provider keyed? (`pi --list-models` returned nothing)",
        };
      }
      // Cap for phone readability; note the truncation so a missing model
      // sends the user to the filter form rather than to confusion.
      const MAX_ROWS = 25;
      const rows = models
        .slice(0, MAX_ROWS)
        .map((m) => `${m.provider}/${m.model}${m.supportsImages ? " 🖼" : ""}`);
      const truncated =
        models.length > MAX_ROWS
          ? `\n… and ${models.length - MAX_ROWS} more — use /model list <filter> to narrow`
          : "";
      return {
        reply:
          `models (${models.length}${provider ? `, provider: ${provider}` : ""}):\n` +
          rows.join("\n") +
          truncated,
      };
    }
    case "claude":
      return {
        reply:
          "claude models are set by alias: opus, sonnet, haiku. " +
          "use /model <alias> to switch.",
      };
    case "codex":
      return {
        reply:
          "codex picks its default model when unset — there's no catalog to list. " +
          "use /model <model-id> to pin one, or /model clear to reset to default.",
      };
    default:
      return { reply: `/model list isn't supported for '${primary.id}'` };
  }
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
    case "pi":
      return 64_000;
    default:
      return 128_000;
  }
}
