/**
 * Conversation-turn continuity indexer.
 *
 * Runs after successful interactive turns, on a predictable user-turn cadence.
 * It backfills all raw turns since the last successful index point into the
 * same MemoryIndex database used by turn-time retrieval. FTS rows are always
 * written; Gemini embeddings are added when configured.
 *
 * Hot-path invariant: never throw back into runTurn. Indexing improves recall,
 * but a failure must not break chat.
 */

import {
  type Config,
  memoryIndexPath,
  type TurnIndexingSettings,
} from "../config.ts";
import { defaultEmbedder, sha256 } from "../lib/embedJob.ts";
import { log } from "../lib/logger.ts";
import {
  MemoryIndex,
  renderTurnForIndex,
} from "../lib/memoryIndex.ts";
import type { MemoryStore, Turn } from "../memory/store.ts";

export interface IndexConversationTurnsInput {
  config: Config;
  persona: string;
  conversation: string;
  memory: MemoryStore;
  settings: TurnIndexingSettings;
  /**
   * Force a flush of any unindexed tail regardless of the count or time
   * triggers. Used by the operator backfill path (`memory index --turns`).
   * A no-op when there is no unindexed tail.
   */
  force?: boolean;
}

export interface IndexConversationTurnsResult {
  triggered: boolean;
  indexed: number;
  embedded: number;
  embeddingFailures: number;
  userTurns: number;
  previousUserTurnsIndexed: number;
  lastTurnId: number;
}

export type TurnIndexer = () => Promise<void>;

export async function indexConversationTurnsIfDue(
  input: IndexConversationTurnsInput,
): Promise<IndexConversationTurnsResult | undefined> {
  if (!input.settings.enabled) return undefined;

  let ix: MemoryIndex | undefined;
  try {
    const userTurns = await input.memory.countUserTurns(
      input.persona,
      input.conversation,
    );
    ix = await MemoryIndex.open(memoryIndexPath(input.persona));
    const state = ix.turnIndexState(input.persona, input.conversation);
    const previousUserTurnsIndexed = state?.userTurnsIndexed ?? 0;
    const lastTurnId = state?.lastTurnId ?? 0;

    // Primary trigger: enough new user turns have accrued (the batch).
    let due = userTurns - previousUserTurnsIndexed >= input.settings.interval;

    // Secondary triggers — only consulted when the count batch hasn't
    // fired. Both need to know whether an unindexed tail actually exists,
    // and (for the time trigger) how old its oldest turn is. One cheap
    // single-row read of the head-of-tail answers both.
    if (!due && (input.force || input.settings.flushAfterHours > 0)) {
      const head = await input.memory.turnsAfterId(
        input.persona,
        input.conversation,
        lastTurnId,
        1,
      );
      if (head.length > 0) {
        if (input.force) {
          // Operator backfill: flush the tail unconditionally.
          due = true;
        } else {
          // Time-based safety net: flush once the oldest unindexed turn has
          // aged past flushAfterHours, even below the count threshold — so a
          // conversation stuck at e.g. 19 turns still becomes recallable.
          const ageMs = Date.now() - head[0]!.createdAt.getTime();
          if (ageMs >= input.settings.flushAfterHours * 3_600_000) due = true;
        }
      }
    }

    if (!due) {
      return {
        triggered: false,
        indexed: 0,
        embedded: 0,
        embeddingFailures: 0,
        userTurns,
        previousUserTurnsIndexed,
        lastTurnId: state?.lastTurnId ?? 0,
      };
    }

    const embedder = defaultEmbedder(input.config);
    let afterId = state?.lastTurnId ?? 0;
    let indexed = 0;
    let embedded = 0;
    let embeddingFailures = 0;

    while (true) {
      const turns = await input.memory.turnsAfterId(
        input.persona,
        input.conversation,
        afterId,
        input.settings.batchSize,
      );
      if (turns.length === 0) break;

      for (const turn of turns) {
        // QUARANTINED turn (embeddable=0): a held untrusted payload the
        // screener wrote into the principal's conversation to ground their
        // approve/deny. It must NEVER reach the FTS/vector index — that is
        // the whole point of the quarantine flag (F). Skip indexing AND
        // embedding, but still advance the cursor past it (afterId) and
        // count it as processed so the next run doesn't re-scan it forever.
        if (turn.embeddable === false) {
          indexed++;
          afterId = turn.id;
          continue;
        }
        const text = renderTurnForIndex(turn);
        const textSha = sha256(text);
        const vec = embedder ? await embedTurn(embedder, turn, text) : undefined;
        if (vec) embedded++;
        else if (embedder) embeddingFailures++;
        ix.upsertTurn(turn, vec, vec ? textSha : undefined);
        indexed++;
        afterId = turn.id;
      }

      if (turns.length < input.settings.batchSize) break;
    }

    ix.updateTurnIndexState(
      input.persona,
      input.conversation,
      afterId,
      userTurns,
    );

    log.info("turn-index: indexed conversation turns", {
      persona: input.persona,
      conversation: input.conversation,
      indexed,
      embedded,
      embeddingFailures,
      userTurns,
    });

    return {
      triggered: true,
      indexed,
      embedded,
      embeddingFailures,
      userTurns,
      previousUserTurnsIndexed,
      lastTurnId: afterId,
    };
  } catch (e) {
    log.warn("turn-index: failed; continuing without indexed turns", {
      persona: input.persona,
      conversation: input.conversation,
      error: (e as Error).message,
    });
    return undefined;
  } finally {
    ix?.close();
  }
}

