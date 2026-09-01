/**
 * Tell every persona on the host when the shared process is about to bounce,
 * and again when it is back (phantombot#519).
 *
 * `/update` and `/restart` are typed in ONE persona's chat but act on the
 * process that serves ALL of them. Before this module the other personas were
 * simply taken down mid-conversation with no signal — the original excuse for
 * gating lifecycle commands behind `default_persona`. Warning everybody is the
 * honest fix: the problem was never who typed the command, it was that nobody
 * else was told.
 *
 * SCOPE — Telegram only, deliberately. The fan-out sends through Telegram bot
 * tokens; a persona served ONLY over PhantomChat gets no heads-up and no
 * back-online line (it is skipped, and the skip is logged at debug). That is a
 * narrowing, not an oversight: a channel-neutral sender needs a per-persona
 * PhantomChat send path that does not exist yet, and the alternative — holding
 * the fix for the users who ARE affected — is worse. Tracked separately; the
 * planner already takes a persona-keyed account map, which is the seam a
 * second channel plugs into. Nothing here regresses for PhantomChat personas:
 * before this module NOBODY was warned.
 *
 * Two halves, deliberately split:
 *
 *   - `planLifecycleBroadcast` is PURE — facts in (config, roster, origin),
 *     recipients out. Everything worth asserting lives here.
 *   - `sendLifecycleBroadcast` is the applier, and is BEST-EFFORT by
 *     construction: it never throws and never propagates a Telegram failure.
 *     A heads-up that fails to send must not be able to abort the restart the
 *     user asked for.
 *
 * The "we're back" half needs to survive the restart, so the pre-restart step
 * records WHICH personas it warned in a small marker file next to the existing
 * `.pending-update.json`. Startup reads it, tells exactly those personas the
 * process is back, and deletes it. Persona NAMES only — never tokens or chat
 * ids: the accounts are re-resolved from config on the other side, so this
 * file is not a secret and a stale copy cannot leak one.
 *
 * Why not reuse `.pending-update.json`? Because `/restart` writes no such
 * marker (there is no version to confirm) and its personas deserve the same
 * "back online" line. One record covering both commands beats bending the
 * update marker into something it is not.
 */

import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import {
  HttpTelegramTransport,
  type TelegramTransport,
} from "../channels/telegram.ts";
import { type Config, type TelegramAccount, xdgConfigHome } from "../config.ts";
import { log } from "./logger.ts";

/* -------------------------------------------------------------------------- *
 * Planning (pure)
 * -------------------------------------------------------------------------- */

export interface BroadcastRecipient {
  persona: string;
  /** Bot token to send through — this persona's own bot. */
  token: string;
  /** Telegram chat ids to notify (that bot's allow-list). */
  chatIds: number[];
}

/**
 * A persona's REAL Telegram account, as the daemon actually started it.
 * Built in `run.ts` from the resolved listener plan, so it needs no inference:
 * the token is the bot that persona's listener is bound to, and the chat ids
 * are that bot's own allow-list.
 */
export interface LifecycleAccount {
  persona: string;
  token: string;
  chatIds: number[];
}

export interface PlanLifecycleBroadcastInput {
  config: Config;
  /**
   * Authoritative persona -> account map. When present it is the ONLY source
   * of recipients; config is not consulted for ownership at all.
   *
   * This exists because `config` here is whatever layer the CALLER was
   * resolved for. On a non-default listener, `config.channels.telegram` is
   * that caller's own bot while `config.defaultPersona` still names the host
   * default — inferring sibling ownership from one effective config therefore
   * labels a sibling and sends through the caller's token. Only the daemon
   * knows the true mapping, so the daemon passes it down.
   */
  accounts?: LifecycleAccount[];
  /**
   * Personas this daemon actually started, when the caller knows them
   * (`SlashCommandContext.runningPersonas`). Authoritative: reconstructing the
   * roster from config alone misses legacy `[channels.telegram.personas.*]`
   * listeners. Absent → derived from config.
   */
  runningPersonas?: string[];
  /**
   * Persona that issued the command. Excluded — it gets the command's own
   * reply in its own chat and does not need a second copy.
   */
  excludePersona?: string;
  /** Restrict to these personas (the "we're back" half re-notifies exactly
   *  the set that was warned). Undefined = the whole roster. */
  only?: string[];
}

