/**
 * phantomchat proactive onboarding greeting.
 *
 * The onboarding flow is INVERTED from TOFU: instead of Andrew copy-pasting a
 * bot's npub into his PWA and sending the first "Hello", he just curates the
 * persona's `allowed_npubs` list (via `phantombot phantomchat --persona …`) and
 * the BOT reaches out — it sends a friendly first-contact DM to every allowed
 * npub it hasn't greeted yet. That DM lands in the PWA as a contact request
 * Andrew approves there. No npub copy-paste, no manual hello.
 *
 * Two pieces live here:
 *   1. `resolvePersonaGreeting` — produce the greeting TEXT. It runs ONE harness
 *      turn with the persona's full system prompt so the hello is in the
 *      persona's own voice (Lena greets differently from Kai). Any failure —
 *      no harness, timeout, empty reply — falls back to a plain "Hello 👋", so
 *      onboarding never blocks on the model.
 *   2. `greetPendingNpubs` — send that greeting to each allowed npub not yet in
 *      the persona's `greeted` list, recording each as it goes so a restart
 *      re-greets only the npubs added since last time.
 *
 * The greet pass is driven from cli/run.ts AFTER the listener is up and runs
 * DETACHED (fire-and-forget): a slow greeting generation must never delay the
 * bot coming online or hold the relay subscription.
 */

import { buildSystemPrompt } from "../../persona/builder.ts";
import { loadPersona } from "../../persona/loader.ts";
import type { Harness } from "../../harnesses/types.ts";
import type { WriteSink } from "../../lib/io.ts";
import { decodeNpubToHex } from "../../lib/nostrIdentity.ts";
import { log } from "../../lib/logger.ts";
import { runWithFallback } from "../../orchestrator/fallback.ts";

/** The greeting used when persona-flavored generation is unavailable. */
export const FALLBACK_GREETING = "Hello 👋";

/**
 * The instruction handed to the persona to compose its first-contact hello.
 * Deliberately tight: one short message, the persona's own voice, no
 * placeholders or meta-commentary — whatever comes back is sent verbatim.
 */
const GREETING_PROMPT = [
  "You've just been added as a contact by someone new on PhantomChat and this",
  "is your very first message to them. Write a short, warm one-line hello that",
  "introduces yourself in your own voice — no more than two sentences. Reply",
  "with ONLY the greeting text itself: no quotes, no preamble, no placeholders,",
  "no sign-off, nothing else.",
].join(" ");

/**
 * Produce the onboarding greeting in the persona's voice via a single harness
 * turn. Never throws and never persists anything (no memory write — this is a
 * throwaway one-shot, not a conversation). Returns `FALLBACK_GREETING` on any
 * failure so the caller can always send *something*.
 */
export async function resolvePersonaGreeting(input: {
  agentDir: string;
  persona: string;
  harnesses: Harness[];
  idleTimeoutMs: number;
  hardTimeoutMs?: number;
  signal?: AbortSignal;
}): Promise<string> {
  try {
    const persona = await loadPersona(input.agentDir);
    const systemPrompt = buildSystemPrompt(persona, {
      channel: "cli",
      conversationId: `phantomchat-greet:${input.persona}`,
      timestamp: new Date(),
      trusted: true,
    });
    let text = "";
    for await (const chunk of runWithFallback(input.harnesses, {
      systemPrompt,
      userMessage: GREETING_PROMPT,
      history: [],
      persona: input.persona,
      workingDir: input.agentDir,
      idleTimeoutMs: input.idleTimeoutMs,
      hardTimeoutMs: input.hardTimeoutMs,
      signal: input.signal,
    })) {
      if (chunk.type === "text") text += chunk.text;
      if (chunk.type === "done") text = chunk.finalText;
      if (chunk.type === "error") throw new Error(chunk.error);
    }
    const trimmed = text.trim();
    if (trimmed.length === 0) {
      log.warn(`phantomchat[${input.persona}]: greeting generation empty — using fallback`);
      return FALLBACK_GREETING;
    }
    return trimmed;
  } catch (e) {
    log.warn(`phantomchat[${input.persona}]: greeting generation failed — using fallback`, {
      error: (e as Error).message,
    });
    return FALLBACK_GREETING;
  }
}

/**
 * Send `greeting` to every npub in `allowedNpubs` that is NOT already in
 * `greetedNpubs`, recording each via `recordGreeted` as it succeeds. A npub
 * that fails to decode or send is left UN-recorded so the next restart retries
 * it (Andrew's rule: greet anyone not yet onboarded on every restart until all
 * are done). Best-effort throughout — one bad npub never aborts the rest.
 *
 * Returns the npubs greeted this pass and the ones that failed.
 */
export async function greetPendingNpubs(input: {
  persona: string;
  allowedNpubs: string[];
  greetedNpubs: string[];
  greeting: string;
  /** Publish the greeting to a recipient hex pubkey (transport.sendMessage). */
  sendMessage: (recipientHex: string, text: string) => Promise<void>;
  /** Durably record that `npub` has been greeted. */
  recordGreeted: (npub: string) => Promise<void>;
  out?: WriteSink;
  err?: WriteSink;
}): Promise<{ greeted: string[]; failed: string[] }> {
  const already = new Set(input.greetedNpubs);
  const pending = input.allowedNpubs.filter((n) => !already.has(n));
  const greeted: string[] = [];
  const failed: string[] = [];

  for (const npub of pending) {
    let hex: string;
    try {
      hex = decodeNpubToHex(npub);
    } catch (e) {
      failed.push(npub);
      log.warn(`phantomchat[${input.persona}]: skipping un-decodable npub`, {
        npub,
        error: (e as Error).message,
      });
      continue;
    }
    try {
      await input.sendMessage(hex, input.greeting);
    } catch (e) {
      failed.push(npub);
      input.err?.write(
        `  [phantomchat:${input.persona}] greeting send failed for ${npub} — will retry next start\n`,
      );
      log.warn(`phantomchat[${input.persona}]: greeting send failed`, {
        npub,
        error: (e as Error).message,
      });
      continue;
    }
    // Sent successfully → record it. A persist failure here is non-fatal: the
    // worst case is one duplicate greeting on the next restart, never a missed
    // onboarding. So we still count it greeted in-memory for this pass.
    try {
      await input.recordGreeted(npub);
    } catch (e) {
      log.warn(`phantomchat[${input.persona}]: greeted but failed to persist marker`, {
        npub,
        error: (e as Error).message,
      });
    }
    greeted.push(npub);
    input.out?.write(`  [phantomchat:${input.persona}] greeted ${npub}\n`);
  }

  return { greeted, failed };
}
