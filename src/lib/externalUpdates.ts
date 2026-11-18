/**
 * Is this binary's lifecycle owned by an external package manager?
 *
 * Phantombot normally updates itself: the heartbeat announces new releases
 * and `/update` / `phantombot update` swap the binary in place. That is wrong
 * when a package manager installed the binary. mise (used by Omarchy) keeps
 * each tool in its own versioned directory and tracks which version is
 * installed; an in-place swap there leaves mise believing the old version is
 * present, and mise's own upgrade later replaces whatever we put down. One
 * owner per binary — so when mise owns it, phantombot stands down and points
 * the user at `mise upgrade`.
 *
 * Detection is by path. mise installs into
 * `<MISE_DATA_DIR>/installs/<tool>/<version>/...`, with MISE_DATA_DIR
 * defaulting to `~/.local/share/mise` (and `%LOCALAPPDATA%\mise` on Windows).
 * The tool directory is `phantombot` for the registry short name, or the
 * backend-qualified form (`github-phantomyard-phantombot`) when someone
 * installs the backend spec directly. Matching the tool directory, not just
 * `/mise/installs/`, matters: a developer whose `bun` came from mise runs
 * `bun src/index.ts` and `bun test` with process.execPath under
 * `mise/installs/bun/`, and that must not read as a mise-managed phantombot.
 */

import { realpathSync } from "node:fs";

export interface ExternalUpdateManager {
  /** Package manager name, for messages. */
  name: "mise";
  /** The command the user should run instead of `/update`. */
  upgradeCommand: string;
}

const MISE_TOOL_DIRS = new Set([
  "phantombot",
  "github-phantomyard-phantombot",
  "aqua-phantomyard-phantombot",
  "ubi-phantomyard-phantombot",
]);

function normalize(p: string): string {
  return p.replace(/\\/g, "/").replace(/\/+$/, "");
}

/**
 * Returns the external manager that owns `binPath`, or null when phantombot
 * owns its own updates. Pure apart from a best-effort realpath; both inputs
 * are injectable for tests.
 */
export function detectExternalUpdateManager(
  binPath: string = process.execPath,
  env: Record<string, string | undefined> = process.env,
): ExternalUpdateManager | null {
  let resolved = binPath;
  try {
    resolved = realpathSync(binPath);
  } catch {
    // Fall back to the path as given — a missing file is still classifiable.
  }
  for (const candidate of new Set([binPath, resolved])) {
    if (isUnderMiseInstall(normalize(candidate), env)) {
      return { name: "mise", upgradeCommand: "mise upgrade phantombot" };
    }
  }
  return null;
}

function isUnderMiseInstall(
  path: string,
  env: Record<string, string | undefined>,
): boolean {
  const roots: string[] = [];
  const dataDir = env.MISE_DATA_DIR?.trim();
  if (dataDir) roots.push(`${normalize(dataDir)}/installs/`);

  for (const root of roots) {
    if (path.startsWith(root) && toolDirAfter(path, root.length)) return true;
  }

  // Default layouts: any `.../mise/installs/<tool>/...` segment.
  const marker = "/mise/installs/";
  const lower = path.toLowerCase();
  let idx = lower.indexOf(marker);
  while (idx !== -1) {
    if (toolDirAfter(path, idx + marker.length)) return true;
    idx = lower.indexOf(marker, idx + 1);
  }
  return false;
}

function toolDirAfter(path: string, start: number): boolean {
  const rest = path.slice(start);
  const slash = rest.indexOf("/");
  if (slash <= 0) return false; // need <tool>/<something> below installs/
  return MISE_TOOL_DIRS.has(rest.slice(0, slash).toLowerCase());
}

/** One-line explanation used by every refused update path. */
export function externalUpdateMessage(m: ExternalUpdateManager): string {
  return (
    `phantombot was installed by ${m.name}, which owns its updates here. ` +
    `Run \`${m.upgradeCommand}\` instead.`
  );
}
