/**
 * phantomchat server loop.
 *
 * The phantomchat analogue of `runTelegramServer`: consume the channel's
 * inbound stream (`channel.listen()`), apply the AUTH GATE, run the
 * channel-agnostic `runTurn`, and stream the reply back as a sequence of
 * NIP-17 bubbles. It runs ALONGSIDE the Telegram listeners (see cli/run.ts).
 *
 * Differences from Telegram, by design:
 *   - Same streaming model as Telegram: the reply is split into markdown-aware
 *     bubbles by the shared StreamSegmenter and progress narration
 *     ("checking your calendar…") is sent as its own bubbles before tool calls
 *     (toolNarration ON), so the user sees live progress instead of one long
 *     wait. Each bubble is its own NIP-17 wrap.
 *   - Slash commands (/stop, /reset, /status, /harness, /coder, /update,
 *     /restart, /help) work via the shared `handleSlashCommand` dispatcher,
 *     handled inline so /stop reaches a turn hung in the per-peer chain.
 *     DM-only (group "/…" lines fall through to a normal turn). No Telegram
 *     `setMyCommands` menu — Nostr has no command-registration API.
 *   - No voice or attachments (groups ARE supported).
 *   - The trust perimeter gates on the CRYPTOGRAPHIC sender (rumor.pubkey,
 *     surfaced as `senderId`), never on the envelope `from` field.
 */

import type { Config } from "../../config.ts";
import { DEFAULT_CHATTINESS, DEFAULT_TELEGRAM_STREAMING } from "../../config.ts";
import type { Harness } from "../../harnesses/types.ts";
import type { WriteSink } from "../../lib/io.ts";
import { log } from "../../lib/logger.ts";
import { resolveNarrationEnabled } from "../../lib/chattiness.ts";
import type { MemoryStore } from "../../memory/store.ts";
import { runTurn } from "../../orchestrator/turn.ts";
import { makeRetriever } from "../../orchestrator/retrieval.ts";
import { makeScreener } from "../../orchestrator/screen.ts";
import { makeTurnIndexer } from "../../orchestrator/turnIndexer.ts";
import {
  type ActiveTurnHandle,
  handleSlashCommand,
} from "../commands.ts";
import { ConversationBacklog } from "../core/backlog.ts";
import {
  TELEGRAM_REPLY_INSTRUCTION,
  VOICE_REPLY_INSTRUCTION,
  voiceUnavailableMessage,
} from "../core/prompts.ts";
import { getPublicKey } from "nostr-tools/pure";
import type { Channel, ChannelMessage } from "../core/types.ts";
import {
  decideGroupReply,
  formatGroupContext,
  GROUP_BUFFER_MAX,
  type GroupChatState,
  matchPersonaNames,
} from "../core/routing.ts";
import {
  hasTextSubstance,
  splitIntoSegments,
  StreamSegmenter,
} from "../streamSegmenter.ts";
import {
  createNarrationController,
  resolveOutgoingSuffix,
  segmenterOptionsFor,
} from "../core/streaming.ts";
import type { ServiceControl } from "../../lib/systemd.ts";
import type { NostrProfileMeta, PhantomchatTransport } from "./transport.ts";
import { sttSupport, synthesize, transcribe, ttsSupported } from "../../lib/audio.ts";
import {
  clearReplyModeOverride,
  DEFAULT_REPLY_MODE_OVERRIDE_TTL_MS,
  getReplyModeOverride,
  normalizeReplyModeRequest,
  type ReplyMode,
  type ReplyModeRequest,
  setReplyModeOverride,
  touchReplyModeOverride,
} from "../../lib/replyMode.ts";
import { DEFAULT_STT_TIMEOUT_MS } from "../../lib/voice.ts";
import { warmSymmetricKeyCache } from "../../lib/nostrCrypto.ts";
import { fetchAndDecryptBlossom } from "./blossomFetch.ts";
import { inboxDir } from "../telegram/parse.ts";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

// Don't download absurdly large attachments. The harness reads from the inbox;
// a multi-hundred-MB blob would blow memory + disk for little benefit.
const MAX_ATTACHMENT_BYTES = 25 * 1024 * 1024;

// Local sleep — spaces out consecutive bubbles so the PWA renders them as a
// readable sequence rather than a single burst (mirrors core/engine.ts).
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Map a mime type to a file extension for the inbox filename (the envelope
// carries no original name). Falls back to the mime subtype, then the kind.
function extForMime(mime: string, kind: string): string {
  const m = ((mime || "").split(";")[0] ?? "").trim().toLowerCase();
  const map: Record<string, string> = {
    "image/jpeg": "jpg",
    "image/png": "png",
    "image/gif": "gif",
    "image/webp": "webp",
    "video/mp4": "mp4",
    "video/webm": "webm",
    "video/quicktime": "mov",
    "audio/ogg": "ogg",
    "audio/mpeg": "mp3",
    "audio/wav": "wav",
    "application/pdf": "pdf",
  };
  if (map[m]) return map[m];
  const sub = m.includes("/") ? m.slice(m.indexOf("/") + 1) : "";
  return /^[a-z0-9]{1,8}$/.test(sub) ? sub : kind === "image" ? "jpg" : kind === "video" ? "mp4" : "bin";
}

// Bound the voice fetch+decrypt+transcribe step. A hung Blossom fetch or STT
// request would otherwise never settle and wedge this peer's serial turn chain
// forever (the Telegram engine guards its STT the same way).
function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return Promise.race([
    p,
    new Promise<T>((_, reject) =>
      setTimeout(() => reject(new Error(`timed out after ${ms}ms`)), ms),
    ),
  ]);
}

