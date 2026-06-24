/**
 * Self-provisioning for the capability-routing Pi extension.
 *
 * phantombot OWNS ~/.pi/agent/extensions/capability-routing/ the way nginx owns
 * conf.d or systemd owns its drop-ins: the directory is overwritten from the
 * binary's embedded assets on every startup (and repaired by `phantombot
 * doctor`). This removes the two pieces of manual setup the old design needed —
 * the symlink into Pi's extensions dir, and the projection of routing models
 * into the spawned Pi child's environment.
 *
 * The extension reads its model config from a managed sibling `routing.json`
 * that we bake here from config.toml's `[harnesses.pi.routing]` — NOT from env
 * vars. See pi-extension/capability-routing/{index,tools}.ts for the consumer.
 */

import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  PI_EXTENSION_ASSETS_HASH,
  PI_EXTENSION_FILES,
} from "./piExtensionAssets.generated.ts";
import type { PiRoutingConfig } from "./piRouting.ts";

/** Marker file recording what we last stamped (drift detection for doctor). */
const MARKER_FILE = ".phantombot-managed";

/**
 * Banner prepended to every stamped SOURCE file so a human poking around the
 * Pi extensions dir sees it's machine-managed and where the real source lives.
 */
const MANAGED_NOTE =
  "MANAGED BY PHANTOMBOT — DO NOT EDIT. Overwritten on startup; edit " +
  "pi-extension/capability-routing/ in the phantombot repo instead.";

export interface ProvisionResult {
  dir: string;
  /**
   * created/updated/unchanged → we stamped (an image model is configured).
   * removed → no image model is configured and we deleted the previously-stamped
   *           dir. absent → nothing to stamp and nothing was there to remove
   *           (already in the desired empty state).
   */
  action: "created" | "updated" | "unchanged" | "removed" | "absent";
  models: {
    primaryModel?: string;
    imageModel?: string;
  };
  /** Relative paths of files we (re)wrote this run. */
  wrote: string[];
  /**
   * Relative paths of orphaned files we DELETED this run — files left over from
   * a previous embedded asset set that are no longer in `desiredFiles()` (e.g. a
   * removed `agents/coder.md`). The managed dir is OWNED by phantombot, so stale
   * files are pruned rather than left behind.
   */
  pruned: string[];
}

export interface ProvisionOpts {
  /** Base home dir; defaults to os.homedir(). Overridable for tests. */
  home?: string;
}

function extensionDir(home: string): string {
  return path.join(home, ".pi", "agent", "extensions", "capability-routing");
}

/** Prepend the managed banner as a language-appropriate comment line. */
function withManagedHeader(rel: string, content: string): string {
  if (rel.endsWith(".md")) {
    return `<!-- ${MANAGED_NOTE} -->\n${content}`;
  }
  // .ts (and any other) → line comment.
  return `// ${MANAGED_NOTE}\n${content}`;
}

/** Trim; blank ⇒ undefined. Mirrors the extension's own clean() in tools.ts. */
function clean(v: string | undefined): string | undefined {
  if (v === undefined) return undefined;
  const t = v.trim();
  return t.length > 0 ? t : undefined;
}

/**
 * The extension earns its place on disk ONLY when an IMAGE model is configured
 * — that's what registers `look_at_image`, the extension's sole tool. A bare
 * `primaryModel` (or a coding model, which drives the per-turn coding-brain swap
 * in harnesses/pi.ts, not a tool) registers nothing, so it does NOT justify
 * provisioning — when no image model is set the managed dir is removed rather
 * than left inert.
 */
export function hasRoutableCapability(
  routing: PiRoutingConfig | undefined,
): boolean {
  return clean(routing?.imageModel) !== undefined;
}

/** Only the defined routing fields, in a stable key order, as a JSON object. */
function routingModels(
  routing: PiRoutingConfig | undefined,
): ProvisionResult["models"] {
  const out: ProvisionResult["models"] = {};
  const primaryModel = clean(routing?.primaryModel);
  const imageModel = clean(routing?.imageModel);
  if (primaryModel !== undefined) out.primaryModel = primaryModel;
  if (imageModel !== undefined) out.imageModel = imageModel;
  // The coding model is deliberately NOT stamped into routing.json: it drives
  // the per-turn coding-brain swap in harnesses/pi.ts, not any tool the
  // extension registers, so the extension has no use for it.
  return out;
}

