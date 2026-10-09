/**
 * Per-conversation scratch workspace (issue #661).
 *
 * A turn's working files — repro clones, test output, intermediate artifacts —
 * used to land in the shared system /tmp: world-readable, shared across
 * personas, wiped on reboot, and invisible to the NEXT turn, which then redid
 * the work or trusted a stale copy. This module provisions a persona-owned
 * scratch dir per turn and hands it to the harness as `PHANTOMBOT_SCRATCH`.
 *
 * Layout under `<agentDir>/scratch/`:
 *
 *   trusted/<conversation>/          cross-turn working files; kept until
 *                                    24h idle, then swept.
 *   untrusted/<conversation>/<turn>/ ONE turn's lifetime — deleted at turn end
 *
 * Dir names are `scratchDirName` output (`<slug>-<digest>`), so distinct
 * conversation keys / turn ids can never alias into one tree.
 *                                    (ephemeral by construction), so an
 *                                    untrusted turn can never leave files a
 *                                    later trusted turn would read. Per-TURN
 *                                    nesting (not the issue's bare
 *                                    `<conversation>/`) so two concurrent
 *                                    untrusted turns in one conversation can
 *                                    neither read nor delete each other's
 *                                    files.
 *
 * The env var is RUNTIME-owned: the path is derived from the persona dir,
 * never read from input or inherited from the ambient environment (see
 * withPersonaEnv). The prompt notice is built from on-disk names, which are
 * attacker-influenced — every interpolated field goes through promptSafeText.
 */

import { createHash } from "node:crypto";
import { mkdir, readdir, rm, rmdir, stat, utimes } from "node:fs/promises";
import { join, relative, resolve, sep } from "node:path";

import { inertText } from "./promptSafeText.ts";

/** Env var handed to harness subprocesses. Runtime-owned — never ambient. */
export const SCRATCH_ENV_VAR = "PHANTOMBOT_SCRATCH";

/**
 * Sweep TTL, deliberately FAT for the same reason PERSONA_TMP_SWEEP_MAX_AGE_MS
 * is (harnessArgvFiles.ts, #367): the age gate is stamped on conversation
 * activity, and a conversation with a turn still running must not have its
 * files reaped mid-run. 24h clears any plausible turn by a wide margin.
 */
export const SCRATCH_SWEEP_MAX_AGE_MS = 24 * 3_600_000;

/** Prompt-injection caps for the file listing. */
const MAX_LISTED_ENTRIES = 20;
const MAX_NOTICE_CHARS = 1200;
const MAX_NAME_CHARS = 100;

export type ScratchTier = "trusted" | "untrusted";

export interface ScratchProvisionInput {
  /** Persona dir — the scratch root is `<agentDir>/scratch`. */
  agentDir: string;
  /** Trust tier of THIS turn. Untrusted scratch is ephemeral. */
  tier: ScratchTier;
  /** Conversation key (e.g. "telegram:123") — the cross-turn scope. */
  conversation: string;
  /** Turn id — the untrusted per-turn dir name. Ignored for trusted. */
  turnId?: string;
  /** Test seam: fixed clock. */
  now?: Date;
}

export interface TurnScratch {
  /** Absolute path handed to the subprocess as PHANTOMBOT_SCRATCH. */
  dir: string;
  /** Conversation-level dir (`<root>/<tier>/<conv>`). */
  conversationDir: string;
  /** Prompt notice: path + lifetime semantics + capped file listing. */
  notice: string;
  /** True when the dir must be deleted at turn end (untrusted tier). */
  ephemeral: boolean;
  /** Kept for the teardown containment guard. */
  agentDir: string;
}

/**
 * Resolve, create and describe this turn's scratch dir. Sweeps stale
 * conversation dirs first (the TTL runs on use, so it cannot be forgotten).
 * Throws on filesystem failure — callers fail OPEN (turn runs without scratch).
 */