export interface RunPhantomchatServerInput {
  config: Config;
  memory: MemoryStore;
  harnesses: Harness[];
  agentDir: string;
  persona: string;
  /**
   * The phantomchat channel to drive. Provided so tests can inject a channel
   * backed by an in-memory pool; production builds it from the resolved
   * identity + transport in cli/run.ts.
   */
  channel: Channel<PhantomchatTransport>;
  /**
   * Decoded allowlist: lowercase 64-char hex pubkeys permitted to talk to the
   * bot. Non-empty = only these are answered. Empty = see `tofu`.
   */
  allowedHex: string[];
  /**
   * OPTIONAL config seed for the group-addressing roster: persona names of other
   * bots that share groups with this one. Normally the roster is derived
   * automatically from group members' kind-0 profiles (any member whose NIP-24
   * `bot` flag is set contributes its display name), so this is only needed as a
   * deterministic override / cold-start seed. Merged with the auto-derived names;
   * this persona's own name is always included.
   */
  groupPersonaNames?: string[];
  /**
   * OPTIONAL config seed for the "ignore other bots" set: hex pubkeys of known
   * sibling bots. Normally a sender is recognised as a bot from its kind-0
   * `bot` flag (see `fetchProfiles`); this just force-marks specific pubkeys as
   * bots even before their profile resolves. A message from a bot is NEVER
   * replied to — in a group OR a 1:1 DM — which kills bot-to-bot cascades
   * (option (a)). Merged with the auto-detected bot set.
   */
  siblingBotHex?: string[];
  /**
   * Resolve kind-0 profiles for a set of lowercased hex pubkeys → metadata. The
   * server uses it to (a) recognise sibling bots via the NIP-24 `bot` flag so it
   * never replies to another bot, and (b) auto-derive the group name-addressing
   * roster from members' display names. Lazily called and cached. Production
   * binds it to `transport.fetchProfiles`; tests inject a stub. Absent → bot
   * detection falls back to the static `siblingBotHex` / `groupPersonaNames`
   * config alone (the pre-auto-resolve behaviour).
   */
  fetchProfiles?: (authors: string[]) => Promise<Map<string, NostrProfileMeta>>;
  /**
   * Trust-on-first-use. Only consulted when `allowedHex` is empty:
   *   - tofu true  → the FIRST sender is trusted, persisted via `persistTrust`,
   *     and the bot locks to it (every later stranger is dropped).
   *   - tofu false → open bot: answer anyone (parallel to Telegram's empty
   *     `allowedUserIds`), with a loud startup warning emitted by the caller.
   */
  tofu?: boolean;
  /**
   * Persist a TOFU-trusted sender (called once, when tofu fires). The caller
   * encodes the hex→npub and writes it into phantomchat.json (clearing tofu).
   * Best-effort: a rejection is logged but the sender is still trusted for the
   * life of this process. Omitted in tests that don't exercise persistence.
   */
  persistTrust?: (senderHex: string) => Promise<void>;
  /**
   * Our secret key. Used to pre-derive symmetric keys for all allowed peers
   * at startup (cache warming), so inbound v2 DMs can be decrypted even
   * though the sender used ephemeral envelope signing.
   */
  secretKey: Uint8Array;
  /** Stop after draining the currently-available messages. For tests. */
  oneShot?: boolean;
  /**
   * ServiceControl override for the `/restart` slash command's afterSend.
   * Production leaves this undefined and `/restart` picks up
   * `defaultServiceControl()`; tests inject a stub so a `bun test` run never
   * invokes the host's real systemctl restart. Mirrors the Telegram engine's
   * input seam.
   */
  serviceControl?: ServiceControl;
  /** Signal to stop the loop cleanly (Ctrl-C / SIGTERM). */
  signal?: AbortSignal;
  out?: WriteSink;
  err?: WriteSink;
}

/**
 * Drive the phantomchat inbound loop until `signal` aborts (or, under
 * `oneShot`, until the stream yields no more immediately-available messages).
 *
 * Concurrency: like Telegram, turns are serialized PER conversation (per peer)
 * so one peer's history can't interleave, while different peers run in
 * parallel. Each turn registers under `activeTurns` so the abort signal can
 * tear it down.
 */
