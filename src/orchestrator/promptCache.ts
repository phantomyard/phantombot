import { createHash } from "node:crypto";

import type { PromptCacheSettings } from "../config.ts";
import type { HistoryTurn } from "../harnesses/types.ts";
import {
  renderConversationPayload,
  type PromptEpochTurn,
} from "../harnesses/payload.ts";
import { log } from "../lib/logger.ts";

const DEFAULT_HISTORY_LIMIT = 30;

export type PromptCacheEpochEvent =
  | "new"
  | "append"
  | "rebase"
  | "bypass"
  | "invalidate";

export type PromptCacheReason =
  | "no_state"
  | "budget"
  | "system_changed"
  | "history_changed"
  | "concurrent_turn"
  | "oversized_base"
  | "no_history"
  | "cache_error"
  | "trust_changed"
  | "persona_changed"
  | "threat_hold"
  | "security_changed";

export type PromptCacheErrorPhase =
  | "prepare"
  | "complete"
  | "fail"
  | "discard";

interface EpochState {
  key: string;
  persona: string;
  conversation: string;
  systemFingerprint: string;
  trusted: boolean;
  securityFingerprint: string;
  baseHistory: HistoryTurn[];
  canonicalHistory: HistoryTurn[];
  epochTurns: PromptEpochTurn[];
  active: boolean;
}

export interface PromptCacheEpochPlan {
  readonly state: EpochState;
  readonly baseHistory: readonly HistoryTurn[];
  readonly epochTurns: readonly PromptEpochTurn[];
  readonly turnContext: string | undefined;
  readonly userMessage: string;
  readonly rebased: boolean;
  readonly retainEpoch: boolean;
  readonly event: PromptCacheEpochEvent;
  readonly reason: PromptCacheReason | undefined;
  /** Rendered UTF-8 bytes sent for this request, using the epoch estimator. */
  readonly promptBytes: number;
  /** Initial projected bytes when a budget rebase was required. */
  readonly projectedEpochBytes: number | undefined;
}

export interface PreparePromptCacheInput {
  settings: PromptCacheSettings;
  persona: string;
  conversation: string;
  systemPrompt: string;
  history: readonly HistoryTurn[];
  /** Explicit security provenance; never infer this from prompt text. */
  trusted?: boolean;
  /** Effective security/tool-surface identity for this turn. */
  securityFingerprint?: string;
  historyLimit?: number;
  turnContext?: string;
  userMessage: string;
}

interface PromptCacheTelemetry {
  event: PromptCacheEpochEvent;
  reason?: PromptCacheReason;
  baseHistoryTurnCount: number;
  epochTurnCount: number;
  promptBytes: number;
  retainEpoch: boolean;
  projectedEpochBytes?: number;
}

/**
 * In-process prompt-cache state. It contains only disposable serialization
 * artifacts. Canonical history remains in PhantomBot's MemoryStore and is
 * re-read on every turn so a restart, edit, reset, or process race can only
 * cause a benign rebase.
 */
export class PromptCacheEpochManager {
  private readonly states = new Map<string, EpochState>();
  /** The current persona for each conversation served by this process. */
  private readonly activePersonas = new Map<string, string>();

  /**
   * Observe persona lifecycle independently of cache eligibility. A persona
   * with caching disabled, or a no-history turn, must still close the prior
   * persona's disposable epoch before that persona can return.
   */
  observePersona(persona: string, conversation: string): boolean {
    const previousPersona = this.activePersonas.get(conversation);
    const personaChanged =
      previousPersona !== undefined && previousPersona !== persona;
    if (personaChanged) this.deleteConversationStates(conversation);
    this.activePersonas.set(conversation, persona);
    return personaChanged;
  }