/**
 * Fallback ownership inference, used ONLY when no account map was supplied
 * (embedded callers and tests). Deliberately conservative: it would rather
 * skip a persona than send as the wrong one.
 */
function accountFor(
  config: Config,
  persona: string,
): TelegramAccount | undefined {
  const own = config.channels.telegramPersonas?.[persona];
  if (own) return own;
  // The effective `[channels.telegram]` block belongs to the persona this
  // Config was RESOLVED for — `personaLayer` when set, otherwise the host
  // layer's default persona. Attributing it to `defaultPersona` regardless
  // would label the default persona while sending through a non-default
  // caller's token (kaieriksen on #520).
  const owner = config.personaLayer ?? config.defaultPersona;
  return owner && persona === owner ? config.channels.telegram : undefined;
}

/**
 * Who to tell. Deduped by (token, chatId) so a host where two personas share
 * one bot sends one message, not two.
 */
export function planLifecycleBroadcast(
  input: PlanLifecycleBroadcastInput,
): BroadcastRecipient[] {
  const roster =
    input.runningPersonas && input.runningPersonas.length > 0
      ? input.runningPersonas
      : [
          ...(input.config.defaultPersona ? [input.config.defaultPersona] : []),
          ...(input.config.autostartPersonas ?? []),
          ...Object.keys(input.config.channels.telegramPersonas ?? {}),
        ];

  const only = input.only ? new Set(input.only) : undefined;
  const seen = new Set<string>();
  const out: BroadcastRecipient[] = [];
  const supplied = input.accounts
    ? new Map(input.accounts.map((a) => [a.persona, a]))
    : undefined;

  for (const persona of roster) {
    if (persona === input.excludePersona) continue;
    if (only && !only.has(persona)) continue;
    const mapped = supplied?.get(persona);
    // A supplied map is exhaustive by construction: a persona missing from it
    // has no Telegram listener, and must NOT fall back to guessing at config.
    const account: { token: string; allowedUserIds: number[] } | undefined =
      supplied
        ? mapped && { token: mapped.token, allowedUserIds: mapped.chatIds }
        : accountFor(input.config, persona);
    if (!account) {
      log.debug("lifecycleBroadcast: persona has no Telegram account, skipped", {
        persona,
      });
      continue;
    }
    const chatIds = account.allowedUserIds.filter((id) => {
      const key = `${account.token}:${id}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
    if (chatIds.length === 0) continue;
    out.push({ persona, token: account.token, chatIds });
  }
  return out;
}

/* -------------------------------------------------------------------------- *
 * Messages
 * -------------------------------------------------------------------------- */

/** Heads-up sent to every OTHER persona just before the process goes down. */
export function impendingRestartMessage(
  command: string,
  originPersona: string,
): string {
  return (
    `⏳ Heads-up: ${command} was just run in ${originPersona}'s chat. ` +
    `One phantombot process serves every persona on this host, so I'm going ` +
    `down with it for a moment. I'll say when I'm back.`
  );
}

/** Sent to those same personas once the process is answering again. */
export function backOnlineMessage(command: string, version: string): string {
  return `✅ Back online on v${version} (after ${command}).`;
}

/* -------------------------------------------------------------------------- *
 * Sending (best-effort applier)
 * -------------------------------------------------------------------------- */

export interface SendLifecycleBroadcastInput {
  recipients: BroadcastRecipient[];
  message: string;
  /** Test seam. Production builds an HTTP transport per token. */
  createTransport?: (token: string) => TelegramTransport;
}

/**
 * Fan the message out. Never throws: a heads-up is a courtesy, and a Telegram
 * outage must not be able to block the restart the user asked for.
 */
export async function sendLifecycleBroadcast(
  input: SendLifecycleBroadcastInput,
): Promise<{ sent: number; failed: number }> {
  let sent = 0;
  let failed = 0;
  for (const r of input.recipients) {
    let transport: TelegramTransport;
    try {
      transport =
        input.createTransport?.(r.token) ?? new HttpTelegramTransport(r.token);
    } catch (e) {
      failed += r.chatIds.length;
      log.warn("lifecycleBroadcast: transport construction failed", {
        persona: r.persona,
        error: (e as Error).message,
      });
      continue;
    }
    for (const chatId of r.chatIds) {
      try {
        await transport.sendMessage(String(chatId), input.message);
        sent++;
      } catch (e) {
        failed++;
        log.warn("lifecycleBroadcast: send failed", {
          persona: r.persona,
          chatId,
          error: (e as Error).message,
        });
      }
    }
  }
  return { sent, failed };
}

/* -------------------------------------------------------------------------- *
 * The "we warned these personas" marker
 * -------------------------------------------------------------------------- */

export function pendingLifecyclePath(): string {
  return join(xdgConfigHome(), "phantombot", ".pending-lifecycle.json");
}

/** Older than this and we clear the record without sending: whatever it was
 *  announcing, "back online" is no longer news. */
export const PENDING_LIFECYCLE_MAX_AGE_MS = 60 * 60 * 1000;

export interface PendingLifecycle {
  /** "/update" or "/restart". Rendered in the back-online line. */
  command: string;
  /** Persona that issued it; excluded from the back-online fan-out too. */
  originPersona: string;
  /** Personas actually warned. Names only — accounts are re-resolved. */
  personas: string[];
  writtenAt: string;
}

export async function writePendingLifecycle(
  p: PendingLifecycle,
  path: string = pendingLifecyclePath(),
): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const tmp = `${path}.tmp`;
  await writeFile(tmp, JSON.stringify(p, null, 2), "utf8");
  await rename(tmp, path);
}

export async function readPendingLifecycle(
  path: string = pendingLifecyclePath(),
): Promise<PendingLifecycle | undefined> {
  try {
    const raw = await readFile(path, "utf8");
    const parsed = JSON.parse(raw) as Partial<PendingLifecycle>;
    if (
      typeof parsed.command !== "string" ||
      typeof parsed.originPersona !== "string" ||
      !Array.isArray(parsed.personas) ||
      typeof parsed.writtenAt !== "string"
    ) {
      return undefined;
    }
    return parsed as PendingLifecycle;
  } catch {
    return undefined;
  }
}

export async function clearPendingLifecycle(
  path: string = pendingLifecyclePath(),
): Promise<void> {
  try {
    await unlink(path);
  } catch {
    // Already gone — that's the desired state.
  }
}

/* -------------------------------------------------------------------------- *
 * Compose: startup "we're back"
 * -------------------------------------------------------------------------- */

export interface NotifyLifecycleBackInput {
  config: Config;
  currentVersion: string;
  runningPersonas?: string[];
  accounts?: LifecycleAccount[];
  path?: string;
  now?: Date;
  createTransport?: (token: string) => TelegramTransport;
}

export type NotifyLifecycleBackStatus =
  "no_marker" | "stale" | "no_recipients" | "notified";

/**
 * Startup half of the broadcast: tell the personas we warned that the process
 * is answering again, then delete the record.
 *
 * The record is cleared in EVERY terminal case, including a failed send. A
 * "back online" line that retries on the next restart is noise about an event
 * the user already lived through.
 */
export async function notifyLifecycleBackIfPending(
  input: NotifyLifecycleBackInput,
): Promise<{ status: NotifyLifecycleBackStatus; sent?: number }> {
  const marker = await readPendingLifecycle(input.path);
  if (!marker) return { status: "no_marker" };

  const now = input.now ?? new Date();
  const age = now.getTime() - Date.parse(marker.writtenAt);
  if (!Number.isFinite(age) || age > PENDING_LIFECYCLE_MAX_AGE_MS) {
    await clearPendingLifecycle(input.path);
    return { status: "stale" };
  }

  const recipients = planLifecycleBroadcast({
    config: input.config,
    runningPersonas: input.runningPersonas,
    accounts: input.accounts,
    excludePersona: marker.originPersona,
    only: marker.personas,
  });
  if (recipients.length === 0) {
    await clearPendingLifecycle(input.path);
    return { status: "no_recipients" };
  }

  const { sent } = await sendLifecycleBroadcast({
    recipients,
    message: backOnlineMessage(marker.command, input.currentVersion),
    createTransport: input.createTransport,
  });
  await clearPendingLifecycle(input.path);
  log.info("lifecycleBroadcast: back-online notified", {
    command: marker.command,
    originPersona: marker.originPersona,
    sent,
  });
  return { status: "notified", sent };
}
