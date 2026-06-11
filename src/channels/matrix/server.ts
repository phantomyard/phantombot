/**
 * Matrix listener loop — the Matrix analogue of `runTelegramServer`.
 *
 * Consumes the channel-agnostic inbound seam (`Channel.listen()`, which the
 * Matrix adapter implements over /sync) and dispatches each decrypted message
 * through the SAME orchestrator (`runTurn`) the Telegram engine uses — same
 * screener, same retriever, same per-conversation memory keying. The result
 * is sent back on the inbound room (reply = inbound channel).
 *
 * The security perimeter is identical in shape to Telegram's, with the trust
 * gate keyed off ALLOW-LISTED MXIDs:
 *
 *   - `checkAllowed` decides whether we ANSWER at all (empty allowlist = open
 *     bot, answers anyone — with a startup warning).
 *   - `principalAuthenticated` is the stricter gate that grants TRUSTED tier:
 *     true ONLY when the sender MXID is explicitly allow-listed. An open bot
 *     is NOT an authenticated principal, so trust stays false and
 *     security-rule writes fail closed — verbatim the Telegram rule, just with
 *     string MXIDs instead of numeric ids.
 *
 * Concurrency: per-room serial chains (a room's turns stay ordered; different
 * rooms run in parallel), mirroring the Telegram engine's per-chat chains. We
 * keep it deliberately simpler than the Telegram engine (no voice/STT,
 * attachments, group-addressing, or slash commands for v1) — text in, harness,
 * text out — because Matrix landed text-first like Telegram once did.
 *
 * Conversation key is `matrix:<roomId>` so Matrix memory is isolated from
 * Telegram's `telegram:<chatId>` and the CLI's `cli:default`.
 */

import type { Config } from "../../config.ts";
import type { Harness } from "../../harnesses/types.ts";
import type { WriteSink } from "../../lib/io.ts";
import { log } from "../../lib/logger.ts";
import type { MemoryStore } from "../../memory/store.ts";
import { makeRetriever } from "../../orchestrator/retrieval.ts";
import { makeScreener } from "../../orchestrator/screen.ts";
import { makeTurnIndexer } from "../../orchestrator/turnIndexer.ts";
import { runTurn } from "../../orchestrator/turn.ts";
import { createMatrixChannel } from "./channel.ts";
import type { MatrixTransport } from "./transport.ts";

export interface RunMatrixServerInput {
  config: Config;
  memory: MemoryStore;
  harnesses: Harness[];
  agentDir: string;
  persona: string;
  transport: MatrixTransport;
  /** The Matrix account this listener is bound to (token + allowlist). */
  account: import("../../config.ts").MatrixAccount;
  /** Stop the loop cleanly. */
  signal?: AbortSignal;
  /** Process at most this many inbound messages, then return. For tests. */
  maxMessages?: number;
  out?: WriteSink;
  err?: WriteSink;
}

/**
 * Run the Matrix listener until `signal` aborts (or `maxMessages` are handled,
 * for tests). Starts the transport's sync, then drains `channel.listen()`,
 * fanning each message onto its room's serial chain.
 */
export async function runMatrixServer(
  input: RunMatrixServerInput,
): Promise<void> {
  const serverStartedAt = Date.now();
  const mx = input.account;
  const channel = createMatrixChannel(input.transport);
  // The Matrix adapter always implements listen() (it's the whole inbound
  // seam); assert it so the optional `listen?` on the Channel interface
  // doesn't force a guard on every iteration.
  const listen = channel.listen!.bind(channel);

  // Trust perimeter. The allowlist is a set of MXIDs (strings). Matched
  // exactly — MXIDs are canonical, no normalization games.
  const allowedSet = new Set(mx.allowedUserIds);
  const checkAllowed = (senderId: string): boolean =>
    allowedSet.size === 0 || allowedSet.has(senderId);
  const isPrincipal = (senderId: string): boolean =>
    allowedSet.size > 0 && allowedSet.has(senderId);

  if (allowedSet.size === 0) {
    log.warn(
      "matrix: no allowed_user_ids configured — anyone who messages the bot is answered (and never trusted)",
    );
  }

  // Begin syncing BEFORE we start consuming listen() so the timeline
  // subscription is live. start() resolves after initial sync.
  await input.transport.start();
  log.info("matrix: sync started", {
    persona: input.persona,
    userId: input.transport.selfUserId(),
  });

  // Per-room serial chains so a room's turns stay ordered; different rooms run
  // in parallel. Mirrors the Telegram engine's chatChains.
  const roomChains = new Map<string, Promise<void>>();
  const inFlight = new Set<Promise<void>>();

  let handled = 0;
  try {
    for await (const msg of listen(input.signal)) {
      if (input.signal?.aborted) break;

      // Drop events that predate this server's start so a restart doesn't
      // replay backlog as fresh inbound. (The SDK's initialSyncLimit already
      // limits this; this is belt-and-braces against re-delivery.)
      const m = msg as import("./types.ts").MatrixChannelMessage;
      if (
        typeof m.originServerTs === "number" &&
        m.originServerTs > 0 &&
        m.originServerTs < serverStartedAt
      ) {
        continue;
      }

      if (!checkAllowed(msg.senderId)) {
        log.info("matrix: rejecting unauthorized user", {
          fromUserId: msg.senderId,
          roomId: msg.conversationId,
        });
        continue;
      }

      log.info("matrix: incoming", {
        roomId: msg.conversationId,
        fromUserId: msg.senderId,
        textLength: msg.text.length,
        persona: input.persona,
        encrypted: m.encrypted,
      });

      const principalAuthenticated = isPrincipal(msg.senderId);
      // Convert prior rejection to resolution so a thrown turn doesn't wedge
      // the per-room queue (the #135 pattern).
      const prev = (roomChains.get(msg.conversationId) ?? Promise.resolve()).catch(
        () => {},
      );
      const next = prev.then(() =>
        processMatrixMessage(msg as import("./types.ts").MatrixChannelMessage, {
          input,
          principalAuthenticated,
        }),
      );
      const tracked = next.finally(() => {
        if (roomChains.get(msg.conversationId) === tracked) {
          roomChains.delete(msg.conversationId);
        }
        inFlight.delete(tracked);
      });
      roomChains.set(msg.conversationId, tracked);
      inFlight.add(tracked);

      handled++;
      if (input.maxMessages !== undefined && handled >= input.maxMessages) {
        break;
      }
    }
  } finally {
    // Drain in-flight workers so tests can assert on transport state and
    // shutdowns don't strand subprocesses.
    if (inFlight.size > 0) {
      await Promise.allSettled([...inFlight]);
    }
    input.transport.stop();
  }
}