/**
 * Build the full desired file set (relative path → content) for a given routing
 * config. Source files get the managed header; routing.json + the marker are
 * generated. This is the single source of truth shared by the writer and the
 * non-writing status check, so they can never disagree about "desired".
 */
function desiredFiles(
  routing: PiRoutingConfig | undefined,
): { files: Map<string, string>; models: ProvisionResult["models"] } {
  const files = new Map<string, string>();
  for (const [rel, content] of Object.entries(PI_EXTENSION_FILES)) {
    files.set(rel, withManagedHeader(rel, content));
  }
  const models = routingModels(routing);
  files.set("routing.json", JSON.stringify(models, null, 2));
  return { files, models };
}

/** Content for the marker file. The hash is what drift detection compares. */
function markerContent(): string {
  return JSON.stringify(
    {
      assetsHash: PI_EXTENSION_ASSETS_HASH,
      stampedAt: new Date().toISOString(),
      note:
        "Managed by phantombot. Re-stamped on startup and by `phantombot " +
        "doctor`. Do not edit by hand.",
    },
    null,
    2,
  );
}

/** Parse the marker's recorded assets hash, or undefined if absent/garbled. */
function readMarkerHash(raw: string | undefined): string | undefined {
  if (raw === undefined) return undefined;
  try {
    const parsed = JSON.parse(raw) as { assetsHash?: unknown };
    return typeof parsed.assetsHash === "string" ? parsed.assetsHash : undefined;
  } catch {
    return undefined;
  }
}

async function readIfExists(p: string): Promise<string | undefined> {
  try {
    return await readFile(p, "utf8");
  } catch {
    return undefined;
  }
}

/**
 * Recursively list every FILE under `dir` as a relative path (POSIX-style "/",
 * matching the keys of `PI_EXTENSION_FILES`). Returns [] if the dir is absent.
 */
async function listFilesRecursive(dir: string): Promise<string[]> {
  const out: string[] = [];
  async function walk(rel: string): Promise<void> {
    const abs = rel === "" ? dir : path.join(dir, rel);
    let entries;
    try {
      entries = await readdir(abs, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const childRel = rel === "" ? e.name : `${rel}/${e.name}`;
      if (e.isDirectory()) {
        await walk(childRel);
      } else {
        out.push(childRel);
      }
    }
  }
  await walk("");
  return out;
}

/** Remove empty subdirectories under `root` (bottom-up). Leaves `root` itself. */
async function pruneEmptyDirs(root: string): Promise<void> {
  let entries;
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    const child = path.join(root, e.name);
    await pruneEmptyDirs(child);
    try {
      const remaining = await readdir(child);
      if (remaining.length === 0) await rm(child, { recursive: true, force: true });
    } catch {
      // ignore — race or already gone
    }
  }
}

/** Remove the managed extension dir entirely. Idempotent: a no-op if absent. */
export async function removeRoutingExtension(
  opts: ProvisionOpts = {},
): Promise<{ removed: boolean; dir: string }> {
  const home = opts.home ?? os.homedir();
  const dir = extensionDir(home);
  if (!existsSync(dir)) return { removed: false, dir };
  await rm(dir, { recursive: true, force: true });
  return { removed: true, dir };
}

/**
 * Ensure the managed extension matches the desired state for this routing
 * config. Idempotent.
 *
 * Rule: the dir is stamped when an IMAGE model is configured (that's what
 * registers `look_at_image`, the extension's sole tool). When no image model is
 * set (undefined routing, or only a primary/coding model) there is nothing for
 * the extension to do, so the managed dir is removed rather than left as an
 * inert empty shell.
 *
 * When stamping, writes each desired file only when missing or different; the
 * marker's hash + content comparison cover both source drift and routing.json
 * drift.
 */
