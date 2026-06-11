/**
 * Principal-conversation + notify routing, made CHANNEL-AWARE off
 * `default_channel`.
 *
 * Shared by the screener (orchestrator/screen.ts) and the notify path
 * (cli/notify.ts) so both agree EXACTLY on:
 *
 *   1. which conversation key(s) identify the principal for a persona, and
 *   2. which channel + persona-bound account an unsolicited send routes through.
 *
 * The #172 invariant this protects: the security-hold grounding pair (the held
 * payload + judge text) MUST land in the SAME conversation the principal's
 * approve/deny reply arrives in — otherwise the reply has no referent. That
 * conversation is the principal's conversation on the DEFAULT channel:
 *
 *   - default_channel = telegram → `telegram:<numericUserId>` (unchanged from
 *     #172).
 *   - default_channel = matrix   → `matrix:<mxid>`. Matrix inbound DMs from a
 *     principal are keyed SENDER-SCOPED (`matrix:<senderId>`, the MXID — see
 *     channels/matrix/server.ts), the direct analogue of Telegram's
 *     `telegram:<userId>`, so the grounding write and the principal's reply
 *     share one conversation key. (Group rooms aren't principal conversations;
 *     proactive/held traffic is a 1:1 owner channel.)
 *
 * Account selection mirrors the existing rule: the persona-bound account when
 * `channels.<chan>.personas.<persona>` is configured, else the default
 * account. Returning the persona NAME (not the account) keeps it aligned with
 * runNotify's own account resolution.
 */

import {
  type Config,
  type DefaultChannel,
  resolveDefaultChannel,
} from "../config.ts";

/**
 * The principal conversation key(s) for `persona` on the DEFAULT channel. The
 * grounding write targets these; empty when the default channel isn't
 * configured / has an empty allowlist (grounding becomes a no-op, fail-safe).
 */
export function principalConversations(config: Config, persona: string): string[] {
  const channel = resolveDefaultChannel(config);
  if (channel === "matrix") {
    const account =
      config.channels.matrixPersonas?.[persona] ?? config.channels.matrix;
    if (!account) return [];
    // MXIDs are already strings; key sender-scoped so the held episode lands
    // in the same `matrix:<mxid>` conversation the principal's DM reply uses.
    return account.allowedUserIds.map((id) => `matrix:${id}`);
  }
  // default_channel = telegram (also the back-compat default).
  const account =
    config.channels.telegramPersonas?.[persona] ?? config.channels.telegram;
  if (!account) return [];
  return account.allowedUserIds.map((id) => `telegram:${id}`);
}

/**
 * Which persona name to route the escalation notify through on the default
 * channel — the persona's own bot when configured, else undefined (default
 * bot). Mirrors principalConversations' account selection so the notify and
 * the grounding write target the same account.
 */
export function resolveNotifyPersona(
  config: Config,
  persona: string,
): string | undefined {
  const channel = resolveDefaultChannel(config);
  const personas =
    channel === "matrix"
      ? config.channels.matrixPersonas
      : config.channels.telegramPersonas;
  return personas?.[persona] !== undefined ? persona : undefined;
}

/** The default channel an unsolicited send routes through. */
export function notifyChannel(config: Config): DefaultChannel {
  return resolveDefaultChannel(config);
}
