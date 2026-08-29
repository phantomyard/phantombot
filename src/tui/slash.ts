/**
 * Slash commands on screen 0 (phantombot#480).
 *
 * Telegram, phantomchat and ACP all sit a command dispatcher in FRONT of the
 * harness; the TUI did not, so `/status` typed at the terminal was sent to the
 * model as prompt text and answered with a guess, and the only way to run
 * `/update` on the host you were sitting at was to quit the app and use the
 * shell.
 *
 * Behaviour is NOT reimplemented here. This module is the surface half —
 * which commands the terminal advertises, how a `/…` is told apart from a
 * path, and what the type-ahead offers — and the run itself delegates to the
 * same `handleSlashCommand` the other channels call (see `chatSession.ts`).
 * A command added there appears here automatically, which is the point: three
 * surfaces that drift are worse than one surface that is missing a command.
 *
 * Persona gating comes free with that delegation: `/update` and `/restart` are
 * refused, with a reason, on a non-default persona, because one phantombot
 * process serves every persona on the host.
 */

import { TELEGRAM_BOT_COMMANDS } from "../channels/commands.ts";

export interface TuiCommand {
  name: string;
  description: string;
}

/**
 * What the terminal advertises, in menu order.
 *
 * The full shared set, unlike ACP: this app runs ON the host whose service
 * `/update` and `/restart` act on, so they mean here exactly what they mean on
 * Telegram. `/start` is accepted as an alias for `/help` but not advertised —
 * there is nothing to start in a terminal that is already open.
 */
export const TUI_COMMANDS: TuiCommand[] = TELEGRAM_BOT_COMMANDS.filter(
  (c) => c.command !== "start",
).map((c) => ({ name: c.command, description: c.description }));

const KNOWN = new Set<string>([...TUI_COMMANDS.map((c) => c.name), "start"]);

/**
 * The bare command name if `text` opens with something SHAPED like a command,
 * else undefined.
 *
 * Shape, not membership: `/wat` is a command-shaped miss and gets an in-TUI
 * "unknown command" answer rather than being handed to the model, which is
 * what the issue asks for. A path or a regex is not command-shaped — a head
 * containing a second `/`, a `.` or a `~` (`/usr/bin/env`, `/etc/hosts`,
 * `/^ab+c$/`) is prose about the filesystem and must reach the phantom
 * untouched.
 */
export function commandName(text: string): string | undefined {
  const trimmed = text.trim();
  if (!trimmed.startsWith("/")) return undefined;
  const head = trimmed.split(/\s+/)[0]!.slice(1);
  if (!/^[A-Za-z][A-Za-z0-9_-]*$/.test(head)) return undefined;
  return head.toLowerCase();
}

/** True if the dispatcher owns this text — i.e. it is one of ours. */
export function isKnownCommand(text: string): boolean {
  const name = commandName(text);
  return name !== undefined && KNOWN.has(name);
}

/**
 * Command-shaped but not ours: answered in the app, never sent to the model.
 */
export function isUnknownCommand(text: string): boolean {
  const name = commandName(text);
  return name !== undefined && !KNOWN.has(name);
}

/** The reply for a command-shaped miss. Names the escape hatch. */
export function unknownCommandReply(text: string): string {
  const name = commandName(text) ?? "";
  return (
    `unknown command /${name}. Type /help for the list, or drop the leading ` +
    `slash to send it to the phantom.`
  );
}

/**
 * The type-ahead list for a partially typed command.
 *
 * Only while the input is a lone `/word` with no argument yet: once a space is
 * typed the user is writing arguments, and a menu that stays up is a menu in
 * the way. An empty `/` offers everything.
 */
export function commandHints(input: string): TuiCommand[] {
  const text = input.trimStart();
  if (!text.startsWith("/") || /\s/.test(text)) return [];
  const prefix = text.slice(1).toLowerCase();
  return TUI_COMMANDS.filter((c) => c.name.startsWith(prefix));
}

/**
 * Tab completion: the input with the command completed as far as it can be
 * unambiguously, or unchanged when there is nothing to add.
 *
 * Completes to the longest COMMON prefix of the candidates, the shell
 * convention — with one match that is the whole command (plus a trailing
 * space, since most commands take an argument or end there anyway).
 */
export function completeCommand(input: string): string {
  const hints = commandHints(input);
  if (hints.length === 0) return input;
  if (hints.length === 1) return `/${hints[0]!.name} `;
  let common = hints[0]!.name;
  for (const hint of hints.slice(1)) {
    while (common && !hint.name.startsWith(common)) common = common.slice(0, -1);
  }
  return `/${common}`;
}