export async function ensureRoutingExtension(
  routing: PiRoutingConfig | undefined,
  opts: ProvisionOpts = {},
): Promise<ProvisionResult> {
  const home = opts.home ?? os.homedir();
  const dir = extensionDir(home);

  // No image model ⇒ the extension would register no tools. Remove any
  // previously-stamped dir instead of leaving an inert shell behind.
  if (!hasRoutableCapability(routing)) {
    const { removed } = await removeRoutingExtension({ home });
    return {
      dir,
      action: removed ? "removed" : "absent",
      models: {},
      wrote: [],
      pruned: [],
    };
  }

  const existedBefore = existsSync(dir);

  const { files, models } = desiredFiles(routing);

  await mkdir(dir, { recursive: true });

  const wrote: string[] = [];
  for (const [rel, content] of files) {
    const full = path.join(dir, rel);
    const current = await readIfExists(full);
    if (current !== content) {
      await mkdir(path.dirname(full), { recursive: true });
      await writeFile(full, content, "utf8");
      wrote.push(rel);
    }
  }

  // Marker: rewrite when its recorded hash differs from the current assets
  // hash (timestamp alone never forces a rewrite, so a no-op run stays
  // "unchanged"). A missing marker also rewrites.
  const markerPath = path.join(dir, MARKER_FILE);
  const existingMarker = await readIfExists(markerPath);
  if (readMarkerHash(existingMarker) !== PI_EXTENSION_ASSETS_HASH) {
    await writeFile(markerPath, markerContent(), "utf8");
    wrote.push(MARKER_FILE);
  }

  // Prune orphans: files left over from a PREVIOUS embedded asset set that are
  // no longer desired (e.g. an `agents/coder.md` removed when the coder tool was
  // dropped). The managed dir is OWNED by phantombot — anything not in the
  // desired set + marker is stale and must go, or `phantombot doctor` would
  // forever report a dir it can't make match desired.
  const allowed = new Set<string>([...files.keys(), MARKER_FILE]);
  const pruned: string[] = [];
  for (const rel of await listFilesRecursive(dir)) {
    if (!allowed.has(rel)) {
      await rm(path.join(dir, rel), { force: true });
      pruned.push(rel);
    }
  }
  if (pruned.length > 0) await pruneEmptyDirs(dir);

  const changed = wrote.length > 0 || pruned.length > 0;
  const action: ProvisionResult["action"] = !existedBefore
    ? "created"
    : changed
      ? "updated"
      : "unchanged";

  return { dir, action, models, wrote, pruned };
}

/**
 * Non-writing health check for `phantombot doctor`.
 *   shouldExist = an image model is configured, so the managed dir is supposed
 *                 to be present.
 *   present     = the dir + marker file exist.
 *   drifted     = on-disk state doesn't match desired. When shouldExist:
 *                 marker hash != current assets hash, OR routing.json differs
 *                 from desired, OR any embedded source file differs, OR it's
 *                 missing. When !shouldExist: the dir exists at all (it must be
 *                 removed). The doctor repairs by stamping or removing per
 *                 shouldExist.
 */
export async function routingExtensionStatus(
  routing: PiRoutingConfig | undefined,
  opts: ProvisionOpts = {},
): Promise<{
  shouldExist: boolean;
  present: boolean;
  drifted: boolean;
  dir: string;
}> {
  const home = opts.home ?? os.homedir();
  const dir = extensionDir(home);
  const shouldExist = hasRoutableCapability(routing);

  // No image model ⇒ desired state is absence. Any leftover dir (even a partial
  // one) is drift that the doctor should remove.
  if (!shouldExist) {
    const exists = existsSync(dir);
    return { shouldExist, present: exists, drifted: exists, dir };
  }

  const markerRaw = await readIfExists(path.join(dir, MARKER_FILE));
  const present = existsSync(dir) && markerRaw !== undefined;
  if (!present) {
    return { shouldExist, present: false, drifted: true, dir };
  }

  if (readMarkerHash(markerRaw) !== PI_EXTENSION_ASSETS_HASH) {
    return { shouldExist, present: true, drifted: true, dir };
  }

  const { files } = desiredFiles(routing);
  for (const [rel, content] of files) {
    const current = await readIfExists(path.join(dir, rel));
    if (current !== content) {
      return { shouldExist, present: true, drifted: true, dir };
    }
  }

  // Orphaned files (on disk but not in the desired set + marker) are drift too —
  // e.g. a stale `agents/coder.md`. The doctor repairs by re-stamping, which now
  // prunes them.
  const allowed = new Set<string>([...files.keys(), MARKER_FILE]);
  for (const rel of await listFilesRecursive(dir)) {
    if (!allowed.has(rel)) {
      return { shouldExist, present: true, drifted: true, dir };
    }
  }

  return { shouldExist, present: true, drifted: false, dir };
}