export async function provisionScratch(
  input: ScratchProvisionInput,
): Promise<TurnScratch> {
  const root = scratchRoot(input.agentDir);
  const conv = scratchDirName(input.conversation);
  const conversationDir = join(root, input.tier, conv);
  const ephemeral = input.tier === "untrusted";
  const dir = ephemeral
    ? join(conversationDir, scratchDirName(input.turnId ?? "turn"))
    : conversationDir;

  await sweepScratch(input.agentDir, { now: input.now });

  await mkdir(dir, { recursive: true, mode: 0o700 });
  // Stamp "last use" on the conversation dir so an active conversation that
  // simply writes no files this turn still resets the sweep clock.
  const now = input.now ?? new Date();
  await utimes(conversationDir, now, now).catch(() => {});

  return {
    dir,
    conversationDir,
    notice: await buildScratchNotice(dir, { ephemeral, now: input.now }),
    ephemeral,
    agentDir: input.agentDir,
  };
}

/**
 * Remove an ephemeral (untrusted) scratch dir at turn end. Best-effort and
 * containment-guarded: only paths inside `<agentDir>/scratch/untrusted/` are
 * ever deleted, so a corrupted TurnScratch cannot become an rm primitive.
 * No-op for trusted scratch and for undefined.
 */
export async function teardownScratch(
  scratch: TurnScratch | undefined,
): Promise<void> {
  if (!scratch?.ephemeral) return;
  try {
    const untrustedRoot = resolve(scratchRoot(scratch.agentDir), "untrusted");
    const target = resolve(scratch.dir);
    const rel = relative(untrustedRoot, target);
    if (!rel || rel.startsWith("..") || rel.startsWith(`..${sep}`) || resolve(untrustedRoot, rel) !== target) {
      return;
    }
    await rm(target, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
    // Drop the conversation shell once the last turn dir is gone. rmdir only
    // succeeds when empty, so a sibling turn's dir keeps the shell alive.
    await rmdir(scratch.conversationDir).catch(() => {});
  } catch {
    // Teardown must never break a turn; the TTL sweep is the backstop.
  }
}

/**
 * Delete conversation dirs idle longer than `maxAgeMs`. Only dirs directly
 * under `scratch/<tier>/` are candidates — phantombot manages exactly that
 * level; anything an agent placed INSIDE its conversation dir dies with it,
 * which is the TTL contract. Best-effort, never throws.
 */
export async function sweepScratch(
  agentDir: string,
  opts: { maxAgeMs?: number; now?: Date } = {},
): Promise<void> {
  const maxAgeMs = opts.maxAgeMs ?? SCRATCH_SWEEP_MAX_AGE_MS;
  const now = opts.now ?? new Date();
  const root = scratchRoot(agentDir);
  for (const tier of ["trusted", "untrusted"] as const) {
    let names: string[];
    try {
      names = await readdir(join(root, tier));
    } catch {
      continue; // no scratch root / tier yet
    }
    for (const name of names) {
      const path = join(root, tier, name);
      try {
        const st = await stat(path);
        if (!st.isDirectory()) continue; // stray file: not ours to reap
        if (now.getTime() - st.mtimeMs <= maxAgeMs) continue;
        await rm(path, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
      } catch {
        // An entry vanishing mid-sweep (concurrent teardown) is fine.
      }
    }
  }
}

/** `<agentDir>/scratch` — created lazily by provisioning/sweep. */
export function scratchRoot(agentDir: string): string {
  return resolve(agentDir, "scratch");
}

/**
 * Path-safe slug for a conversation key / turn id. Keeps `[A-Za-z0-9._-]`,
 * maps everything else to `_`, and refuses the empty/dot results that would
 * escape or collapse the layout. Bounded so a hostile key cannot bloat paths.
 *
 * The mapping is LOSSY in two ways — substitution (many raw chars fold to `_`)
 * and truncation (96 chars) — so this must never be used alone to name a
 * scratch dir; see `scratchDirName` below.
 */
export function sanitizeScratchName(raw: string): string {
  const slug = raw.replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 96);
  if (!slug || slug === "." || slug === "..") return "default";
  return slug;
}

/**
 * Collision-free dir name for a conversation key or turn id: the readable
 * slug plus a 12-hex digest of the FULL raw key. The slug alone is lossy
 * (substitution + truncation), so two distinct conversations could alias into
 * one trusted scratch tree and read or overwrite each other's files —
 * `matrix:room/a` and `matrix:room:a` both resolved to `matrix_room_a`, and
 * keys sharing their first 96 chars collided on truncation (review of #662).
 * The digest is derived from the raw key and nothing else, so a conversation
 * keeps the same dir across turns and restarts.
 */
export function scratchDirName(raw: string): string {
  const digest = createHash("sha256").update(raw, "utf8").digest("hex").slice(0, 12);
  return `${sanitizeScratchName(raw)}-${digest}`;
}

/**
 * The prompt notice: where scratch lives, how long it lives, and what earlier
 * turns left there. Every filesystem-derived string is rendered inert
 * (promptSafeText) — a file named like a prompt heading must stay one line of
 * data. Capped twice: at MAX_LISTED_ENTRIES entries and MAX_NOTICE_CHARS.
 */
export async function buildScratchNotice(
  dir: string,
  opts: { ephemeral?: boolean; now?: Date } = {},
): Promise<string> {
  const lines: string[] = [];
  // The env var NAME is the contract, not the literal path: the path is
  // runtime-owned (read it from $PHANTOMBOT_SCRATCH), and keeping it out of
  // the prompt keeps the notice free of volatile absolute paths.
  lines.push(
    opts.ephemeral
      ? `\`${SCRATCH_ENV_VAR}\` (set in this turn's environment) — this turn's working files (scratch/repro artifacts). EPHEMERAL: deleted when this turn ends; nothing written here survives.`
      : `\`${SCRATCH_ENV_VAR}\` (set in this turn's environment) — this conversation's working files (scratch/repro artifacts, not memory). Kept across turns until 24h idle.`,
  );

  let entries: { name: string; isDir: boolean; size: number; mtimeMs: number }[] = [];
  try {
    entries = await listEntries(dir);
  } catch {
    lines.push("(listing unavailable)");
    return lines.join("\n");
  }
  if (entries.length === 0) {
    lines.push("No files yet.");
    return lines.join("\n");
  }

  lines.push("Left by earlier turns in this conversation:");
  let shown = 0;
  let budget = MAX_NOTICE_CHARS;
  for (const entry of entries) {
    const label = entry.isDir
      ? `- \`${inertText(entry.name, MAX_NAME_CHARS)}/\` — directory`
      : `- \`${inertText(entry.name, MAX_NAME_CHARS)}\` — ${formatSize(entry.size)}, ${formatMtime(entry.mtimeMs)}`;
    if (shown >= MAX_LISTED_ENTRIES || budget - label.length < 0) break;
    lines.push(label);
    budget -= label.length;
    shown++;
  }
  const hidden = entries.length - shown;
  if (hidden > 0) lines.push(`…and ${hidden} more`);
  return lines.join("\n");
}

async function listEntries(
  dir: string,
): Promise<{ name: string; isDir: boolean; size: number; mtimeMs: number }[]> {
  const dirents = await readdir(dir, { withFileTypes: true });
  const entries = await Promise.all(
    dirents.map(async (d) => {
      const st = await stat(join(dir, d.name)).catch(() => undefined);
      return {
        name: d.name,
        isDir: d.isDirectory(),
        size: st?.size ?? 0,
        mtimeMs: st?.mtimeMs ?? 0,
      };
    }),
  );
  // Newest first: what a previous turn just produced is what the next one wants.
  return entries.sort((a, b) => b.mtimeMs - a.mtimeMs);
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function formatMtime(mtimeMs: number): string {
  return `${new Date(mtimeMs).toISOString().slice(0, 16).replace("T", " ")} UTC`;
}
