/**
 * `phantombot notify` — agent's tool for talking to the user out-of-band.
 *
 * Why this exists: by design, scheduled tasks (`phantombot tick`) don't
 * automatically notify Telegram on every run — the user explicitly asked
 * for silence as default. The harnessed agent calls `phantombot notify`
 * inside its prompt when it decides the user should hear about something.
 *
 * ROUTING: notify BROADCASTS to EVERY authorized recipient on EVERY configured
 * channel for the persona — every Telegram allowed_user_id AND every phantomchat
 * allowed npub. If both channels are configured, every authorized owner gets it
 * on BOTH, so an incident is never missed because one channel is down or one
 * recipient wasn't the "primary". Recipients are deduped (per (bot, chatId) for
 * Telegram, per recipientHex for phantomchat) so a repeated entry gets one send,
 * and delivery is per-recipient with independent error handling — one recipient
 * failing (blocked bot, dead relay) never aborts delivery to the others. This is
 * unconditional; there is no "primary only" mode and no opt-out.
 *
 * --message  → text via sendMessage (both channels)
 * --voice    → synthesized via the configured TTS provider, sent via
 *              sendVoice as an OGG-Opus voice note (TELEGRAM only — Nostr DMs
 *              are text-only, so phantomchat receives the text instead).
 * --persona  → which persona's channels to notify. Selects the persona-bound
 *              Telegram bot (`channels.telegram.personas.<name>`, falling back
 *              to the default bot) AND that persona's `phantomchat.json`.
 *              Omitting it uses the default persona. A `tick`-fired notify has
 *              no inbound context, so this is how it lands in the right place.
 * Both message/voice flags can be combined to send text AND voice.
 */

import { defineCommand } from "citty";

import {
  HttpTelegramTransport,
  type TelegramTransport,
} from "../channels/telegram.ts";
import {
  personaDir,
  type Config,
  type TelegramAccount,
  loadConfig,
} from "../config.ts";
import { loadPhantomchatPersonaConfig } from "../channels/phantomchat/personaStore.ts";
import { synthesize, ttsSupport } from "../lib/audio.ts";
import type { WriteSink } from "../lib/io.ts";
import { log } from "../lib/logger.ts";

/**
 * Send a phantomchat (Nostr NIP-17 DM) text to `recipientHex`. Default builds a
 * one-shot SimplePool transport from the persona's nsec + relays, publishes the
 * gift-wrap, and tears the pool down. Injectable so tests don't open sockets.
 */
export type PhantomchatNotifySend = (args: {
  secretKey: Uint8Array;
  relays: string[];
  recipientHex: string;
  text: string;
}) => Promise<void>;

const defaultPhantomchatSend: PhantomchatNotifySend = async ({
  secretKey,
  relays,
  recipientHex,
  text,
}) => {
  // Lazy import keeps the nostr-tools websocket machinery out of the import
  // graph for Telegram-only notifies.
  const { SimplePool } = await import("nostr-tools/pool");
  const { SimplePoolPhantomchatTransport } = await import(
    "../channels/phantomchat/transport.ts"
  );
  const pool = new SimplePool();
  const transport = new SimplePoolPhantomchatTransport(
    secretKey,
    relays,
    pool as unknown as ConstructorParameters<
      typeof SimplePoolPhantomchatTransport
    >[2],
  );
  try {
    await transport.sendMessage(recipientHex, text);
  } finally {
    transport.close();
  }
};

export interface RunNotifyInput {
  config?: Config;
  message?: string;
  voice?: string;
  /**
   * Which persona's channels to notify. Selects the persona-bound Telegram bot
   * (falling back to the default bot) and that persona's phantomchat.json.
   * When omitted, the default persona is used.
   */
  persona?: string;
  /** Inject for testing. Default: HttpTelegramTransport with the configured token. */
  transport?: TelegramTransport;
  /** Inject for testing. Default: one-shot SimplePool gift-wrap publish. */
  phantomchatSend?: PhantomchatNotifySend;
  out?: WriteSink;
  err?: WriteSink;
}

