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
import { defaultEmbedder, type Embedder, sha256 } from "../lib/embedJob.ts";
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
  /**
   * Override the embedder resolved from config. Tests inject a stub here;
   * production leaves it unset and gets `defaultEmbedder(config)`.
   */
  embedder?: Embedder;
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

    const embedder = input.embedder ?? defaultEmbedder(input.config);
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
  /** Test seam; production resolves the embedder from config. */
  embedder?: Embedder;
}

export interface FlushDueConversationsResult {
  /** How many conversations were scanned. */
  conversations: number;
  /** How many actually flushed a tail (triggered). */
  triggered: number;
  indexed: number;
  embedded: number;
  embeddingFailures: number;
  /** Previously-failed turns that the repair pass re-embedded this sweep. */
  repaired: number;
  /** Turns the repair pass tried and failed to embed again. */
  repairFailures: number;
}

/** How many consecutive repair failures before we assume the provider is down. */
const REPAIR_GIVE_UP_AFTER_CONSECUTIVE_FAILURES = 3;

export interface RepairMissingTurnEmbeddingsInput {
  config: Config;
  persona: string;
  settings: TurnIndexingSettings;
  embedder?: Embedder;
}

export interface RepairMissingTurnEmbeddingsResult {
  repaired: number;
  failures: number;
}

/**
 * Re-embed turns that are in the FTS index but have no vector — the residue
 * of embed calls that failed at index time (429s, outages, network blips).
 *
 * Why this needs to exist at all: `indexConversationTurnsIfDue` advances
 * `lastTurnId` past a turn whether or not its embedding succeeded (it must —
 * the alternative is a poisoned turn wedging the cursor and stalling the
 * whole conversation). The consequence is that a failed turn falls *behind*
 * the cursor and no cursor-driven path can ever revisit it: not the batch
 * trigger, not the age flush, not the sweep, not `memory index --turns
 * --force` (which force-flushes the *tail*, it does not rescan). Without this
 * pass, a turn that failed to embed is lexical-only forever. That's a silent,
 * one-way degradation, and because embed failures arrive in bursts it takes
 * out whole contiguous windows of history at a time.
 *
 * Bounded (`repairBatchSize` per sweep) and idempotent: a repaired turn gains
 * an embedding row and therefore drops out of the scan. If the embedder is
 * still failing we bail after a few consecutive errors rather than spending
 * the whole budget hammering a provider that is evidently down — the next
 * sweep will pick up where this one left off.
 *
 * Never throws.
 */
export async function repairMissingTurnEmbeddings(
  input: RepairMissingTurnEmbeddingsInput,
): Promise<RepairMissingTurnEmbeddingsResult> {
  const result: RepairMissingTurnEmbeddingsResult = {
    repaired: 0,
    failures: 0,
  };
  if (!input.settings.enabled) return result;
  if (input.settings.repairBatchSize <= 0) return result;

  const embedder = input.embedder ?? defaultEmbedder(input.config);
  // No embedder configured: every turn is legitimately vector-less and there
  // is nothing to repair. Bail before touching the DB — otherwise an
  // embeddings-disabled install would scan its entire history every sweep.
  if (!embedder) return result;

  let ix: MemoryIndex | undefined;
  try {
    ix = await MemoryIndex.open(memoryIndexPath(input.persona));
    const stale = ix.turnsMissingEmbeddings(
      input.persona,
      input.settings.repairBatchSize,
    );
    if (stale.length === 0) return result;

    let consecutiveFailures = 0;
    for (const row of stale) {
      const r = await embedder(row.content);
      if (r.ok) {
        ix.upsertTurnEmbedding(row.path, r.values, sha256(row.content));
        result.repaired++;
        consecutiveFailures = 0;
        continue;
      }
      result.failures++;
      consecutiveFailures++;
      if (
        consecutiveFailures >= REPAIR_GIVE_UP_AFTER_CONSECUTIVE_FAILURES
      ) {
        log.warn("turn-index repair: embedder still failing; deferring", {
          persona: input.persona,
          repaired: result.repaired,
          failures: result.failures,
          error: r.error,
        });
        break;
      }
    }

    if (result.repaired > 0 || result.failures > 0) {
      log.info("turn-index repair: re-embedded previously failed turns", {
        persona: input.persona,
        repaired: result.repaired,
        failures: result.failures,
        // Turns this pass looked at, capped at repairBatchSize. Deliberately
        // NOT a "remaining" count: the scan is bounded, so we don't know the
        // true backlog without a second query, and reporting a batch-relative
        // remainder as if it were the total would read as "all clear" on a run
        // that in fact left thousands of turns unrepaired.
        batch: stale.length,
        batchFull: stale.length >= input.settings.repairBatchSize,
      });
    }
    return result;
  } catch (e) {
    log.warn("turn-index repair: failed; embeddings left as-is", {
      persona: input.persona,
      error: (e as Error).message,
    });
    return result;
  } finally {
    ix?.close();
  }
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
    repaired: 0,
    repairFailures: 0,
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
      embedder: input.embedder,
    });
    if (r?.triggered) {
      summary.triggered++;
      summary.indexed += r.indexed;
      summary.embedded += r.embedded;
      summary.embeddingFailures += r.embeddingFailures;
    }
  }

  // Self-heal *after* the flush, so any turn whose embedding just failed above
  // is already visible to the scan and gets its first retry on the very next
  // sweep rather than waiting a cycle. Runs once per persona (the index DB is
  // per-persona), not once per conversation — the scan isn't conversation-scoped,
  // which is what lets it find turns stranded behind any conversation's cursor.
  const repair = await repairMissingTurnEmbeddings({
    config: input.config,
    persona: input.persona,
    settings: input.settings,
    embedder: input.embedder,
  });
  summary.repaired = repair.repaired;
  summary.repairFailures = repair.failures;

  if (summary.triggered > 0 || summary.repaired > 0) {
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
