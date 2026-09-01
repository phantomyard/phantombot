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
 * SCOPE — channel-neutral as of phantombot#523. Telegram accounts fan out
 * through bot tokens; a persona served ONLY over PhantomChat is warned through
 * its own phantomchat.json identity (nsec + relays + allowlist) via the same
 * one-shot out-of-loop send path `phantombot notify` uses
 * (`channels/phantomchat/oneShotSend.ts`). A persona reachable on BOTH channels
 * is warned on Telegram only — the PhantomChat half exists to close the gap,
 * not to double-notify. PhantomChat recipients are the persona's allowed_npubs
 * hexes (the trusted tier — relay_npubs are never notified); an open/TOFU bot
 * with an EMPTY allowlist has no known contacts and is skipped, exactly like
 * the Telegram skip it replaces. When no account map is supplied (embedded
 * callers), the conservative fallback inference stays Telegram-only —
 * inferring a phantomchat identity from an arbitrary config layer would mean
 * reading persona dirs the caller may not own.
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
import {
  defaultPhantomchatOneShotSend,
  type PhantomchatOneShotSend,
} from "../channels/phantomchat/oneShotSend.ts";
import { type Config, type TelegramAccount, xdgConfigHome } from "../config.ts";
import { log } from "./logger.ts";

/* -------------------------------------------------------------------------- *
 * Planning (pure)
 * -------------------------------------------------------------------------- */

export interface TelegramBroadcastRecipient {
  channel: "telegram";
  persona: string;
  /** Bot token to send through — this persona's own bot. */
  token: string;
  /** Telegram chat ids to notify (that bot's allow-list). */
  chatIds: number[];
}

/** One PhantomChat recipient: DM the persona's allowed owners from its own
 *  identity. Recipients are allowed_npubs hexes — the RELAY tier is never
 *  notified (untrusted by doctrine). */
export interface PhantomchatBroadcastRecipient {
  channel: "phantomchat";
  persona: string;
  /** The persona's own Nostr secret key (from its phantomchat.json). */
  secretKey: Uint8Array;
  /** Relays to publish the gift-wraps on (the persona's configured set). */
  relays: string[];
  /** Allowed-npub hex pubkeys to DM, already deduped by the planner. */
  recipientHexes: string[];
}

export type BroadcastRecipient =
  | TelegramBroadcastRecipient
  | PhantomchatBroadcastRecipient;

/**
 * A persona's REAL Telegram account, as the daemon actually started it.
 * Built in `run.ts` from the resolved listener plan, so it needs no inference:
 * the token is the bot that persona's listener is bound to, and the chat ids
 * are that bot's own allow-list.
 */
export interface TelegramLifecycleAccount {
  /** Omitted = "telegram" (the daemon's historical wiring predates channels). */
  channel?: "telegram";
  persona: string;
  token: string;
  chatIds: number[];
}

/** The persona's phantomchat identity as the daemon resolved it from its
 *  phantomchat.json. Hexes are the trusted allowlist tier only — the relay
 *  tier is NEVER a lifecycle recipient. */
export interface PhantomchatLifecycleAccount {
  channel: "phantomchat";
  persona: string;
  secretKey: Uint8Array;
  relays: string[];
  recipientHexes: string[];
}

export type LifecycleAccount =
  | TelegramLifecycleAccount
  | PhantomchatLifecycleAccount;

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

const isTelegramAccount = (
  a: LifecycleAccount,
): a is TelegramLifecycleAccount => (a.channel ?? "telegram") === "telegram";

const isPhantomchatAccount = (
  a: LifecycleAccount,
): a is PhantomchatLifecycleAccount => a.channel === "phantomchat";

