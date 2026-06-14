/**
 * phantomchat server loop.
 *
 * The phantomchat analogue of `runTelegramServer`: consume the channel's
 * inbound stream (`channel.listen()`), apply the AUTH GATE, run the
 * channel-agnostic `runTurn`, accumulate the full reply, and publish it back
 * as a NIP-17 DM. It runs ALONGSIDE the Telegram listeners (see cli/run.ts).
 *
 * Differences from Telegram, by design:
 *   - No streaming / segmenting. Nostr DMs are single messages, so we
 *     accumulate the whole reply and send it once (toolNarration OFF).
 *   - No slash commands, groups, voice, or attachments.
 *   - The trust perimeter gates on the CRYPTOGRAPHIC sender (rumor.pubkey,
 *     surfaced as `senderId`), never on the envelope `from` field.
 */

import type { Config } from "../../config.ts";
import type { Harness } from "../../harnesses/types.ts";
import type { WriteSink } from "../../lib/io.ts";
import { log } from "../../lib/logger.ts";
import type { MemoryStore } from "../../memory/store.ts";
import { runTurn } from "../../orchestrator/turn.ts";
import { makeRetriever } from "../../orchestrator/retrieval.ts";
import { makeScreener } from "../../orchestrator/screen.ts";
import { makeTurnIndexer } from "../../orchestrator/turnIndexer.ts";
import { TELEGRAM_REPLY_INSTRUCTION } from "../core/prompts.ts";
import type { Channel, ChannelMessage } from "../core/types.ts";
import type { PhantomchatTransport } from "./transport.ts";

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
  /** Stop after draining the currently-available messages. For tests. */
  oneShot?: boolean;
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

  const harnesses: Harness[] = [...input.harnesses];

  // Per-peer promise chain so messages from one peer stay strictly ordered.
  const chains = new Map<string, Promise<void>>();
  const inFlight = new Set<Promise<void>>();

  const handle = async (msg: ChannelMessage): Promise<void> => {
    const senderHex = msg.senderId;

    // ===================== AUTH GATE =====================
    // Gate on the CRYPTOGRAPHIC sender (rumor.pubkey, carried as senderId — the
    // verifying unwrap proved it equals seal.pubkey and is signature-checked).
    // The envelope `from` field is NEVER consulted here: it's attacker-
    // controllable plaintext. A sender not in the allowlist is dropped SILENTLY
    // (info log only) — no reply, so the bot doesn't become an oracle that
    // confirms its own pubkey is live to strangers.
    const lowerHex = senderHex.toLowerCase();
    if (allowedSet.size > 0) {
      // Locked allowlist (configured, or already claimed by TOFU).
      if (!allowedSet.has(lowerHex)) {
        log.info("phantomchat: dropping message from non-allowed sender", {
          sender: senderHex.slice(0, 12) + "…",
        });
        return;
      }
    } else if (tofuArmed) {
      // TRUST-ON-FIRST-USE. Claim this sender SYNCHRONOUSLY (before any await)
      // so a near-simultaneous second stranger sees a now-non-empty set and is
      // dropped — JS single-threading makes this block atomic vs other peers.
      tofuArmed = false;
      allowedSet.add(lowerHex);
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

    let reply = "";
    // Typing indicator. Unlike Telegram's streaming engine (which refreshes the
    // indicator on every chunk), this loop sends a single message at the end —
    // so we drive the typing tick ourselves. The PWA shows three-dots on each
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
    const sendTypingTick = () => void transport.sendTyping(senderHex);
    const firstTypingTick = setTimeout(sendTypingTick, 0);
    const typingTimer = setInterval(sendTypingTick, 2000);
    try {
      for await (const chunk of runTurn({
        persona: input.persona,
        conversation: conversationKey,
        userMessage: msg.text,
        agentDir: input.agentDir,
        harnesses,
        memory: input.memory,
        idleTimeoutMs: input.config.harnessIdleTimeoutMs,
        hardTimeoutMs: input.config.harnessHardTimeoutMs,
        signal: input.signal,
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
        // is on a phone-style chat client here too. No voice overlay (Nostr
        // DMs are text only).
        systemPromptSuffix: TELEGRAM_REPLY_INSTRUCTION,
        // No live stream to fill: we send one message at the end, so pre-tool
        // narration would just bloat the reply.
        toolNarration: false,
      })) {
        if (chunk.type === "text") reply += chunk.text;
        if (chunk.type === "done") reply = chunk.finalText;
      }
    } catch (e) {
      log.warn("phantomchat: turn failed", {
        error: (e as Error).message,
        sender: senderHex.slice(0, 12) + "…",
      });
      return;
    } finally {
      // Stop the typing refresh whether the turn succeeded, errored, or the
      // early-return above fired. The PWA's last indicator self-expires ~6s
      // later, and the reply we send (success path) clears it immediately.
      clearTimeout(firstTypingTick);
      clearInterval(typingTimer);
    }

    const finalReply = reply.trim();
    if (finalReply.length === 0) return;

    try {
      if (msg.groupId) {
        // GROUP REPLY. Broadcast back into the group instead of DMing the
        // sender (the HQ bug was replying 1:1). The bridge holds no group DB, so
        // the outbound member set is reconstructed from the inbound rumor:
        //
        //   full group  = inbound p-tags ∪ { sender }      (the PWA omits the
        //                                                    sender from its own
        //                                                    p-tags)
        //   others (us excluded) = full group \ { us }
        //
        // wrapGroupMessage adds OUR self-wrap, so we pass it everyone-but-us.
        // (sendGroupMessage defensively drops our own hex if it appears here.)
        const others = new Set<string>(msg.groupMemberHexes ?? []);
        // Add the original sender back: the PWA omits the sender from its own
        // p-tags, so without this the sender wouldn't receive our reply.
        others.add(senderHex.toLowerCase());
        const memberHexes = [...others];
        await transport.sendGroupMessage(msg.groupId, memberHexes, finalReply);
      } else {
        // transport.sendMessage NIP-17-wraps the plaintext to `senderHex` and
        // publishes both wraps. conversationId === recipient hex pubkey.
        await transport.sendMessage(senderHex, finalReply);
      }
    } catch (e) {
      log.warn("phantomchat: reply publish failed", {
        error: (e as Error).message,
        sender: senderHex.slice(0, 12) + "…",
      });
    }
  };

  // Serialize per peer: chain the new work onto that peer's last promise.
  const enqueue = (msg: ChannelMessage): void => {
    const key = msg.senderId;
    const prev = chains.get(key) ?? Promise.resolve();
    const next = prev
      .catch(() => {
        // A failed prior turn must not poison the chain — swallow so the next
        // message for this peer still runs.
      })
      .then(() => handle(msg));
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
    enqueue(msg);
  }

  // Drain in-flight turns so callers (and tests) can assert on what was sent
  // without racing the workers.
  await Promise.allSettled([...inFlight]);
}
