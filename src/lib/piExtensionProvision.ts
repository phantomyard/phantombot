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

import { mkdir, readFile, writeFile } from "node:fs/promises";
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
  action: "created" | "updated" | "unchanged";
  models: { primaryModel?: string; imageModel?: string; codingModel?: string };
  /** Relative paths of files we (re)wrote this run. */
  wrote: string[];
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

/** Only the defined routing fields, in a stable key order, as a JSON object. */
function routingModels(
  routing: PiRoutingConfig | undefined,
): { primaryModel?: string; imageModel?: string; codingModel?: string } {
  const out: {
    primaryModel?: string;
    imageModel?: string;
    codingModel?: string;
  } = {};
  if (routing?.primaryModel !== undefined) out.primaryModel = routing.primaryModel;
  if (routing?.imageModel !== undefined) out.imageModel = routing.imageModel;
  if (routing?.codingModel !== undefined) out.codingModel = routing.codingModel;
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
 * Ensure the managed extension is present and current. Idempotent: writes each
 * desired file only when missing or different. The marker's hash + the content
 * comparison together cover both source drift and routing.json drift.
 *
 * When `routing` is undefined we still stamp the source files but write an
 * empty `routing.json` ({}) so the extension registers nothing — keeping the
 * managed dir coherent rather than half-present.
 */
export async function ensureRoutingExtension(
  routing: PiRoutingConfig | undefined,
  opts: ProvisionOpts = {},
): Promise<ProvisionResult> {
  const home = opts.home ?? os.homedir();
  const dir = extensionDir(home);
  const existedBefore = existsSync(dir);

  const { files, models } = desiredFiles(routing);

  await mkdir(path.join(dir, "agents"), { recursive: true });

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

  const action: ProvisionResult["action"] = !existedBefore
    ? "created"
    : wrote.length > 0
      ? "updated"
      : "unchanged";

  return { dir, action, models, wrote };
}

/**
 * Non-writing health check for `phantombot doctor`.
 *   present  = the dir + marker file exist.
 *   drifted  = the marker hash != the current assets hash, OR routing.json
 *              differs from desired, OR any embedded source file differs.
 */
export async function routingExtensionStatus(
  routing: PiRoutingConfig | undefined,
  opts: ProvisionOpts = {},
): Promise<{ present: boolean; drifted: boolean; dir: string }> {
  const home = opts.home ?? os.homedir();
  const dir = extensionDir(home);

  const markerRaw = await readIfExists(path.join(dir, MARKER_FILE));
  const present = existsSync(dir) && markerRaw !== undefined;
  if (!present) {
    return { present: false, drifted: true, dir };
  }

  if (readMarkerHash(markerRaw) !== PI_EXTENSION_ASSETS_HASH) {
    return { present: true, drifted: true, dir };
  }

  const { files } = desiredFiles(routing);
  for (const [rel, content] of files) {
    const current = await readIfExists(path.join(dir, rel));
    if (current !== content) {
      return { present: true, drifted: true, dir };
    }
  }

  return { present: true, drifted: false, dir };
}
