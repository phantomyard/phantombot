/**
 * Per-conversation override for coder-progress streaming (`/viewcoder`).
 *
 * Mirrors the structure of replyMode.ts (a persona+conversation scoped
 * override persisted as a small JSON file) but is deliberately PERSISTENT —
 * there is NO idle expiry. A user who turns coder streaming off for a chat
 * expects it to STAY off until they change it, not silently re-enable after a
 * few minutes of quiet. So unlike reply-mode there is no TTL and no `touch`.
 *
 * States:
 *   - "on"      — force streaming on for this conversation, even if the global
 *                 routing default is off.
 *   - "off"     — suppress streaming for this conversation, even if the global
 *                 default is on.
 *   - "default" — no override; defer to the routing.json `codingProgress` flag.
 *                 Stored as a deletion (no entry) so the file stays minimal.
 *
 * The coder progress sink in the capability-routing Pi extension reads this
 * state at emit time, keyed by PHANTOMBOT_PERSONA + PHANTOMBOT_CONVERSATION, so
 * the override wins over the global default. The extension is dependency-free
 * and cannot import this module, so it re-derives the same state path and JSON
 * shape inline — keep the two in sync (path resolution + the `{ mode }` entry
 * shape). See pi-extension/capability-routing/index.ts (viewCoderOverrideOf).
 */

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { xdgStateHome } from "../config.ts";

/** Persisted override value. "default" is represented as the absence of an entry. */
export type ViewCoderMode = "on" | "off";
export type ViewCoderRequest = ViewCoderMode | "default";

export function normalizeViewCoderRequest(
  value: unknown,
): ViewCoderRequest | undefined {
  if (value === "on" || value === "enable" || value === "enabled") return "on";
  if (value === "off" || value === "disable" || value === "disabled") return "off";
  if (value === "default" || value === "clear" || value === "auto") return "default";
  return undefined;
}

interface StoredOverride {
  mode: ViewCoderMode;
  touchedAt: string;
}

type StoredOverrides = Record<string, StoredOverride>;

export function viewCoderStatePath(): string {
  return (
    process.env.PHANTOMBOT_VIEW_CODER_STATE ??
    join(xdgStateHome(), "phantombot", "view-coder-overrides.json")
  );
}

function key(persona: string, conversation: string): string {
  return `${persona}\u0000${conversation}`;
}

// Key shape: `${persona}\u0000${conversation}` (NUL separator, matching
// replyMode.ts). The extension's inline reader re-derives the same key — keep
// them in sync.

async function load(path = viewCoderStatePath()): Promise<StoredOverrides> {
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

async function save(state: StoredOverrides, path = viewCoderStatePath()): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(state, null, 2) + "\n", "utf8");
}

/**
 * Read the persistent override for a conversation. Returns "on"/"off", or
 * undefined when there's no override (= defer to the routing default). No TTL:
 * an override persists until explicitly changed.
 */
export async function getViewCoderOverride(input: {
  persona: string;
  conversation: string;
}): Promise<ViewCoderMode | undefined> {
  const state = await load();
  const entry = state[key(input.persona, input.conversation)];
  return entry?.mode;
}

/** Force the override to "on" or "off" for a conversation. */
export async function setViewCoderOverride(input: {
  persona: string;
  conversation: string;
  mode: ViewCoderMode;
  now?: Date;
}): Promise<void> {
  const path = viewCoderStatePath();
  const state = await load(path);
  state[key(input.persona, input.conversation)] = {
    mode: input.mode,
    touchedAt: (input.now ?? new Date()).toISOString(),
  };
  await save(state, path);
}

/** Clear the override → conversation defers to the global routing default. */
export async function clearViewCoderOverride(input: {
  persona: string;
  conversation: string;
}): Promise<void> {
  const path = viewCoderStatePath();
  const state = await load(path);
  delete state[key(input.persona, input.conversation)];
  await save(state, path);
}

/**
 * Apply a normalized `/viewcoder` request to the store. "on"/"off" persist;
 * "default" clears. Centralized so the CLI and the chat-command dispatcher
 * agree on the semantics.
 */
export async function applyViewCoderRequest(input: {
  persona: string;
  conversation: string;
  request: ViewCoderRequest;
  now?: Date;
}): Promise<void> {
  if (input.request === "default") {
    await clearViewCoderOverride(input);
    return;
  }
  await setViewCoderOverride({
    persona: input.persona,
    conversation: input.conversation,
    mode: input.request,
    now: input.now,
  });
}