  prepare(
    input: PreparePromptCacheInput,
    observedPersonaChanged?: boolean,
  ): PromptCacheEpochPlan | undefined {
    const personaChanged =
      observedPersonaChanged ??
      this.observePersona(input.persona, input.conversation);
    if (!input.settings.enabled) return undefined;

    const key = cacheKey(input.persona, input.conversation);
    const historyLimit = Math.max(
      0,
      input.historyLimit ?? DEFAULT_HISTORY_LIMIT,
    );
    const fingerprint = systemFingerprint(input.systemPrompt);
    const trusted = input.trusted === true;
    const securityFingerprint =
      input.securityFingerprint ?? (trusted ? "trusted" : "untrusted");
    let state = this.states.get(key);
    let rebased = false;
    let reason: PromptCacheReason | undefined;

    // Epoch state is disposable optimization data. Never trust malformed or
    // inconsistent state when it is found: discard it and let the caller
    // degrade this request to the normal feature-off prompt path.
    if (
      state !== undefined &&
      !isValidEpochState(state, key, input.persona, input.conversation)
    ) {
      this.states.delete(key);
      throw new Error("prompt-cache state is invalid");
    }

    if (personaChanged) {
      reason = "persona_changed";
    } else if (!state) {
      reason = "no_state";
    } else if (state.active) {
      reason = "concurrent_turn";
    } else if (state.trusted !== trusted) {
      reason = "trust_changed";
    } else if (state.securityFingerprint !== securityFingerprint) {
      reason = "security_changed";
    } else if (state.systemFingerprint !== fingerprint) {
      reason = "system_changed";
    } else if (
      !sameHistory(
        input.history,
        historyTail(state.canonicalHistory, historyLimit),
      )
    ) {
      reason = "history_changed";
    }

    if (reason !== undefined) {
      state = this.newState({
        key,
        persona: input.persona,
        conversation: input.conversation,
        systemFingerprint: fingerprint,
        trusted,
        securityFingerprint,
        history: input.history,
      });
      this.states.set(key, state);
      rebased = reason !== "no_state";
    }
    if (!state) throw new Error("prompt-cache state was not initialized");

    let promptBytes = estimatePromptBytes({
      systemPrompt: input.systemPrompt,
      history: state.baseHistory,
      epochTurns: state.epochTurns,
      turnContext: input.turnContext,
      userMessage: input.userMessage,
    });
    const projectedEpochBytes =
      promptBytes > input.settings.maxEpochBytes &&
      state.epochTurns.length > 0 &&
      reason === undefined
        ? promptBytes
        : undefined;

    // A full canonical prompt can itself be larger than the configured
    // optimization budget. Preserve normal chat correctness in that case:
    // send this turn from canonical history and do not retain an oversized
    // epoch. The budget is a cache-epoch ceiling, not a reason to reject a
    // user turn.
    let retainEpoch = true;
    if (promptBytes > input.settings.maxEpochBytes) {
      if (state.epochTurns.length > 0) {
        state = this.newState({
          key,
          persona: input.persona,
          conversation: input.conversation,
          systemFingerprint: fingerprint,
          trusted,
          securityFingerprint,
          history: input.history,
        });
        this.states.set(key, state);
        rebased = true;
        reason = "budget";
      }
      promptBytes = estimatePromptBytes({
        systemPrompt: input.systemPrompt,
        history: state.baseHistory,
        epochTurns: [],
        turnContext: input.turnContext,
        userMessage: input.userMessage,
      });
      if (promptBytes > input.settings.maxEpochBytes) {
        state.active = true;
        retainEpoch = false;
        const plan: PromptCacheEpochPlan = {
          state,
          baseHistory: state.baseHistory,
          epochTurns: [],
          turnContext: input.turnContext,
          userMessage: input.userMessage,
          rebased,
          retainEpoch,
          event: "bypass",
          reason: "oversized_base",
          promptBytes,
          projectedEpochBytes,
        };
        this.logTelemetry(input, {
          event: plan.event,
          reason: plan.reason,
          baseHistoryTurnCount: plan.baseHistory.length,
          epochTurnCount: plan.epochTurns.length,
          promptBytes: plan.promptBytes,
          retainEpoch: plan.retainEpoch,
          projectedEpochBytes: plan.projectedEpochBytes,
        });
        return plan;
      }
    }

    state.active = true;
    const event: PromptCacheEpochEvent =
      rebased ? "rebase" : state.epochTurns.length > 0 ? "append" : "new";
    const plan: PromptCacheEpochPlan = {
      state,
      baseHistory: state.baseHistory,
      epochTurns: state.epochTurns,
      turnContext: input.turnContext,
      userMessage: input.userMessage,
      rebased,
      retainEpoch,
      event,
      reason: event === "append" ? undefined : reason,
      promptBytes,
      projectedEpochBytes,
    };
    this.logTelemetry(input, {
      event: plan.event,
      reason: plan.reason,
      baseHistoryTurnCount: plan.baseHistory.length,
      epochTurnCount: plan.epochTurns.length,
      promptBytes: plan.promptBytes,
      retainEpoch: plan.retainEpoch,
      projectedEpochBytes: plan.projectedEpochBytes,
    });
    return plan;
  }

