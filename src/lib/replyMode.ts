import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { xdgStateHome } from "../config.ts";
import { writeFileAtomic } from "./io.ts";

export type ReplyMode = "text" | "voice";
export type ReplyModeRequest = ReplyMode | "default";

export const DEFAULT_REPLY_MODE_OVERRIDE_TTL_MS = 600_000;

export function normalizeReplyMode(value: unknown): ReplyMode | undefined {
  return value === "text" || value === "voice" ? value : undefined;
}

export function normalizeReplyModeRequest(
  value: unknown,
): ReplyModeRequest | undefined {
  if (value === "text" || value === "voice") return value;
  if (value === "default" || value === "clear" || value === "auto") {
    return "default";
  }
  if (value === "disable" || value === "disabled") return "default";
  return undefined;
}

interface StoredOverride {
  mode: ReplyMode;
  touchedAt: string;
}

type StoredOverrides = Record<string, StoredOverride>;

export function replyModeStatePath(): string {
  return (
    process.env.PHANTOMBOT_REPLY_MODE_STATE ??
    join(xdgStateHome(), "phantombot", "reply-mode-overrides.json")
  );
}

function key(persona: string, conversation: string): string {
  return `${persona}\u0000${conversation}`;
}

async function load(path = replyModeStatePath()): Promise<StoredOverrides> {
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

async function save(state: StoredOverrides, path = replyModeStatePath()): Promise<void> {
  // Atomic write: a torn overrides file makes load() throw and drops every
  // inbound message until it's deleted. Never expose a half-written file.
  await writeFileAtomic(path, JSON.stringify(state, null, 2) + "\n");
}

function active(
  entry: StoredOverride | undefined,
  ttlMs: number,
  now: Date,
): entry is StoredOverride {
  if (!entry) return false;
  const touched = Date.parse(entry.touchedAt);
  if (!Number.isFinite(touched)) return false;
  return now.getTime() - touched <= ttlMs;
}

export async function getReplyModeOverride(input: {
  persona: string;
  conversation: string;
  ttlMs?: number;
  now?: Date;
}): Promise<ReplyMode | undefined> {
  const ttlMs = input.ttlMs ?? DEFAULT_REPLY_MODE_OVERRIDE_TTL_MS;
  const now = input.now ?? new Date();
  const path = replyModeStatePath();
  const state = await load(path);
  const k = key(input.persona, input.conversation);
  const entry = state[k];
  if (active(entry, ttlMs, now)) return entry.mode;
  if (entry) {
    delete state[k];
    await save(state, path);
  }
  return undefined;
}

export async function setReplyModeOverride(input: {
  persona: string;
  conversation: string;
  mode: ReplyMode;
  now?: Date;
}): Promise<void> {
  const path = replyModeStatePath();
  const state = await load(path);
  state[key(input.persona, input.conversation)] = {
    mode: input.mode,
    touchedAt: (input.now ?? new Date()).toISOString(),
  };
  await save(state, path);
}

export async function clearReplyModeOverride(input: {
  persona: string;
  conversation: string;
}): Promise<void> {
  const path = replyModeStatePath();
  const state = await load(path);
  delete state[key(input.persona, input.conversation)];
  await save(state, path);
}

export async function touchReplyModeOverride(input: {
  persona: string;
  conversation: string;
  ttlMs?: number;
  now?: Date;
}): Promise<ReplyMode | undefined> {
  const ttlMs = input.ttlMs ?? DEFAULT_REPLY_MODE_OVERRIDE_TTL_MS;
  const now = input.now ?? new Date();
  const path = replyModeStatePath();
  const state = await load(path);
  const k = key(input.persona, input.conversation);
  const entry = state[k];
  if (!active(entry, ttlMs, now)) {
    if (entry) {
      delete state[k];
      await save(state, path);
    }
    return undefined;
  }
  entry.touchedAt = now.toISOString();
  await save(state, path);
  return entry.mode;
}
