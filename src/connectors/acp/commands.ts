/**
 * Slash commands over ACP.
 *
 * `/stop` and `/reset` did not work in Zed / VS Code / JetBrains at all. The
 * dispatcher in `channels/commands.ts` was only ever wired into the Telegram
 * engine, so over ACP a typed `/stop` was delivered to the harness as ordinary
 * prompt text — the model would cheerfully *talk about* stopping while the turn
 * it was supposed to kill ran on. We also never advertised any commands, so the
 * editor's `/`-menu was empty and there was no hint they were meant to exist.
 *
 * This module is the ACP half: which commands we own on this surface, how the
 * editor is told about them, and the parse. The *behaviour* is not
 * reimplemented — it delegates to the same `handleSlashCommand` Telegram uses,
 * so `/stop` aborts and `/reset` clears exactly as it does there.
 *
 * OUT-OF-BAND IS THE WHOLE POINT: the server dispatches these ahead of the
 * serial request queue (see server.ts). `/stop` exists precisely to kill the
 * long-running prompt that is *currently blocking that queue* — queueing it
 * behind that prompt would mean it only ran once the turn it was meant to
 * cancel had already finished. Same deadlock `session/cancel` already avoids.
 */

import {
  handleSlashCommand,
  type SlashCommandContext,
  type SlashCommandResult,
} from "../../channels/commands.ts";
import type { AcpAvailableCommand } from "./protocol.ts";

/**
 * The commands phantombot offers over ACP, in menu order.
 *
 * DELIBERATELY NOT the full Telegram set. `/update` and `/restart` are omitted:
 * they swap the phantombot binary and bounce the service, and this process is a
 * subprocess whose lifecycle the EDITOR owns. Restarting the daemon from inside
 * an editor thread means the thread's agent is no longer the thing that got
 * restarted — a confusing half-action at best. Those stay on Telegram, where
 * the service and the channel are the same process. (They still fall through to
 * the model here, same as any other unrecognized slash text, so nothing silently
 * disappears.)
 */
export const ACP_AVAILABLE_COMMANDS: AcpAvailableCommand[] = [
  { name: "stop", description: "Abort the turn that's currently running" },
  { name: "reset", description: "Clear this thread's history" },
  { name: "status", description: "Show harness, uptime, context usage" },
  {
    name: "harness",
    description: "List or switch the active harness",
    input: { hint: "<harness id> — omit to list" },
  },
  { name: "help", description: "Show the available commands" },
];

/**
 * Commands this connector handles itself. `/start` is accepted as an alias for
 * `/help` (it is what Telegram users' fingers type) but is not advertised — an
 * editor thread has nothing to "start".
 */
const OWNED = new Set<string>([
  ...ACP_AVAILABLE_COMMANDS.map((c) => `/${c.name}`),
  "/start",
]);

/**
 * The command name if `text` is a slash command we own on this surface, else
 * undefined — in which case the caller MUST fall through to the model.
 *
 * Falling through matters: personas define their own conversational slash-isms
 * (`/remember …`), and a prompt that merely *starts* with a slash (a path, a
 * regex, "/usr/bin/env is on PATH?") must not be swallowed as a command.
 *
 * Exported for testing the parse in isolation.
 */
export function acpCommandName(text: string): string | undefined {
  const trimmed = text.trim();
  if (!trimmed.startsWith("/")) return undefined;
  // Strip any `@bot` suffix so `/stop@phantom` matches too — harmless here, and
  // it keeps the parse identical to the Telegram one.
  const head = trimmed.split(/\s+/)[0]!.split("@")[0]!.toLowerCase();
  return OWNED.has(head) ? head : undefined;
}

/** True if this prompt text is a command this connector should intercept. */
export function isAcpCommand(text: string): boolean {
  return acpCommandName(text) !== undefined;
}

/**
 * Run an ACP slash command. Returns null if we don't own it (caller falls
 * through to the model).
 *
 * The allowlist is enforced HERE, before delegation, so the ACP surface can
 * never accidentally inherit a new Telegram-only command (a future `/wipe`,
 * say) just because it was added to the shared dispatcher.
 */
export async function handleAcpCommand(
  text: string,
  ctx: SlashCommandContext,
): Promise<SlashCommandResult | null> {
  if (!isAcpCommand(text)) return null;
  return await handleSlashCommand(text, ctx);
}