/**
 * Process one inbound Matrix message: run the harness chain through the
 * orchestrator and send the reply back on the same room. Self-contained so the
 * loop can fire-and-track.
 */
async function processMatrixMessage(
  msg: import("./types.ts").MatrixChannelMessage,
  ctx: {
    input: RunMatrixServerInput;
    /** TRUSTED tier iff the sender is an allow-listed MXID. */
    principalAuthenticated: boolean;
  },
): Promise<void> {
  const { input } = ctx;
  const startedAt = Date.now();
  const conversationKey = `matrix:${msg.conversationId}`;

  // Show a typing indicator while we work (best-effort).
  void input.transport.sendTyping(msg.conversationId);

  let finalReply: string | undefined;
  let streamedReply = "";
  let errored: string | undefined;
  const controller = new AbortController();
  // Tie the turn to the server signal so shutdown aborts in-flight turns.
  const onAbort = () => controller.abort("shutdown");
  input.signal?.addEventListener("abort", onAbort, { once: true });

  try {
    for await (const chunk of runTurn({
      persona: input.persona,
      conversation: conversationKey,
      userMessage: msg.text,
      agentDir: input.agentDir,
      harnesses: input.harnesses,
      memory: input.memory,
      idleTimeoutMs: input.config.harnessIdleTimeoutMs,
      hardTimeoutMs: input.config.harnessHardTimeoutMs,
      signal: controller.signal,
      // Security perimeter: TRUSTED only for an allow-listed principal MXID —
      // the Matrix mirror of the Telegram rule. Untrusted (open-bot or
      // non-allowlisted) turns are screened by makeScreener below.
      trusted: ctx.principalAuthenticated === true,
      screen: makeScreener(
        input.config,
        input.persona,
        conversationKey,
        input.harnesses,
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
    })) {
      if (chunk.type === "text") streamedReply += chunk.text;
      if (chunk.type === "done") finalReply = chunk.finalText;
      if (chunk.type === "error") errored = chunk.error;
    }
  } catch (e) {
    errored = (e as Error).message;
    log.error("matrix: turn threw", { error: errored, roomId: msg.conversationId });
  } finally {
    input.signal?.removeEventListener("abort", onAbort);
  }

  if (controller.signal.aborted) {
    log.info("matrix: turn aborted", {
      roomId: msg.conversationId,
      reason: String(controller.signal.reason),
    });
    return;
  }

  const reply = finalReply ?? streamedReply;
  if (errored && reply.length === 0) {
    // Turn failed with nothing to say — stay silent (diagnostic is logged).
    log.error("matrix: turn failed with no reply", {
      roomId: msg.conversationId,
      error: errored,
    });
    return;
  }
  if (reply.length === 0) return;

  // Reply on the INBOUND room — the SDK Megolm-encrypts transparently if the
  // room is encrypted (the encrypt-on-egress seam).
  await input.transport.sendMessage(msg.conversationId, reply);

  log.info("matrix: complete", {
    roomId: msg.conversationId,
    durationMs: Date.now() - startedAt,
    replyChars: reply.length,
    ok: !errored,
  });
}
