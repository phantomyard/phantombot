/**
 * Phantombot-managed runtime state. Lives at `<persona>/state.json` (#435) —
 * per persona, because `harness_bins` is a property of the persona's own
 * harness chain and two personas on one box must not overwrite each other's.
 *
 * Distinct from config.toml: config.toml is user-owned and hand-edited,
 * state.json is phantombot-owned and mutated by commands like
 * `set-default-persona`. Splitting them lets us avoid round-tripping the
 * user's TOML (which would lose comments) when phantombot updates a setting.
 *
 * Resolution priority for any value that lives in both: env > state > toml > default.
 */

import { mkdir, readFile, appendFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { writeFileAtomic } from "./lib/io.ts";
import {
  loadGlobalConfig,
  personaStatePath,
  setGlobalConfigValue,
} from "./lib/personaPaths.ts";

export interface State {
  /**
   * Which persona a `--persona`-less CLI call means. NOT stored in the
   * per-persona state file — it is inherently global, so it is read from and
   * written to `<personas-root>/config.toml`. Surfaced on this object so the
   * many existing `state.default_persona` call sites keep working.
   */
  default_persona?: string;
  harness_bins?: Record<string, string>;
}

export function statePath(persona?: string): string {
  return personaStatePath(persona);
}

export async function loadState(persona?: string): Promise<State> {
  const globalDefault = loadGlobalConfig().default_persona;
  let own: State = {};
  try {
    const content = await readFile(statePath(persona), "utf8");
    const parsed = JSON.parse(content);
    if (typeof parsed === "object" && parsed !== null) own = parsed as State;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
  }
  // The global value always wins for default_persona: a stale copy left in a
  // persona state file by a pre-#435 box must never resurrect an old default.
  return globalDefault === undefined
    ? own
    : { ...own, default_persona: globalDefault };
}

/**
 * Best-effort read of the current state, used only to compute the old→new
 * delta for the audit log. A corrupt/unreadable state.json must NOT block a
 * repair write (persona/config commands exist precisely to overwrite a bad
 * file), so any failure here resolves to an empty state.
 */
async function loadStateForAudit(): Promise<State> {
  try {
    return await loadState();
  } catch {
    return {};
  }
}

/**
 * Audit log lives next to the state file it tracks, so pointing
 * PHANTOMBOT_STATE at a tmp path (as the test suite does) also redirects the
 * audit log there instead of polluting the live data dir. An explicit
 * PHANTOMBOT_STATE_AUDIT still wins if set.
 */
export function auditPath(): string {
  if (process.env.PHANTOMBOT_STATE_AUDIT) return process.env.PHANTOMBOT_STATE_AUDIT;
  return join(dirname(statePath()), "state-audit.log");
}

/**
 * Append-only forensic log of every default_persona change. Best-effort:
 * an audit failure must never block the actual state write. Records the
 * timestamp, PID, parent PID, old→new value, and a trimmed stack trace so
 * the *writer* of a bad persona is identifiable after the fact.
 */
async function auditPersonaChange(prev: State, next: State): Promise<void> {
  try {
    const before = prev.default_persona ?? null;
    const after = next.default_persona ?? null;
    if (before === after) return;
    const stack = (new Error().stack ?? "")
      .split("\n")
      .slice(2)
      .map((l) => l.trim())
      .filter((l) => l.startsWith("at "))
      .slice(0, 6)
      .join(" <- ");
    const entry = {
      ts: new Date().toISOString(),
      pid: process.pid,
      ppid: process.ppid,
      argv: process.argv.slice(1).join(" "),
      from: before,
      to: after,
      stack,
    };
    const path = auditPath();
    await mkdir(dirname(path), { recursive: true });
    await appendFile(path, JSON.stringify(entry) + "\n", "utf8");
  } catch {
    // never let auditing break a real state write
  }
}

export async function saveState(state: State, persona?: string): Promise<string> {
  const path = statePath(persona);
  const prev = await loadStateForAudit();
  await auditPersonaChange(prev, state);
  // default_persona is global, so it is routed to the global file rather than
  // written into this persona's state.json — otherwise `phantombot persona`
  // run as lena would set a default only lena could see.
  const { default_persona, ...ownState } = state;
  if (default_persona !== undefined && default_persona !== prev.default_persona) {
    setGlobalConfigValue("default_persona", default_persona);
  }
  // Atomic write: a torn state.json bricks every command that must parse it
  // on startup (loadState throws), so never expose a half-written file.
  await writeFileAtomic(path, JSON.stringify(ownState, null, 2) + "\n");
  return path;
}

export async function saveHarnessBins(
  updates: Record<string, string | undefined>,
): Promise<string | undefined> {
  const clean = Object.fromEntries(
    Object.entries(updates).filter(([, value]) => typeof value === "string" && value.length > 0),
  ) as Record<string, string>;
  if (Object.keys(clean).length === 0) return undefined;
  const state = await loadState();
  await saveState({
    ...state,
    harness_bins: {
      ...(state.harness_bins ?? {}),
      ...clean,
    },
  });
  return statePath();
}