  /** Record a feature-enabled request that explicitly cannot use history. */
  bypass(input: PreparePromptCacheInput, reason: "no_history"): void {
    if (!input.settings.enabled) return;
    const telemetry: PromptCacheTelemetry = {
      event: "bypass" as const,
      reason,
      promptBytes: estimatePromptBytes({
        systemPrompt: input.systemPrompt,
        history: [],
        turnContext: input.turnContext,
        userMessage: input.userMessage,
      }),
      epochTurnCount: 0,
      baseHistoryTurnCount: 0,
      retainEpoch: false,
    };
    this.logTelemetry(input, telemetry);
  }

  complete(plan: PromptCacheEpochPlan, assistantMessage: string): void {
    const state = plan.state;
    try {
      state.active = false;
      if (this.states.get(state.key) !== state) return;

      if (
        !isValidEpochState(
          state as unknown,
          state.key,
          state.persona,
          state.conversation,
        ) ||
        typeof assistantMessage !== "string"
      ) {
        this.states.delete(state.key);
        return;
      }

      if (!plan.retainEpoch) {
        this.states.delete(state.key);
        return;
      }

      const nextTurn: PromptEpochTurn = {
        turnContext: plan.turnContext ?? "",
        userMessage: plan.userMessage,
        assistantMessage,
      };
      state.epochTurns.push(nextTurn);
      state.canonicalHistory.push(
        { role: "user", text: plan.userMessage },
        { role: "assistant", text: assistantMessage },
      );
    } catch (error) {
      this.states.delete(state.key);
      throw error;
    }
  }

  fail(plan: PromptCacheEpochPlan): void {
    const state = plan.state;
    try {
      state.active = false;
      if (this.states.get(state.key) !== state) return;
      if (
        !isValidEpochState(
          state as unknown,
          state.key,
          state.persona,
          state.conversation,
        )
      ) {
        this.states.delete(state.key);
        return;
      }
      // A failed request has no durable turn to append. Retain the prior epoch
      // so an ordinary retry can reuse the same safe prefix.
    } catch (error) {
      this.states.delete(state.key);
      throw error;
    }
  }

  /** Discard disposable state after any cache bookkeeping failure. */
  discard(persona: string, conversation: string): void {
    this.states.delete(cacheKey(persona, conversation));
  }

  /**
   * Invalidate a security boundary without touching canonical memory.
   *
   * This is deliberately best-effort bookkeeping: a hold, trust transition,
   * or effective security-surface change must never turn into a failed turn
   * because disposable cache state could not be removed.
   */
  invalidate(
    input: Pick<PreparePromptCacheInput, "settings" | "persona" | "conversation">,
    reason: "trust_changed" | "persona_changed" | "threat_hold" | "security_changed",
  ): void {
    if (!input.settings.enabled) return;
    this.states.delete(cacheKey(input.persona, input.conversation));
    log.info("prompt_cache.epoch", {
      event: "invalidate",
      persona: input.persona,
      conversation: input.conversation,
      retain_epoch: false,
      invalidation_reason: reason,
    });
  }