export function makeTurnIndexer(
  config: Config,
  persona: string,
  conversation: string,
  memory: MemoryStore,
): TurnIndexer | undefined {
  const retrieval = config.retrieval;
  const turnIndexing = retrieval?.turnIndexing;
  if (!retrieval?.enabled || !turnIndexing?.enabled) return undefined;
  return () =>
    indexConversationTurnsIfDue({
      config,
      persona,
      conversation,
      memory,
      settings: turnIndexing,
    }).then(() => undefined);
}

export interface FlushDueConversationsInput {
  config: Config;
  persona: string;
  memory: MemoryStore;
  settings: TurnIndexingSettings;
  /** Force-flush every conversation's tail regardless of count/age. */
  force?: boolean;
}

export interface FlushDueConversationsResult {
  /** How many conversations were scanned. */
  conversations: number;
  /** How many actually flushed a tail (triggered). */
  triggered: number;
  indexed: number;
  embedded: number;
  embeddingFailures: number;
}

/**
 * Sweep every conversation for one persona and flush any tail that is due —
 * by the count batch, by age (flushAfterHours), or unconditionally when
 * `force` is set. This is the box-level drain the live service can't do on
 * its own: the service only flushes a conversation when a new message in it
 * crosses the batch, so a quiet sub-threshold tail would otherwise stay
 * unembedded indefinitely. Called by the 30-min heartbeat (time-based) and
 * `phantombot memory index --turns` (operator backfill, force).
 *
 * Never throws: indexConversationTurnsIfDue swallows its own errors per
 * conversation, and a failure to enumerate conversations is logged and
 * returns an empty summary. Safe to run from the mechanical heartbeat.
 */
export async function flushDueConversationTurns(
  input: FlushDueConversationsInput,
): Promise<FlushDueConversationsResult> {
  const summary: FlushDueConversationsResult = {
    conversations: 0,
    triggered: 0,
    indexed: 0,
    embedded: 0,
    embeddingFailures: 0,
  };
  if (!input.settings.enabled) return summary;

  let conversations: string[];
  try {
    conversations = await input.memory.listConversations(input.persona);
  } catch (e) {
    log.warn("turn-index sweep: failed to list conversations", {
      persona: input.persona,
      error: (e as Error).message,
    });
    return summary;
  }
  summary.conversations = conversations.length;

  for (const conversation of conversations) {
    const r = await indexConversationTurnsIfDue({
      config: input.config,
      persona: input.persona,
      conversation,
      memory: input.memory,
      settings: input.settings,
      force: input.force,
    });
    if (r?.triggered) {
      summary.triggered++;
      summary.indexed += r.indexed;
      summary.embedded += r.embedded;
      summary.embeddingFailures += r.embeddingFailures;
    }
  }

  if (summary.triggered > 0) {
    log.info("turn-index sweep: flushed conversation tails", { ...summary });
  }
  return summary;
}

async function embedTurn(
  embedder: NonNullable<ReturnType<typeof defaultEmbedder>>,
  turn: Turn,
  text: string,
): Promise<Float32Array | undefined> {
  const r = await embedder(text);
  if (r.ok) return r.values;
  log.warn("turn-index: turn embed failed; FTS-only for this turn", {
    persona: turn.persona,
    conversation: turn.conversation,
    turnId: turn.id,
    error: r.error,
  });
  return undefined;
}
