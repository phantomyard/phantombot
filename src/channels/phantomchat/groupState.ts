/**
 * What a phantom remembers about its PhantomChat groups across a restart: each
 * group's name and the member list it was last shown. One small file per
 * persona, `<personaDir>/phantomchat-groups.json`. Losing it costs a missing
 * name and one missed "changed since" line, so every failure is logged and
 * survived.
 */

import { readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { log } from "../../lib/logger.ts";
import { GROUP_NAME_MAX, groupLabel } from "../core/groupContext.ts";

export const GROUP_STATE_FILE = "phantomchat-groups.json";
/** Groups remembered; past this the longest-untouched one is forgotten. */
const GROUPS_MAX = 500;

interface GroupState {
  name?: string;
  /** Source-event time (unix seconds) of `name`: an older event never wins. */
  nameAt?: number;
  /** Member hexes as of the last turn this phantom took here. */
  seen?: string[];
}

export class GroupStateStore {
  private readonly groups = new Map<string, GroupState>();
  private readonly path: string;

  constructor(personaDir: string) {
    this.path = join(personaDir, GROUP_STATE_FILE);
    try {
      const parsed = JSON.parse(readFileSync(this.path, "utf8")) as Record<string, unknown>;
      for (const [id, raw] of Object.entries(parsed ?? {})) {
        if (!raw || typeof raw !== "object") continue;
        const r = raw as Record<string, unknown>;
        this.groups.set(id, {
          ...(typeof r.name === "string" && Number.isFinite(r.nameAt)
            ? { name: groupLabel(r.name, GROUP_NAME_MAX), nameAt: r.nameAt as number }
            : {}),
          ...(Array.isArray(r.seen)
            ? { seen: r.seen.filter((h): h is string => typeof h === "string") }
            : {}),
        });
      }
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") {
        log.warn("phantomchat: group state unreadable, starting empty", {
          error: (e as Error).message,
        });
      }
    }
  }

  name(conversationId: string): string | undefined {
    return this.groups.get(conversationId)?.name;
  }

  seen(conversationId: string): string[] | undefined {
    return this.groups.get(conversationId)?.seen;
  }

  setName(conversationId: string, name: string, at: number): void {
    const label = groupLabel(name, GROUP_NAME_MAX);
    if (!label) return;
    const prev = this.groups.get(conversationId);
    if (prev?.nameAt !== undefined && at < prev.nameAt) return;
    if (prev?.name === label && prev.nameAt === at) return;
    this.put(conversationId, { ...prev, name: label, nameAt: at });
  }

  setSeen(conversationId: string, members: string[]): void {
    const prev = this.groups.get(conversationId);
    if (prev?.seen && sameSet(prev.seen, members)) return;
    this.put(conversationId, { ...prev, seen: [...members] });
  }

  private put(conversationId: string, state: GroupState): void {
    this.groups.delete(conversationId);
    this.groups.set(conversationId, state);
    while (this.groups.size > GROUPS_MAX) {
      this.groups.delete(this.groups.keys().next().value!);
    }
    try {
      const tmp = `${this.path}.${process.pid}.tmp`;
      writeFileSync(tmp, JSON.stringify(Object.fromEntries(this.groups)) + "\n", { mode: 0o600 });
      renameSync(tmp, this.path);
    } catch (e) {
      log.warn("phantomchat: group state not saved", { error: (e as Error).message });
    }
  }
}

function sameSet(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  const s = new Set(a);
  return b.every((h) => s.has(h));
}
