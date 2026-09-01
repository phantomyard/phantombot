/**
 * Phantombot-managed runtime state. Lives at $XDG_DATA_HOME/phantombot/state.json.
 *
 * Distinct from config.toml: config.toml is user-owned and hand-edited,
 * state.json is phantombot-owned and mutated by commands like
 * `set-default-persona`. Splitting them lets us avoid round-tripping the
 * user's TOML (which would lose comments) when phantombot updates a setting.
 *
 * Resolution priority for any value that lives in both: env > state > toml > default.
 */

import { mkdir, readFile, appendFile } from "node:fs/promises";
import { dirname, join, resolve, sep } from "node:path";
import { tmpdir } from "node:os";
import { xdgDataHome } from "./config.ts";
import { writeFileAtomic } from "./lib/io.ts";

export interface State {
  default_persona?: string;
  harness_bins?: Record<string, string>;
}

export function statePath(): string {
  return (
    process.env.PHANTOMBOT_STATE ??
    join(xdgDataHome(), "phantombot", "state.json")
  );
}

export async function loadState(): Promise<State> {
  try {
    const content = await readFile(statePath(), "utf8");
    const parsed = JSON.parse(content);
    return typeof parsed === "object" && parsed !== null ? parsed : {};
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw e;
  }
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

/**
 * Refuse to write the LIVE host's state.json from a test run.
 *
 * Armed only by tests/testEnvIsolation.ts (the bun `preload`), so this is
 * inert in every shipped binary — the check costs one env read at runtime and
 * exists because the failure it prevents is invisible: a test that writes the
 * real state.json repoints the host's default persona and arms a heartbeat
 * timer for a fixture persona, with a GREEN test run as the only evidence.
 *
 * Anything under the isolation root or the system temp dir is fine — the 23
 * suites that pin their own `mkdtemp` path must keep working. What is
 * forbidden is precisely the default resolution into a real data dir.
 */
function assertNotLiveStateWrite(path: string): void {
  const root = process.env.PHANTOMBOT_TEST_ISOLATION_ROOT;
  if (!root) return;
  const target = resolve(path);
  const allowed = [root, tmpdir()].map((d) => resolve(d) + sep);
  if (allowed.some((prefix) => target.startsWith(prefix))) return;
  throw new Error(
    `refusing to write state.json outside test isolation: ${target}\n` +
      "A test reached a state-writing code path with PHANTOMBOT_STATE pointing at " +
      "the real host. Point it at a temp dir in the test's own hooks (and restore " +
      "the saved value, do not delete it).",
  );
}

export async function saveState(state: State): Promise<string> {
  const path = statePath();
  assertNotLiveStateWrite(path);
  const prev = await loadStateForAudit();
  await auditPersonaChange(prev, state);
  // Atomic write: a torn state.json bricks every command that must parse it
  // on startup (loadState throws), so never expose a half-written file.
  await writeFileAtomic(path, JSON.stringify(state, null, 2) + "\n");
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