  clear(): void {
    this.states.clear();
    this.activePersonas.clear();
  }

  private logTelemetry(
    input: PreparePromptCacheInput,
    telemetry: PromptCacheTelemetry,
  ): void {
    log.info("prompt_cache.epoch", {
      event: telemetry.event,
      persona: input.persona,
      conversation: input.conversation,
      base_history_turns: telemetry.baseHistoryTurnCount,
      epoch_turns: telemetry.epochTurnCount,
      prompt_bytes: telemetry.promptBytes,
      max_epoch_bytes: input.settings.maxEpochBytes,
      retain_epoch: telemetry.retainEpoch,
      ...(telemetry.reason
        ? {
            ...(telemetry.event === "rebase"
              ? { rebase_reason: telemetry.reason }
              : telemetry.event === "bypass"
                ? { bypass_reason: telemetry.reason }
                : { reason: telemetry.reason }),
          }
        : {}),
      ...(telemetry.projectedEpochBytes !== undefined
        ? { projected_epoch_bytes: telemetry.projectedEpochBytes }
        : {}),
    });
  }

  private newState(
    input: Omit<
      EpochState,
      "baseHistory" | "canonicalHistory" | "epochTurns" | "active"
    > & { history: readonly HistoryTurn[] },
  ): EpochState {
    const history = cloneHistory(input.history);
    return {
      key: input.key,
      persona: input.persona,
      conversation: input.conversation,
      systemFingerprint: input.systemFingerprint,
      trusted: input.trusted,
      securityFingerprint: input.securityFingerprint,
      baseHistory: history,
      canonicalHistory: cloneHistory(history),
      epochTurns: [],
      active: false,
    };
  }

  private deleteConversationStates(conversation: string): void {
    for (const [key, state] of this.states) {
      if (state.conversation === conversation) this.states.delete(key);
    }
  }
}

export const promptCacheEpochs = new PromptCacheEpochManager();

export function clearPromptCacheEpochs(): void {
  promptCacheEpochs.clear();
}

/**
 * Emit only safe metadata for a cache failure. Prompt content and raw error
 * messages are deliberately excluded because this path is allowed to run
 * while recovering from malformed private state.
 */
export function reportPromptCacheError(
  persona: string,
  conversation: string,
  phase: PromptCacheErrorPhase,
): void {
  try {
    log.warn("prompt_cache.epoch", {
      event: "bypass",
      persona,
      conversation,
      retain_epoch: false,
      bypass_reason: "cache_error",
      phase,
    });
  } catch {
    // Cache telemetry is best effort and must never affect the turn.
  }
}

/** Rendered UTF-8 byte count used only for the backend-neutral epoch bound. */
export function estimatePromptBytes(input: {
  systemPrompt: string;
  history: readonly HistoryTurn[];
  epochTurns?: readonly PromptEpochTurn[];
  turnContext?: string;
  userMessage: string;
}): number {
  const payload = renderConversationPayload(input);
  // This measures only PhantomBot's rendered system/payload bytes. It is not
  // an exact model-token count: harness/chat-template/tool tokens may exist
  // outside this measurement. Keeping the bound byte-based avoids pretending
  // that one tokenizer or backend applies to every supported harness.
  return (
    Buffer.byteLength(input.systemPrompt, "utf8") +
    Buffer.byteLength(payload, "utf8") +
    (input.systemPrompt.length > 0 && payload.length > 0 ? 2 : 0)
  );
}

/**
 * Stable identity for the effective security surface of a cached turn.
 *
 * This is intentionally not telemetry and is never exposed to a harness. It
 * makes changes to screening availability or the per-turn tool surface an
 * explicit cache boundary, independent of prompt wording.
 */