export async function runNotify(input: RunNotifyInput = {}): Promise<number> {
  const out = input.out ?? process.stdout;
  const err = input.err ?? process.stderr;

  if (!input.message && !input.voice) {
    err.write("nothing to notify — pass --message and/or --voice.\n");
    return 2;
  }

  const config = input.config ?? (await loadConfig());
  const persona = input.persona ?? config.defaultPersona;

  // ── Resolve the configured channels for this persona ──────────────────
  // A channel is a notify target when it has an account/identity AND at least
  // one owner. We BROADCAST to every authorized owner of each, deduped.

  // Telegram: persona-bound bot if present, else the default bot. Fan out to
  // EVERY allowed user id on that bot, deduped per chatId (an id repeated in the
  // allowlist gets one send, not many).
  const tg: TelegramAccount | undefined =
    config.channels.telegramPersonas?.[persona] ?? config.channels.telegram;
  const tgChatIds =
    tg && tg.allowedUserIds.length > 0
      ? [...new Set(tg.allowedUserIds.map((id) => String(id)))]
      : [];
  const tgTarget =
    tg && tgChatIds.length > 0 ? { account: tg, chatIds: tgChatIds } : undefined;

  // Phantomchat: the persona's own phantomchat.json (identity + allowlist). Fan
  // out to EVERY allowed npub, deduped per recipientHex.
  let pcTarget:
    | { secretKey: Uint8Array; relays: string[]; recipientHexes: string[] }
    | undefined;
  try {
    const pc = loadPhantomchatPersonaConfig(personaDir(config, persona));
    const hexes = pc ? [...new Set(pc.allowedHex)] : [];
    if (pc && hexes.length > 0) {
      pcTarget = {
        secretKey: pc.identity.secretKey,
        relays: pc.relays,
        recipientHexes: hexes,
      };
    }
  } catch (e) {
    log.warn("notify: failed to load phantomchat config", {
      persona,
      error: (e as Error).message,
    });
  }

  if (!tgTarget && !pcTarget) {
    err.write(
      `no notify channel configured for persona '${persona}' — set up Telegram (\`phantombot telegram\`) and/or phantomchat (\`phantombot phantomchat\`) with at least one allowed owner first.\n`,
    );
    return 2;
  }

  // ── Telegram send (every authorized owner) ────────────────────────────
  let textSent = 0;
  let voiceSent = 0;
  if (tgTarget) {
    const transport =
      input.transport ?? new HttpTelegramTransport(tgTarget.account.token);

    // Pre-synthesize once if voice was requested. Telegram-only — Nostr DMs
    // carry no audio. Doing it before the text send means a provider misconfig
    // fails before we half-notify.
    let voiceAudio: { data: Buffer; mime: string } | undefined;
    if (input.voice) {
      const support = ttsSupport(config);
      if (!support.ok) {
        if (!input.message) {
          err.write(
            `voice notification not possible: ${describeAudioFailure(support)}\n`,
          );
        } else {
          err.write(
            `voice synthesis unavailable (${describeAudioFailure(support)}); sending text only.\n`,
          );
        }
      } else {
        const r = await synthesize(config, input.voice);
        if (!r.ok) {
          err.write(
            `voice synthesis failed (${r.error}); sending text only.\n`,
          );
        } else {
          voiceAudio = r.audio;
        }
      }
    }

    // Fan out to every authorized chatId. Per-recipient try/catch: one blocked
    // or dead recipient is logged and swallowed, never aborting the rest.
    for (const chatId of tgTarget.chatIds) {
      try {
        if (input.message) {
          await transport.sendMessage(chatId, input.message);
          textSent++;
        }
        if (voiceAudio) {
          await transport.sendVoice(chatId, voiceAudio.data, voiceAudio.mime);
          voiceSent++;
        }
      } catch (e) {
        log.warn("notify: telegram send failed", {
          chatId,
          error: (e as Error).message,
        });
      }
    }
  }

  // ── Phantomchat send (every authorized owner) ─────────────────────────
  // Nostr DMs are text-only: send --message, or fall back to the --voice text
  // so a voice-only notify still reaches every owner here as text. Per-recipient
  // try/catch so one dead relay/recipient never aborts delivery to the rest.
  let pcSent = 0;
  if (pcTarget) {
    const text = input.message ?? input.voice;
    if (text) {
      const send = input.phantomchatSend ?? defaultPhantomchatSend;
      for (const recipientHex of pcTarget.recipientHexes) {
        try {
          await send({
            secretKey: pcTarget.secretKey,
            relays: pcTarget.relays,
            recipientHex,
            text,
          });
          pcSent++;
        } catch (e) {
          log.warn("notify: phantomchat send failed", {
            recipient: recipientHex.slice(0, 12) + "…",
            error: (e as Error).message,
          });
        }
      }
    }
  }

  const channels = [
    tgTarget ? "telegram" : undefined,
    pcTarget ? "phantomchat" : undefined,
  ].filter(Boolean);
  out.write(
    `notify: persona=${persona} channels=[${channels.join(", ")}] telegram(text=${textSent} voice=${voiceSent}) phantomchat(text=${pcSent})\n`,
  );
  // At least one channel was configured (we'd have returned 2 otherwise). Exit 0
  // when something actually went out; exit 1 when nothing could be delivered —
  // e.g. a voice-only notify whose synthesis failed with no text fallback, or
  // every configured channel's send erroring.
  return textSent + voiceSent + pcSent > 0 ? 0 : 1;
}

function describeAudioFailure(
  s: Extract<ReturnType<typeof ttsSupport>, { ok: false }>,
): string {
  if (s.reason === "provider_none") return "no TTS provider configured";
  if (s.reason === "provider_no_stt") {
    // sttSupport returns this for azure_edge; ttsSupport never does for
    // the same provider, but TS still wants the branch covered.
    return `${s.provider} has no STT (shouldn't happen on tts path)`;
  }
  return `key missing for ${s.provider} (env var ${s.envVar})`;
}

export default defineCommand({
  meta: {
    name: "notify",
    description:
      "Surface a message to every authorized recipient on every configured channel (all Telegram allowed ids + all phantomchat allowed npubs, deduped). The harnessed agent calls this when a scheduled task or background work needs to reach the user.",
  },
  args: {
    message: {
      type: "string",
      description: "Text to send via sendMessage.",
    },
    voice: {
      type: "string",
      description:
        "Text to synthesize via the configured TTS provider and send as a voice note.",
    },
    persona: {
      type: "string",
      description:
        "Which persona's channels to notify (its Telegram bot + phantomchat identity). Defaults to the default persona. Reaches every authorized owner of each configured channel.",
    },
  },
  async run({ args }) {
    process.exitCode = await runNotify({
      message: args.message as string | undefined,
      voice: args.voice as string | undefined,
      persona: args.persona as string | undefined,
    });
  },
});
