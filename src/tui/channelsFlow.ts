/**
 * The Telegram channel setup, as a sequence of SCREEN questions.
 *
 * `phantombot telegram` asks the same questions with @clack, which meant the
 * Channels row left the app: no header, no footer, no `esc`. This module keeps
 * the CLI's write path (`applyTelegramConfig`, `telegramGetMe`,
 * `resolvePersonaWriteTarget`) and replaces only the asking, so the two cannot
 * drift apart.
 *
 * Every question is injected rather than imported, so the flow is testable
 * without a terminal — and so cancelling is a real answer at every step:
 * `undefined` from any question leaves the config untouched.
 */

import { parseAllowedUserIds } from "../cli/telegram.ts";
import { parseAllowedNpubs } from "../cli/phantomchat.ts";

export interface ChannelsQuestions {
  choose(input: {
    title: string;
    options: readonly { value: string; label: string; hint?: string }[];
  }): Promise<string | undefined>;
  value(input: {
    title: string;
    hint?: string;
    masked?: boolean;
    initial?: string;
  }): Promise<string | undefined>;
  confirm(input: {
    title: string;
    consequence: {
      summary: string;
      detail: string;
      longRunning: boolean;
      restarts: boolean;
    };
    danger?: boolean;
  }): Promise<boolean>;
}

export interface ChannelsExisting {
  token: string;
  allowedUserIds: readonly number[];
}

export interface ChannelsDeps {
  /** The Telegram block already live for this persona, if any. */
  existing?: ChannelsExisting;
  /** `getMe` — proves the token before it is written. */
  validateToken(token: string): Promise<
    { ok: true; username: string; id: number } | { ok: false; error: string }
  >;
  /** Writes the config block. Same function the CLI calls. */
  save(inputs: { token: string; allowedUserIds: number[] }): Promise<void>;
  /** Where the write lands — shown back so the user knows which file moved. */
  targetPath: string;
}

const TOKEN_RE = /^\d+:[A-Za-z0-9_-]{30,}$/;

const HELP =
  "from @BotFather: /newbot, then copy the HTTP API token";

/**
 * Run the flow. Returns the line to show in the notice bar — every exit,
 * including a cancel, names what happened to the config.
 */
/** What the persona's phantomchat identity and allowlist look like now. */
export interface PhantomchatExisting {
  npub: string;
  allowedNpubs: readonly string[];
}

export interface PhantomchatDeps {
  /**
   * Reads the persona's identity, MINTING one only if it has none. Adoption
   * order matters and belongs to the CLI helper, not here: identity.json also
   * derives the vault key, so generating a second nsec would orphan every
   * secret already encrypted under the first.
   */
  identity(): Promise<PhantomchatExisting>;
  save(inputs: { allowedNpubs: string[] }): Promise<string>;
}

/**
 * PhantomChat (Nostr DMs) for one persona.
 *
 * Only one question is ever asked — the allowlist — because everything else
 * (`the keypair, the relays`) is either already on disk or fetched from the
 * canonical relay list. An empty answer is not a cancel: it arms
 * trust-on-first-use, which is the documented way to pair a fresh phantom.
 */
export async function configurePhantomchat(
  persona: string,
  q: ChannelsQuestions,
  deps: PhantomchatDeps,
): Promise<string> {
  const existing = await deps.identity();
  const raw = await q.value({
    title: `Allowed npubs for ${persona}`,
    hint: `${persona} is ${existing.npub} — paste YOUR npub from the PhantomChat app; empty arms trust-on-first-use`,
    initial: existing.allowedNpubs.join(", "),
  });
  if (raw === undefined) return "phantomchat unchanged";
  const allowedNpubs = parseAllowedNpubs(raw);
  const savedPath = await deps.save({ allowedNpubs });
  return allowedNpubs.length === 0
    ? `phantomchat saved to ${savedPath} — trust-on-first-use armed`
    : `phantomchat saved to ${savedPath}`;
}

/**
 * Ask whether to touch a channel at all.
 *
 * Both channels are OPTIONAL, and a phantom that already has one configured
 * must not be walked back through its setup to get past it. So each channel is
 * gated on an explicit choice whose default is to leave it alone.
 */
export async function offerChannel(
  q: ChannelsQuestions,
  input: { title: string; configured: string | undefined },
): Promise<boolean> {
  const answer = await q.choose({
    title: input.title,
    options: [
      input.configured
        ? { value: "skip", label: "Keep as it is", hint: input.configured }
        : { value: "skip", label: "Skip", hint: "optional — set it up later" },
      {
        value: "go",
        label: input.configured ? "Change it" : "Set it up now",
      },
    ],
  });
  return answer === "go";
}

export async function configureTelegram(
  persona: string,
  q: ChannelsQuestions,
  deps: ChannelsDeps,
): Promise<string> {
  const { existing } = deps;

  let token = existing?.token;
  if (existing) {
    const action = await q.choose({
      title: `Telegram for ${persona}`,
      options: [
        { value: "users", label: "Allowed users", hint: "keep the token" },
        { value: "replace", label: "Replace token", hint: "and allowed users" },
      ],
    });
    if (!action) return "channels unchanged";
    if (action === "replace") token = undefined;
  }

  if (!token) {
    const typed = await q.value({
      title: `Bot token for ${persona}`,
      hint: HELP,
      masked: true,
    });
    if (!typed) return "channels unchanged";
    if (!TOKEN_RE.test(typed)) return "channels unchanged — not a bot token";
    const me = await deps.validateToken(typed);
    // A token is only accepted once Telegram itself has answered to it:
    // writing an unvalidated one leaves a persona that looks configured and
    // silently never receives a message.
    if (!me.ok) return `channels unchanged — token rejected: ${me.error}`;
    token = typed;
  }

  const raw = await q.value({
    title: "Allowed Telegram user IDs",
    hint: "comma-separated; the first ID receives incident alerts",
    initial: existing?.allowedUserIds.join(", ") ?? "",
  });
  if (raw === undefined) return "channels unchanged";
  const allowedUserIds = parseAllowedUserIds(raw);

  if (allowedUserIds.length === 0) {
    const yes = await q.confirm({
      title: "Answer anyone who messages this bot?",
      consequence: {
        summary: "removes the allowlist",
        detail:
          "With no allowed user IDs, every Telegram account that finds the bot is answered as a trusted principal.",
        longRunning: false,
        restarts: true,
      },
      danger: true,
    });
    if (!yes) return "channels unchanged";
  }

  await deps.save({ token, allowedUserIds });
  return `channels saved to ${deps.targetPath}${
    allowedUserIds.length === 0 ? " — allowlist OPEN" : ""
  }`;
}