export async function runPhantomchatServer(
  input: RunPhantomchatServerInput,
): Promise<void> {
  const { channel } = input;
  const transport = channel.transport;

  // Decoded allowlist as a set for O(1) membership. Mutable: TOFU adds the
  // first sender at runtime, after which the set is non-empty and locked.
  const allowedSet = new Set(input.allowedHex.map((h) => h.toLowerCase()));
  // TOFU is armed only when we start with an empty allowlist and tofu is on.
  let tofuArmed = allowedSet.size === 0 && input.tofu === true;

  // ===================== GROUP ADDRESSING + BOT DETECTION =====================
  // Mirrors the Telegram engine (core/engine.ts): in a group, every bot
  // receives every human message, but a bot must only SPEAK when addressed by
  // name or when it currently holds the thread; and a bot NEVER replies to
  // another bot (in a group OR a DM), which kills bot-to-bot cascades. The
  // decision is computed purely from the shared human-message stream
  // (decideGroupReply), so every bot converges with no coordination. State is
  // per-group, in-memory.
  const groupChats = new Map<string, GroupChatState>();
  const selfName = input.persona;
  // Our own hex pubkey — excluded from the roster and always treated as a bot
  // (so the bot never replies to its own self-wrapped group echo).
  const ourHex = getPublicKey(input.secretKey).toLowerCase();
  // OPTIONAL config seeds (pre-auto-resolve overrides). The roster always
  // contains our own name; sibling names/hexes are MERGED with what we resolve
  // from members' kind-0 profiles at decision time.
  const configRosterNames = input.groupPersonaNames ?? [];
  const configSiblingHex = new Set(
    (input.siblingBotHex ?? []).map((h) => h.toLowerCase()),
  );

  // ----- kind-0 profile cache (bot detection + name resolution) -----
  // Lazily populated via input.fetchProfiles; bounded refresh so an absent
  // profile (a human with no kind-0) isn't re-fetched on every message.
  const PROFILE_TTL_MS = 5 * 60 * 1000;
  const profileCache = new Map<string, NostrProfileMeta>();
  const profileFetchedAt = new Map<string, number>();
  const profileInFlight = new Map<string, Promise<void>>();

  /** Resolve (and cache) the kind-0 profiles for `hexes`, skipping ourselves and
   *  any pubkey fetched within PROFILE_TTL_MS. Concurrent fetches of the same
   *  author are de-duped. Best-effort — a failed/absent fetch leaves the cache
   *  empty for that author (treated as human/unknown by `isBot`). */
  const ensureProfiles = async (hexes: string[]): Promise<void> => {
    if (!input.fetchProfiles) return;
    const now = Date.now();
    const due = [...new Set(hexes.map((h) => h.toLowerCase()))].filter(
      (h) => h.length > 0 && h !== ourHex &&
        now - (profileFetchedAt.get(h) ?? 0) >= PROFILE_TTL_MS,
    );
    if (due.length === 0) return;
    const toFetch = due.filter((h) => !profileInFlight.has(h));
    if (toFetch.length > 0) {
      const p = (async () => {
        try {
          const got = await input.fetchProfiles!(toFetch);
          const t = Date.now();
          for (const h of toFetch) {
            profileFetchedAt.set(h, t);
            const meta = got.get(h);
            if (meta) profileCache.set(h, meta);
          }
        } catch (e) {
          log.warn("phantomchat: profile fetch failed (non-fatal)", {
            error: (e as Error).message,
          });
        }
      })();
      for (const h of toFetch) profileInFlight.set(h, p);
      void p.finally(() => {
        for (const h of toFetch) {
          if (profileInFlight.get(h) === p) profileInFlight.delete(h);
        }
      });
    }
    await Promise.all(
      due.map((h) => profileInFlight.get(h)).filter((x): x is Promise<void> => !!x),
    );
  };

  /** Is `hex` a bot? True for ourselves, any configured sibling, or any pubkey
   *  whose resolved kind-0 carries the NIP-24 `bot` flag. */
  const isBot = (hex: string): boolean => {
    const h = hex.toLowerCase();
    if (h === ourHex || configSiblingHex.has(h)) return true;
    return profileCache.get(h)?.bot === true;
  };

  /** Build the group name-addressing roster for a message: our own name + any
   *  configured sibling names + the display names of every OTHER member resolved
   *  as a bot. Deduped case-insensitively, order preserved. */
  const buildRoster = (memberHexes: string[]): string[] => {
    const names = [selfName, ...configRosterNames];
    for (const hex of memberHexes) {
      const h = hex.toLowerCase();
      if (h === ourHex) continue;
      const meta = profileCache.get(h);
      if (meta?.bot === true) {
        const n = meta.name || meta.display_name;
        if (n) names.push(n);
      }
    }
    const seen = new Set<string>();
    const out: string[] = [];
    for (const n of names) {
      const k = n.toLowerCase();
      if (n.length === 0 || seen.has(k)) continue;
      seen.add(k);
      out.push(n);
    }
    return out;
  };

  // ===================== CACHE WARMING =====================
  // Warm the profile cache for known peers so a DM partner's bot-status is known
  // before their first message (avoids a cold-start fetch gating the first
  // reply). Fire-and-forget; group members are resolved lazily on first message.
  if (input.fetchProfiles && allowedSet.size > 0) {
    void ensureProfiles([...allowedSet]).catch(() => {});
  }
  // Pre-derive symmetric keys for all allowed peers so inbound v2 DMs
  // (which use ephemeral envelope signing) can be decrypted immediately.
  // Fire-and-forget: keys derived after the first unwrap will be picked up
  // by subsequent unwraps.
  if (allowedSet.size > 0) {
    void warmSymmetricKeyCache(input.secretKey, [...allowedSet]).catch((e) => {
      log.warn("phantomchat: cache warming failed (non-fatal)", {
        error: (e as Error).message,
      });
    });
  }

  const harnesses: Harness[] = [...input.harnesses];

  // Wall-clock when the server came up, for the /status uptime line.
  const serverStartedAt = Date.now();

  // In-flight turns keyed by conversationId (senderHex for a DM, `group:<id>`
  // for a group). A /stop or /reset slash command looks the peer up here and
  // aborts its controller; /status reads startTime + lastProgressNote. Mirrors
  // the Telegram engine's `activeTurns` map.
  const activeTurns = new Map<string, ActiveTurnHandle>();

  // Per-peer promise chain so messages from one peer stay strictly ordered.
  const chains = new Map<string, Promise<void>>();
  const inFlight = new Set<Promise<void>>();
  // Epoch registry backing interrupt / `/stop` backlog flushes (#301). Keyed by
  // conversationId — the SAME key as `activeTurns` and the slash context above,
  // so an interrupt, a `/stop` and a `/status` all address one queue. (The
  // promise chain itself is keyed by senderId; for DMs, where slash commands
  // and interrupts live, the two are identical.)
  const backlog = new ConversationBacklog();

  // ===================== AUTH GATE =====================
  // Gate on the CRYPTOGRAPHIC sender (rumor.pubkey, carried as senderId — the
  // verifying unwrap proved it equals seal.pubkey and is signature-checked).
  // The envelope `from` field is NEVER consulted here: it's attacker-
  // controllable plaintext. A sender not in the allowlist is dropped SILENTLY
  // (info log only) — no reply, so the bot doesn't become an oracle that
  // confirms its own pubkey is live to strangers. Returns false to drop.
  // Factored out so both the regular turn path (`handle`) and the inline slash
  // path (`runSlash`) apply the identical gate.
  const authorize = (msg: ChannelMessage): boolean => {
    const senderHex = msg.senderId;
    const lowerHex = senderHex.toLowerCase();
    if (allowedSet.size > 0) {
      // Locked allowlist (configured, or already claimed by TOFU).
      if (!allowedSet.has(lowerHex)) {
        log.info("phantomchat: dropping message from non-allowed sender", {
          sender: senderHex.slice(0, 12) + "…",
        });
        return false;
      }
    } else if (tofuArmed) {
      // TRUST-ON-FIRST-USE. Claim this sender SYNCHRONOUSLY (before any await)
      // so a near-simultaneous second stranger sees a now-non-empty set and is
      // dropped — JS single-threading makes this block atomic vs other peers.
      tofuArmed = false;
      allowedSet.add(lowerHex);
      // Warm the symmetric key cache for this newly-trusted peer so future
      // inbound v2 DMs can be decrypted without waiting for a send.
      void warmSymmetricKeyCache(input.secretKey, [lowerHex]).catch(() => {});
      log.info("phantomchat: TOFU — trusted first sender and locked", {
        sender: senderHex.slice(0, 12) + "…",
      });
      if (input.persistTrust) {
        // Best-effort durable write; trust already stands in-memory regardless.
        void input.persistTrust(senderHex).catch((e) => {
          log.warn("phantomchat: failed to persist TOFU-trusted npub", {
            error: (e as Error).message,
          });
        });
      }
    }
    // else: empty set + tofu off = open bot — answer anyone (caller warned).
    return true;
  };

  const handle = async (msg: ChannelMessage): Promise<void> => {
    const senderHex = msg.senderId;

    if (!authorize(msg)) return;

    // ===================== PROFILE RESOLUTION + BOT GATE =====================
    // Resolve the kind-0 profiles this decision needs: always the sender (for the
    // global bot-gate just below) and, for a group, every member (to auto-derive
    // the name roster). Lazy + cached, so a warm cache makes this a no-op. The
    // await only populates the cache — the per-group state mutation further down
    // stays a single synchronous (atomic) read-modify-write.
    const memberHexes = msg.groupId ? msg.groupMemberHexes ?? [] : [];
    await ensureProfiles([senderHex, ...memberHexes]);

    // GLOBAL cascade kill (option (a)): a bot NEVER replies to another bot — in a
    // group OR a 1:1 DM. A sender is a bot if its kind-0 carries the NIP-24 `bot`
    // flag (or it's a configured sibling / ourselves). Only humans drive
    // conversation, so a bot's own reply can't trigger another. Drop silently —
    // no receipt, no state change — exactly like a non-allowed sender.
    if (isBot(senderHex)) {
      log.info("phantomchat: ignoring message from a bot", {
        persona: input.persona,
        ...(msg.groupId ? { group: msg.groupId } : {}),
        sender: senderHex.slice(0, 12) + "…",
      });
      return;
    }

    // ===================== GROUP ADDRESSING GATE =====================
    // Only for group messages, and only when this bot shares the group with at
    // least one OTHER bot. Decide — from the shared human message stream —
    // whether THIS bot should reply, mirroring core/engine.ts. Runs BEFORE the
    // (paid) voice/media pipeline so a message aimed at another bot costs no STT.
    // The read-modify-write of the per-group state below is await-free, so it's
    // atomic against other peers' interleaved turns (JS single thread).
    let groupContext: string | undefined;
    if (msg.groupId) {
      // Auto-derived roster: our own name + configured siblings + the display
      // names of every member resolved as a bot. The gate engages ONLY when
      // another bot is actually present — a lone bot in a group answers
      // everything (Telegram single-bot behaviour), so this can't make an
      // existing single-bot deployment go mute.
      const roster = buildRoster(memberHexes);
      const otherBotPresent =
        roster.length > 1 ||
        memberHexes.some((h) => h.toLowerCase() !== ourHex && isBot(h));
      if (otherBotPresent) {
        const state =
          groupChats.get(msg.conversationId) ?? { lastAddressed: [], buffer: [] };
        // Route on the message text. A bare media message (e.g. a group voice
        // note) has empty text, so it continues the current thread rather than
        // re-addressing — same as Telegram routing on text/caption only.
        const matchText = msg.text ?? "";
        const matched = matchPersonaNames(matchText, roster);
        const decision = decideGroupReply({
          self: selfName,
          matched,
          lastAddressed: state.lastAddressed,
        });
        state.lastAddressed = decision.nextLastAddressed;

        // What to keep in the rolling buffer for context catch-up. Text keeps its
        // words; a media message keeps a short label so the thread stays coherent.
        const bufText =
          matchText.trim().length > 0
            ? matchText.trim()
            : msg.media
              ? `[${msg.media.kind}]`
              : "";
        // No usernames on Nostr — label the buffer entry by the short sender hex.
        const fromLabel = senderHex.slice(0, 8) + "…";

        if (!decision.reply) {
          if (bufText.length > 0) {
            state.buffer.push({ from: fromLabel, text: bufText, delivered: false });
          }
          while (state.buffer.length > GROUP_BUFFER_MAX) state.buffer.shift();
          groupChats.set(msg.conversationId, state);
          log.info("phantomchat: group message not for this bot — staying quiet", {
            persona: input.persona,
            group: msg.groupId,
            matched,
            lastAddressed: state.lastAddressed,
          });
          return;
        }

        // We're replying: hand the harness the messages we observed but stayed
        // quiet through as a context preamble, then mark the buffer delivered.
        const undelivered = state.buffer.filter((e) => !e.delivered);
        groupContext = formatGroupContext(undelivered) || undefined;
        for (const e of state.buffer) e.delivered = true;
        if (bufText.length > 0) {
          state.buffer.push({ from: fromLabel, text: bufText, delivered: true });
        }
        while (state.buffer.length > GROUP_BUFFER_MAX) state.buffer.shift();
        groupChats.set(msg.conversationId, state);
      }
    }

    // ===================== DELIVERY RECEIPT =====================
    // The sender just passed the auth gate, so acknowledging receipt to them is
    // safe (we never receipt a dropped stranger — that path returned above). A
    // NIP-17 delivery receipt lights the remote's second tick AND, crucially,
    // tells its always-on retry layer the message landed so it stops re-sending
    // — closing the "first message ghosts, second works" loop. DM only: group
    // delivery is tracked per-member on the client via a separate mechanism.
    // Fire-and-forget BEFORE the (possibly slow) turn so the tick is prompt.
    if (!msg.groupId && msg.messageId) {
      void transport.sendDeliveryReceipt(senderHex, msg.messageId);
    }

    // Route a short user-facing notice to the SAME place a reply would go: into
    // the group when the message arrived via a group (reconstructing the member
    // set exactly like the reply path), else a 1:1 DM. Without this, a group
    // voice/media failure (STT unavailable/failed/errored) would surface
    // privately to the sender instead of in the group conversation.
    const sendNotice = (text: string): Promise<void> => {
      if (msg.groupId) {
        const others = new Set<string>(msg.groupMemberHexes ?? []);
        others.add(senderHex.toLowerCase());
        return transport.sendGroupMessage(msg.groupId, [...others], text);
      }
      return transport.sendMessage(senderHex, text);
    };

    // ===================== VOICE / MEDIA → TEXT =====================
    // A voice note arrives as an encrypted Blossom file (msg.media) with an
    // empty text body. Fetch + AES-256-GCM decrypt + transcribe so the turn
    // reasons over the words — mirroring the Telegram voice→STT path
    // (core/engine.processChatMessage). Done AFTER the auth gate so we never
    // spend a paid STT call (or de-stealth) on a dropped stranger. Other media
    // kinds carry no transcript yet, so the turn sees a short marker.
    let userMessage = msg.text;
    if (msg.media) {
      const m = msg.media;
      if (m.kind === "voice") {
        const stt = sttSupport(input.config);
        if (!stt.ok) {
          log.warn("phantomchat: voice note but STT unavailable", {
            persona: input.persona,
            reason: stt.reason,
          });
          await sendNotice(voiceUnavailableMessage(stt)).catch(() => {});
          return;
        }
        try {
          const r = await withTimeout(
            (async () => {
              const audio = await fetchAndDecryptBlossom(m.url, m.keyHex, m.ivHex, {
                expectedSha256Hex: m.sha256,
                mirrors: m.servers,
                signal: input.signal,
              });
              return transcribe(input.config, audio, m.mimeType);
            })(),
            input.config.voice.sttTimeoutMs ?? DEFAULT_STT_TIMEOUT_MS,
          );
          if (!r.ok) {
            log.error("phantomchat: STT failed", {
              persona: input.persona,
              error: r.error,
            });
            await sendNotice(
              "🎙️ I couldn’t make out that voice note — the audio may be unclear or too quiet. Please try again, or type your message.",
            ).catch(() => {});
            return;
          }
          userMessage = r.text;
          log.info("phantomchat: STT ok", {
            persona: input.persona,
            transcriptChars: r.text.length,
          });
        } catch (e) {
          log.error("phantomchat: voice pipeline error", {
            persona: input.persona,
            error: (e as Error).message,
          });
          await sendNotice(
            "⚠️ Something went wrong processing that voice note. Please try again in a moment, or type your message.",
          ).catch(() => {});
          return;
        }
      } else {
        // image / video / file: fetch + AES-GCM decrypt + save to the per-chat
        // inbox, then hand the harness "[attached: <abs-path>]" so it can read
        // the file — mirrors the Telegram attachment path
        // (core/engine.processChatMessage). The harness decides what to do.
        const caption = msg.text?.trim() ? msg.text + "\n\n" : "";
        if (m.size !== undefined && m.size > MAX_ATTACHMENT_BYTES) {
          log.warn("phantomchat: attachment over cap — not downloading", {
            persona: input.persona,
            kind: m.kind,
            size: m.size,
          });
          userMessage = `${caption}[sent a ${m.kind} (~${Math.round(m.size / 1024 / 1024)} MB) — too large to fetch]`;
        } else {
          const convId = `phantomchat-${msg.groupId ? `group-${msg.groupId}` : senderHex}`;
          try {
            const data = await withTimeout(
              fetchAndDecryptBlossom(m.url, m.keyHex, m.ivHex, {
                expectedSha256Hex: m.sha256,
                mirrors: m.servers,
                signal: input.signal,
              }),
              input.config.voice.sttTimeoutMs ?? DEFAULT_STT_TIMEOUT_MS,
            );
            const dir = inboxDir(convId);
            await mkdir(dir, { recursive: true });
            const path = join(dir, `${m.sha256.slice(0, 16)}.${extForMime(m.mimeType, m.kind)}`);
            await writeFile(path, data);
            log.info("phantomchat: attachment saved", {
              persona: input.persona,
              kind: m.kind,
              path,
              bytes: data.byteLength,
            });
            userMessage = `${caption}[attached: ${path}]`;
          } catch (e) {
            log.error("phantomchat: attachment download failed", {
              persona: input.persona,
              kind: m.kind,
              error: (e as Error).message,
            });
            userMessage = caption
              ? msg.text!
              : `[sent a ${m.kind}, but it couldn’t be downloaded]`;
          }
        }
      }
    }

    // Group catch-up context goes at the very TOP of the turn input so the
    // harness reads the room (messages this bot saw but stayed quiet through)
    // before the specific message it's answering. Mirrors core/engine.ts.
    if (groupContext) {
      userMessage =
        userMessage.length > 0
          ? `${groupContext}\n\n${userMessage}`
          : groupContext;
    }

    // A sender that PASSES the allowlist is a trusted principal — exactly the
    // same trust grant Telegram's allowlisted users get. This selects the
    // trusted SECURITY_PERIMETER prompt block and skips the threat screen.
    //
    // The conversation key threads the turn. A GROUP message is keyed by the
    // group (so HQ has its own memory/turn-ordering thread, distinct from the
    // sender's 1:1 DM with the bot); a plain DM keeps the per-peer key. The
    // channel already set msg.conversationId to `group:<id>` for group messages,
    // so we reuse it — falling back to the sender hex for DMs (whose
    // conversationId equals senderHex).
    const conversationKey = msg.groupId
      ? `phantomchat:group:${msg.groupId}`
      : `phantomchat:${senderHex}`;

    const streaming =
      input.config.telegramStreaming ?? DEFAULT_TELEGRAM_STREAMING;
    const segmenterOptions = segmenterOptionsFor(streaming);
    // Streaming accumulators — mirror core/engine.ts so the PWA gets the same
    // progressive bubbles Telegram does. `streamedReply` is the running sum of
    // text chunks; `consumedReplyChars` is the prefix already delivered as a
    // final bubble OR classified as progress narration and dropped from the
    // answer; the narration controller (core/streaming.ts) coalesces classified
    // narration and flushes it on a clock; `finalSegmenter` is the
    // markdown-aware live splitter.
    let streamedReply = "";
    let consumedReplyChars = 0;
    let finalSegmenter = new StreamSegmenter(segmenterOptions);
    let finalCandidateText = "";
    let finalCandidateSentChars = 0;
    let finalReply: string | undefined;
    let requestedReplyMode: ReplyModeRequest | undefined;
    // FINAL bubbles actually published this turn. Gates the orphaned-sign-off
    // suppression in sendBubble: no final bubble out yet means the fragment IS
    // the reply, so it must still send. Narration is deliberately NOT counted
    // here — see the comment in sendBubble.
    let finalBubblesSent = 0;

    // Reply-modality routing (mirrors core/engine.ts). Default: mirror the
    // input — a voice note in → a voice note back, text in → text out. An
    // override set via `phantombot reply-mode text|voice` (10-min idle TTL,
    // keyed on conversationKey) wins. Voice replies are DM-only: group egress
    // (sendGroupMessage) is text, and TTS must be configured.
    const inputWasVoice = msg.media?.kind === "voice";
    let modalityOverride: ReplyMode | undefined = msg.groupId
      ? undefined
      : await touchReplyModeOverride({
          persona: input.persona,
          conversation: conversationKey,
          ttlMs: DEFAULT_REPLY_MODE_OVERRIDE_TTL_MS,
        });
    const resolveWillReplyWithVoice = (
      override: ReplyMode | undefined,
    ): boolean => {
      if (msg.groupId) return false;
      const wantsVoice =
        override === "voice"
          ? true
          : override === "text"
            ? false
            : inputWasVoice;
      return wantsVoice && ttsSupported(input.config);
    };
    let willReplyWithVoice = resolveWillReplyWithVoice(modalityOverride);
    // Typing indicator. The PWA shows three-dots on each
    // ephemeral kind-20001 event and auto-expires it after ~6s, so we refresh
    // every 2s for the whole turn. A plain interval (rather than per-chunk)
    // keeps the dots alive through long tool-call gaps where runTurn emits no
    // chunks at all. Best-effort: sendTyping never throws (see transport).
    //
    // Both the first tick and the interval are scheduled on the macrotask queue
    // (setTimeout 0 / setInterval) rather than called inline: a typing tick
    // signs a Nostr event (Schnorr), and doing that synchronously here would
    // delay the start of the turn itself. The indicator must never be on the
    // turn's critical path.
    // For a group message the dots must land in the GROUP chat (so the PWA
    // shows "Lena is typing…" in HQ, not in her DM). Reconstruct the broadcast
    // set exactly like the reply path: inbound p-tags ∪ { sender }. For a DM the
    // tick p-tags the sender as before.
    const groupTypingMembers = msg.groupId
      ? (() => {
          const set = new Set<string>(msg.groupMemberHexes ?? []);
          set.add(senderHex.toLowerCase());
          return [...set];
        })()
      : null;
    const sendTypingTick = () =>
      msg.groupId
        ? void transport.sendGroupTyping(msg.groupId, groupTypingMembers!)
        : willReplyWithVoice
          ? void transport.sendRecording(senderHex)
          : void transport.sendTyping(senderHex);
    const firstTypingTick = setTimeout(sendTypingTick, 0);

    // Publish one chat bubble — a progress/narration line or a slice of the
    // final answer — routed to the group broadcast or the 1:1 DM exactly like
    // the final reply path. groupTypingMembers is the same set the reply path
    // broadcasts to (inbound p-tags ∪ { sender }). Best-effort: a failed bubble
    // is logged, not thrown, so one dropped progress line never aborts the turn.
    const sendBubble = async (
      text: string,
      kind: "narration" | "final" = "final",
    ): Promise<void> => {
      if (text.trim().length === 0) return;
      // A bubble with no letters or digits ("⚡", "👍") is a sign-off, not an
      // answer. It reaches here as the streamed leftover: the splitter cut the
      // real bubble at a sentence boundary and PUBLISHED it, so there is
      // nothing left to merge into — suppress it instead. This matters most
      // here: the newest event drives the push notification, so an orphaned
      // emoji becomes a notification reading "max: ⚡" with the real answer
      // buried above it.
      //
      // Gate on FINAL bubbles only. Narration is not an answer, so it must
      // never license suppressing one: if the model's whole reply is "👍",
      // that emoji IS the answer and has to ship even though narration
      // already went out — otherwise the push notification becomes the
      // narration and the confirmation never arrives.
      if (!hasTextSubstance(text) && finalBubblesSent > 0) return;
      try {
        if (msg.groupId) {
          await transport.sendGroupMessage(
            msg.groupId,
            groupTypingMembers!,
            text,
          );
        } else {
          // transport.sendMessage NIP-17-wraps the plaintext to `senderHex`
          // and publishes both wraps. conversationId === recipient hex pubkey.
          await transport.sendMessage(senderHex, text);
        }
        if (kind === "final") finalBubblesSent++;
      } catch (e) {
        log.warn("phantomchat: bubble send failed", {
          error: (e as Error).message,
          sender: senderHex.slice(0, 12) + "…",
        });
      }
    };

    // /chattiness gate: does this conversation want interim progress bubbles?
    // Per-conversation override wins; absent, the config default decides.
    // Suppresses ONLY narration — the final reply is untouched.
    //
    // NOTE(dedup): the shared pieces of this loop (segmenter options, the
    // narration buffer/flush controller, the streamed-suffix reconciliation)
    // live in core/streaming.ts and are used by both this file and
    // src/channels/core/engine.ts. The surrounding orchestration is still
    // mirrored on purpose — the two channels diverge in transport addressing
    // (group vs 1:1 routing) and Telegram's failure-handling; see issue #245
    // (Tier B, not planned).
    const narrationEnabled = await resolveNarrationEnabled({
      persona: input.persona,
      conversation: conversationKey,
      configDefault: input.config.chattiness ?? DEFAULT_CHATTINESS,
    });

    // Coalesce progress narration and flush it on a clock (see core/streaming.ts),
    // not on every tool boundary. Driven by both the typing interval below and
    // the chunk boundaries in the loop. No `suppress` here: unlike Telegram,
    // PhantomChat voice replies are DM-only and gated elsewhere.
    const narration = createNarrationController({
      streaming,
      enabled: narrationEnabled,
      send: (text) => sendBubble(text, "narration"),
    });

    const resetFinalCandidate = (): void => {
      finalSegmenter = new StreamSegmenter(segmenterOptions);
      finalCandidateText = "";
      finalCandidateSentChars = 0;
    };

    // Refresh the typing dots every 2s AND flush any pending narration, so a
    // long tool run (during which runTurn emits no chunks) still surfaces the
    // "working on…" line buffered before the tool started.
    const typingTimer = setInterval(() => {
      sendTypingTick();
      void narration.flush();
    }, 2000);

    // Register this turn so a /stop or /reset slash command can abort it and
    // /status can read its elapsed time + latest progress note. The turn aborts
    // on EITHER the server's shutdown signal OR this per-turn controller (which
    // /stop fires). Keyed by conversationId, exactly the key the slash path
    // looks up.
    const controller = new AbortController();
    const turnHandle: ActiveTurnHandle = {
      controller,
      startTime: Date.now(),
    };
    activeTurns.set(msg.conversationId, turnHandle);
    const turnSignal = input.signal
      ? AbortSignal.any([input.signal, controller.signal])
      : controller.signal;
    try {
      for await (const chunk of runTurn({
        persona: input.persona,
        conversation: conversationKey,
        userMessage,
        agentDir: input.agentDir,
        harnesses,
        memory: input.memory,
        idleTimeoutMs: input.config.harnessIdleTimeoutMs,
        hardTimeoutMs: input.config.harnessHardTimeoutMs,
        signal: turnSignal,
        // The trust grant — see the auth gate above. Always true here because
        // we already dropped non-allowlisted senders.
        trusted: true,
        // Trusted turns never screen, but pass the screener for parity/future
        // open-bot use (empty allowlist → trusted: true still, matching
        // Telegram's "answer anyone" semantics, so the screen is effectively
        // unused; kept for symmetry with the Telegram call site).
        screen: makeScreener(
          input.config,
          input.persona,
          conversationKey,
          harnesses,
          input.memory,
        ),
        retrieve: makeRetriever(
          input.config,
          input.persona,
          input.agentDir,
          conversationKey,
        ),
        indexTurns: makeTurnIndexer(
          input.config,
          input.persona,
          conversationKey,
          input.memory,
        ),
        // Reuse Telegram's short-reply / plan-then-confirm guidance — the user
        // is on a phone-style chat client here too. Stack the voice overlay
        // (short, no-markdown, TTS-friendly) when this reply will be spoken.
        systemPromptSuffix: willReplyWithVoice
          ? `${TELEGRAM_REPLY_INSTRUCTION}\n\n${VOICE_REPLY_INSTRUCTION}`
          : TELEGRAM_REPLY_INSTRUCTION,
        // Pre-tool narration ON for text-out: the user sees streamed bubbles,
        // so a "checking your calendar…" line usefully fills the silence. OFF
        // for voice-out: the reply is synthesized once at the end, so narration
        // would only lengthen the spoken output.
        toolNarration: !willReplyWithVoice,
      })) {
        if (chunk.type === "text") {
          streamedReply += chunk.text;
          // Voice-out: don't stream text bubbles — the whole reply is
          // synthesized once at the end. Just keep accumulating streamedReply.
          if (!willReplyWithVoice) {
            finalCandidateText += chunk.text;
            // Markdown-aware splitter: emit only completed sentence/block
            // boundaries as bubbles; partial text stays buffered until it is.
            const { segments } = finalSegmenter.push(chunk.text);
            for (const segment of segments) {
              await sendBubble(segment);
              consumedReplyChars += segment.length;
              finalCandidateSentChars += segment.length;
              if (streaming.bubbleDelayMs > 0) {
                await sleep(streaming.bubbleDelayMs);
              }
            }
          }
        }
        if (chunk.type === "heartbeat") {
          // Tool completed or model is thinking — a chance to surface narration.
          await narration.flush();
        }
        if (chunk.type === "progress") {
          // Surface the latest progress note on the turn handle so /status can
          // show "running: <tool>" in real time.
          turnHandle.lastProgressNote = chunk.note.slice(0, 500);
          // A tool is about to run. Text emitted since the last boundary that
          // the splitter hasn't already sent as a final bubble is progress
          // narration ("checking your calendar…"): buffer it for the timed
          // flush, then consume it so it is not duplicated in the final answer.
          const unsent = finalCandidateText.slice(finalCandidateSentChars);
          if (unsent.trim().length > 0) narration.append(unsent);
          consumedReplyChars = streamedReply.length;
          resetFinalCandidate();
          await narration.flush();
        }
        if (chunk.type === "done") {
          finalReply = chunk.finalText;
          requestedReplyMode = normalizeReplyModeRequest(chunk.meta?.replyMode);
        }
      }
    } catch (e) {
      log.warn("phantomchat: turn failed", {
        error: (e as Error).message,
        sender: senderHex.slice(0, 12) + "…",
      });
      return;
    } finally {
      // Deregister the turn (only if we're still the registered one — a later
      // turn for this peer could have replaced us).
      if (activeTurns.get(msg.conversationId) === turnHandle) {
        activeTurns.delete(msg.conversationId);
      }
      // Stop the typing refresh whether the turn succeeded, errored, or the
      // early-return above fired, then publish an explicit STOP so the PWA
      // clears the dots AT ONCE instead of waiting out its 6s auto-expiry (the
      // "typing lingers after the answer" fix). Best-effort: never throws.
      clearTimeout(firstTypingTick);
      clearInterval(typingTimer);
      if (msg.groupId) {
        void transport.sendGroupTyping(msg.groupId, groupTypingMembers!, true);
      } else {
        void transport.sendTyping(senderHex, true);
      }
    }

    // After live streaming, send only what the user hasn't seen yet. If the
    // consumed prefix matches the authoritative reply, send just the suffix; if
    // the harness reformatted (prefix mismatch), send the whole thing, accepting
    // some duplication over truncating. Mirrors core/engine.ts. Empty outText is
    // intentional silence — progress/final bubbles already delivered everything,
    // or the reply was genuinely empty (original behaviour: stay silent).
    //
    // sendBubble routes group-broadcast vs 1:1 DM exactly like the old single-
    // shot path did: a group reply is reconstructed from the inbound rumor
    // (inbound p-tags ∪ { sender }) since the bridge holds no group DB, and
    // sendGroupMessage adds our self-wrap and defensively drops our own hex.
    //
    // If the turn was aborted (/stop or /reset), don't emit a trailing partial:
    // the command already sent its own confirmation and any streamed bubbles
    // stand on their own.
    if (controller.signal.aborted) return;
    const fullReply = finalReply ?? streamedReply;
    let outText: string;
    if (fullReply.trim().length === 0) {
      outText = "";
    } else {
      outText = resolveOutgoingSuffix(
        fullReply,
        streamedReply,
        consumedReplyChars,
      );
    }

    // Persist a model-requested reply-mode change (via meta.replyMode) for
    // future turns, mirroring core/engine.ts.
    if (!msg.groupId) {
      if (requestedReplyMode === "default") {
        await clearReplyModeOverride({
          persona: input.persona,
          conversation: conversationKey,
        });
      } else if (requestedReplyMode) {
        await setReplyModeOverride({
          persona: input.persona,
          conversation: conversationKey,
          mode: requestedReplyMode,
        });
      }
      // Re-read the override after the harness finishes so a mid-turn
      // `phantombot reply-mode voice|text` call affects THIS reply too. Never
      // switch INTO voice once text bubbles have already streamed — that would
      // mix wire formats and duplicate content for one answer.
      modalityOverride = await getReplyModeOverride({
        persona: input.persona,
        conversation: conversationKey,
        ttlMs: DEFAULT_REPLY_MODE_OVERRIDE_TTL_MS,
      });
      willReplyWithVoice = resolveWillReplyWithVoice(modalityOverride);
      if (willReplyWithVoice && consumedReplyChars > 0) {
        willReplyWithVoice = false;
      }
    }

    // Voice-out: synthesize the full reply (split into short clips so a long
    // answer doesn't hit the TTS size limit) and send each as a voice note. On
    // any synth failure, fall back to text for the remainder. Text streaming is
    // disabled in voice mode, so there's nothing to dedupe — send fullReply.
    if (willReplyWithVoice && fullReply.trim().length > 0) {
      const voiceSegments = splitIntoSegments(fullReply, {
        maxSentences: streaming.voiceMaxSentences,
        maxChars: streaming.bubbleMaxChars,
      });
      for (const segment of voiceSegments) {
        const r = await synthesize(input.config, segment);
        if (r.ok) {
          try {
            await transport.sendVoice(senderHex, r.audio.data, r.audio.mime);
          } catch (e) {
            log.warn("phantomchat: sendVoice failed; falling back to text", {
              error: (e as Error).message,
            });
            await sendBubble(fullReply);
            break;
          }
        } else {
          log.warn("phantomchat: TTS failed; falling back to text", {
            error: r.error,
          });
          await sendBubble(fullReply);
          break;
        }
      }
      return;
    }

    if (outText.trim().length === 0) return;

    const finalSegments = splitIntoSegments(outText, segmenterOptions);
    for (let i = 0; i < finalSegments.length; i++) {
      await sendBubble(finalSegments[i]!);
      if (i < finalSegments.length - 1 && streaming.bubbleDelayMs > 0) {
        await sleep(streaming.bubbleDelayMs);
      }
    }
  };

  // A DM whose text begins with "/" is a candidate control command. Media
  // messages and group messages never take the slash path (see runSlash).
  const isControlCommand = (msg: ChannelMessage): boolean =>
    !msg.groupId && !msg.media && msg.text.trim().startsWith("/");

  // Slash commands (/stop, /reset, /status, /harness, /coder, /help, …) are
  // handled INLINE — bypassing the per-peer turn chain — so /stop can abort a
  // turn that is currently hung in that chain (a queued /stop would never run
  // until the very turn it is meant to kill had finished). DM-only: group slash
  // semantics (who may /reset the shared thread, /status broadcast noise) are
  // out of scope, so in a group a "/…" line falls through to a normal turn.
  // Unknown commands (handleSlashCommand → null) also fall through to a normal
  // turn, since some personas treat e.g. /remember as plain input.
  const runSlash = async (msg: ChannelMessage): Promise<void> => {
    if (!authorize(msg)) return;
    const senderHex = msg.senderId;
    const result = await handleSlashCommand(msg.text, {
      chatId: msg.conversationId,
      persona: input.persona,
      // Must match handle()'s DM conversationKey EXACTLY so /reset and /coder
      // target the same persisted history. senderId is already lowercase hex
      // (the channel lowercases rumor.pubkey).
      conversation: `phantomchat:${senderHex}`,
      memory: input.memory,
      // Same array runTurn uses, so /harness reordering sticks for next turn.
      harnesses,
      startedAt: serverStartedAt,
      activeTurn: activeTurns.get(msg.conversationId),
      config: input.config,
      serviceControl: input.serviceControl,
      // /stop flushes the same per-conversation backlog an interrupt does.
      flushBacklog: () => backlog.flush(msg.conversationId, "stop"),
      // No @username concept on Nostr, and slash handling is DM-only, so there
      // is nothing to disambiguate — leave botUsername undefined.
    }).catch((e: unknown) => {
      log.warn("phantomchat: slash command failed", {
        error: (e as Error).message,
        sender: senderHex.slice(0, 12) + "…",
      });
      return undefined; // error: drop (don't run a failed command as a turn)
    });

    if (result === undefined) return; // errored — already logged
    if (result === null) {
      // Not a command we own — run it as a normal turn instead.
      enqueue(msg);
      return;
    }
    try {
      await transport.sendMessage(senderHex, result.reply);
      // /update and /restart fire their side effect AFTER the reply lands, so
      // the user sees "restarting…" before the process is SIGTERM'd.
      if (result.afterSend) await result.afterSend();
    } catch (e) {
      log.warn("phantomchat: slash reply send failed", {
        error: (e as Error).message,
        sender: senderHex.slice(0, 12) + "…",
      });
    }
  };

  // Serialize per peer: chain the new work onto that peer's last promise.
  const enqueue = (msg: ChannelMessage): void => {
    const key = msg.senderId;

    // INTERRUPT (#301): a new ordinary message arriving while a turn is running
    // means "stop what you're doing and listen to me." Abort the active turn
    // AND discard everything queued behind it — otherwise the bot grinds
    // through instructions the user has already superseded. Silent by design:
    // only `/stop` tells the user what it threw away. Gated on an active turn
    // so that a burst of messages sent while idle is still answered in full.
    const active = activeTurns.get(msg.conversationId);
    if (active) {
      const dropped = backlog.flush(msg.conversationId, "interrupt");
      log.info("phantomchat: new message — interrupting active turn", {
        sender: msg.senderId.slice(0, 12) + "…",
        elapsedS: ((Date.now() - active.startTime) / 1000).toFixed(1),
        droppedQueued: dropped,
      });
      active.controller.abort("interrupt");
    }

    // Captured synchronously, before the callback is attached — see the
    // Telegram engine for the full rationale.
    const epoch = backlog.enqueue(msg.conversationId);
    const prev = chains.get(key) ?? Promise.resolve();
    const next = prev
      .catch(() => {
        // A failed prior turn must not poison the chain — swallow so the next
        // message for this peer still runs.
      })
      .then(async () => {
        // Superseded while queued — evaporate without running.
        if (!backlog.claim(msg.conversationId, epoch)) return;
        await handle(msg);
      });
    chains.set(key, next);
    inFlight.add(next);
    void next.finally(() => {
      inFlight.delete(next);
      // Drop the chain entry once it's the tail and settled, so the map doesn't
      // grow without bound across many peers.
      if (chains.get(key) === next) chains.delete(key);
    });
  };

  if (!channel.listen) {
    throw new Error("phantomchat channel does not implement listen()");
  }

  // Drive the inbound stream. In production listen() runs until the signal
  // aborts. Under oneShot, tests feed a fixed set of gift-wraps and then abort
  // the signal; listen()'s loop drains its queue and completes, so this
  // for-await ends naturally and we fall through to draining inFlight.
  for await (const msg of channel.listen(input.signal)) {
    if (isControlCommand(msg)) {
      // Handle inline (off the per-peer chain) but still track it in inFlight
      // so oneShot tests and clean shutdown wait for it to settle.
      const p = runSlash(msg);
      inFlight.add(p);
      void p.finally(() => inFlight.delete(p));
    } else {
      enqueue(msg);
    }
  }

  // Drain in-flight turns so callers (and tests) can assert on what was sent
  // without racing the workers.
  await Promise.allSettled([...inFlight]);
}
