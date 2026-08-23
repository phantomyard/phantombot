/**
 * Chattiness: a per-conversation toggle for the interim "progress narration"
 * bubbles the chat channels stream while a turn is running.
 *
 * WHAT it controls
 *   While a phantom works, text the model emits BEFORE a tool call ("checking
 *   your calendar…") is classified as progress narration, buffered, and flushed
 *   to the chat on a timer. Some users like that running commentary; others feel
 *   spammed by it. Chattiness lets a conversation turn those interim bubbles OFF
 *   without touching anything else — the FINAL answer always posts, and the
 *   error paths are untouched (narration suppression never sees them).
 *
 * SCOPE (deliberate)
 *   Telegram + PhantomChat only. Both channels stream narration through their
 *   own mirrored `flushNarration` loop (src/channels/core/engine.ts and
 *   src/channels/phantomchat/server.ts) — the gate lives in BOTH, keep them in
 *   sync. CLI and voice never emit narration bubbles, so they're out of scope
 *   for free. The editor (ACP) surface respects only the config DEFAULT, not the
 *   per-conversation override (see connectors/acp).
 *
 * MODEL (mirrors coderSwap.ts's override store)
 *   - `on`  → narration bubbles stream (the informative default).
 *   - `off` → quiet: no interim bubbles, just the final reply.
 *   - A per-conversation override is persistent (no TTL) and WINS over the
 *     config default. Absence of an entry = "defer to the config default".
 *   - `chattiness = true/false` in config.toml is the standing default when a
 *     conversation has no override; `/chattiness <on|off> default` writes it.
 */

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { xdgStateHome } from "../config.ts";

/** Persisted override. "default" is represented as the absence of an entry. */
export type ChattinessMode = "on" | "off";
export type ChattinessRequest = ChattinessMode | "default";

/**
 * Parse a free-text argument into a normalized request. Accepts a handful of
 * friendly synonyms so `/chattiness quiet` or `/chattiness auto` just work.
 * Returns undefined for anything unrecognized (caller shows usage).
 */
export function normalizeChattinessRequest(
  value: unknown,
): ChattinessRequest | undefined {
  if (
    value === "on" ||
    value === "enable" ||
    value === "enabled" ||
    value === "loud" ||
    value === "verbose"
  )
    return "on";
  if (
    value === "off" ||
    value === "disable" ||
    value === "disabled" ||
    value === "quiet" ||
    value === "silent" ||
    value === "no"
  )
    return "off";
  if (
    value === "default" ||
    value === "clear" ||
    value === "auto" ||
    value === "reset" ||
    value === ""
  )
    return "default";
  return undefined;
}

interface StoredOverride {
  mode: ChattinessMode;
  touchedAt: string;
}

type StoredOverrides = Record<string, StoredOverride>;

export function chattinessStatePath(): string {
  return (
    process.env.PHANTOMBOT_CHATTINESS_STATE ??
    join(xdgStateHome(), "phantombot", "chattiness-overrides.json")
  );
}

function key(persona: string, conversation: string): string {
  return `${persona} ${conversation}`;
}

async function load(path = chattinessStatePath()): Promise<StoredOverrides> {
  try {
    const parsed = JSON.parse(await readFile(path, "utf8"));
    return typeof parsed === "object" && parsed !== null
      ? (parsed as StoredOverrides)
      : {};
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw e;
  }
}

async function save(
  state: StoredOverrides,
  path = chattinessStatePath(),
): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(state, null, 2) + "\n", "utf8");
}

/** Read the persistent override for a conversation, or undefined (defer to default). */
export async function getChattinessOverride(input: {
  persona: string;
  conversation: string;
}): Promise<ChattinessMode | undefined> {
  const state = await load();
  return state[key(input.persona, input.conversation)]?.mode;
}

/** Force the override to "on" or "off" for a conversation. */
export async function setChattinessOverride(input: {
  persona: string;
  conversation: string;
  mode: ChattinessMode;
  now?: Date;
}): Promise<void> {
  const path = chattinessStatePath();
  const state = await load(path);
  state[key(input.persona, input.conversation)] = {
    mode: input.mode,
    touchedAt: (input.now ?? new Date()).toISOString(),
  };
  await save(state, path);
}

/** Clear the override → conversation defers to the config default. */
export async function clearChattinessOverride(input: {
  persona: string;
  conversation: string;
}): Promise<void> {
  const path = chattinessStatePath();
  const state = await load(path);
  delete state[key(input.persona, input.conversation)];
  await save(state, path);
}

/** Apply a normalized request: "on"/"off" persist; "default" clears. */
export async function applyChattinessRequest(input: {
  persona: string;
  conversation: string;
  request: ChattinessRequest;
  now?: Date;
}): Promise<void> {
  if (input.request === "default") {
    await clearChattinessOverride(input);
    return;
  }
  await setChattinessOverride({
    persona: input.persona,
    conversation: input.conversation,
    mode: input.request,
    now: input.now,
  });
}

/**
 * Resolve whether interim narration bubbles should be SHOWN for a conversation.
 *
 * Precedence: a per-conversation override wins; absent, fall back to the config
 * default (`chattiness = true/false`). This is the single decision the two
 * channel `flushNarration` loops consult before emitting a progress bubble.
 */
export async function resolveNarrationEnabled(input: {
  persona: string;
  conversation: string;
  configDefault: boolean;
}): Promise<boolean> {
  const override = await getChattinessOverride({
    persona: input.persona,
    conversation: input.conversation,
  });
  if (override) return override === "on";
  return input.configDefault;
}