export function promptCacheSecurityFingerprint(input: {
  trusted: boolean;
  screening: "screened" | "unscreened" | "trusted";
  mcpMode: "default" | "none";
  tools: readonly string[] | undefined;
}): string {
  return createHash("sha256")
    .update(
      JSON.stringify({
        trusted: input.trusted,
        screening: input.screening,
        mcpMode: input.mcpMode,
        tools: input.tools ? [...input.tools].sort() : null,
      }),
      "utf8",
    )
    .digest("hex");
}

function cacheKey(persona: string, conversation: string): string {
  return `${persona}\u0000${conversation}`;
}

function systemFingerprint(systemPrompt: string): string {
  return createHash("sha256").update(systemPrompt, "utf8").digest("hex");
}

function cloneHistory(history: readonly HistoryTurn[]): HistoryTurn[] {
  return history.map((turn) => ({ role: turn.role, text: turn.text }));
}

function sameHistory(
  left: readonly HistoryTurn[],
  right: readonly HistoryTurn[],
): boolean {
  if (left.length !== right.length) return false;
  return left.every(
    (turn, index) =>
      turn.role === right[index]?.role && turn.text === right[index]?.text,
  );
}

function historyTail(
  history: readonly HistoryTurn[],
  limit: number,
): readonly HistoryTurn[] {
  return limit === 0 ? [] : history.slice(-limit);
}

function isValidEpochState(
  value: unknown,
  expectedKey: string,
  expectedPersona: string,
  expectedConversation: string,
): value is EpochState {
  if (!value || typeof value !== "object") return false;
  const state = value as Partial<EpochState>;
  if (
    state.key !== expectedKey ||
    state.persona !== expectedPersona ||
    state.conversation !== expectedConversation ||
    typeof state.systemFingerprint !== "string" ||
    !/^[0-9a-f]{64}$/.test(state.systemFingerprint) ||
    typeof state.trusted !== "boolean" ||
    typeof state.securityFingerprint !== "string" ||
    typeof state.active !== "boolean" ||
    !Array.isArray(state.baseHistory) ||
    !Array.isArray(state.canonicalHistory) ||
    !Array.isArray(state.epochTurns) ||
    !state.baseHistory.every(isHistoryTurn) ||
    !state.canonicalHistory.every(isHistoryTurn) ||
    !state.epochTurns.every(isPromptEpochTurn) ||
    state.canonicalHistory.length !==
      state.baseHistory.length + state.epochTurns.length * 2 ||
    !sameHistory(
      state.baseHistory,
      state.canonicalHistory.slice(0, state.baseHistory.length),
    )
  ) {
    return false;
  }

  for (let index = 0; index < state.epochTurns.length; index++) {
    const epochTurn = state.epochTurns[index];
    if (!epochTurn) return false;
    const canonicalIndex = state.baseHistory.length + index * 2;
    if (
      state.canonicalHistory[canonicalIndex]?.role !== "user" ||
      state.canonicalHistory[canonicalIndex]?.text !== epochTurn.userMessage ||
      state.canonicalHistory[canonicalIndex + 1]?.role !== "assistant" ||
      state.canonicalHistory[canonicalIndex + 1]?.text !==
        epochTurn.assistantMessage
    ) {
      return false;
    }
  }
  return true;
}

function isHistoryTurn(value: unknown): value is HistoryTurn {
  if (!value || typeof value !== "object") return false;
  const turn = value as Partial<HistoryTurn>;
  return (
    (turn.role === "user" || turn.role === "assistant") &&
    typeof turn.text === "string"
  );
}

function isPromptEpochTurn(value: unknown): value is PromptEpochTurn {
  if (!value || typeof value !== "object") return false;
  const turn = value as Partial<PromptEpochTurn>;
  return (
    typeof turn.turnContext === "string" &&
    typeof turn.userMessage === "string" &&
    typeof turn.assistantMessage === "string"
  );
}