/**
 * Who to tell. Deduped so a host where two personas share one bot sends one
 * Telegram message, not two (by (token, chatId)), and so a repeated hex in one
 * persona's phantomchat allowlist DMs once (by (persona, hex)).
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
  const seenTg = new Set<string>();
  const seenPc = new Set<string>();
  const out: BroadcastRecipient[] = [];
  // Group the supplied accounts by persona: a persona can carry BOTH a
  // telegram and a phantomchat account, and the pick below must be
  // deterministic (Telegram preferred) rather than last-in-list wins.
  const supplied = input.accounts
    ? (() => {
        const m = new Map<string, LifecycleAccount[]>();
        for (const a of input.accounts) {
          const list = m.get(a.persona) ?? [];
          list.push(a);
          m.set(a.persona, list);
        }
        return m;
      })()
    : undefined;

  for (const persona of roster) {
    if (persona === input.excludePersona) continue;
    if (only && !only.has(persona)) continue;
    const mapped = supplied?.get(persona);
    // A supplied map is exhaustive by construction: a persona missing from it
    // has no channel at all, and must NOT fall back to guessing at config.
    // Telegram wins when a persona carries both channels — the PhantomChat
    // half exists to reach phantomchat-ONLY personas (phantombot#523), not
    // to double-notify one reachable on both.
    const tgAccount: { token: string; allowedUserIds: number[] } | undefined =
      supplied
        ? (() => {
            const a = mapped?.find(isTelegramAccount);
            return a && { token: a.token, allowedUserIds: a.chatIds };
          })()
        : accountFor(input.config, persona);
    if (tgAccount) {
      const chatIds = tgAccount.allowedUserIds.filter((id) => {
        const key = `${tgAccount.token}:${id}`;
        if (seenTg.has(key)) return false;
        seenTg.add(key);
        return true;
      });
      // A telegram account claims the persona even when its allowlist is
      // empty — an empty Telegram allowlist and a PhantomChat fallback are
      // both misconfigurations; silent channel-hopping would hide that.
      if (chatIds.length === 0) continue;
      out.push({ channel: "telegram", persona, token: tgAccount.token, chatIds });
      continue;
    }
    // Supplied-only: the fallback inference above is Telegram-shaped, so a
    // phantomchat account is only ever used when the daemon's real listener
    // plan supplied it.
    const pcAccount = supplied ? mapped?.find(isPhantomchatAccount) : undefined;
    if (pcAccount) {
      // Normalized to lowercase: allowedHex is lowercased upstream
      // (personaStore decodes via toLowerCase), but the planner defends
      // against a mixed-case entry turning one owner into two DMs.
      const hexes = pcAccount.recipientHexes
        .map((hex) => hex.toLowerCase())
        .filter((hex) => {
          const key = `${persona}:${hex}`;
          if (seenPc.has(key)) return false;
          seenPc.add(key);
          return true;
        });
      if (hexes.length === 0) continue;
      out.push({
        channel: "phantomchat",
        persona,
        secretKey: pcAccount.secretKey,
        relays: pcAccount.relays,
        recipientHexes: hexes,
      });
      continue;
    }
    log.debug("lifecycleBroadcast: persona has no channel account, skipped", {
      persona,
    });
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
  /** Test seam for the PhantomChat half. Production uses the shared one-shot
   *  pool-per-send primitive (one pool per recipient hex, like `notify`). */
  sendPhantomchat?: PhantomchatOneShotSend;
}

/**
 * Fan the message out. Never throws: a heads-up is a courtesy, and a Telegram
 * outage (or a relay outage) must not be able to block the restart the user
 * asked for. Each recipient is an independent send — one failure is logged and
 * swallowed, never aborting the others.
 */
export async function sendLifecycleBroadcast(
  input: SendLifecycleBroadcastInput,
): Promise<{ sent: number; failed: number }> {
  let sent = 0;
  let failed = 0;
  for (const r of input.recipients) {
    if (r.channel === "phantomchat") {
      const send = input.sendPhantomchat ?? defaultPhantomchatOneShotSend;
      for (const recipientHex of r.recipientHexes) {
        try {
          await send({
            secretKey: r.secretKey,
            relays: r.relays,
            recipientHex,
            text: input.message,
          });
          sent++;
        } catch (e) {
          failed++;
          log.warn("lifecycleBroadcast: phantomchat send failed", {
            persona: r.persona,
            recipient: recipientHex.slice(0, 12) + "…",
            error: (e as Error).message,
          });
        }
      }
      continue;
    }
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
  /** Test seam for the PhantomChat half (see sendLifecycleBroadcast). */
  sendPhantomchat?: PhantomchatOneShotSend;
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
    sendPhantomchat: input.sendPhantomchat,
  });
  await clearPendingLifecycle(input.path);
  log.info("lifecycleBroadcast: back-online notified", {
    command: marker.command,
    originPersona: marker.originPersona,
    sent,
  });
  return { status: "notified", sent };
}
