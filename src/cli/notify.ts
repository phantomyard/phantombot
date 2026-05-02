/**
 * `phantombot notify` — agent's tool for talking to the user out-of-band.
 *
 * Why this exists: by design, scheduled tasks (`phantombot tick`) don't
 * automatically notify Telegram on every run — the user explicitly asked
 * for silence as default. The harnessed agent calls `phantombot notify`
 * inside its prompt when it decides the user should hear about something.
 *
 * Sends to every chat in `channels.telegram.allowed_user_ids`. For the
 * common single-allowlisted-user case that's exactly one recipient.
 * For multi-recipient lists, we fan out — a follow-up can add
 * `--to <userId>` if per-recipient routing matters.
 *
 * --message  → text via sendMessage
 * --voice    → synthesized via the configured TTS provider, sent via
 *              sendVoice as an OGG-Opus voice note. Same provider stack
 *              PR #30 added; same key-discovery rules.
 * Both flags can be combined to send text AND voice (two API calls).
 */

import { defineCommand } from "citty";

import {
  HttpTelegramTransport,
  type TelegramTransport,
} from "../channels/telegram.ts";
import { type Config, loadConfig } from "../config.ts";
import { synthesize, ttsSupport } from "../lib/audio.ts";
import type { WriteSink } from "../lib/io.ts";
import { log } from "../lib/logger.ts";

export interface RunNotifyInput {
  config?: Config;
  message?: string;
  voice?: string;
  /** Inject for testing. Default: HttpTelegramTransport with the configured token. */
  transport?: TelegramTransport;
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
  const tg = config.channels.telegram;
  if (!tg) {
    err.write(
      "telegram is not configured — run `phantombot telegram` first.\n",
    );
    return 2;
  }
  if (tg.allowedUserIds.length === 0) {
    err.write(
      "channels.telegram.allowed_user_ids is empty — refusing to broadcast. Add at least one userId via `phantombot telegram`.\n",
    );
    return 2;
  }

  const transport = input.transport ?? new HttpTelegramTransport(tg.token);

  // Pre-synthesize once if voice was requested. Doing this before the
  // text send means a voice-provider misconfig fails the whole call
  // before we've half-notified the user.
  let voiceAudio: { data: Buffer; mime: string } | undefined;
  if (input.voice) {
    const support = ttsSupport(config);
    if (!support.ok) {
      // Fall back to text-only if message was also supplied; otherwise fail.
      if (!input.message) {
        err.write(
          `voice notification not possible: ${describeAudioFailure(support)}\n`,
        );
        return 1;
      }
      err.write(
        `voice synthesis unavailable (${describeAudioFailure(support)}); sending text only.\n`,
      );
    } else {
      const r = await synthesize(config, input.voice);
      if (!r.ok) {
        if (!input.message) {
          err.write(`voice synthesis failed: ${r.error}\n`);
          return 1;
        }
        err.write(`voice synthesis failed (${r.error}); sending text only.\n`);
      } else {
        voiceAudio = r.audio;
      }
    }
  }

  let textSent = 0;
  let voiceSent = 0;
  for (const chatId of tg.allowedUserIds) {
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
      log.warn("notify: send failed", {
        chatId,
        error: (e as Error).message,
      });
    }
  }

  out.write(
    `notify: sent text=${textSent} voice=${voiceSent} to ${tg.allowedUserIds.length} recipients\n`,
  );
  return 0;
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
      "Send a Telegram message to all allowed users. The harnessed agent calls this when a scheduled task or background work needs to surface to the user.",
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
  },
  async run({ args }) {
    process.exitCode = await runNotify({
      message: args.message as string | undefined,
      voice: args.voice as string | undefined,
    });
  },
});
