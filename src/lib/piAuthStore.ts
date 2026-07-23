/**
 * Writer for Pi's own auth store: ~/.pi/agent/auth.json.
 *
 * WHY THIS EXISTS (issue #312): `pi --list-models` reads auth ONLY from this
 * file and the providers' native env vars — it ignores `--api-key`. The
 * onboarding wizard collects the provider key into phantombot's own env store
 * (PHANTOMBOT_PI_API_KEY, threaded per-turn) and used to refresh the model
 * catalog by injecting the native env var into the `--list-models` child.
 * That works on Linux but proved unreliable elsewhere (macOS repro in #312),
 * leaving fresh installs with an empty catalog and free-text model entry.
 * Keying Pi directly fixes it because the first catalog fetch then succeeds —
 * so the wizard now merge-writes the key into Pi's store too.
 *
 * SCOPE: this module is WRITE-ONLY. Phantombot never deletes from Pi's store:
 * the "Use Pi's own config" path (clearPiRouting) delegates to the very login
 * this file holds, so erasing it would break the mode it enables. Pi's store
 * is shared user state (interactive `pi` logins included) — we add/replace an
 * api_key entry for the provider the operator just keyed, and nothing else.
 *
 * GUARDS (Pi's auth.json is user-owned, so we are conservative):
 *   - existing oauth entry for the same provider → left untouched (an
 *     interactive `/login` beats a wizard key; the provider is already keyed)
 *   - existing file is unparseable or not a JSON object → REFUSE to write
 *     rather than clobber unknown state
 *   - all other providers' entries are preserved verbatim
 */

import { existsSync } from "node:fs";
import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export function piAuthJsonPath(home: string = homedir()): string {
  return join(home, ".pi", "agent", "auth.json");
}

/** One entry in Pi's auth.json. OAuth entries carry more fields; we only read `type`. */
interface PiAuthEntry {
  type?: string;
  key?: string;
  [k: string]: unknown;
}

export type PiAuthMerge =
  | { action: "write"; store: Record<string, PiAuthEntry> }
  | { action: "skip-oauth" }
  | { action: "refuse"; reason: string };

/**
 * Pure merge decision: given the raw existing file content (`undefined` when
 * the file does not exist yet — fresh install ⇒ start from an empty object),
 * decide what writing `provider`'s api_key should do. Exported for tests.
 */
export function mergePiApiKey(
  existingText: string | undefined,
  provider: string,
  apiKey: string,
): PiAuthMerge {
  let store: Record<string, PiAuthEntry> = {};
  if (existingText !== undefined) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(existingText);
    } catch {
      return {
        action: "refuse",
        reason: "existing auth.json is not valid JSON — refusing to clobber it",
      };
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return {
        action: "refuse",
        reason: "existing auth.json is not a JSON object — refusing to clobber it",
      };
    }
    store = parsed as Record<string, PiAuthEntry>;
    const current = store[provider];
    if (current && typeof current === "object" && current.type === "oauth") {
      return { action: "skip-oauth" };
    }
  }
  store[provider] = { type: "api_key", key: apiKey };
  return { action: "write", store };
}

export type PiAuthWriteResult =
  | { ok: true; path: string; skipped?: "oauth-present" }
  | { ok: false; path: string; reason: string };

/**
 * Merge-write an api_key for `provider` into Pi's auth.json, preserving every
 * other entry. Atomic (tmp + rename), mode 0o600 — same discipline as
 * envFile.ts. Never throws: failures are reported in the result so the wizard
 * can fall back to the env-injected catalog refresh.
 *
 * `home` is injectable for tests.
 */
export async function writePiApiKey(
  provider: string,
  apiKey: string,
  home?: string,
): Promise<PiAuthWriteResult> {
  const path = piAuthJsonPath(home);
  try {
    const existing = existsSync(path)
      ? await readFile(path, "utf8")
      : undefined;
    const merge = mergePiApiKey(existing, provider, apiKey);
    if (merge.action === "refuse") {
      return { ok: false, path, reason: merge.reason };
    }
    if (merge.action === "skip-oauth") {
      return { ok: true, path, skipped: "oauth-present" };
    }
    await mkdir(dirname(path), { recursive: true });
    // Write to a tempfile at mode 0o600 then atomically rename over the target,
    // so a fresh file is never briefly world-readable (mirrors saveEnvFile).
    const tmp = `${path}.tmp`;
    try {
      await writeFile(tmp, JSON.stringify(merge.store, null, 2) + "\n", {
        encoding: "utf8",
        mode: 0o600,
      });
      await rename(tmp, path);
    } catch (e) {
      try {
        await unlink(tmp);
      } catch {
        /* best-effort cleanup */
      }
      throw e;
    }
    return { ok: true, path };
  } catch (e) {
    return {
      ok: false,
      path,
      reason: e instanceof Error ? e.message : String(e),
    };
  }
}
