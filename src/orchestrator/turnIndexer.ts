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
    const due = userTurns - previousUserTurnsIndexed >= input.settings.interval;
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
